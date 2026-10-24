/**
 * The wallet tools, registered on any McpServer. Everything a tool needs is
 * injected, so the same seven tools serve both the local stdio server (one
 * wallet on disk in the owner's home) and the hosted remote server (one wallet
 * per signed-in user, keys held server-side). A tool body cannot reach for a
 * home directory, a global wallet or a file ledger on its own; that is what
 * lets one copy of the money logic serve both.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  claimAll,
  classifyPending,
  withdraw,
  executeSwap,
  resolveSwapIntent,
  resolveSwapTicket,
  swapFloorNotes,
  parseSwapVenue,
  parseSlippagePct,
  resolveTrustedDsoParty,
  SWAP_MAX_FEE_CC,
  KNOWN_INSTRUMENTS,
  type AgentWallet,
  type RelayClient,
} from "@ftptech/canton-agent-wallet";
import type { SpendPolicy } from "./config.js";
import {
  PolicyError,
  assertPayAllowed,
  assertWithdrawAllowed,
  assertSwapAllowed,
  payValueCeiling,
  type PolicyLedgerStore,
  type OperationRecord,
} from "./policy.js";

/** What the tools act on. */
export interface WalletToolDeps {
  /** The wallet the tools act on. The local server creates it on first use. */
  getWallet(): Promise<AgentWallet>;
  /** A relay client for that wallet. */
  relayFor(w: AgentWallet): RelayClient;
  /** An x402 paying fetch bound to that wallet, capped by the options. */
  payingFetchFor(
    w: AgentWallet,
    opts: { maxPaymentValue?: string; expectedPayTo?: string }
  ): Promise<typeof globalThis.fetch>;
  apiKey?: string | undefined;
  policy: SpendPolicy;
  ledger: PolicyLedgerStore;
  /**
   * Runs one money move (pay, withdraw, swap) at a time for this wallet. The
   * policy gate reads the ledger, the money moves, and only then is the spend
   * recorded; two moves running together would both pass the gate on the same
   * reading and together exceed the daily cap. The hosted server passes a
   * per-user queue here; the local server serializes through its pay lock.
   */
  serialize?: <T>(fn: () => Promise<T>) => Promise<T>;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const errText = (s: string) => ({
  content: [{ type: "text" as const, text: s }],
  isError: true,
});

/** A CC amount as a plain decimal string with at most 10 places (the ledger's
 *  precision), rounded DOWN so a ceiling never grows by rounding. */
const decimal10 = (cc: number): string => {
  const s = (Math.floor(cc * 1e10) / 1e10).toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return s === "" ? "0" : s;
};

const toNum = (cc: string): number => {
  const n = Number(cc);
  return Number.isFinite(n) ? n : 0;
};

/** Map a thrown wallet/relay error to a clean tool error (never leak key bytes,
 *  never throw out of a handler — return isError instead). */
function toolError(where: string, err: unknown): ReturnType<typeof errText> {
  if (err instanceof PolicyError) return errText(`blocked by spend policy: ${err.message}`);
  const msg = err instanceof Error ? err.message : String(err);
  const cause =
    err instanceof Error && err.cause instanceof Error && err.cause.message !== msg
      ? ` (${err.cause.message})`
      : "";
  return errText(`${where} failed: ${msg}${cause}`);
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

export function registerWalletTools(server: McpServer, deps: WalletToolDeps): void {
  const { getWallet, relayFor, payingFetchFor, apiKey, policy, ledger } = deps;
  const serialize = deps.serialize ?? (<T,>(fn: () => Promise<T>): Promise<T> => fn());
  const recordOp = async (op: OperationRecord): Promise<void> => {
    try {
      await ledger.recordOperation?.(op, Date.now());
    } catch {
      // History is for the owner; it never fails the move it describes.
    }
  };

  // ── read-only (auto-allow) ────────────────────────────────────────────────
  server.registerTool(
    "get_address",
    {
      title: "Get wallet address",
      description:
        "Return this agent's Canton party id (its wallet address). Creates the wallet on first use, which accepts the Terms of Service (https://ftp-tech.mintlify.site/terms). Read-only.",
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
        const b = await relayFor(w).balance(w.party);
        // Incoming transfers are not balance until accepted; say they are
        // there, or an agent reads 0 while a transfer sits waiting for `claim`.
        // Only what `claim` would accept: an expired offer or a token with no
        // trust anchor here would keep the hint up and send the agent back and
        // forth between get_balance and a claim that skips it.
        let incoming = "";
        try {
          const { pending } = await relayFor(w).pending(w.party);
          const trustedDso = resolveTrustedDsoParty(process.env, w.network);
          const now = Date.now();
          const live = pending.filter(
            (p) => classifyPending(p, trustedDso, now).kind === "claimable"
          ).length;
          if (live > 0) {
            incoming = `; ${live} incoming transfer${live === 1 ? "" : "s"} waiting — call \`claim\` to accept`;
          }
        } catch {
          /* best-effort: the balance above stands on its own */
        }
        return text(
          `${b.cc} CC (${b.amulet} amulet${b.amulet === 1 ? "" : "s"}) for ${w.party}${incoming}`
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
        const r = await claimAll(relayFor(w), w);
        // Raise the funded ceiling to the post-claim high-water (balance + what
        // has already gone out) so the agent may spend up to what was funded in.
        const bal = await relayFor(w).balance(w.party);
        const led = (await ledger.read(Date.now()));
        await ledger.recordClaimedHighWater(toNum(bal.cc) + led.lifetimeOutCC, Date.now());
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
        if (r.claimed > 0) await recordOp({ kind: "claim", detail: `${r.claimed} incoming transfer(s)`, ok: true });
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
    async ({ url, method, headers, body: reqBody }) => serialize(async () => {
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
          const now = toNum((await relayFor(w).balance(w.party)).cc);
          spent = Math.max(0, before - now);
          if (spent > 0) await ledger.recordOutbound(spent, Date.now());
        } catch {
          // The balance read itself failed. Nothing to record honestly, and
          // throwing here would replace the caller's real error with ours.
        }
      };
      try {
        w = await getWallet();
        const led = await ledger.read(Date.now());
        assertPayAllowed(policy, led, url);
        before = toNum((await relayFor(w).balance(w.party)).cc);
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
        //
        // And not only the per-tx cap: the rest of today's budget and of the
        // funded ceiling too, whichever is smallest. The gate above can only
        // refuse a payment once the cap is ALREADY spent, so with 19.9 of 20 CC
        // spent a 5 CC payment used to go through and leave the day at 24.9.
        const ceiling = payValueCeiling(policy, led);
        const payingFetch = await payingFetchFor(
          w,
          ceiling === undefined
            ? {}
            : { maxPaymentValue: ceiling === policy.maxPerTx ? String(policy.maxPerTx) : decimal10(ceiling) }
        );
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
        await recordOp({ kind: "pay", amountCC: spent, detail: `${new URL(url).host} (HTTP ${res.status})`, updateId, ok: res.ok });
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
          await recordOp({ kind: "pay", amountCC: spent, detail: `${url} (failed after paying)`, ok: false });
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
    })
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
    async ({ to, amount }) => serialize(async () => {
      try {
        const w = await getWallet();
        // Resolve the effective amount up front so caps apply to the REAL number.
        let effective: number;
        if (amount && amount.trim()) {
          effective = toNum(amount);
        } else if (policy.maxPerTx !== undefined) {
          return errText(
            "withdraw blocked: a per-tx cap is set, so an explicit amount is required (refusing a full-balance sweep)."
          );
        } else {
          effective = toNum((await relayFor(w).balance(w.party)).cc);
        }
        assertWithdrawAllowed(policy, (await ledger.read(Date.now())), effective, to);
        const wopts: { to: string; amount?: string; apiKey?: string } = { to };
        const amt = amount?.trim();
        if (amt) wopts.amount = amt;
        if (apiKey) wopts.apiKey = apiKey;
        const r = await withdraw({ ...wopts, wallet: w, relay: relayFor(w) });
        await ledger.recordOutbound(toNum(r.amount), Date.now());
        await recordOp({ kind: "withdraw", amountCC: toNum(r.amount), detail: `to ${to}`, updateId: r.updateId, ok: true });
        const verify = await lighthouseVerify(r.updateId);
        return text(
          `withdrew ${r.amount} CC to ${to}; updateId ${r.updateId}` +
            (verify ? (verify.ok ? ` (verified)` : ` (WARNING unverified: ${verify.verdict}/${verify.send})`) : "")
        );
      } catch (err) {
        return toolError("withdraw", err);
      }
    })
  );

  server.registerTool(
    "swap",
    {
      title: "Swap CC and tokens on a venue",
      description:
        "MOVES FUNDS OUT to a swap venue and brings the counter-asset back. Swaps `amount` of `in` for `out` — Canton Coin (CC) or a known token (" +
        Object.keys(KNOWN_INSTRUMENTS).join(", ") +
        ") — on Cantex Connect (default; 50 CC minimum; fills at ITS rate when it executes, there is no on-ledger floor) or the Tradecraft AMM (venue `tradecraft`; enforces the slippage floor when a memo key is configured), or `auto` (compares free quotes, takes the better output). " +
        "The input only ever goes to the pinned venue parties, never to an address from a quote. Bounded by the spend policy: a CC input is checked against the per-tx cap, daily cap and funded ceiling BEFORE anything moves; a token input against the per-tx cap, using the venue's quoted CC value. " +
        "The ticket normally comes from the x402 swap endpoint for a small CC fee (0.01 CC live, capped at " +
        SWAP_MAX_FEE_CC +
        "); `direct: true` quotes the venue itself for free. " +
        "Waits until the output lands (up to ~2 minutes; that is normal). Call it ONCE per swap — never retry on a timeout or error without checking get_balance first: the input may already have been sent.",
      inputSchema: {
        in: z.string().describe("Symbol to sell: CC or a known token (" + Object.keys(KNOWN_INSTRUMENTS).join(", ") + ")"),
        out: z.string().describe("Symbol to buy (same set)"),
        amount: z.string().describe('Amount of `in` to swap, as a decimal string, e.g. "60"'),
        venue: z
          .enum(["cantex", "tradecraft", "auto"])
          .optional()
          .describe(
            "Venue. Default cantex; when NOT named, a CC input under 50 CC or a Cantex quote failure routes to tradecraft. Named explicitly, those are errors instead."
          ),
        slippage: z
          .number()
          .optional()
          .describe(
            "Slippage percent (default 1). Tradecraft: the on-ledger floor. Cantex: only the delivery threshold this tool reports against."
          ),
        direct: z
          .boolean()
          .optional()
          .describe("Quote the venue directly (free) instead of the x402 swap endpoint (small fee)"),
        wait: z
          .boolean()
          .optional()
          .describe(
            "Wait for the output to land (default true). false returns as soon as the input is sent; then call `claim` / get_balance later."
          ),
      },
      annotations: { title: "Swap (moves funds OUT)", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ in: inSym, out: outSym, amount, venue, slippage, direct, wait }) => serialize(async () => {
      // Two things can leave the wallet here, at two different moments: the
      // ticket FEE (a real x402 payment to the swap endpoint, before any ticket
      // is validated) and the swap INPUT (sent to the venue). Both are gated
      // before they move and recorded right after, separately — a swap that
      // pays the fee and then fails to send still cost the fee, and the ledger
      // must say so.
      let w: AgentWallet | undefined;
      let ccBefore: number | undefined;
      let sentUpdateId: string | undefined;
      try {
        w = await getWallet();
        const intent = resolveSwapIntent(inSym, outSym);
        const slippagePct = parseSlippagePct(slippage);
        const venueChoice = parseSwapVenue(venue);
        const amountNum = toNum(amount);
        if (!(amountNum > 0)) {
          return errText(`swap: amount must be a positive number (got ${JSON.stringify(amount)})`);
        }
        const inputIsCC = intent.inInstrument === null;
        const outputIsCC = intent.outInstrument === null;
        const inLabel = intent.inCanon;
        const outLabel = intent.outCanon;

        // POLICY, CC INPUT: the amount is known now, so the full gate runs here,
        // before the fee (itself a payment) and before any quote.
        if (inputIsCC) {
          assertSwapAllowed(policy, (await ledger.read(Date.now())), {
            ccValue: amountNum,
            inputIsCC: true,
          });
        }
        ccBefore = toNum((await relayFor(w).balance(w.party)).cc);

        // The fee ceiling never exceeds the per-tx cap: the endpoint auto-settles
        // whatever 402 it answers, and the signer's maxPaymentValue is the only
        // thing standing between a hijacked endpoint and the balance.
        const feeCap =
          policy.maxPerTx !== undefined && policy.maxPerTx < Number(SWAP_MAX_FEE_CC)
            ? String(policy.maxPerTx)
            : SWAP_MAX_FEE_CC;
        const swapMerchant = process.env.CANTON_AGENT_SWAP_MERCHANT;
        const wallet = w;
        const { ticket, notes } = await resolveSwapTicket({
          intent,
          amount,
          slippagePct,
          venue: venueChoice,
          venueExplicit: venue !== undefined,
          direct: direct === true,
          dsoParty: resolveTrustedDsoParty(process.env, wallet.network),
          payingFetch: () =>
            payingFetchFor(wallet, {
              maxPaymentValue: feeCap,
              ...(swapMerchant ? { expectedPayTo: swapMerchant } : {}),
            }),
        });
        // Whatever the quote cost is already gone: record it now, not after the
        // send, so a swap that fails between here and the send still books it.
        const ccAfterTicket = toNum((await relayFor(w).balance(w.party)).cc);
        const fee = Math.max(0, ccBefore - ccAfterTicket);
        if (fee > 0) await ledger.recordOutbound(fee, Date.now());

        // POLICY, TOKEN INPUT: the CC figure only exists once the venue has
        // quoted. NaN when neither leg is CC — the gate decides what that means.
        if (!inputIsCC) {
          assertSwapAllowed(policy, (await ledger.read(Date.now())), {
            ccValue: outputIsCC ? Number(ticket.quote) : NaN,
            inputIsCC: false,
          });
        }

        const waiting = wait !== false;
        const sr = await executeSwap({
          amount,
          ticket,
          apiKey,
          waitForOutput: waiting,
          wallet: w,
          relay: relayFor(w),
        });
        sentUpdateId = sr.sentUpdateId;
        if (inputIsCC) await ledger.recordOutbound(amountNum, Date.now());

        const bal = toNum((await relayFor(w).balance(w.party)).cc);
        // A CC input the venue would not fill (Tradecraft, below its minimum)
        // comes BACK as CC — directly, when this wallet holds a CC preapproval.
        // executeSwap watches for that from its second tick; the end-balance
        // check here also catches a return that landed after the window (or a
        // first-tick return the loop deliberately does not trust). Seen live on
        // MainNet: 0.2 CC to the CC/USDCx pool, back within the window.
        const inputReturned =
          sr.inputReturned ||
          (inputIsCC &&
            sr.delivered === undefined &&
            bal >= ccAfterTicket - amountNum + amountNum * 0.99);
        if ((outputIsCC && sr.delivered !== undefined) || inputReturned) {
          // CC came IN — the venue's output, or the input handed back. Funding
          // for the ceiling's purposes: the same high-water `claim` sets. The
          // outbound entry stays (it did leave); the daily counter keeps it,
          // conservatively.
          const led = (await ledger.read(Date.now()));
          await ledger.recordClaimedHighWater(bal + led.lifetimeOutCC, Date.now());
        }

        const lines: string[] = [];
        lines.push(
          `swap ${amount} ${inLabel} -> ${outLabel} on ${ticket.venue}: input sent, updateId ${sr.sentUpdateId}`
        );
        if (!waiting) {
          lines.push(
            `not waiting for the return — call \`claim\` shortly (or check get_balance) to pick up the ${outLabel}`
          );
        } else if (sr.delivered !== undefined) {
          lines.push(`received ${sr.delivered} ${outLabel}`);
        } else if (inputReturned) {
          lines.push(
            `the input was RETURNED — nothing was swapped: the CC balance is back at ${bal.toFixed(10)} CC ` +
              `(the venue hands back a trade it will not fill, e.g. below its minimum). ` +
              `Only the ticket fee was spent.`
          );
        } else {
          lines.push(
            `${outLabel} NOT received yet — it may still be settling (call \`claim\` / get_balance in a minute), ` +
              `or the trade was below the venue minimum and the input was returned. Do NOT swap again before checking.` +
              (sr.partialRise !== undefined
                ? ` ${outLabel} balance rose ${sr.partialRise}, below the ticket minimum ${ticket.minOutput} — possibly an unrelated inbound, not this swap's fill.`
                : "") +
              (sr.claimed > 0
                ? ` Claimed ${sr.claimed} incoming transfer(s): ${sr.claimedUpdateIds.join(", ")}.`
                : "") +
              (sr.pollErrors > 0
                ? ` ${sr.pollErrors} poll error(s) while waiting — the relay was flaky, but the input WAS sent.`
                : "")
          );
        }
        lines.push(`quote ~${ticket.quote} ${outLabel} (venue party ${ticket.poolParty})`);
        for (const n of [...notes, ...swapFloorNotes(ticket, slippagePct, outLabel)]) {
          lines.push(n.level === "warn" ? `! ${n.text}` : n.text);
        }
        lines.push(
          fee > 0 ? `ticket fee ${fee.toFixed(10)} CC (swap endpoint)` : "ticket fee 0 CC"
        );
        lines.push(`balance now ${bal.toFixed(10)} CC`);
        await recordOp({
          kind: "swap",
          ...(inputIsCC ? { amountCC: amountNum } : {}),
          detail: `${amount} ${inLabel} -> ${outLabel} on ${ticket.venue}`,
          updateId: sr.sentUpdateId,
          ok: true,
        });
        return text(lines.join("\n"));
      } catch (err) {
        // The agent decides whether to retry, so it must know what already
        // moved. Once the input is sent nothing here throws (executeSwap's wait
        // is best-effort), so an error with `sentUpdateId` set is rare — but a
        // lost relay response on the send itself can still leave funds moved
        // with no updateId in hand; the balance delta is the honest tell.
        const base = toolError("swap", err);
        let warn = "";
        if (sentUpdateId) {
          warn =
            `WARNING: the swap input WAS sent (updateId ${sentUpdateId}) before this error. ` +
            `Do NOT call swap again for it; call \`claim\` and get_balance to see what arrived.`;
        } else if (w && ccBefore !== undefined) {
          try {
            const now = toNum((await relayFor(w).balance(w.party)).cc);
            const dropped = Math.max(0, ccBefore - now);
            if (dropped > 0) {
              warn =
                `WARNING: the wallet's CC balance fell by ${dropped.toFixed(10)} CC during this call — ` +
                `funds MOVED (the ticket fee, or the swap input). Check get_balance and \`claim\` before calling swap again.`;
            }
          } catch {
            // A failed balance read is no reason to hide the real error.
          }
        }
        return warn
          ? { ...base, content: [{ type: "text" as const, text: warn }, ...base.content] }
          : base;
      }
    })
  );

}
