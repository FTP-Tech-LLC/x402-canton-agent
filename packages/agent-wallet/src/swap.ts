/**
 * swap — a self-custody swap primitive over Tradecraft (an AMM DEX on Canton).
 * A Tradecraft swap is just an on-ledger transfer of the input token to a
 * per-pair pool party (`tc-swp_{IN}-{OUT}::<amm_cid>`); the pool sends the
 * counter-asset back within a minute or two, as a transfer OFFER when the output
 * is not pre-approved (which `claimAll` accepts) or DIRECTLY when it is.
 *
 * SAFETY MODEL (what actually holds):
 *  - The recipient is ALWAYS a pool party derived from a trusted `amm_cid`
 *    (config/constant), never a client- or 402-supplied address. This is the one
 *    unconditional guarantee.
 *  - Slippage protection is OPTIONAL: Tradecraft reads the minimum from the
 *    transfer's memo field, so it is attached only when a memo key is configured
 *    (`ticket.memoKey`, from CANTON_AGENT_TRADECRAFT_MEMO_KEY). With NO key the
 *    swap fills at MARKET price — the proven bare flow — and `swap` warns.
 *  - Output preapproval is ON by default (`--no-preapprove` opts out), because a
 *    Tradecraft pool delivers a registry output only to a PREAPPROVED receiver.
 *    Tradecraft's docs note the hazard that on a DIRECT settlement an
 *    un-preapproved output can be "consumed on fill with no funds returned",
 *    which is exactly what the auto-provisioned preapproval prevents. An
 *    unfilled trade returns
 *    the input either way.
 */
import { RelayClient } from "./relay-client.js";
import { withdraw } from "./withdraw.js";
import { selfProvisionRegistryPreapproval, claimAll } from "./tx.js";
import { resolveHashBinding } from "./hash-binding.js";
import { loadWallet, type AgentWallet } from "./store.js";
import type { HashBindingOptions } from "./verify-prepared.js";
import {
  sumLedgerDecimals,
  decimalToAtomicCC,
  atomicToDecimalCC,
} from "@ftptech/x402-canton-core";

/** A registry instrument, or `null` for native Canton Coin. */
export type SwapInstrument = { admin: string; id: string } | null;

/** Everything needed to execute one swap, resolved up front (locally, or by the
 *  facilitator /swap fee-ticket which knows the network's registrars). */
export interface SwapTicket {
  /** The pool party to send the input to: `tc-swp_{IN}-{OUT}::<amm_cid>`. */
  poolParty: string;
  /** Slippage-protected minimum output, as a ledger decimal string. Always
   *  computed for display; only ENFORCED when `memoKey` is set (see below). */
  minOutput: string;
  /** The transfer-meta key Tradecraft reads the minimum from ("the memo field").
   *  When set, the minimum is attached to the input transfer and the pool honors
   *  it (below-minimum → the trade fails and the input returns). When UNDEFINED,
   *  the swap executes at market price with no slippage protection — exactly the
   *  bare "send to the pool" flow, which works. Tradecraft's docs: the minimum is
   *  the first text in the memo field, a decimal with ≤10 places. */
  memoKey?: string;
  /** The raw quote (estimated output) that produced `minOutput`. */
  quote: string;
  /** The instrument being sent in (null = CC). */
  inInstrument: SwapInstrument;
  /** The instrument expected back (null = CC). */
  outInstrument: SwapInstrument;
}

const AMM_PAIR_SEP = "-";

/** Per-input-token advisory minimums, mirrored from the Tradecraft web app (there
 *  is NO API endpoint for these — they are a hardcoded frontend constant). A trade
 *  below the minimum is ADVISORY only: the pool safely returns the funds if it will
 *  not fill (no loss), and amounts slightly under still often fill. `swap` warns
 *  when the amount is under the listed minimum but does not block. Symbols not
 *  listed have no advertised minimum. */
export const TRADECRAFT_MIN_INPUT: Readonly<Record<string, number>> = {
  CC: 6,
  USDCx: 1,
  USDXLR: 1,
  cETH: 6e-4,
  CBTC: 1.25e-5,
  HANDL: 100,
  EDELx: 75,
  HECTO: 500,
  "FRXUSD.B": 1,
  eXAG: 0.017,
  eXAU: 2.5e-4,
  TRKXRWA: 0.015,
  USDM1: 1,
  USTY: 1,
};

