/**
 * @ftptech/canton-x402-mcp — MCP server exposing a self-custody Canton x402
 * wallet as tools. THIN wrapper over @ftptech/canton-agent-wallet: all crypto,
 * relay, and verify-before-sign live there and are reused verbatim.
 *
 * Delivery model (see the redesign brief): a HUMAN connects this server
 * out-of-band (`claude mcp add ...`). The agent then calls TOOLS — it never
 * runs an install, never sees the private key (it stays in the server's home),
 * and money-moving tools (pay/withdraw) are ask/cap. Read tools auto-allow.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRequire } from "node:module";
import { z } from "zod";

// serverInfo.version must track the package version (clients display it); a
// hardcoded literal drifted (0.3.0 shipped announcing "0.1.2").
const PKG_VERSION = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;
import {
  ensureWallet,
  loadWallet,
  saveWallet,
  agentKeyFromPrivatePem,
  RelayClient,
  claimAll,
  withdraw,
  makePayingFetch,
  questFund,
  QuestFundError,
  writeRescueKey,
  type AgentWallet,
} from "@ftptech/canton-agent-wallet";
import type { McpConfig } from "./config.js";
import {
  PolicyError,
  readLedger,
  assertPayAllowed,
  assertWithdrawAllowed,
  recordOutbound,
  recordClaimedHighWater,
} from "./policy.js";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const errText = (s: string) => ({
  content: [{ type: "text" as const, text: s }],
  isError: true,
});

const toNum = (cc: string): number => {
  const n = Number(cc);
  return Number.isFinite(n) ? n : 0;
};

/** Map a thrown wallet/relay error to a clean tool error (never leak key bytes,
 *  never throw out of a handler — return isError instead). */
function toolError(where: string, err: unknown): ReturnType<typeof errText> {
  if (err instanceof PolicyError) return errText(`blocked by spend policy: ${err.message}`);
  const msg = err instanceof Error ? err.message : String(err);
  return errText(`${where} failed: ${msg}`);
}

/** Lighthouse cross-check: success iff verdict==accepted AND send==Success.
 *  Best-effort + read-only; never throws (balance is the authoritative truth). */
async function lighthouseVerify(
  updateId: string
): Promise<{ ok: boolean; verdict?: string | undefined; send?: string | undefined } | null> {
  try {
    const res = await fetch(
      `https://lighthouse.cantonloop.com/api/transactions/${encodeURIComponent(updateId)}`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    const blob = JSON.stringify(j);
    const verdict = /"verdict_result"\s*:\s*"([^"]+)"/.exec(blob)?.[1];
    const send = /"TransferCommandResult(\w+)"/.exec(blob)?.[0];
    const ok = verdict === "accepted" && send === "TransferCommandResultSuccess";
    return { ok, verdict, send };
  } catch {
    return null;
  }
}

/** Best-effort updateId from an x402 payment response header (PAYMENT-RESPONSE /
 *  X-PAYMENT-RESPONSE = base64 JSON carrying `transaction`). Balance remains the
 *  source of truth if this is absent. */
function updateIdFromResponse(res: Response): string | undefined {
  const raw =
    res.headers.get("payment-response") ??
    res.headers.get("x-payment-response") ??
    res.headers.get("payment-response-canton");
  if (!raw) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as {
      transaction?: string;
      updateId?: string;
    };
    return decoded.transaction ?? decoded.updateId;
  } catch {
    return undefined;
  }
}

export function buildFundingText(party: string, amount?: string): string {
  const amt = amount && amount.trim() ? `${amount} Canton Coin (CC)` : "some Canton Coin (CC) (0.05–1 CC is plenty to start)";
  return (
    `My Canton wallet is ready. Party id:\n  ${party}\n\n` +
    `Please send ${amt} to that party id on MainNet. ` +
    `Once you've sent it, tell me and I'll claim it.`
  );
}

