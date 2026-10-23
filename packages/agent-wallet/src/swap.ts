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

/** The swap venue a ticket routes to. Tradecraft uses pool addresses; Cantex uses
 *  the keyless Connect "trade by a simple send" path. Both share the same on-ledger
 *  execution primitive (send the input to a party with a memo), so `executeSwap` is
 *  venue-agnostic and only ticket resolution differs. */
export type SwapVenue = "tradecraft" | "cantex";

/** Everything needed to execute one swap, resolved up front (locally, or by the
 *  facilitator /swap fee-ticket which knows the network's registrars). */
export interface SwapTicket {
  /** Which venue resolved this ticket (defaults to tradecraft when absent, for
   *  backward compatibility with older endpoint responses). */
  venue?: SwapVenue;
  /** The party to send the input to: Tradecraft `tc-swp_{IN}-{OUT}::<amm_cid>`, or
   *  the Cantex Connect swap party. */
  poolParty: string;
  /** Slippage-protected minimum output, as a ledger decimal string. Always
   *  computed for the display + delivery-detection threshold; on Tradecraft it is
   *  also what rides in the memo as the enforced minimum. */
  minOutput: string;
  /** The transfer-meta key the venue reads the memo from. Tradecraft: set only when
   *  slippage protection is on (else market fill). Cantex: always the reason key. */
  memoKey?: string;
  /** The exact string to place in the memo (under `memoKey`). Tradecraft: the
   *  min-out decimal. Cantex: the buy-token symbol (e.g. "CBTC"). Defaults to
   *  `minOutput` when absent (older Tradecraft-only tickets). */
  memoValue?: string;
  /** The raw quote (estimated output) that produced `minOutput`. */
  quote: string;
  /** The instrument being sent in (null = CC). */
  inInstrument: SwapInstrument;
  /** The instrument expected back (null = CC). */
  outInstrument: SwapInstrument;
}

/** The Cantex Connect swap party (client-trusted constant; env-overridable). Funds
 *  can only ever be sent here for a Cantex swap, so a compromised endpoint cannot
 *  redirect them. */
export const CANTEX_CONNECT_PARTY =
  process.env.CANTON_AGENT_CANTEX_PARTY ??
  "cantex-swap::122038c015864f106cfed48bb9106b7c89982368d27956ffcdfda6c38328f0909b8c";

/** Cantex Connect quote endpoint (keyless, public). */
export const CANTEX_CONNECT_URL =
  process.env.CANTON_AGENT_CANTEX_URL ??
  "https://api.cantex.io/v1/public/connect/quote";

/** The Canton token-standard reason key Cantex reads the buy symbol from. */
export const CANTEX_MEMO_KEY = "splice.lfdecentralizedtrust.org/reason";

/** Cantex Connect minimum input, in CC-equivalent. Trades below this bounce at the
 *  quote step. */
export const CANTEX_MIN_INPUT_CC = 50;

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

/** Canonical CC-pair order for the tokens we support, as [token1, token2] in the
 *  pool party's order (from each pool's `lp_token_name`). Used as a FALLBACK when
 *  Tradecraft's `/pools` API is unreachable (it 5xxs periodically) so a swap can
 *  still target the correct pool party without their API. Every one is CC-first
 *  except CBTC/CC (the one live pool whose canonical order is token-first).
 *  Key is the OTHER token (case-insensitive lookup). If a pair is absent here and
 *  `/pools` is down, we fail closed rather than guess an order. */
const KNOWN_CC_POOL_ORDER: Readonly<Record<string, readonly [string, string]>> = {
  usdcx: ["CC", "USDCx"],
  usdxlr: ["CC", "USDXLR"],
  ceth: ["CC", "cETH"],
  exag: ["CC", "eXAG"],
  exau: ["CC", "eXAU"],
  cbtc: ["CBTC", "CC"],
};

/** The canonical [token1, token2] for a CC/`other` pair from the fallback table,
 *  or undefined if we do not have it hardcoded. `other` is the non-CC symbol. */