/** The advisory minimum input for `symbol` (canonical), or undefined if none is
 *  advertised. Case-sensitive on the canonical symbol. */
export function tradecraftMinInput(symbol: string): number | undefined {
  return TRADECRAFT_MIN_INPUT[symbol];
}

/** Derive the Tradecraft pool party for a pair: `tc-swp_{TOKEN1}-{TOKEN2}::<ammCid>`.
 *  `token1`/`token2` MUST be in the pool's CANONICAL order (as listed by /pools),
 *  NOT the swap direction: Tradecraft has one pool party per pair that accepts
 *  either token and returns the other, so `tc-swp_CC-USDCx` serves both CC→USDCx
 *  and USDCx→CC. Deriving from the swap direction (`{in}-{out}`) yields a
 *  non-existent party for one of the two directions. The amm_cid is a single
 *  AMM-rules contract shared by every pair. Pure. */
export function derivePoolParty(
  token1: string,
  token2: string,
  ammCid: string
): string {
  return `tc-swp_${token1}${AMM_PAIR_SEP}${token2}::${ammCid}`;
}

/** One pool row from Tradecraft `/v1/pools`, reduced to what a swap needs: the
 *  pair in the pool party's CANONICAL order. That order is the one in
 *  `lp_token_name` ("TC {TOKEN1}-{TOKEN2} LP"), which is what the on-ledger pool
 *  party `tc-swp_{TOKEN1}-{TOKEN2}::<ammCid>` uses — NOT the row's `token1`/`token2`
 *  fields, which are ordered differently for 9 of 34 live pools (e.g. the CBTC/CC
 *  pool lists token1=CC,token2=CBTC but its party and LP name are CBTC-CC). */
export interface TradecraftPool {
  /** First symbol of the pool party, from lp_token_name. */
  token1: string;
  /** Second symbol of the pool party, from lp_token_name. */
  token2: string;
}

/** Parse the canonical pair order out of an `lp_token_name` like "TC CBTC/CC LP".
 *  Returns undefined when it does not match (caller falls back). */
function parseLpName(lp: unknown): { token1: string; token2: string } | undefined {
  if (typeof lp !== "string") return undefined;
  const m = lp.match(/^TC\s+(\S+)\/(\S+)\s+LP$/);
  return m ? { token1: m[1]!, token2: m[2]! } : undefined;
}

/** Parse `/v1/pools` into rows carrying each pool's CANONICAL pair order (from
 *  `lp_token_name`, falling back to `token1`/`token2`). Tolerates a bare array or
 *  `{pools:[…]}`. Exported for unit testing. */
export function parseTradecraftPools(body: unknown): TradecraftPool[] {
  const rows = Array.isArray(body)
    ? body
    : Array.isArray((body as { pools?: unknown })?.pools)
      ? (body as { pools: unknown[] }).pools
      : undefined;
  if (!rows) {
    throw new Error(`swap: unexpected Tradecraft /pools response ${JSON.stringify(body)}`);
  }
  const out: TradecraftPool[] = [];
  for (const r of rows) {
    const fromLp = parseLpName((r as { lp_token_name?: unknown }).lp_token_name);
    if (fromLp) {
      out.push(fromLp);
      continue;
    }
    const t1 = (r as { token1?: unknown }).token1;
    const t2 = (r as { token2?: unknown }).token2;
    if (typeof t1 === "string" && typeof t2 === "string") {
      out.push({ token1: t1, token2: t2 });
    }
  }
  return out;
}

/** Find the pool whose pair equals {a, b} (case-insensitive, unordered) and
 *  return its CANONICAL token order (the pool party's order). Throws when no such
 *  pool exists — exactly the "send to a non-existent pool party" mistake we must
 *  not make. Exported for unit testing. */
