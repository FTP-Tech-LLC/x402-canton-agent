/**
 * Quest-funded bootstrap client.
 *
 * WHY this exists: a bare public faucet that hands free CC to any fresh party is
 * farmable — a bot mints parties in a loop and drains it. So the raw facilitator
 * faucet is locked to the pay-proxy, and the ONLY way to get CC out of it is the
 * pay-proxy's quest flow, which binds the grant to a REAL x402 payment: it mints a
 * wallet, faucets it, immediately spends the bulk on a CanTrust image call, and
 * leaves the small change. An abuser therefore cannot extract the full grant — to
 * get the change they must make (and pay for) a real on-ledger transaction, which
 * is exactly the work we want, not free money.
 *
 * `auto_fund` uses this instead of a bare faucet: it runs the quest, then imports
 * the returned wallet key so the agent SELF-CUSTODIES the funded wallet (it holds
 * the private key afterwards; the pay-proxy holds nothing). The agent ends with a
 * funded wallet + a made image, having spent no human effort.
 *
 * The flow is the pay-proxy 2-step (both async POST→poll, because each leg has a
 * multi-second on-ledger tail):
 *   STEP 1  POST /v1/quest/wallet/create           → 202 { walletJobId }
 *           GET  /v1/quest/wallet/result?walletJobId → funded { secret, walletToken }
 *   STEP 2  POST /v1/quest/wallet/pay { walletToken } → 202 { payJobId }
 *           GET  /v1/quest/wallet/pay-result?payJobId → done { updateId, image, balanceCc }
 */
import { agentKeyFromPrivatePem } from "./keys.js";
import { ensureWallet } from "./onboard.js";
import { loadWallet, saveWallet, walletDir, type AgentWallet } from "./store.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RelayClient } from "./relay-client.js";

/** The funded-wallet result: the SECRET (PKCS8 PEM — imported so the agent
 *  self-custodies), the party, the post-pay change balance, the on-ledger
 *  updateId of the transa, and the image URL the CanTrust call produced. */
export interface QuestFundResult {
  secret: string;
  party: string;
  network: string;
  balanceCc: string | undefined;
  updateId: string | undefined;
  image: string | undefined;
}

