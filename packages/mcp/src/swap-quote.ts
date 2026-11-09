/**
 * swap_quote: what the swap venues offer, read without paying or moving
 * anything.
 *
 * The pool list is Tradecraft's public `/v1/pools`. A quote goes through the
 * same resolveSwapTicket as `swap`, on its free direct path, so the venue it
 * names is the venue `swap` would pick: the routing rules are not restated
 * here. Each venue is asked once; the default route and `auto` share the
 * answers.
 *
 * Everything here reaches the agent's context, and the tool is read-only, so
 * clients run it without asking. Only plain token symbols and numbers from
 * the venues are shown; a venue's error text becomes a fixed reason.
 */
import {
  buildCantexTicket,
  buildLocalTicket,
  resolveSwapSymbol,
  resolveSwapTicket,
  tradecraftMinInput,
  DEFAULT_SWAP_VENUE,
  DEFAULT_TRADECRAFT_API,
  type SwapIntent,
  type SwapTicket,
  type SwapVenue,
} from "@ftptech/canton-agent-wallet";

/** One Tradecraft pool: the pair in the pool party's order, the reserves by
 *  symbol, and the fee a trade pays (liquidity + operator), in percent. */
export interface PoolRow {
  pair: [string, string];
  reserves: Record<string, number>;
  feePct: number;
}

const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN);

/** A token symbol as Tradecraft spells them (FRXUSD.B, eXAG). A field that is
 *  not a plain symbol is dropped rather than shown. */
const SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/;
const symbol = (v: unknown): string | undefined => (typeof v === "string" && SYMBOL.test(v) ? v : undefined);

/** The most pools one answer lists; `in` narrows the rest. */
export const MAX_POOLS_LISTED = 80;
/** The most token names a "no such pool" answer lists. */
const MAX_TOKENS_LISTED = 60;
/** The largest /v1/pools answer read (today's is about 9 KB). */
const MAX_POOLS_BODY = 1_000_000;
/** How long one /v1/pools request may take, and a whole quote. */
const POOLS_TIMEOUT_MS = 10_000;
export const QUOTE_DEADLINE_MS = 15_000;

/** A signal that aborts after `ms`, or when `outer` does (the client stopped
 *  waiting). Built by hand: AbortSignal.any needs a newer Node than the
 *  package supports. */
function deadline(ms: number, outer?: AbortSignal): AbortSignal {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new Error(`no answer within ${ms / 1000} s`)), ms);
  t.unref?.();
  if (outer?.aborted) c.abort(outer.reason);
  else outer?.addEventListener("abort", () => c.abort(outer.reason), { once: true });
  return c.signal;
}

/**
 * Parse `/v1/pools`. The pair comes from `lp_token_name` ("TC CBTC/CC LP"),
 * the order of the pool party; the reserves come from `token1_holdings` and
 * `token2_holdings`, which follow the row's own `token1`/`token2`, a different
 * order for some pools (CBTC/CC lists token1=CC). Rows without two plain
 * symbols are skipped.
 */
export function parsePoolRows(body: unknown): PoolRow[] {
  const rows = Array.isArray(body)
    ? body
    : Array.isArray((body as { pools?: unknown } | null)?.pools)
      ? (body as { pools: unknown[] }).pools
      : undefined;
  if (!rows) throw new Error("unexpected answer from Tradecraft /v1/pools");
  const out: PoolRow[] = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    if (typeof r !== "object" || r === null) continue;
    const t1 = symbol(r.token1);
    const t2 = symbol(r.token2);
    const lp = typeof r.lp_token_name === "string" ? /^TC\s+(\S+)\/(\S+)\s+LP$/.exec(r.lp_token_name) : null;
    const l1 = symbol(lp?.[1]);
    const l2 = symbol(lp?.[2]);
    const pair: [string, string] | undefined = l1 && l2 ? [l1, l2] : t1 && t2 ? [t1, t2] : undefined;
    if (!pair) continue;
    const reserves: Record<string, number> = {};
    if (t1) reserves[t1] = num(r.token1_holdings);
    if (t2) reserves[t2] = num(r.token2_holdings);
    out.push({ pair, reserves, feePct: num(r.lp_fee_percent) + num(r.operator_fee_percent) });
  }
  return out;
}

/** Tradecraft's pools. Its edge 403s a request without a User-Agent and
 *  answers 5xx now and then, so a 5xx or a dropped connection is tried again;
 *  a read moves nothing, so that is safe. Stops when `signal` aborts. */