export function resolvePoolPair(
  pools: TradecraftPool[],
  a: string,
  b: string
): { token1: string; token2: string } {
  const lo = a.toLowerCase();
  const ro = b.toLowerCase();
  for (const p of pools) {
    const p1 = p.token1.toLowerCase();
    const p2 = p.token2.toLowerCase();
    if ((p1 === lo && p2 === ro) || (p1 === ro && p2 === lo)) {
      return { token1: p.token1, token2: p.token2 };
    }
  }
  throw new Error(
    `swap: no Tradecraft pool for the pair ${a}/${b} — check the symbols and that a pool exists`
  );
}

/** Slippage-protected minimum output: `quote * (1 - slippagePct/100)`, floored to
 *  10 decimals (every DA-Utility instrument and Canton Coin use 10). Floored, not
 *  rounded — the minimum must never sit ABOVE the true floor, or an honest fill
 *  could be rejected. `slippagePct` must be in [0, 100). Pure. */
export function computeMinOutput(quote: number, slippagePct: number): string {
  if (!Number.isFinite(quote) || quote < 0) {
    throw new Error(`swap: invalid quote ${JSON.stringify(quote)}`);
  }
  if (!Number.isFinite(slippagePct) || slippagePct < 0 || slippagePct >= 100) {
    throw new Error(
      `swap: slippage must be a percentage in [0, 100) (got ${JSON.stringify(slippagePct)})`
    );
  }
  const min = quote * (1 - slippagePct / 100);
  // Floor to 10 decimal places by STRING TRUNCATION, never a float ×1e10 (which
  // re-introduces noise: 0.693 * 1e10 === 6929999999.999…). Snap to 12 fractional
  // places to absorb binary-float noise (0.693 → "0.693000000000"), then keep the
  // first 10 fractional digits. Truncating (not rounding) keeps the result at or
  // below the true minimum, so an honest fill is never rejected.
  const fixed = min.toFixed(12); // always "<whole>.<12 digits>"
  const [whole, frac12] = fixed.split(".");
  const frac = frac12!.slice(0, 10).replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : whole!;
}

/** Parse Tradecraft's `/v1/quoteForFixedInput/{IN}/{OUT}?givingAmount=N` →
 *  `{ user_gets: number }`. Exported for unit testing the shape. */
export function parseTradecraftQuote(body: unknown): number {
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { user_gets?: unknown }).user_gets !== "number"
  ) {
    throw new Error(
      `swap: unexpected Tradecraft quote response ${JSON.stringify(body)}`
    );
  }
  return (body as { user_gets: number }).user_gets;
}

/** Fetch a live quote from Tradecraft's public REST and build a ticket locally
 *  (the `--no-fee` / test path). The fee path gets its ticket from the
 *  facilitator /swap endpoint instead. */