/**
 * `auto_fund` flow, extracted for unit testing. It NO LONGER pulls a bare faucet
 * seed (a free-CC faucet is farmable — a bot mints parties in a loop and drains
 * it). Instead it funds through the pay-proxy QUEST, which binds the grant to a
 * REAL x402 payment: the pay-proxy mints a wallet, faucets it, spends the bulk on
 * a CanTrust image, and leaves the small change. `auto_fund` then IMPORTS the
 * returned key so the agent SELF-CUSTODIES the funded wallet.
 *
 * Safety:
 *   - NO-CLOBBER: if the agent already has a FUNDED wallet, it is never replaced —
 *     we just report the balance. Only an empty/absent wallet is bootstrapped.
 *   - Any quest failure (pay-proxy down / faucet off / over budget) falls back to
 *     the manual-funding ask, NOT an error — the agent always gets a next step.
 * `questFundImpl` + `importWallet` are injected so this is testable without a real
 * pay-proxy or ledger.
 */
export async function runAutoFund(deps: {
  wallet: AgentWallet;
  relay: Pick<RelayClient, "balance" | "pending">;
  home: string;
  payProxyUrl: string | undefined;
  questFundImpl?: typeof questFund;
  /** Persist a key rescued from a failed quest (tests). Defaults to the
   *  agent-wallet helper, so both packages obey one set of rules. */
  rescueKeyImpl?: typeof writeRescueKey;
  importWallet?: (
    secret: string,
    relayUrl: string,
    network: string
  ) => Promise<AgentWallet>;
}): Promise<string> {
  const { wallet, relay, home, payProxyUrl } = deps;

  // NO-CLOBBER: an already-funded wallet is the user's — never mint over it.
  //
  // UNREADABLE IS NOT EMPTY. This guard is the only thing between the wallet on
  // disk and the `saveWallet` further down, and that write destroys the private
  // key — the one thing here that cannot be undone. Catching the balance read
  // into "0" and proceeding "to bootstrap" made a relay blip look exactly like
  // an empty wallet.
  //
  // It is not hypothetical: /v1/wallet/:party/balance answers 413
  // holdings_exceed_node_limit for a party holding more amulet contracts than
  // the participant's element cap, and RelayClient.balance has no fallback for
  // it. So the wallets whose balance cannot be read are precisely the ones that
  // accumulated the most CC, and every auto_fund call reproduces it — while
  // onboarding still works, so the mint goes through.
  //
  // The sibling path (fundViaQuest, agent-wallet) already refuses here; this
  // copy was never updated. A wallet is replaced only when we KNOW it is empty.
  let existingCc: string;
  try {
    existingCc = (await relay.balance(wallet.party)).cc;
  } catch (err) {
    return (
      `A wallet already exists (${wallet.party}) but its balance could not be ` +
      `read (${err instanceof Error ? err.message : String(err)}). Refusing to ` +
      `auto-fund: an unreadable balance is not an empty one, and minting a new ` +
      `wallet would overwrite this one's private key. Retry once the relay is ` +
      `reachable.\n` +
      buildFundingText(wallet.party)
    );
  }
  if (toNum(existingCc) > 0) {
    return (
      `Wallet already funded: ${existingCc} CC for ${wallet.party}. ` +
      `No action taken (auto_fund never replaces a funded wallet).`
    );
  }

  // ZERO IS NOT EMPTY EITHER. /balance counts Amulet contracts only, so CC that
  // the owner has SENT but that this wallet has not accepted yet — a pending
  // TransferInstruction — reads as zero. That is the ordinary state of an agent
  // wallet between "owner sent funds" and "agent ran claim", which is the very
  // sequence this tool's own funding instructions ask for. Replacing the wallet
  // there destroys the key those funds are addressed to and strands them on the
  // ledger for good.
  //
  // Same fix as the agent-wallet twin (fundViaQuest). The two copies of this
  // guard have now diverged twice; whichever is edited next, edit both.
  let existingPending: Array<{ cid: string; amount?: string }>;
  try {
    existingPending = (await relay.pending(wallet.party)).pending;
  } catch (err) {
    return (
      `A wallet already exists (${wallet.party}) and reads as empty, but its ` +
      `pending incoming transfers could not be read (${
        err instanceof Error ? err.message : String(err)
      }). Refusing to auto-fund: a zero balance only proves there are no ` +
      `ACCEPTED funds, and minting a new wallet would overwrite this one's ` +
      `private key. Retry once the relay is reachable.\n` +
      buildFundingText(wallet.party)
    );
  }
  if (existingPending.length > 0) {
    const total = existingPending
      .reduce((sum, p) => sum + toNum(p.amount ?? "0"), 0)
      .toFixed(10);
    return (
      `Wallet ${wallet.party} has ${existingPending.length} unaccepted ` +
      `incoming transfer(s) totalling ${total} CC. Refusing to auto-fund: ` +
      `replacing the wallet would destroy the private key those funds are ` +
      `addressed to. Run the \`claim\` tool to accept them, then check the ` +
      `balance.`
    );
  }

  // The quest is the only funding path (the bare faucet is locked). It needs the
  // pay-proxy URL; without it, fall back to manual funding.
  if (!payProxyUrl) {
    return (
      `Auto-fund goes through the quest, which needs the pay-proxy URL ` +
      `(--pay-proxy-url or CANTON_AGENT_PAY_PROXY_URL). It is not configured.\n` +
      buildFundingText(wallet.party)
    );
  }

  const runQuest = deps.questFundImpl ?? questFund;
  // Injectable so a test can prove the rescue ran without writing a key to the
  // developer's real wallet directory.
  const rescueKey = deps.rescueKeyImpl ?? writeRescueKey;
  const doImport =
    deps.importWallet ??
    (async (secret: string, relayUrl: string, network: string) => {
      const key = agentKeyFromPrivatePem(secret);
      // ensureWallet is LOAD-FIRST: the server's empty BOOT wallet is already on
      // disk here, so a plain ensureWallet would return it and silently drop the
      // funded key (found live). `ephemeral` skips the store read; persist the
      // imported key explicitly.
      const w = await ensureWallet({
        relayUrl,
        network,
        key,
        restore: true,
        ephemeral: true,
      });
      saveWallet(w);
      return w;
    });

  let funded: Awaited<ReturnType<typeof questFund>>;
  try {
    funded = await runQuest({ payProxyUrl });
  } catch (e) {
    // A QUEST THAT FAILED PAST STEP 1 STILL LEFT US HOLDING A KEY.
    //
    // Step 1 mints the wallet and hands back its PEM; step 2 is where the
    // faucet grant is dispensed AND where the pay-proxy drops its copy of the
    // key. So a step-2 failure or timeout means real CC is sitting on a MainNet
    // party whose only surviving key is the one attached to this error. Reading
    // just `e.message` let it be collected with the Error — funds nobody can
    // ever move — while the agent was told the quest was merely "unavailable"
    // and to go ask a human, a benign claim for a state where money moved.
    //
    // The agent-wallet twin has rescued this since the morning; this copy calls
    // the lower-level `questFund` directly and never got it. Same helper, so
    // there is one rescue and one set of rules (0600, beside the wallet, never
    // AS the wallet, party in the filename).
    const rec = e instanceof QuestFundError ? e.recoverable : undefined;
    let rescued = "";
    if (rec) {
      try {
        const path = rescueKey(rec.secret, rec.party, rec.network);
        rescued =
          `\nA wallet WAS created and may hold faucet CC: party ${rec.party}. ` +
          `Its private key is saved at ${path} — import it with ` +
          `\`canton-agent-wallet import --key-file ${path}\` before retrying, ` +
          `or those funds are unreachable.\n`;
      } catch (writeErr) {
        // Say it plainly rather than swallow it: the key is about to be lost.
        rescued =
          `\nA wallet WAS created (party ${rec.party}) and its key could NOT be ` +
          `saved (${writeErr instanceof Error ? writeErr.message : String(writeErr)}). ` +
          `Any faucet CC on that party is unrecoverable.\n`;
      }
    }
    return (
      `Auto-fund via the quest is unavailable ` +
      `(${e instanceof Error ? e.message : String(e)}).\n` +
      rescued +
      buildFundingText(wallet.party)
    );
  }

  // Install the funded wallet (self-custody: the agent now holds the key). This
  // replaces the empty bootstrap wallet with the funded, minted one. FAIL LOUD
  // on a party mismatch — reporting the funded party while a different wallet
  // survived on disk would strand the grant behind a dropped key.
  try {
    const installed = await doImport(funded.secret, wallet.relayUrl, funded.network);
    if (installed.party !== funded.party) {
      throw new Error(
        `installed wallet party ${installed.party} is not the funded party — the funded key was NOT persisted`
      );
    }
  } catch (e) {
    // The old text here said "the server does not expose the key, so treat that
    // wallet as lost". That was false: `funded.secret` is in scope one line
    // above. The wallet is funded and the key is in hand — throwing it away and
    // telling the agent to retry means paying for a second one.
    let where: string;
    try {
      where = `Its key is saved at ${rescueKey(funded.secret, funded.party, funded.network)}`;
    } catch (writeErr) {
      where = `Its key could NOT be saved (${
        writeErr instanceof Error ? writeErr.message : String(writeErr)
      }) and those funds are unrecoverable`;
    }
    return (
      `Quest funding could NOT be completed: the funded wallet (party ${funded.party}) ` +
      `failed to install locally (${e instanceof Error ? e.message : String(e)}). ` +
      `${where} — import it rather than retrying auto_fund, which would fund a ` +
      `second wallet and strand this one. If import is not possible, fall back ` +
      `to manual funding:\n` +
      buildFundingText(wallet.party)
    );
  }

  // Raise the funded ceiling to the new balance so the agent may spend it.
  const bal = funded.balanceCc ?? "0";
  const led = readLedger(home, Date.now());
  recordClaimedHighWater(home, toNum(bal) + led.lifetimeOutCC, Date.now());

  const imageNote = funded.image
    ? ` A demo image was generated along the way: ${funded.image}.`
    : "";
  return (
    `Funded a fresh self-custody wallet via the quest: party ${funded.party}, ` +
    `balance ${bal} CC (the grant minus the on-ledger payment).${imageNote} ` +
    `You now hold this wallet's private key.`
  );
}