function knownCcPoolOrder(other: string): readonly [string, string] | undefined {
  return KNOWN_CC_POOL_ORDER[other.toLowerCase()];
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
  /** Retries for a transient Tradecraft 5xx on the pools/quote fetch. Default 4. */
  quoteAttempts?: number;
}): Promise<SwapTicket> {
  const f = opts.fetchImpl ?? globalThis.fetch;
  const base = opts.tradecraftApi.replace(/\/$/, "");
  // Tradecraft's edge (Cloudflare) 403s a request with no User-Agent — node's
  // fetch sends none by default. A plain UA is enough.
  // Tradecraft's edge returns 5xx (esp. 503) transiently; retry a few times before
  // giving up. Read-only quote fetch, so a retry is safe and no funds have moved.
  const get = async (path: string): Promise<unknown> => {
    const attempts = opts.quoteAttempts ?? 4;
    let last = 0;
    for (let i = 0; i < attempts; i++) {
      const res = await f(`${base}${path}`, {
        headers: { "user-agent": "canton-agent-wallet", accept: "application/json" },
      });
      if (res.ok) return res.json();
      last = res.status;
      // Retry only transient 5xx, and only while attempts remain; a 4xx is a hard
      // failure. On the last 5xx attempt fall out of the loop to the summary throw.
      if (res.status >= 500 && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (res.status < 500) {
        throw new Error(`swap: Tradecraft GET ${path} failed (HTTP ${res.status})`);
      }
    }
    throw new Error(`swap: Tradecraft GET ${path} failed after ${attempts} attempts (HTTP ${last})`);
  };

  // Resolve the pool's CANONICAL pair order. Prefer /pools (authoritative, validates
  // the pool exists); if that API is unreachable (Tradecraft 5xxs periodically), fall
  // back to the hardcoded CC-pair order so a swap still targets the correct pool party
  // WITHOUT their API — the pool address is all that is needed to send. A CC pair not
  // in the fallback table fails closed rather than guessing.
  //
  // The FETCH and the RESOLVE are separated on purpose: only a fetch failure (Tradecraft
  // 5xx/network) is allowed to fall back to the hardcoded order. `resolvePoolPair` failing
  // means /pools loaded but has no such pool — a genuine "pool does not exist" that MUST
  // surface as a hard error, never silently target the hardcoded pool party.
  const resolvePair = async (): Promise<{ token1: string; token2: string; poolsUp: boolean }> => {
    let pools: TradecraftPool[];
    try {
      pools = parseTradecraftPools(await get("/v1/pools"));
    } catch (e) {
      const cc = opts.inSymbol === "CC" ? opts.outSymbol
        : opts.outSymbol === "CC" ? opts.inSymbol
        : undefined;
      const known = cc !== undefined ? knownCcPoolOrder(cc) : undefined;
      if (!known) throw e; // fetch failed and no fallback for this pair — surface it
      return { token1: known[0], token2: known[1], poolsUp: false };
    }
    // pools loaded: a missing pair here is a real "no such pool" and throws (never falls back).
    const { token1, token2 } = resolvePoolPair(pools, opts.inSymbol, opts.outSymbol);
    return { token1, token2, poolsUp: true };
  };
  const { token1, token2, poolsUp } = await resolvePair();

  // The quote is directional and only informs the slippage minimum + display. When
  // /pools is down the quote endpoint is down too, so skip it and market-fill (no
  // memo min) rather than fail the whole swap; the pool still fills at market.
  let userGets: number | undefined;
  if (poolsUp) {
    try {
      userGets = parseTradecraftQuote(
        await get(
          `/v1/quoteForFixedInput/${encodeURIComponent(opts.inSymbol)}/` +
            `${encodeURIComponent(opts.outSymbol)}?givingAmount=${encodeURIComponent(opts.amount)}`
        )
      );
    } catch {
      userGets = undefined; // quote flaked; fall through to market-fill
    }
  }
  const haveQuote = userGets !== undefined;
  // Fail closed: if the caller explicitly enabled on-ledger slippage protection (memoKey)
  // but no quote could be obtained to base the minimum on, refuse rather than silently
  // downgrading to an unprotected market-fill. With no memoKey (the default), a missing
  // quote falls through to market-fill so a swap still completes while the API is down.
  if (opts.memoKey !== undefined && !haveQuote) {
    throw new Error(
      "swap: on-ledger slippage protection was requested (memoKey) but no quote could be " +
        "obtained to compute the minimum — refusing to market-fill without a floor"
    );
  }
  const minOutput = haveQuote ? computeMinOutput(userGets!, opts.slippagePct) : "0";
  // Enforce a memo min only with a quote to base it on; without a memoKey the swap is a
  // market-fill (no memo), the proven bare pool-address flow.
  const attachMemo = opts.memoKey !== undefined && haveQuote;
  return {
    venue: "tradecraft",
    poolParty: derivePoolParty(token1, token2, opts.ammCid),
    minOutput,
    ...(attachMemo ? { memoKey: opts.memoKey, memoValue: minOutput } : {}),
    quote: haveQuote ? String(userGets) : "unknown (Tradecraft quote API unavailable)",
    inInstrument: opts.inInstrument,
    outInstrument: opts.outInstrument,
  };
}

/** Fetch a live Cantex Connect quote and build a ticket locally (the keyless
 *  `--direct` path for Cantex — Connect is public and free, so no fee/endpoint is
 *  needed). The counter-asset settles directly to the sender's pre-approved wallet.
 *  Unlike Tradecraft, Cantex's memo is the BUY SYMBOL (from the quote), not a min;
 *  `slippagePct` only sets the local delivery-detection threshold. */
export async function buildCantexTicket(opts: {
  connectUrl: string;
  cantexParty: string;
  /** Full DSO party id — Cantex requires the FULL Amulet admin (not "DSO"). */
  dsoParty: string;
  inSymbol: string;
  outSymbol: string;
  amount: string;
  slippagePct: number;
  inInstrument: SwapInstrument;
  outInstrument: SwapInstrument;
  fetchImpl?: typeof globalThis.fetch;
  /** Retries for Cantex's transient "unable to determine CC-equivalent input size"
   *  (seen on token->CC quotes when their price backend is briefly degraded). Default 4. */
  quoteAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SwapTicket> {
  const f = opts.fetchImpl ?? globalThis.fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const inCx = opts.inInstrument ?? { id: "Amulet", admin: opts.dsoParty };
  const outCx = opts.outInstrument ?? { id: "Amulet", admin: opts.dsoParty };
  const reqBody = JSON.stringify({
    sellAmount: opts.amount,
    sellInstrumentId: inCx.id,
    sellInstrumentAdmin: inCx.admin,
    buyInstrumentId: outCx.id,
    buyInstrumentAdmin: outCx.admin,
  });
  // Cantex's keyless quote sometimes cannot price a non-CC input's CC-equivalent
  // (the min check) and 400s transiently on token->CC. This is a QUOTE failure only
  // (no funds have moved), so retry a few times before giving up / falling back.
  const attempts = opts.quoteAttempts ?? 4;
  let res!: Awaited<ReturnType<typeof f>>;
  let lastTransient = "";
  for (let i = 0; i < attempts; i++) {
    res = await f(opts.connectUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: reqBody,
    });
    if (res.ok) break;
    const text = await res.text().catch(() => "");
    if (/CC-equivalent input size/i.test(text)) {
      lastTransient = text;
      if (i < attempts - 1) {
        await sleep(1500);
        continue;
      }
      break; // transient error on the last attempt — fall through to the guidance below
    }
    throw new Error(`swap: Cantex Connect quote failed (HTTP ${res.status}) ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(
      `swap: Cantex Connect could not quote after ${attempts} attempts ` +
        `(${lastTransient.slice(0, 120)}) — try again shortly or use --venue tradecraft`
    );
  }
  const body = (await res.json()) as { memo?: unknown; returned?: { amount?: unknown } };
  if (typeof body?.memo !== "string" || typeof body?.returned?.amount !== "string") {
    throw new Error(`swap: unexpected Cantex Connect quote response ${JSON.stringify(body)}`);
  }
  const userGets = Number(body.returned.amount);
  if (!Number.isFinite(userGets) || userGets < 0) {
    throw new Error(`swap: Cantex returned a non-numeric output ${JSON.stringify(body.returned.amount)}`);
  }
  // The quote memo drives what Cantex buys — assert it identifies our requested
  // output (defense in depth even on this direct/TLS path).
  assertMemoMatchesOutput(body.memo, opts.outSymbol, opts.outInstrument, "Cantex");
  return {
    venue: "cantex",
    poolParty: opts.cantexParty,
    minOutput: computeMinOutput(userGets, opts.slippagePct),
    memoKey: CANTEX_MEMO_KEY,
    // Cantex reads the buy instrument from the memo (symbol or admin party). No ref.
    memoValue: body.memo,
    quote: body.returned.amount,
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
    ...(b.venue === "cantex" || b.venue === "tradecraft" ? { venue: b.venue } : {}),
    poolParty: b.poolParty,
    minOutput: b.minOutput,
    ...(typeof b.memoKey === "string" ? { memoKey: b.memoKey } : {}),
    ...(typeof b.memoValue === "string" ? { memoValue: b.memoValue } : {}),
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

/** Assert a Cantex memo identifies EXACTLY the requested output instrument. Cantex
 *  Connect returns the buy instrument as its symbol, its instrument id, or its full
 *  admin party (observed: "CBTC" for CBTC, the registrar party for USDCx). The memo
 *  drives what asset Cantex buys, so it must be one of those forms for the caller's
 *  own output — never an endpoint-chosen substitute. `outInstrument` is null for a CC
 *  output (Cantex's buy id is then "Amulet"). Throws on any mismatch. */
function assertMemoMatchesOutput(
  memo: string | undefined,
  outCanon: string,
  outInstrument: SwapInstrument,
  source: string
): void {
  const allowed = [
    outCanon,
    outInstrument?.id,
    outInstrument?.admin,
    outInstrument === null ? "Amulet" : undefined,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  if (typeof memo !== "string" || !allowed.includes(memo)) {
    throw new Error(
      `swap: ${source} memo ${JSON.stringify(memo)} does not identify the requested output ` +
        `${JSON.stringify(outCanon)} (allowed: ${allowed.join(", ")}) — refusing`
    );
  }
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
    /** The client-trusted Cantex Connect party (for cantex-venue tickets). */
    trustedCantexParty: string;
  }
): void {
  // The receiver (`poolParty`) is pinned to a client-trusted constant PER VENUE, so a
  // compromised endpoint can never redirect funds to an attacker party. Tradecraft:
  // the pool must be tc-swp of this pair under OUR amm_cid. Cantex: the party must be
  // OUR trusted Cantex Connect party exactly.
  // minOutput is consumed AFTER the input is sent (executeSwap's BigInt(decimalToAtomicCC(
  // minOutput)) delivery-threshold), and a throw there would strand a SENT swap as an
  // apparent failure (a retry = double-send). So validate it numeric for EVERY venue
  // here, before anything moves — not just on the Tradecraft path.
  if (!/^\d+(\.\d+)?$/.test(ticket.minOutput)) {
    throw new Error(
      `swap: endpoint returned a non-numeric minOutput ${JSON.stringify(ticket.minOutput)} — refusing`
    );
  }
  const venue: SwapVenue = ticket.venue ?? "tradecraft";
  if (venue === "cantex") {
    if (ticket.poolParty !== expect.trustedCantexParty) {
      throw new Error(
        `swap: endpoint returned Cantex party ${JSON.stringify(ticket.poolParty)} which is not our ` +
          `trusted Cantex Connect party — refusing`
      );
    }
    // The memo IS the buy-instrument selector Cantex acts on (its symbol, its
    // instrument id, or its full admin party — the forms Cantex Connect returns), so
    // it drives what asset the wallet receives. It MUST match the output the caller
    // asked for, or a compromised endpoint could make Cantex buy a different (junk)
    // token. Also pin the memo key. This exact-match allow-list subsumes any
    // affiliate-`ref:` injection (a ref-appended memo simply is not in the set).
    if (ticket.memoKey !== CANTEX_MEMO_KEY) {
      throw new Error(
        `swap: endpoint returned an unexpected Cantex memo key ${JSON.stringify(ticket.memoKey)} — refusing`
      );
    }
    assertMemoMatchesOutput(ticket.memoValue, expect.outCanon, expect.outInstrument, "Cantex");
  } else {
    const wantA = derivePoolParty(expect.inCanon, expect.outCanon, expect.trustedAmmCid);
    const wantB = derivePoolParty(expect.outCanon, expect.inCanon, expect.trustedAmmCid);
    if (ticket.poolParty !== wantA && ticket.poolParty !== wantB) {
      throw new Error(
        `swap: endpoint returned pool party ${JSON.stringify(ticket.poolParty)} which is not the ` +
          `trusted ${expect.inCanon}/${expect.outCanon} pool — refusing (a compromised endpoint ` +
          `cannot redirect the swap: the pool must be tc-swp of this pair under our own amm_cid)`
      );
    }
    // Tradecraft reads the slippage FLOOR from the on-chain memo. `executeSwap` sends
    // `memoValue`, so if a memo rides (memoKey set) it MUST be the validated minOutput
    // under the trusted reason key — otherwise a compromised endpoint could show a
    // healthy minOutput while sending a zero/garbage floor on-chain (no protection).
    if (ticket.memoKey !== undefined) {
      if (ticket.memoKey !== CANTEX_MEMO_KEY) {
        throw new Error(
          `swap: endpoint returned an unexpected Tradecraft memo key ${JSON.stringify(ticket.memoKey)} — refusing`
        );
      }
      if (ticket.memoValue !== ticket.minOutput) {
        throw new Error(
          `swap: endpoint's on-chain floor ${JSON.stringify(ticket.memoValue)} does not equal the ` +
            `validated minOutput ${JSON.stringify(ticket.minOutput)} — refusing (slippage-strip attempt)`
        );
      }
    }
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
  /** The caller's OWN trusted amm_cid the pool party MUST derive from (Tradecraft). */
  trustedAmmCid: string;
  /** The caller's OWN trusted Cantex Connect party the pool party MUST equal (Cantex). */
  trustedCantexParty: string;
  /** Which venue to request. Default cantex. */
  venue?: SwapVenue;
}): Promise<SwapTicket> {
  const base = opts.swapUrl.replace(/\/$/, "");
  const url =
    `${base}/swap?in=${encodeURIComponent(opts.inSymbol)}` +
    `&out=${encodeURIComponent(opts.outSymbol)}` +
    `&amount=${encodeURIComponent(opts.amount)}` +
    `&slippage=${encodeURIComponent(String(opts.slippagePct))}` +
    `&venue=${encodeURIComponent(opts.venue ?? "cantex")}`;
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
    trustedCantexParty: opts.trustedCantexParty,
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
   *  zero or when `delivered` is set. Also set next to `deliveryUnobservable`
   *  when the rise was seen before the wait ended on an incomplete read. */
  partialRise?: string;
  /** True when the INPUT came back instead of the output: a CC input to a venue
   *  that would not fill the trade (below its minimum) is handed back as CC —
   *  directly, to a wallet holding a CC preapproval — which the output watch
   *  cannot see. Detected from the CC balance standing back at its pre-send
   *  level (≥99% of the amount, from the second tick on), and it ends the wait
   *  early. A balance delta, not a per-transfer receipt: a concurrent inbound of
   *  the same size reads the same. Only watched for a CC input + token output. */
  inputReturned: boolean;
  /** True when we waited but the output had not arrived by the end of the window. */
  timedOut: boolean;
  /** True when the relay cannot list every holding of the OUTPUT token (the
   *  wallet holds more holdings of that token's registry template than the
   *  participant lists in one read — every DA Registry Utility token shares
   *  one — or an older relay counts the whole wallet), so the delivery
   *  — its newest holding — cannot be seen. Decided before the send (the
   *  output is then never polled), or by a wait whose last read was
   *  incomplete. The wait still runs its window, claiming offers and watching
   *  for a returned input. The input WAS sent; nothing is known about whether
   *  the output landed. Not a failure and not a timeout — `claim` picks up an
   *  input handed back later; check `balance` after `merge --all-tokens`, and
   *  never resend on this alone. */
  deliveryUnobservable: boolean;
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
  // A registry output is read through a BOUNDED read, which a current relay
  // narrows to that token's holding template: Canton Coin dust does not make it
  // incomplete. It IS incomplete when the wallet holds more holdings of that
  // template than the participant lists in one read (every DA Registry Utility
  // token shares one, so CBTC dust counts against USDCx), or on an older relay
  // that counts the whole wallet. What it lists is then the OLDEST holdings and
  // the pool's delivery — the newest one — is not among them, so a balance
  // delta would never move. Such a wallet cannot observe delivery at all; we
  // say so instead of reporting a false timeout, and stop polling the output
  // (the claims and the input-return watch keep running for the window).
  const readOutputBalance = async (): Promise<{ sum: string; complete: boolean }> => {
    if (ticket.outInstrument) {
      const { admin, id } = ticket.outInstrument;
      const h = await relay.holdings(wallet.party, { admin, id }, { slice: true });
      return {
        sum: sumLedgerDecimals(
          h.instruments[0]?.holdings.filter((x) => !x.locked).map((x) => x.amount) ?? []
        ),
        complete: h.complete,
      };
    }
    return { sum: (await relay.balance(wallet.party)).cc, complete: true };
  };
  // Claim whatever is ALREADY pending into the baseline first: a pre-existing
  // unclaimed offer accepted mid-wait would otherwise register as a balance rise
  // and be reported as this swap's output. Pre-send, so failing here is SAFE
  // (nothing has moved yet — let it propagate and abort).
  if (wait) await claimAll(relay, wallet, { hashBinding });
  const baselineRead = wait ? await readOutputBalance() : { sum: "0", complete: true };
  const outputBaseline = baselineRead.sum;
  // Pre-send, so the caller can still decide; the send itself is unaffected.
  // A wait that ends on an incomplete read sets it too (the wallet crossed the
  // cap mid-wait).
  let deliveryUnobservable = wait && !baselineRead.complete;

  // Convert the numeric delivery thresholds to atomics BEFORE sending, so a malformed
  // decimal (e.g. an endpoint-supplied non-numeric minOutput that somehow reached here)
  // throws PRE-SEND — never after the input has moved, which would surface a sent swap as
  // a failure and invite a double-send retry. assertTicketMatchesIntent already rejects a
  // non-numeric minOutput on the endpoint path; this is the executeSwap-level backstop.
  const baseAtomic = wait ? BigInt(decimalToAtomicCC(outputBaseline)) : 0n;
  const minAtomic = wait ? BigInt(decimalToAtomicCC(ticket.minOutput)) : 0n;

  // CC input, token output: an unfilled trade hands the CC back — to a wallet
  // holding a CC preapproval DIRECTLY, and long before the window ends — and the
  // output watch above cannot see it (seen live: 0.2 CC to the CC/USDCx pool was
  // back within a minute while the loop ran its full two). Baseline the CC
  // balance BEFORE the send (a post-send read would race the return) so each
  // tick can tell "back where it started" from "still out". Pre-send, so a
  // failure here aborts safely with nothing moved.
  const watchInputReturn = wait && ticket.inInstrument === null && ticket.outInstrument !== null;
  const ccBeforeSend = watchInputReturn
    ? BigInt(decimalToAtomicCC((await relay.balance(wallet.party)).cc))
    : 0n;
  const inputAtomic = watchInputReturn ? BigInt(decimalToAtomicCC(opts.amount)) : 0n;

  // (2) SEND THE INPUT to the pool, carrying the slippage floor in the AMM's meta
  // key. The ticket's pool party was derived from (or validated against, on the
  // endpoint path via assertTicketMatchesIntent) the CALLER's trusted amm_cid, so
  // it cannot have been redirected by an untrusted quote source.
  const sent = await withdraw({
    to: ticket.poolParty,
    amount: opts.amount,
    apiKey: opts.apiKey,
    hashBinding,
    // Attach the memo ONLY when a memo key is set. Tradecraft: the value is the
    // slippage floor (omitted → market fill). Cantex: the value is the buy symbol
    // (always set). `memoValue` falls back to `minOutput` for older Tradecraft-only
    // tickets that predate the field.
    ...(ticket.memoKey
      ? { meta: { [ticket.memoKey]: ticket.memoValue ?? ticket.minOutput } }
      : {}),
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
  let inputReturned = false;
  let timedOut = false;
  let pollErrors = 0;
  if (wait) {
    const sleep = opts.sleep ?? defaultSleep;
    const attempts = opts.claimAttempts ?? 8;
    const intervalMs = opts.claimIntervalMs ?? 15_000;
    timedOut = true;
    let lastRise = 0n;
    // The last output read listed only part of the output token's holdings.
    let lastReadIncomplete = false;
    for (let i = 0; i < attempts; i++) {
      try {
        // Claimed every tick, observable or not: a trade the venue will not
        // fill can come back as an offer, and only a claim recovers it.
        const r = await claimAll(relay, wallet, { hashBinding });
        claimedUpdateIds.push(...r.updateIds);
        // An incomplete BASELINE is never compared against: it is a prefix of
        // the oldest holdings, the delivery is the newest, and one prefix minus
        // another is no rise. Only the output read is skipped — the claim
        // above and the input-return check below still run for the window.
        if (!deliveryUnobservable) {
          const out = await readOutputBalance();
          const rise = BigInt(decimalToAtomicCC(out.sum)) - baseAtomic;
          if (rise > 0n && rise >= minAtomic) {
            // An incomplete read is a lower bound, so a rise it shows did happen.
            delivered = atomicToDecimalCC(rise.toString());
            timedOut = false;
            break;
          }
          if (rise > lastRise) lastRise = rise;
          // One incomplete read does not end the wait (a lookup that raced an
          // archive, a relay that could not list it all this once): the next
          // may list everything again. A wait that ENDS on one is reported as
          // unobservable below.
          lastReadIncomplete = !out.complete;
        }
        // The input-return check waits one interval: on the very first tick a
        // balance read that has not caught up with the send would show the CC
        // still "there" and read as a return that never happened.
        if (watchInputReturn && i > 0) {
          const cc = BigInt(decimalToAtomicCC((await relay.balance(wallet.party)).cc));
          if (cc - (ccBeforeSend - inputAtomic) >= (inputAtomic * 99n) / 100n) {
            inputReturned = true;
            timedOut = false;
            break;
          }
        }
      } catch {
        pollErrors++;
      }
      if (i < attempts - 1) await sleep(intervalMs);
    }
    // Before the reclassification below: a sub-minimum rise seen during the
    // window is still worth reporting when the wait then ends unobservable.
    if (timedOut && lastRise > 0n) partialRise = atomicToDecimalCC(lastRise.toString());
    // Not a timeout: the window could not see the delivery (from the baseline
    // on, or as of its last read).
    if (delivered === undefined && !inputReturned && (deliveryUnobservable || lastReadIncomplete)) {
      deliveryUnobservable = true;
      timedOut = false;
    }
  }

  return {
    sentUpdateId: sent.updateId,
    claimed: claimedUpdateIds.length,
    claimedUpdateIds,
    ...(delivered !== undefined ? { delivered } : {}),
    ...(partialRise !== undefined ? { partialRise } : {}),
    inputReturned,
    timedOut,
    deliveryUnobservable,
    pollErrors,
  };
}