export async function buildLocalTicket(opts: {
  tradecraftApi: string;
  ammCid: string;
  /** The memo key that enforces the minimum; omit to swap at market. */
  memoKey?: string;
  inSymbol: string;
  outSymbol: string;
  amount: string;
  slippagePct: number;
  inInstrument: SwapInstrument;
  outInstrument: SwapInstrument;
  fetchImpl?: typeof globalThis.fetch;
}): Promise<SwapTicket> {
  const f = opts.fetchImpl ?? globalThis.fetch;
  const base = opts.tradecraftApi.replace(/\/$/, "");
  // Tradecraft's edge (Cloudflare) 403s a request with no User-Agent — node's
  // fetch sends none by default. A plain UA is enough.
  const get = async (path: string): Promise<unknown> => {
    const res = await f(`${base}${path}`, {
      headers: { "user-agent": "canton-agent-wallet", accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`swap: Tradecraft GET ${path} failed (HTTP ${res.status})`);
    }
    return res.json();
  };

  // Resolve the pool's CANONICAL pair order from /pools so the pool party is
  // correct for BOTH swap directions (one party per pair serves either way). This
  // also validates the pool exists before we send any funds.
  const pools = parseTradecraftPools(await get("/v1/pools"));
  const { token1, token2 } = resolvePoolPair(pools, opts.inSymbol, opts.outSymbol);

  // The quote IS directional: giving `inSymbol`, receiving `outSymbol`.
  const userGets = parseTradecraftQuote(
    await get(
      `/v1/quoteForFixedInput/${encodeURIComponent(opts.inSymbol)}/` +
        `${encodeURIComponent(opts.outSymbol)}?givingAmount=${encodeURIComponent(opts.amount)}`
    )
  );
  return {
    poolParty: derivePoolParty(token1, token2, opts.ammCid),
    minOutput: computeMinOutput(userGets, opts.slippagePct),
    ...(opts.memoKey ? { memoKey: opts.memoKey } : {}),
    quote: String(userGets),
    inInstrument: opts.inInstrument,
    outInstrument: opts.outInstrument,
  };
}

/** Validate a value as a SwapInstrument ({admin,id} or null). */
function asSwapInstrument(v: unknown): SwapInstrument {
  if (v === null || v === undefined) return null;
  const o = v as { admin?: unknown; id?: unknown };
  if (typeof o.admin === "string" && typeof o.id === "string") {
    return { admin: o.admin, id: o.id };
  }
  throw new Error(`swap: endpoint returned a malformed instrument ${JSON.stringify(v)}`);
}

/** Parse a swap-endpoint ticket response into a SwapTicket, validating the fields
 *  the local execute path relies on. Extra fields (e.g. ammCid) are ignored. */
export function parseEndpointTicket(body: unknown): SwapTicket {
  const b = body as Partial<SwapTicket> & Record<string, unknown>;
  if (
    typeof b?.poolParty !== "string" ||
    typeof b?.minOutput !== "string" ||
    typeof b?.quote !== "string"
  ) {
    throw new Error(`swap: malformed ticket from endpoint ${JSON.stringify(body)}`);
  }
  return {
    poolParty: b.poolParty,
    minOutput: b.minOutput,
    ...(typeof b.memoKey === "string" ? { memoKey: b.memoKey } : {}),
    quote: b.quote,
    inInstrument: asSwapInstrument(b.inInstrument),
    outInstrument: asSwapInstrument(b.outInstrument),
  };
}

/** True when two SwapInstruments are the same (both null, or same admin+id). */
function sameInstrument(a: SwapInstrument, b: SwapInstrument): boolean {
  if (a === null || b === null) return a === b;
  return a.admin === b.admin && a.id === b.id;
}

/**
 * Validate an endpoint-returned ticket against LOCALLY-TRUSTED values before it is
 * ever executed. The swap endpoint is UNTRUSTED for money safety: the ticket's
 * `poolParty` becomes the transfer receiver and its instruments become the assets
 * moved, and verify-before-sign only pins those to caller INTENT — so if intent
 * came from the endpoint unchecked, a malicious/compromised endpoint could name an
 * attacker party and drain the swap amount. We therefore pin, client-side:
 *   - `poolParty` MUST be `tc-swp_{A}-{B}::<trustedAmmCid>` for the two canonical
 *     symbols the caller chose (either pair order) — its namespace equals our own
 *     trusted amm_cid, which a hostile endpoint cannot forge, and its localpart is
 *     the Tradecraft pool naming for exactly this pair;
 *   - the in/out instruments MUST equal the ones the caller resolved locally from
 *     KNOWN_INSTRUMENTS.
 * The endpoint is then trusted ONLY for the price/minimum (a bad one loses at most
 * a bad fill, which returns the input) — never for where the funds go.
 */
export function assertTicketMatchesIntent(
  ticket: SwapTicket,
  expect: {
    inCanon: string;
    outCanon: string;
    inInstrument: SwapInstrument;
    outInstrument: SwapInstrument;
    trustedAmmCid: string;
  }
): void {
  const wantA = derivePoolParty(expect.inCanon, expect.outCanon, expect.trustedAmmCid);
  const wantB = derivePoolParty(expect.outCanon, expect.inCanon, expect.trustedAmmCid);
  if (ticket.poolParty !== wantA && ticket.poolParty !== wantB) {
    throw new Error(
      `swap: endpoint returned pool party ${JSON.stringify(ticket.poolParty)} which is not the ` +
        `trusted ${expect.inCanon}/${expect.outCanon} pool — refusing (a compromised endpoint ` +
        `cannot redirect the swap: the pool must be tc-swp of this pair under our own amm_cid)`
    );
  }
  if (!sameInstrument(ticket.inInstrument, expect.inInstrument)) {
    throw new Error(
      `swap: endpoint returned a different input instrument than requested — refusing`
    );
  }
  if (!sameInstrument(ticket.outInstrument, expect.outInstrument)) {
    throw new Error(
      `swap: endpoint returned a different output instrument than requested — refusing`
    );
  }
  if (!/^\d+(\.\d+)?$/.test(ticket.minOutput)) {
    throw new Error(
      `swap: endpoint returned a non-numeric minOutput ${JSON.stringify(ticket.minOutput)} — refusing`
    );
  }
}

/** Fetch a swap ticket from OUR x402-gated `/swap` endpoint (the default path): the
 *  managed router that stays current with Tradecraft's pools/amm_cid/minimums and
 *  charges a small fee. `payingFetch` is a `makePayingFetch` result, so the 402 is
 *  paid automatically from the agent's wallet. The endpoint is UNTRUSTED for money
 *  safety — the returned ticket is validated against the caller's locally-trusted
 *  amm_cid + instruments (see assertTicketMatchesIntent) before it is returned, so
 *  a hostile endpoint can only give a bad price, never redirect funds. */
export async function fetchTicketFromEndpoint(opts: {
  swapUrl: string;
  inSymbol: string;
  outSymbol: string;
  amount: string;
  slippagePct: number;
  payingFetch: typeof globalThis.fetch;
  /** Locally-resolved input instrument (null = CC) the ticket MUST match. */
  inInstrument: SwapInstrument;
  /** Locally-resolved output instrument (null = CC) the ticket MUST match. */
  outInstrument: SwapInstrument;
  /** The caller's OWN trusted amm_cid the pool party MUST derive from. */
  trustedAmmCid: string;
}): Promise<SwapTicket> {
  const base = opts.swapUrl.replace(/\/$/, "");
  const url =
    `${base}/swap?in=${encodeURIComponent(opts.inSymbol)}` +
    `&out=${encodeURIComponent(opts.outSymbol)}` +
    `&amount=${encodeURIComponent(opts.amount)}` +
    `&slippage=${encodeURIComponent(String(opts.slippagePct))}`;
  const res = await opts.payingFetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`swap: endpoint ${base}/swap failed (HTTP ${res.status}) ${text.slice(0, 200)}`);
  }
  const ticket = parseEndpointTicket(await res.json());
  assertTicketMatchesIntent(ticket, {
    inCanon: opts.inSymbol,
    outCanon: opts.outSymbol,
    inInstrument: opts.inInstrument,
    outInstrument: opts.outInstrument,
    trustedAmmCid: opts.trustedAmmCid,
  });
  return ticket;
}