export function createServer(config: McpConfig): McpServer {
  // store.ts resolves the wallet home from CANTON_AGENT_HOME at call time, so the
  // server's own home must be in the env before any wallet op. bin.ts sets this
  // too; setting it here as well keeps createServer self-contained for tests.
  process.env.CANTON_AGENT_HOME = config.home;
  const { relayUrl, network, apiKey } = config;

  const relay = (w: AgentWallet) => new RelayClient({ relayUrl: w.relayUrl, apiKey });

  // Lazily create-or-load the wallet once; the key is generated + persisted in
  // config.home and never returned by any tool.
  const getWallet = async (): Promise<AgentWallet> =>
    loadWallet() ?? (await ensureWallet({ relayUrl, network, apiKey }));

  const server = new McpServer({ name: "canton-x402", version: PKG_VERSION });

  // ── read-only (auto-allow) ────────────────────────────────────────────────
  server.registerTool(
    "get_address",
    {
      title: "Get wallet address",
      description:
        "Return this agent's Canton party id (its wallet address). Creates the wallet on first use. Read-only.",
      inputSchema: {},
      annotations: { title: "Get address", readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const w = await getWallet();
        return text(w.party);
      } catch (err) {
        return toolError("get_address", err);
      }
    }
  );

  server.registerTool(
    "get_balance",
    {
      title: "Get wallet balance",
      description:
        "Return the agent's on-ledger Canton Coin (CC) balance and holdings. Read-only, authoritative.",
      inputSchema: {},
      annotations: { title: "Get balance", readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const w = await getWallet();
        const b = await relay(w).balance(w.party);
        return text(
          `${b.cc} CC (${b.amulet} amulet${b.amulet === 1 ? "" : "s"}) for ${w.party}`
        );
      } catch (err) {
        return toolError("get_balance", err);
      }
    }
  );

  server.registerTool(
    "request_funding",
    {
      title: "Request funding from the owner",
      description:
        "Return the agent's party id plus a ready-to-paste message asking the human owner to send CC. Moves nothing; funds appear after the owner sends and the agent calls `claim`.",
      inputSchema: { amount: z.string().optional().describe("Suggested CC amount, e.g. \"0.5\"") },
      annotations: { title: "Request funding", readOnlyHint: true, openWorldHint: false },
    },
    async ({ amount }) => {
      try {
        const w = await getWallet();
        return text(buildFundingText(w.party, amount));
      } catch (err) {
        return toolError("request_funding", err);
      }
    }
  );

  // ── inbound state-change (auto-ok: can only pull funds IN) ─────────────────
  server.registerTool(
    "auto_fund",
    {
      title: "Auto-fund a starter wallet",
      description:
        "Bootstrap a funded self-custody wallet with NO human funding step: this runs the hosted quest (mint → grant → a real on-ledger CanTrust payment → small change) and imports the resulting key so you own the funded wallet. If you already hold a funded wallet it is left untouched. If the quest is unavailable this returns a ready-to-paste message asking your human to fund you manually instead — then call `claim`.",
      inputSchema: {},
      annotations: { title: "Auto-fund", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      try {
        const w = await getWallet();
        return text(
          await runAutoFund({
            wallet: w,
            relay: relay(w),
            home: config.home,
            payProxyUrl: config.payProxyUrl,
          })
        );
      } catch (err) {
        return toolError("auto_fund", err);
      }
    }
  );

  server.registerTool(
    "claim",
    {
      title: "Claim incoming funding",
      description:
        "Accept all pending incoming transfers into this wallet (funds IN only — cannot send funds out). Run after the owner has sent CC.",
      inputSchema: {},
      annotations: { title: "Claim funding", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      try {
        const w = await getWallet();
        const r = await claimAll(relay(w), w);
        // Raise the funded ceiling to the post-claim high-water (balance + what
        // has already gone out) so the agent may spend up to what was funded in.
        const bal = await relay(w).balance(w.party);
        const led = readLedger(config.home, Date.now());
        recordClaimedHighWater(config.home, toNum(bal.cc) + led.lifetimeOutCC, Date.now());
        // Report every outcome, not only the claimed count: an agent that reads
        // "nothing to claim" while three offers sit expired and one failed has
        // been told something false. Expired ones are skipped by design (the
        // ledger refuses their accept); failed ones are named by cid.
        const extras = [
          r.skippedExpired ? `${r.skippedExpired} expired (skipped)` : "",
          r.skippedUntrusted.length
            ? `${r.skippedUntrusted.length} offer(s) of an untrusted-registrar token skipped (${[...new Set(r.skippedUntrusted.map((s) => s.admin))].join(", ")})`
            : "",
          r.failed.length
            ? `${r.failed.length} failed: ${r.failed.map((f) => `${f.cid.slice(0, 12)}… ${f.error}`).join("; ")}`
            : "",
        ].filter(Boolean);
        const tail = extras.length ? ` — ${extras.join("; ")}` : "";
        if (r.claimed === 0 && r.failed.length > 0) {
          return errText(`claim: every attempted accept failed — nothing was claimed${tail}`);
        }
        return text(
          (r.claimed > 0
            ? `claimed ${r.claimed} transfer(s); balance now ${bal.cc} CC`
            : `nothing to claim; balance ${bal.cc} CC`) + tail
        );
      } catch (err) {
        return toolError("claim", err);
      }
    }
  );

  // ── money OUT (ask / cap) ─────────────────────────────────────────────────
  server.registerTool(
    "pay",
    {
      title: "Pay an x402-gated URL",
      description:
        "MOVES FUNDS OUT. Pay for an HTTP 402 / x402-gated resource and return its response. Supports GET and POST (pass method/headers/body to pay a POST API such as an LLM completions endpoint). Bounded by the spend policy (allowed domains, per-tx cap, daily cap, funded ceiling) set by the owner at startup. Calls the URL exactly once — do NOT wrap in a retry loop (the first payment can take ~60-90s; that is normal, not a failure).",
      inputSchema: {
        url: z.string().url().describe("The 402-gated URL to pay for"),
        method: z
          .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
          .optional()
          .describe("HTTP method (default GET); use POST for APIs that take a request body"),
        headers: z
          .record(z.string())
          .optional()
          .describe('Request headers, e.g. {"content-type":"application/json"}'),
        body: z
          .string()
          .optional()
          .describe("Raw request body for POST/PUT/PATCH (e.g. a JSON string)"),
      },
      annotations: { title: "Pay (moves funds OUT)", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ url, method, headers, body: reqBody }) => {
      // The spend ledger must be written from what the BALANCE did, not from
      // whether this call returned. A paying fetch can settle several real
      // payments and then throw — the client says so itself — and the
      // accounting used to sit after the fetch inside the same try, so a throw
      // skipped it entirely. `spentTodayCC` stayed 0, and --daily-cap, whose
      // only input is that counter, could never fire: a merchant that keeps
      // answering 402 after settling drains the wallet while the breaker reads
      // zero. Whatever happens, if the balance went down we owe the ledger an
      // entry.
      let w: Awaited<ReturnType<typeof getWallet>> | undefined;
      let before: number | undefined;
      let spent = 0;
      const recordWhatLeft = async (): Promise<void> => {
        if (!w || before === undefined) return;
        try {
          const now = toNum((await relay(w).balance(w.party)).cc);
          spent = Math.max(0, before - now);
          if (spent > 0) recordOutbound(config.home, spent, Date.now());
        } catch {
          // The balance read itself failed. Nothing to record honestly, and
          // throwing here would replace the caller's real error with ours.
        }
      };
      try {
        w = await getWallet();
        assertPayAllowed(config.policy, readLedger(config.home, Date.now()), url);
        before = toNum((await relay(w).balance(w.party)).cc);
        // THE PER-TX CAP HAS TO REACH THE ONE PLACE THAT KNOWS THE AMOUNT.
        //
        // `pay` cannot pre-check the charge the way `withdraw` does — the
        // amount only exists once the merchant answers 402. So --max-per-tx was
        // enforced on withdraw and silently ignored here, and the daily cap
        // only ever blocked STARTING a payment once already exhausted: a single
        // over-quoting merchant could take the whole wallet in one call and
        // still be inside policy. The signer already implements exactly this
        // ceiling (relay-signer enforceSpendLimits, fail-closed before any
        // relay call, and used by pay-proxy); it was simply never handed the
        // number. Same unit on both sides: CC, as the 402 quotes it.
        const payingFetch = await makePayingFetch({
          relayUrl: w.relayUrl,
          network: w.network,
          apiKey,
          ...(config.policy.maxPerTx !== undefined
            ? { maxPaymentValue: String(config.policy.maxPerTx) }
            : {}),
        });
        let res;
        try {
          res = await payingFetch(url, {
            ...(method ? { method } : {}),
            ...(headers ? { headers } : {}),
            ...(reqBody !== undefined ? { body: reqBody } : {}),
          }); // EXACTLY ONCE — no outer retry (double-pay risk)
        } catch (payErr) {
          await recordWhatLeft();
          throw payErr;
        }
        await recordWhatLeft();
        const after = before - spent;
        const updateId = updateIdFromResponse(res);
        const verify = updateId ? await lighthouseVerify(updateId) : null;
        const body = await res.text().catch(() => "");
        const verifyLine = verify
          ? verify.ok
            ? ` verified (accepted/${verify.send})`
            : ` WARNING unverified (verdict=${verify.verdict ?? "?"}, send=${verify.send ?? "?"}) — check balance`
          : "";
        return text(
          `HTTP ${res.status}; spent ${spent.toFixed(10)} CC; balance ${after.toFixed(10)} CC` +
            (updateId ? `; updateId ${updateId}` : "") +
            verifyLine +
            `\n--- response body ---\n${body.slice(0, 4000)}`
        );
      } catch (err) {
        // FUNDS MAY ALREADY HAVE MOVED, AND THE AGENT IS THE ONE WHO DECIDES
        // WHETHER TO RETRY.
        //
        // `recordWhatLeft` above measured the balance delta — it has to, or the
        // daily cap could never fire. But the number was then discarded here,
        // so "the merchant never got paid, retry" and "you paid and got
        // nothing, do NOT retry" reached the caller as the same sentence. A
        // human might check; an agent retries, and pays twice.
        //
        // Still `isError`: the call DID fail. Dressing it as success would be a
        // worse lie than the one this fixes.
        const base = toolError("pay", err);
        if (spent > 0) {
          const warn =
            `WARNING: the wallet balance fell by ${spent.toFixed(10)} CC during ` +
            `this call — funds MOVED. Do NOT call pay again for this request; ` +
            `confirm with get_balance and check whether the merchant delivered.`;
          return {
            ...base,
            content: [{ type: "text" as const, text: warn }, ...base.content],
          };
        }
        return base;
      }
    }
  );

  server.registerTool(
    "withdraw",
    {
      title: "Withdraw CC to another party",
      description:
        "MOVES FUNDS OUT. Send CC from this wallet to another Canton party. Bounded by the spend policy. If a per-tx cap is set, an explicit amount is required (no silent full-balance sweep).",
      inputSchema: {
        to: z.string().describe("Recipient Canton party id"),
        amount: z.string().optional().describe("CC amount; omit to send the full balance (rejected if a per-tx cap is set)"),
      },
      annotations: { title: "Withdraw (moves funds OUT)", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ to, amount }) => {
      try {
        const w = await getWallet();
        // Resolve the effective amount up front so caps apply to the REAL number.
        let effective: number;
        if (amount && amount.trim()) {
          effective = toNum(amount);
        } else if (config.policy.maxPerTx !== undefined) {
          return errText(
            "withdraw blocked: a per-tx cap is set, so an explicit amount is required (refusing a full-balance sweep)."
          );
        } else {
          effective = toNum((await relay(w).balance(w.party)).cc);
        }
        assertWithdrawAllowed(config.policy, readLedger(config.home, Date.now()), effective);
        const wopts: { to: string; amount?: string; apiKey?: string } = { to };
        const amt = amount?.trim();
        if (amt) wopts.amount = amt;
        if (apiKey) wopts.apiKey = apiKey;
        const r = await withdraw(wopts);
        recordOutbound(config.home, toNum(r.amount), Date.now());
        const verify = await lighthouseVerify(r.updateId);
        return text(
          `withdrew ${r.amount} CC to ${to}; updateId ${r.updateId}` +
            (verify ? (verify.ok ? ` (verified)` : ` (WARNING unverified: ${verify.verdict}/${verify.send})`) : "")
        );
      } catch (err) {
        return toolError("withdraw", err);
      }
    }
  );

  return server;
}