export interface QuestFundOpts {
  /** pay-proxy base URL (e.g. https://pay.ftptech.xyz). */
  payProxyUrl: string;
  /** Optional prompt for the CanTrust image; defaults server-side if omitted. */
  prompt?: string | undefined;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Poll interval ms (default 3000). */
  pollMs?: number;
  /** Max total polls per step before giving up (default 40 ≈ 2 min/step). */
  maxPolls?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** A quest leg failed or the flow could not complete. `auto_fund` catches this
 *  and falls back to the manual-funding ask, so a pay-proxy hiccup never turns
 *  into a hard tool error. */
/**
 * `recoverable` is set when the quest failed AFTER step 1 handed us a real
 * party and its private key. Losing that key loses custody of whatever the
 * faucet already put on that party — the throw used to discard it, and the CLI
 * then told the operator to ask their owner for CC while the grant sat on a
 * party nobody could act as any more.
 */
export class QuestFundError extends Error {
  /**
   * NON-ENUMERABLE ON PURPOSE, AND THIS IS THE WHOLE POINT.
   *
   * `recoverable.secret` is a raw PKCS8 private key with real MainNet CC behind
   * it. Assigned as an ordinary property it becomes an enumerable own property
   * of a thrown Error, and this class is exported from the package index — so
   * every ordinary way a consumer records a failure copies the key out:
   * `JSON.stringify(err)` includes it, and pino's default `err` serializer
   * copies own enumerable properties, so a plain `logger.error({ err })` in a
   * third-party service writes the key into that service's log pipeline.
   * Measured, not assumed: both leak it.
   *
   * `declare` is required, not stylistic — the workspace compiles with
   * `useDefineForClassFields: true`, so a plain field declaration would emit a
   * defineProperty that overwrites the descriptor below with an enumerable
   * `undefined` and silently undo the fix.
   *
   * The rescue path is unaffected: both readers
   * (quest-fund.ts `err.recoverable`, mcp/server.ts `e.recoverable`) ask for
   * the property by name, and non-enumerable properties answer that normally.
   * Hidden from anything that ENUMERATES, present for anything that ASKS.
   */
  declare readonly recoverable?: { secret: string; party: string; network: string };
  constructor(
    message: string,
    recoverable?: { secret: string; party: string; network: string }
  ) {
    super(message);
    this.name = "QuestFundError";
    if (recoverable) {
      Object.defineProperty(this, "recoverable", {
        value: recoverable,
        enumerable: false,
        writable: false,
        configurable: false,
      });
    }
  }
}

/**
 * The parsed body, or undefined when the answer was not a readable JSON result.
 *
 * The distinction is the point. A reverse proxy in front of the pay-proxy
 * answers a restart or an upstream hiccup with a 502/504 HTML page, and a
 * rate-limiter answers 429 — none of which is the job telling us anything. The
 * old version flattened all of it to `{}`, which matched neither "pending" nor
 * the terminal status, so a poll that could not be read was reported as "the
 * quest failed" on the very first blip, with 39 polls of budget still unused.
 * The two POSTs in this file check `status !== 202` correctly; the rule was
 * simply dropped on the reads that decide the outcome.
 */
async function jsonOf(r: Response): Promise<Record<string, unknown> | undefined> {
  if (!r.ok) return undefined;
  const text = await r.text();
  try {
    return (JSON.parse(text) as Record<string, unknown>) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run the pay-proxy quest and return a funded wallet (key + change + image).
 * Throws QuestFundError on any refusal / timeout — never a partial state.
 */
export async function questFund(opts: QuestFundOpts): Promise<QuestFundResult> {
  const base = opts.payProxyUrl.replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const pollMs = opts.pollMs ?? 3000;
  const maxPolls = opts.maxPolls ?? 40;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // --- STEP 1: create ---
  const createRes = await doFetch(`${base}/v1/quest/wallet/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (createRes.status !== 202) {
    throw new QuestFundError(
      `quest create returned ${createRes.status} (expected 202)`
    );
  }
  const walletJobId = (await jsonOf(createRes))?.walletJobId;
  if (typeof walletJobId !== "string" || !walletJobId) {
    throw new QuestFundError("quest create returned no walletJobId");
  }

  // --- STEP 1 poll: result ---
  let funded: Record<string, unknown> | undefined;
  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollMs);
    const r = await doFetch(
      `${base}/v1/quest/wallet/result?walletJobId=${encodeURIComponent(walletJobId)}`
    );
    const body = await jsonOf(r);
    // Unreadable answer: not a verdict. Keep polling with the budget we have.
    if (!body) continue;
    if (body.status === "pending") continue;
    if (body.status === "funded") {
      funded = body;
      break;
    }
    throw new QuestFundError(
      `quest STEP 1 failed: ${String(body.error ?? body.status ?? "unknown")}`
    );
  }
  if (!funded) throw new QuestFundError("quest STEP 1 timed out");
  const secret = funded.secret;
  const walletToken = funded.walletToken;
  const party = funded.party;
  const network = funded.network;
  if (
    typeof secret !== "string" ||
    typeof walletToken !== "string" ||
    typeof party !== "string"
  ) {
    throw new QuestFundError("quest STEP 1 returned an incomplete funded body");
  }

  // --- STEP 2: pay (faucet + CanTrust image + change, on the minted wallet) ---
  const payRes = await doFetch(`${base}/v1/quest/wallet/pay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      walletToken,
      ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
    }),
  });
  if (payRes.status !== 202) {
    throw new QuestFundError(
      `quest pay returned ${payRes.status} (expected 202)`
    );
  }
  const payJobId = (await jsonOf(payRes))?.payJobId;
  if (typeof payJobId !== "string" || !payJobId) {
    throw new QuestFundError("quest pay returned no payJobId");
  }