export async function fetchPoolRows(opts: {
  api?: string;
  fetchImpl?: typeof globalThis.fetch;
  attempts?: number;
  retryMs?: number;
  signal?: AbortSignal;
}): Promise<PoolRow[]> {
  const f = opts.fetchImpl ?? globalThis.fetch;
  const api = (opts.api ?? process.env.CANTON_AGENT_TRADECRAFT_API ?? DEFAULT_TRADECRAFT_API).replace(/\/$/, "");
  const attempts = opts.attempts ?? 3;
  let why = "";
  for (let i = 0; i < attempts && !opts.signal?.aborted; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, opts.retryMs ?? 1000));
    let res: Response;
    try {
      res = await f(`${api}/v1/pools`, {
        headers: { "user-agent": "canton-agent-wallet", accept: "application/json" },
        signal: deadline(POOLS_TIMEOUT_MS, opts.signal),
      });
    } catch {
      why = "no answer";
      continue;
    }
    if (res.ok) {
      const body = await readCapped(res, MAX_POOLS_BODY);
      if (body === undefined) throw new Error("Tradecraft's pool list is too large to read");
      return parsePoolRows(JSON.parse(body));
    }
    why = `HTTP ${res.status}`;
    if (res.status < 500) break;
  }
  throw new Error(`Tradecraft's pool list could not be read (${why || "cancelled"}); try again in a minute`);
}

/** A response body read up to `max` bytes, or undefined past that: the read
 *  stops there instead of holding a huge answer in memory first. */
export async function readCapped(res: Response, max: number): Promise<string | undefined> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A reserve or a price, short: whole numbers with separators from 1000 up,
 *  two decimals from 1, four significant digits below. */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "?";
  const a = Math.abs(n);
  if (a >= 1000) return Math.round(n).toLocaleString("en-US");
  if (a >= 1) return String(Number(n.toFixed(2)));
  if (a === 0) return "0";
  return String(Number(n.toPrecision(4)));
}

const isCC = (s: string): boolean => resolveSwapSymbol(s).kind === "cc";
const known = (s: string): boolean => resolveSwapSymbol(s).kind !== "unknown";

/** A filter symbol in the pools' spelling: CC for its aliases (amulet,
 *  canton-coin), a known token's canonical case, anything else as given. */
function canonical(s: string): string {
  const leg = resolveSwapSymbol(s);
  return leg.kind === "unknown" ? s.trim() : leg.symbol;
}

function poolLine(p: PoolRow, showFee: boolean): string {
  const [a, b] = p.pair;
  const ra = p.reserves[a] ?? NaN;
  const rb = p.reserves[b] ?? NaN;
  // A pair with CC is priced in CC; any other pair as its first token in the second.
  const price = isCC(a) ? `1 ${b} = ${fmtNum(ra / rb)} ${a}` : `1 ${a} = ${fmtNum(rb / ra)} ${b}`;
  return `  ${a}/${b}: ${fmtNum(ra)} ${a} + ${fmtNum(rb)} ${b}; ${price}${showFee ? `; fee ${fmtNum(p.feePct)}%` : ""}`;
}

/** Deepest CC pools first (by the CC reserve), then the rest by name. */
function byDepth(x: PoolRow, y: PoolRow): number {
  const cc = (p: PoolRow): number => {
    const s = p.pair.find(isCC);
    return s === undefined ? -1 : p.reserves[s] ?? -1;
  };
  return cc(y) - cc(x) || x.pair.join("/").localeCompare(y.pair.join("/"));
}

export interface PoolFilter {
  /** Only pools with this token; with `out` too, only that pair. */
  in?: string | undefined;
  out?: string | undefined;
  /** The owner has a CC cap set, so `swap` refuses a swap with no CC leg. */
  capsSet: boolean;
}