export interface ExecuteSwapOpts {
  amount: string;
  ticket: SwapTicket;
  apiKey?: string | undefined;
  hashBinding?: HashBindingOptions;
  wallet?: AgentWallet;
  relay?: RelayClient;
  /**
   * Self-provision a TransferPreapproval for the OUTPUT instrument before sending
   * the input, so the pool can deliver the counter-asset DIRECTLY. This is
   * REQUIRED for a registry output: a Tradecraft pool holds no preapproval for the
   * payer and does not create a return offer, so without our preapproval the pool
   * keeps the swapped-out asset (the trade does not complete on our side). Defaults
   * to ON for a registry output (`outInstrument` set) and is a no-op for a CC
   * output (Amulet needs none). Set false only to skip it deliberately (e.g. the
   * preapproval already exists, or a test).
   */
  preapproveOutput?: boolean;
  /**
   * Wait until the OUTPUT asset actually lands in the wallet before returning
   * (default ON). This is what lets `swap` be one command: it polls the output
   * balance — claiming any returning OFFER each tick — until the rise reaches the
   * ticket's minimum output, unifying the direct-to-preapproval delivery (registry
   * output) and the offer path (CC output) so no manual `claim` is needed. Set
   * false for fire-and-forget (send + return immediately), e.g. automation that
   * must not block; then the caller polls / claims itself.
   */
  waitForOutput?: boolean;
  /** Injectable sleep + poll bounds for the settlement wait (tests). */
  sleep?: (ms: number) => Promise<void>;
  claimAttempts?: number;
  claimIntervalMs?: number;
}