  // --- STEP 2 poll: pay-result ---
  let done: Record<string, unknown> | undefined;
  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollMs);
    const r = await doFetch(
      `${base}/v1/quest/wallet/pay-result?payJobId=${encodeURIComponent(payJobId)}`
    );
    const body = await jsonOf(r);
    if (!body) continue;
    if (body.status === "pending") continue;
    if (body.status === "done") {
      done = body;
      break;
    }
    throw new QuestFundError(
      `quest STEP 2 failed: ${String(body.error ?? body.status ?? "unknown")}`,
      { secret, party, network: typeof network === "string" ? network : "canton:mainnet" }
    );
  }
  if (!done) {
    throw new QuestFundError("quest STEP 2 timed out", {
      secret,
      party,
      network: typeof network === "string" ? network : "canton:mainnet",
    });
  }

  return {
    secret,
    party,
    network: typeof network === "string" ? network : "canton:mainnet",
    balanceCc: typeof done.balanceCc === "string" ? done.balanceCc : undefined,
    updateId: typeof done.updateId === "string" ? done.updateId : undefined,
    image: typeof done.image === "string" ? done.image : undefined,
  };
}

/**
 * Persist a key rescued from a failed quest, beside the wallet but never AS the
 * wallet.
 *
 * EXPORTED because the MCP server runs the same quest through the lower-level
 * `questFund` and needs the same rescue. It had none: the only copy of the
 * private key rode away inside the thrown Error and was collected, leaving
 * faucet CC on a MainNet party nobody can spend. One rescue, one place. Overwriting wallet.json here would destroy the private key of an
 * existing wallet on an error path — the exact loss this rescue exists to
 * prevent, aimed at the other wallet. The party goes in the filename so two
 * rescues cannot silently overwrite each other.
 */
export function writeRescueKey(secret: string, party: string, _network: string): string {
  const d = walletDir();
  mkdirSync(d, { recursive: true, mode: 0o700 });
  const safe = party.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  const p = join(d, `rescued-key-${safe}.pem`);
  writeFileSync(p, secret.endsWith("\n") ? secret : secret + "\n", { mode: 0o600 });
  return p;
}

export interface FundViaQuestOpts {
  /** pay-proxy base URL used to run the quest. */
  payProxyUrl: string;
  /** The facilitator relay URL to persist on the imported wallet (its home for
   *  future balance/pay/withdraw). */
  relayUrl: string;
  /** Optional image prompt. */
  prompt?: string | undefined;
  /** Injectables (tests). */
  questFundImpl?: typeof questFund;
  fetchImpl?: typeof fetch;
  /** Injectable wallet-store seams (tests) — default to the real store/onboard. */
  loadWalletImpl?: () => AgentWallet | undefined;
  balanceOf?: (relayUrl: string, party: string) => Promise<string>;
  /** Unaccepted incoming transfers addressed to the party. Separate from the
   *  balance because the relay's /balance counts Amulet contracts only, and a
   *  transfer nobody has accepted yet is not one. */
  pendingOf?: (
    relayUrl: string,
    party: string
  ) => Promise<Array<{ cid: string; amount?: string; sender?: string }>>;
  installKey?: (
    secret: string,
    relayUrl: string,
    network: string
  ) => Promise<AgentWallet>;
  /** Where a key rescued from a failed quest is written. Returns the path it
   *  wrote, which the thrown error names. Defaults to a 0600 file beside the
   *  wallet — NEVER wallet.json itself, so a rescue can destroy nothing. */
  rescueKeyImpl?: (secret: string, party: string, network: string) => string;
}

/** Outcome of `fundViaQuest`: either a freshly-installed funded wallet, or a
 *  "kept" note (an already-funded wallet was left untouched). */