/** swap_quote's pool list, grouped by what `swap` can do with each pool. */
export function formatPools(rows: readonly PoolRow[], f: PoolFilter): string {
  if (rows.length === 0) return "Tradecraft lists no pools right now; try again in a minute.";
  const want = [f.in, f.out].filter((s): s is string => s !== undefined).map(canonical);
  const has = (p: PoolRow, s: string): boolean => p.pair.some((x) => x.toLowerCase() === s.toLowerCase());
  const hits = rows.filter((p) => want.every((s) => has(p, s)));
  if (hits.length === 0) {
    const tokens = [...new Set(rows.flatMap((p) => p.pair))].sort((x, y) => x.localeCompare(y));
    const more = tokens.length > MAX_TOKENS_LISTED ? ` and ${tokens.length - MAX_TOKENS_LISTED} more` : "";
    return `No Tradecraft pool for ${want.join("/")}. Tokens with a pool: ${tokens.slice(0, MAX_TOKENS_LISTED).join(", ")}${more}.`;
  }
  const fees = new Map<number, number>();
  for (const p of hits) fees.set(p.feePct, (fees.get(p.feePct) ?? 0) + 1);
  const usualFee = [...fees.entries()].sort((x, y) => y[1] - x[1])[0]![0];
  const tradable: PoolRow[] = [];
  const noCcLeg: PoolRow[] = [];
  const unknown: PoolRow[] = [];
  for (const p of hits) {
    if (!p.pair.every(known)) unknown.push(p);
    else if (f.capsSet && !p.pair.some(isCC)) noCcLeg.push(p);
    else tradable.push(p);
  }
  const lines = [
    `Tradecraft pools: ${hits.length}${hits.length < rows.length ? ` of ${rows.length}` : ""}. ` +
      `Fee ${fmtNum(usualFee)}% a trade. A price here is the reserve ratio, before the fee and price impact; ` +
      "give in, out and amount for a real quote.",
  ];
  let room = MAX_POOLS_LISTED;
  const group = (title: string, ps: PoolRow[]): void => {
    if (ps.length === 0 || room === 0) return;
    const shown = ps.sort(byDepth).slice(0, room);
    room -= shown.length;
    lines.push("", `${title} (${ps.length}):`, ...shown.map((p) => poolLine(p, p.feePct !== usualFee)));
  };
  group("swap can trade", tradable);
  group("Token to token: swap refuses these while a CC limit is set (swap through CC)", noCcLeg);
  group("swap cannot trade (tokens this wallet does not know)", unknown);
  if (hits.length > MAX_POOLS_LISTED) lines.push("", `${hits.length - MAX_POOLS_LISTED} more; narrow the list with in.`);
  return lines.join("\n");
}

/** A venue's quote line, short: eight significant digits. Tradecraft's
 *  ticket carries no number when its API did not answer (swap's direct path
 *  then fills at market). */
const quoteLine = (venue: SwapVenue, q: string, out: string): string => {
  const n = Number(q);
  return Number.isFinite(n)
    ? `- ${venue}: ~${String(Number(n.toPrecision(8)))} ${out}`
    : `- ${venue}: no quote right now (its API did not answer)`;
};

/** Why a venue could not quote, as a fixed phrase: a venue's own error text
 *  is never passed on. */
export function venueReason(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/abort|no answer within|timed? ?out/i.test(m)) return "no answer in time";
  if (/no Tradecraft pool for the pair/i.test(m)) return "no pool for this pair";
  if (/cannot resolve the DSO party/i.test(m)) return "no DSO party is pinned for this network";
  if (/does not identify the requested output/i.test(m)) return "it quoted a different token (refused)";
  if (/could not quote after/i.test(m)) return "no quote after several tries";
  const http = /HTTP (\d{3})/.exec(m);
  if (http) return `HTTP ${http[1]}`;
  if (/unexpected .*response|non-numeric/i.test(m)) return "an answer that could not be read";
  return "the venue could not quote";
}

/** resolveSwapTicket's advisory lines are this package's own text, except the
 *  venue error inside "Cantex could not quote (…)". */
const cleanNote = (n: string): string =>
  /^Cantex could not quote \(.*\); routing to Tradecraft$/s.test(n) ? "Cantex could not quote; routing to Tradecraft" : n;

/**
 * The venues' quote builders, held to one deadline: they give up at `ms` or
 * when `signal` aborts, and ask a venue at most twice. For a free quote that
 * runs where a hung venue would hold something else up (swap's queue).
 */