export interface SwapResult {
  /** updateId of the input transfer we sent to the pool. */
  sentUpdateId: string;
  /** How many returning transfers we claimed DURING the wait (0 if the pool
   *  settled directly to our preapproval, or nothing arrived within the window).
   *  Offers already pending BEFORE the swap are claimed into the baseline
   *  pre-send and are NOT counted here — they are not this swap's return. */
  claimed: number;
  claimedUpdateIds: string[];
  /** The output amount that landed in the wallet: the rise on the output balance
   *  once it reached the ticket's minimum output. Undefined when waitForOutput is
   *  off, or the window elapsed without such a rise (still settling, or a
   *  below-minimum trade whose input was returned instead). A concurrent inbound
   *  of the same asset inside the window is still counted — this is a balance
   *  delta, not a per-transfer receipt. */
  delivered?: string;
  /** The window elapsed with the balance up by this much but BELOW the ticket
   *  minimum — an unrelated inbound, or a partial/odd settlement. Undefined when
   *  zero or when `delivered` is set. */
  partialRise?: string;
  /** True when we waited but the output had not arrived by the end of the window. */
  timedOut: boolean;
  /** Relay read/claim errors survived during the wait. NOTHING thrown after the
   *  input is sent — a transient relay blip must never make a SENT swap look
   *  failed (that reads as "retry me", i.e. a double-send). */
  pollErrors: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Execute a swap from a resolved ticket: (1) pre-approve the output instrument so
 * the pool's return can never be a consumed-input-no-return loss, (2) send the
 * input to the pool with the minimum in meta, (3) claim the returning transfer if
 * it arrives as an offer rather than settling directly.
 */
export async function executeSwap(opts: ExecuteSwapOpts): Promise<SwapResult> {
  const wallet = opts.wallet ?? loadWallet();
  if (!wallet) throw new Error("no wallet — run `create` first");
  const relay =
    opts.relay ??
    new RelayClient({ relayUrl: wallet.relayUrl, apiKey: opts.apiKey });
  const hashBinding = opts.hashBinding ?? resolveHashBinding();
  const { ticket } = opts;

  // (1) OUTPUT PREAPPROVAL (direct settlement). REQUIRED for a registry output:
  // the pool delivers the counter-asset only to a preapproved receiver, so without
  // this the swapped-out asset never reaches us. Defaults ON for a registry output;
  // a CC output needs none (native Amulet). Idempotent — skipped when one already
  // exists. Opt out with preapproveOutput:false.
  const wantPreapprove = opts.preapproveOutput ?? true;
  if (wantPreapprove && ticket.outInstrument) {
    const { admin, id } = ticket.outInstrument;
    const status = await relay.preapprovalStatus(wallet.party, admin, id);
    if (status.hasPreapproval !== true) {
      await selfProvisionRegistryPreapproval(relay, wallet, {
        instrumentId: { admin, id },
        hashBinding,
      });
    }
  }

  // Baseline the OUTPUT balance BEFORE sending, so we can detect the counter-asset
  // arriving — whether the pool delivers it DIRECTLY to our preapproval (registry
  // output) or as an OFFER we claim (CC output). CC → the Amulet balance; a registry
  // output → the summed UNLOCKED HoldingV1 amounts for that instrument (a locked
  // holding is committed to a pending outbound two-step transfer; its mid-window
  // archival would otherwise mask a real arrival as a false timeout). Skipped when
  // not waiting. (All swappable instruments are 10-dp, so the CC atomic scale is
  // exact for the delta below.)
  const wait = opts.waitForOutput ?? true;
  const readOutputBalance = async (): Promise<string> => {
    if (ticket.outInstrument) {
      const { admin, id } = ticket.outInstrument;
      const h = await relay.holdings(wallet.party, { admin, id });
      return sumLedgerDecimals(
        h.instruments[0]?.holdings.filter((x) => !x.locked).map((x) => x.amount) ?? []
      );
    }
    return (await relay.balance(wallet.party)).cc;
  };
  // Claim whatever is ALREADY pending into the baseline first: a pre-existing
  // unclaimed offer accepted mid-wait would otherwise register as a balance rise
  // and be reported as this swap's output. Pre-send, so failing here is SAFE
  // (nothing has moved yet — let it propagate and abort).
  if (wait) await claimAll(relay, wallet, { hashBinding });
  const outputBaseline = wait ? await readOutputBalance() : "0";

  // (2) SEND THE INPUT to the pool, carrying the slippage floor in the AMM's meta
  // key. The ticket's pool party was derived from (or validated against, on the
  // endpoint path via assertTicketMatchesIntent) the CALLER's trusted amm_cid, so
  // it cannot have been redirected by an untrusted quote source.
  const sent = await withdraw({
    to: ticket.poolParty,
    amount: opts.amount,
    apiKey: opts.apiKey,
    hashBinding,
    // Attach the slippage floor ONLY when a memo key is configured; without it
    // the swap executes at market price (the pool needs no meta to fill).
    ...(ticket.memoKey ? { meta: { [ticket.memoKey]: ticket.minOutput } } : {}),
    ...(ticket.inInstrument
      ? {
          instrumentAdmin: ticket.inInstrument.admin,
          instrumentId: ticket.inInstrument.id,
          // A pool holds no preapproval, so a registry INPUT settles via the
          // two-step offer shape — opt verify-before-sign into it. CC input uses
          // the Amulet path and needs no such opt-in.
          allowRegistryOffer: true,
        }
      : {}),
    wallet,
    relay,
  });

  // (3) WAIT FOR THE OUTPUT to land (default). Poll the output balance until the
  // rise over the baseline reaches the ticket's MINIMUM output — claiming any
  // returning OFFER each tick (that also recovers a below-minimum trade's returned
  // input, which comes back as an offer) — so `swap` finishes only once the
  // counter-asset is actually in the wallet, with no manual `claim`. Unifies BOTH
  // the direct-to-preapproval delivery (registry output) and the offer path (CC
  // output / opted-out). The min threshold keeps an unrelated small inbound from
  // ending the wait as a false fill; a sub-minimum rise is reported separately as
  // `partialRise`, never as `delivered`. `waitForOutput:false` returns immediately
  // (fire-and-forget); the caller then polls / claims itself.
  //
  // EVERYTHING in this loop is best-effort: the input is ALREADY SENT, so a
  // transient relay error here must degrade to a missed poll — never to a thrown
  // "swap failed" that loses sentUpdateId and invites a retry (= double-send).
  const claimedUpdateIds: string[] = [];
  let delivered: string | undefined;
  let partialRise: string | undefined;
  let timedOut = false;
  let pollErrors = 0;
  if (wait) {
    const sleep = opts.sleep ?? defaultSleep;
    const attempts = opts.claimAttempts ?? 8;
    const intervalMs = opts.claimIntervalMs ?? 15_000;
    const baseAtomic = BigInt(decimalToAtomicCC(outputBaseline));
    const minAtomic = BigInt(decimalToAtomicCC(ticket.minOutput));
    timedOut = true;
    let lastRise = 0n;
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await claimAll(relay, wallet, { hashBinding });
        claimedUpdateIds.push(...r.updateIds);
        const now = await readOutputBalance();
        const rise = BigInt(decimalToAtomicCC(now)) - baseAtomic;
        if (rise > lastRise) lastRise = rise;
        if (rise > 0n && rise >= minAtomic) {
          delivered = atomicToDecimalCC(rise.toString());
          timedOut = false;
          break;
        }
      } catch {
        pollErrors++;
      }
      if (i < attempts - 1) await sleep(intervalMs);
    }
    if (timedOut && lastRise > 0n) partialRise = atomicToDecimalCC(lastRise.toString());
  }

  return {
    sentUpdateId: sent.updateId,
    claimed: claimedUpdateIds.length,
    claimedUpdateIds,
    ...(delivered !== undefined ? { delivered } : {}),
    ...(partialRise !== undefined ? { partialRise } : {}),
    timedOut,
    pollErrors,
  };
}