export type FundViaQuestResult =
  | {
      kind: "funded";
      wallet: AgentWallet;
      balanceCc: string | undefined;
      updateId: string | undefined;
      image: string | undefined;
    }
  | { kind: "already_funded"; party: string; balanceCc: string };

/**
 * Bootstrap a funded self-custody wallet through the quest (mint → grant →
 * CanTrust payment → change) and INSTALL it (`saveWallet`) so the caller owns the
 * key. This is the ONLY non-farmable funding path: the grant is inseparable from a
 * real payment, so an abuser gets only the small change, not free CC.
 *
 * NO-CLOBBER: if a wallet already exists AND holds a balance, it is NEVER replaced
 * — the existing wallet is returned as `already_funded`. Only an absent or empty
 * wallet home is bootstrapped. Throws QuestFundError on quest failure (the caller
 * decides the fallback, e.g. manual funding).
 */
export async function fundViaQuest(
  opts: FundViaQuestOpts
): Promise<FundViaQuestResult> {
  const load = opts.loadWalletImpl ?? loadWallet;
  const balanceOf =
    opts.balanceOf ??
    (async (relayUrl: string, party: string) =>
      (await new RelayClient({ relayUrl }).balance(party)).cc);
  const pendingOf =
    opts.pendingOf ??
    (async (relayUrl: string, party: string) =>
      (await new RelayClient({ relayUrl }).pending(party)).pending);

  const existing = load();
  if (existing) {
    // UNREADABLE IS NOT EMPTY.
    //
    // The guard below is the only thing standing between an existing wallet
    // and `saveWallet` overwriting it — and overwriting wallet.json destroys
    // the private key, which is the one thing here that cannot be undone. The
    // old code caught the balance read into `cc = "0"` and commented that as
    // "treat as empty and proceed to bootstrap": a relay blip, a DNS hiccup or
    // any 5xx therefore looked exactly like an empty wallet, and the key of a
    // wallet holding real CC was replaced.
    //
    // A wallet is only ever replaced when we KNOW it is empty. If the balance
    // cannot be read we refuse and say so; the caller retries when the relay
    // is back, and nothing was lost in the meantime.
    let cc: string;
    try {
      cc = await balanceOf(opts.relayUrl, existing.party);
    } catch (err) {
      throw new QuestFundError(
        `a wallet already exists (${existing.party}) but its balance could not ` +
          `be read (${err instanceof Error ? err.message : String(err)}) — ` +
          `refusing to overwrite it, because an unreadable balance is not an ` +
          `empty one and replacing the wallet would destroy its private key. ` +
          `Retry once the relay is reachable.`
      );
    }
    if (Number(cc) > 0) {
      return { kind: "already_funded", party: existing.party, balanceCc: cc };
    }

    // A BALANCE OF ZERO IS NOT PROOF OF AN EMPTY WALLET.
    //
    // The relay's /balance counts `Splice.Amulet:Amulet` contracts and nothing
    // else (facilitator routes/wallet.ts scopes the query to that template on
    // purpose). CC that someone has SENT to this party but that nobody has
    // accepted yet is not an Amulet — it is a pending TransferInstruction, and
    // it reads as 0.0000000000 here.
    //
    // That is the normal state of an agent wallet, not an exotic one: an agent
    // has no TransferPreapproval, which is precisely why a separate `claim`
    // step exists ("run after the owner has sent CC"). So the window between
    // "owner sent the funds" and "agent accepted them" is exactly the window in
    // which this guard called the wallet empty and `saveWallet` destroyed the
    // private key of the party those funds are addressed to. The CC stays on
    // the ledger, addressed to a party nobody can act as any more.
    //
    // Same rule as the balance read above, applied to the other half of the
    // question: unreadable is not empty, and neither is unclaimed.
    let pending: Array<{ cid: string; amount?: string }>;
    try {
      pending = await pendingOf(opts.relayUrl, existing.party);
    } catch (err) {
      throw new QuestFundError(
        `a wallet already exists (${existing.party}) and reads as empty, but ` +
          `its pending incoming transfers could not be read (${
            err instanceof Error ? err.message : String(err)
          }) — refusing to overwrite it, because a balance of zero only proves ` +
          `there are no ACCEPTED funds. Retry once the relay is reachable.`
      );
    }
    if (pending.length > 0) {
      const total = pending
        .reduce((sum, p) => sum + Number(p.amount ?? 0), 0)
        .toFixed(10);
      throw new QuestFundError(
        `a wallet already exists (${existing.party}) with ${pending.length} ` +
          `unaccepted incoming transfer(s) totalling ${total} CC — refusing to ` +
          `overwrite it, because replacing the wallet would destroy the private ` +
          `key those funds are addressed to and they could never be claimed. ` +
          `Run \`claim\` to accept them first.`
      );
    }
  }

  const runQuest = opts.questFundImpl ?? questFund;
  const rescueKey = opts.rescueKeyImpl ?? writeRescueKey;
  let funded: Awaited<ReturnType<typeof questFund>>;
  try {
    funded = await runQuest({
      payProxyUrl: opts.payProxyUrl,
      ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  } catch (err) {
    // A QUEST THAT FAILS PAST STEP 1 STILL LEFT US HOLDING A KEY.
    //
    // Step 2 is the leg that faucets, accepts and spends, so by the time it can
    // fail the party may already hold real CC. Letting the exception carry the
    // only copy of its private key away turned a recoverable interruption into
    // funds nobody can ever move. We write the key out and name the file in the
    // error — deliberately NOT into wallet.json, which may hold another wallet
    // whose own key must not be destroyed by an error path.
    const rec = err instanceof QuestFundError ? err.recoverable : undefined;
    if (!rec) throw err;
    let where: string;
    try {
      where = rescueKey(rec.secret, rec.party, rec.network);
    } catch (writeErr) {
      throw new QuestFundError(
        `${(err as Error).message} — and the funded party's key could NOT be ` +
          `written to disk (${
            writeErr instanceof Error ? writeErr.message : String(writeErr)
          }). Party ${rec.party} may hold CC that is now unreachable; capture ` +
          `the key from this process before it exits.`,
        rec
      );
    }
    throw new QuestFundError(
      `${(err as Error).message} — the funded party's key was saved to ${where}. ` +
        `Party ${rec.party} may already hold CC: run ` +
        `\`canton-agent-wallet import --key-file ${where}\` in an empty wallet ` +
        `home to take custody, then \`claim\`.`,
      rec
    );
  }

  const install =
    opts.installKey ??
    (async (secret: string, relayUrl: string, network: string) => {
      const key = agentKeyFromPrivatePem(secret);
      // ensureWallet is LOAD-FIRST: with a wallet already on disk it returns
      // THAT wallet and silently ignores `key` (the CLI `import` refuses
      // non-empty homes for exactly this reason). We only reach here after the
      // no-clobber check DECIDED to replace (absent or empty wallet), so skip
      // the store read with `ephemeral` and persist the imported key
      // explicitly — otherwise the funded key is dropped and the empty boot
      // wallet survives (found live: MCP auto_fund reported the funded party
      // while wallet.json still held the empty boot wallet).
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
  const wallet = await install(funded.secret, opts.relayUrl, funded.network);

  // FAIL LOUD, never lie: the installed wallet MUST be the funded party. Any
  // install path that keeps a different wallet (a load-first ensure, a stale
  // injected seam) would otherwise report success while the grant sits on a
  // party whose key was just dropped.
  if (wallet.party !== funded.party) {
    throw new QuestFundError(
      `installed wallet party ${wallet.party} is not the funded party ${funded.party} — ` +
        `the funded key was NOT persisted; refusing to report success`
    );
  }

  return {
    kind: "funded",
    wallet,
    balanceCc: funded.balanceCc,
    updateId: funded.updateId,
    image: funded.image,
  };
}