export function timedQuoteDeps(signal: AbortSignal | undefined, ms = QUOTE_DEADLINE_MS) {
  const stop = deadline(ms, signal);
  const fetchImpl = ((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
    globalThis.fetch(input, { ...init, signal: stop })) as typeof globalThis.fetch;
  return {
    buildCantexTicket: (o: Parameters<typeof buildCantexTicket>[0]) => buildCantexTicket({ ...o, fetchImpl, quoteAttempts: 2 }),
    buildLocalTicket: (o: Parameters<typeof buildLocalTicket>[0]) => buildLocalTicket({ ...o, fetchImpl, quoteAttempts: 2 }),
  };
}

/**
 * Free quotes for one swap, from each venue `swap` would ask, and the venue
 * its default route and `auto` would take. `refusal` is swap's own policy
 * gate for the picked ticket: when it refuses, that is said instead of a
 * venue. `ok` is false when no venue could quote (a `swap` now would fail the
 * same way). Never pays: the direct path builds no paying fetch. The whole
 * quote stops at `deadlineMs` (QUOTE_DEADLINE_MS), or when `signal` aborts.
 */
export async function quoteSwap(opts: {
  intent: SwapIntent;
  amount: string;
  dsoParty: string | undefined;
  refusal?: (picked: SwapTicket) => Promise<string | undefined>;
  signal?: AbortSignal;
  deadlineMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ok: boolean; text: string }> {
  const { intent, amount } = opts;
  const timed = timedQuoteDeps(opts.signal, opts.deadlineMs ?? QUOTE_DEADLINE_MS);
  const answers = new Map<SwapVenue, Promise<SwapTicket>>();
  const once =
    <O extends object>(venue: SwapVenue, build: (o: O) => Promise<SwapTicket>) =>
    (o: O): Promise<SwapTicket> => {
      let p = answers.get(venue);
      if (!p) {
        p = build(o);
        p.catch(() => undefined);
        answers.set(venue, p);
      }
      return p;
    };
  const route = {
    intent,
    amount,
    // Slippage only shapes a ticket's minimum; a quote does not show one.
    slippagePct: 1,
    venueExplicit: false,
    direct: true,
    dsoParty: opts.dsoParty,
    ...(opts.env ? { env: opts.env } : {}),
    deps: {
      buildCantexTicket: once("cantex", timed.buildCantexTicket),
      buildLocalTicket: once("tradecraft", timed.buildLocalTicket),
    },
  };
  // Both routes start together, so the venues are asked at the same time.
  const [byDefault, byAuto] = await Promise.allSettled([
    resolveSwapTicket({ ...route, venue: DEFAULT_SWAP_VENUE }),
    resolveSwapTicket({ ...route, venue: "auto" }),
  ]);
  const lines = [`Free quotes for ${amount} ${intent.inCanon} -> ${intent.outCanon}. Nothing moved; prices move.`];
  for (const venue of ["cantex", "tradecraft"] as const) {
    const p = answers.get(venue);
    if (!p) continue;
    try {
      lines.push(quoteLine(venue, (await p).quote, intent.outCanon));
    } catch (e) {
      lines.push(`- ${venue}: no quote (${venueReason(e)})`);
    }
  }
  if (byDefault.status === "rejected") {
    lines.push(`swap would fail now: ${venueReason(byDefault.reason)}.`);
    return { ok: false, text: lines.join("\n") };
  }
  const picked = byDefault.value.ticket;
  // The quote is built without a ticket; swap with no venue buys one, and
  // refuses one below Tradecraft's minimum (the pool would not take the input).
  const tcMin = (picked.venue ?? "tradecraft") === "tradecraft" ? tradecraftMinInput(intent.inCanon) : undefined;
  const belowMin = tcMin !== undefined && Number(amount) < tcMin;
  const refused = await opts.refusal?.(picked);
  if (refused !== undefined) {
    lines.push(`swap would be refused by the owner's limits: ${refused}`);
  } else if (belowMin) {
    lines.push(
      `swap with no venue would refuse this: ${amount} ${intent.inCanon} is below Tradecraft's advertised minimum of ` +
        `${tcMin} ${intent.inCanon}, and the pool would not take it. A direct or auto swap pays no ticket fee and may still try.`
    );
  } else {
    // The larger numeric quote `auto` found, if it is not the default's venue.
    const best = byAuto.status === "fulfilled" ? byAuto.value.ticket : undefined;
    const bestVenue = best && Number.isFinite(Number(best.quote)) ? (best.venue ?? "tradecraft") : undefined;
    const usual = picked.venue ?? "tradecraft";
    lines.push(
      bestVenue === undefined || bestVenue === usual
        ? `swap with no venue would use ${usual}.`
        : `swap with no venue would use ${usual}, but ${bestVenue} quotes more: to swap there, call swap with venue "${bestVenue}".`,
      "Unless direct: true or venue auto, swap also pays a 0.01 CC ticket fee. On Tradecraft the ticket carries a minimum output; a direct or auto swap fills at market unless CANTON_AGENT_TRADECRAFT_MEMO_KEY is set.",
    );
  }
  lines.push(
    ...byDefault.value.notes
      .filter((n) => n.level === "warn" && !(belowMin && /advertised minimum/.test(n.text)))
      .map((n) => cleanNote(n.text))
  );
  if (opts.dsoParty === undefined) {
    lines.push("Cantex was not quoted: no DSO party is pinned for this network, so swap may pick another venue.");
  }
  return { ok: true, text: lines.join("\n") };
}
