/**
 * swap-route — the venue-routing half of `swap`: resolve the two legs fail-closed,
 * pick a venue (explicit, default-with-fallback, or `auto` by best quote) and
 * produce the ticket `executeSwap` sends against.
 *
 * This is the ONE copy of that logic. The CLI `swap` command and the MCP `swap`
 * tool both call it, so a routing rule (which venue is tried first, when a
 * fallback is allowed, which minimums are checked) cannot drift between the two
 * the way two hand-kept copies of a wallet guard once did.
 *
 * Nothing here moves the swap input. The only money this module can spend is the
 * endpoint's ticket fee, on the non-direct path, through the `payingFetch` the
 * caller supplies (and bounds).
 */
import { resolveSwapSymbol, KNOWN_INSTRUMENTS } from "./registry-parties.js";
import {
  buildLocalTicket,
  buildCantexTicket,
  fetchTicketFromEndpoint,
  tradecraftMinInput,
  CANTEX_CONNECT_PARTY,
  CANTEX_CONNECT_URL,
  CANTEX_MIN_INPUT_CC,
  type SwapInstrument,
  type SwapTicket,
  type SwapVenue,
} from "./swap.js";

/** A venue to route to, or `auto` (compare free quotes, take the better output). */
export type SwapVenueChoice = SwapVenue | "auto";

/** The venue used when the caller names none. */
export const DEFAULT_SWAP_VENUE: SwapVenueChoice = "cantex";

/** Ceiling on the swap-ticket fee the endpoint may charge, in CC. The live fee is
 *  0.01 CC, so this leaves a wide margin while still bounding a hijacked endpoint
 *  to a trivial loss instead of the agent's balance. */
export const SWAP_MAX_FEE_CC = "0.5";

/** The Tradecraft AMM-rules contract every pool party derives from. CLIENT-TRUSTED
 *  (config, never the endpoint): the receiver of a Tradecraft swap must be a
 *  `tc-swp_…::<this>` party, so a compromised endpoint cannot redirect funds. */
export const DEFAULT_TRADECRAFT_AMM_CID =
  "122096fe076cc065af0cb38f94caa60e8ddfecbe8f0cfe10655ae7aa06fab99c66b7";

/** Our x402-gated ticket endpoint (the default, fee-charging path). */
export const DEFAULT_SWAP_URL = "https://swap.ftptech.xyz";

/** Tradecraft's public REST (the `direct` path quotes here). */
export const DEFAULT_TRADECRAFT_API = "https://api.tradecraft.fi";

/** Parse a venue choice; absent = the default. Throws on anything else. */
export function parseSwapVenue(raw: string | undefined): SwapVenueChoice {
  const v = (raw ?? DEFAULT_SWAP_VENUE).toLowerCase();
  if (v !== "cantex" && v !== "tradecraft" && v !== "auto") {
    throw new Error("swap: venue must be cantex, tradecraft, or auto");
  }
  return v;
}

/** Parse a slippage percentage; absent = 1%. Throws outside [0, 100). */
export function parseSlippagePct(raw: string | number | undefined): number {
  const pct = raw === undefined ? 1 : Number(raw);
  if (!Number.isFinite(pct) || pct < 0 || pct >= 100) {
    throw new Error("swap: slippage must be a percentage in [0, 100)");
  }
  return pct;
}

/** The two legs of a swap, resolved to canonical symbols + instruments. */
export interface SwapIntent {
  inCanon: string;
  outCanon: string;
  /** null = native Canton Coin. */
  inInstrument: SwapInstrument;
  outInstrument: SwapInstrument;
}

/**
 * Resolve each leg to a CANONICAL symbol, and FAIL CLOSED on an unrecognized one.
 * Without this an unknown symbol would fall back to native Canton Coin, so a typo
 * like `USDC` (for USDCx) would silently send real CC to a `tc-swp_USDC-…` pool.
 * The canonical casing also targets the real `USDCx` pool, not a case-mismatched
 * non-existent one. `labels` name the two inputs in the error the way the caller
 * spells them (`--in` for the CLI, `in` for a tool argument).
 */
export function resolveSwapIntent(
  inSym: string,
  outSym: string,
  labels: { in: string; out: string } = { in: "in", out: "out" }
): SwapIntent {
  const inLeg = resolveSwapSymbol(inSym);
  const outLeg = resolveSwapSymbol(outSym);
  for (const [label, sym, leg] of [
    [labels.in, inSym, inLeg],
    [labels.out, outSym, outLeg],
  ] as const) {
    if (leg.kind === "unknown") {
      throw new Error(
        `swap: ${label} ${JSON.stringify(sym)} is not a known instrument. ` +
          `Use CC or one of: ${Object.keys(KNOWN_INSTRUMENTS).join(", ")} ` +
          `(add others via CANTON_AGENT_REGISTRY_TRUSTED_PARTIES + code).`
      );
    }
  }
  if (inLeg.kind === "unknown" || outLeg.kind === "unknown") {
    throw new Error("unreachable"); // narrowed above
  }
  if (inLeg.kind === "cc" && outLeg.kind === "cc") {
    throw new Error(`swap: ${labels.in} and ${labels.out} are both CC — nothing to swap`);
  }
  return {
    inCanon: inLeg.symbol,
    outCanon: outLeg.symbol,
    inInstrument: inLeg.kind === "registry" ? inLeg.instrument : null,
    outInstrument: outLeg.kind === "registry" ? outLeg.instrument : null,
  };
}

/** An advisory line for the user. `info` is progress ("auto: … -> chose cantex");
 *  `warn` is something they should read before trusting the outcome (a fallback
 *  taken, a minimum not met, a missing floor). */
export interface SwapNote {
  level: "info" | "warn";
  text: string;
}

export interface ResolveSwapTicketOpts {
  intent: SwapIntent;
  /** Amount of the input instrument, as a ledger decimal string. */
  amount: string;
  slippagePct: number;
  venue: SwapVenueChoice;
  /** True when the caller NAMED the venue. An explicit `cantex` surfaces a Cantex
   *  failure or minimum as an error; the default (nothing named) routes to
   *  Tradecraft instead. A failed quote sends no funds, so neither can strand. */
  venueExplicit: boolean;
  /** Quote locally (free, no endpoint). `auto` always quotes locally. */
  direct: boolean;
  /** The FULL DSO party — Cantex quotes name Canton Coin by its admin. Required
   *  for a Cantex quote on the direct/auto path; undefined fails that venue. */
  dsoParty: string | undefined;
  /** Builds the fee-paying fetch for the endpoint path. Called only when that
   *  path is actually taken, so a direct or auto swap never constructs one (and
   *  never pays a fee). The caller bounds it (maxPaymentValue / expectedPayTo). */
  payingFetch?: () => Promise<typeof globalThis.fetch>;
  /** Streamed advisory lines, in the order they happen (also returned in
   *  `notes`). The CLI prints them as they come; a tool collects them. */
  onNote?: (note: SwapNote) => void;
  env?: NodeJS.ProcessEnv;
  /** Injectable quote builders (tests). */
  deps?: {
    buildCantexTicket?: typeof buildCantexTicket;
    buildLocalTicket?: typeof buildLocalTicket;
    fetchTicketFromEndpoint?: typeof fetchTicketFromEndpoint;
  };
}

export interface ResolvedSwapTicket {
  ticket: SwapTicket;
  notes: SwapNote[];
}

/**
 * Resolve the ticket for a swap. DEFAULT path = our x402 `/swap` endpoint (a
 * small CC fee for a ticket that stays current with each venue's pools/params);
 * the returned ticket is validated against the trusted per-venue receiver +
 * instruments inside `fetchTicketFromEndpoint`, so the endpoint is trusted for
 * price only. The `direct` path resolves the venue's quote locally (no fee).
 *
 * Venue rules (identical for every caller):
 *  - `cantex` (default): a CC input below Cantex's minimum, or a Cantex quote
 *    failure, routes to Tradecraft — unless the caller named cantex explicitly,
 *    in which case it is an error.
 *  - `tradecraft`: Tradecraft only.
 *  - `auto`: FREE direct quotes from every eligible venue, best expected output
 *    wins; one venue erroring uses the other. Never pays the endpoint fee.
 */
export async function resolveSwapTicket(
  opts: ResolveSwapTicketOpts
): Promise<ResolvedSwapTicket> {
  const env = opts.env ?? process.env;
  const { intent, amount, slippagePct } = opts;
  const d = {
    buildCantexTicket,
    buildLocalTicket,
    fetchTicketFromEndpoint,
    ...opts.deps,
  };
  const notes: SwapNote[] = [];
  const note = (level: SwapNote["level"], text: string): void => {
    const n = { level, text };
    notes.push(n);
    opts.onNote?.(n);
  };

  // CLIENT-TRUSTED constants (config, never the endpoint): the receiver of the
  // funds must equal one of these per venue, so a compromised swap endpoint can
  // never redirect the swap to an attacker party.
  const trustedAmmCid = env.CANTON_AGENT_TRADECRAFT_AMM_CID ?? DEFAULT_TRADECRAFT_AMM_CID;
  const trustedCantexParty = CANTEX_CONNECT_PARTY;

  // Cantex Connect handles BOTH directions (CC->token and token->CC). Its minimum
  // is 50 CC-equivalent. We can only check that locally for a CC input; for a
  // token input the CC-equivalent is unknown client-side, so we let Cantex's quote
  // enforce it (and fall back to Tradecraft on failure). Cantex's keyless quote can
  // also transiently fail to price a token input — buildCantexTicket retries, and
  // the default/auto paths fall back to Tradecraft if it still cannot quote.
  const inputIsCC = intent.inInstrument === null;
  const cantexRuledOut = inputIsCC && Number(amount) < CANTEX_MIN_INPUT_CC;

  const resolveDirect = async (v: SwapVenue): Promise<SwapTicket> => {
    if (v === "cantex") {
      if (!opts.dsoParty) {
        throw new Error(
          "swap: cannot resolve the DSO party for Cantex — set CANTON_AGENT_DSO_PARTY"
        );
      }
      return d.buildCantexTicket({
        connectUrl: CANTEX_CONNECT_URL,
        cantexParty: trustedCantexParty,
        dsoParty: opts.dsoParty,
        inSymbol: intent.inCanon,
        outSymbol: intent.outCanon,
        amount,
        slippagePct,
        inInstrument: intent.inInstrument,
        outInstrument: intent.outInstrument,
      });
    }
    const memoKey = env.CANTON_AGENT_TRADECRAFT_MEMO_KEY;
    const tradecraftApi = env.CANTON_AGENT_TRADECRAFT_API ?? DEFAULT_TRADECRAFT_API;
    return d.buildLocalTicket({
      tradecraftApi,
      ammCid: trustedAmmCid,
      ...(memoKey ? { memoKey } : {}),
      inSymbol: intent.inCanon,
      outSymbol: intent.outCanon,
      amount,
      slippagePct,
      inInstrument: intent.inInstrument,
      outInstrument: intent.outInstrument,
    });
  };
  const resolveEndpoint = async (v: SwapVenue): Promise<SwapTicket> => {
    if (!opts.payingFetch) {
      throw new Error(
        "swap: the endpoint path needs a paying fetch (none supplied) — use direct"
      );
    }
    const swapUrl = env.CANTON_AGENT_SWAP_URL ?? DEFAULT_SWAP_URL;
    // Built here, not up front: the endpoint auto-settles whatever 402 it answers
    // before any ticket validation, so the fetch (and its fee bound) must exist
    // only on the path that actually pays.
    const payingFetch = await opts.payingFetch();
    return d.fetchTicketFromEndpoint({
      swapUrl,
      inSymbol: intent.inCanon,
      outSymbol: intent.outCanon,
      amount,
      slippagePct,
      payingFetch,
      inInstrument: intent.inInstrument,
      outInstrument: intent.outInstrument,
      trustedAmmCid,
      trustedCantexParty,
      venue: v,
    });
  };
  const resolveOne = (v: SwapVenue): Promise<SwapTicket> =>
    opts.direct ? resolveDirect(v) : resolveEndpoint(v);

  let ticket: SwapTicket;
  if (opts.venue === "auto") {
    // Compare FREE direct quotes from eligible venues and pick the better output
    // (auto never pays the endpoint fee twice). One venue erroring uses the other.
    const candidates: SwapVenue[] = [];
    if (!cantexRuledOut) candidates.push("cantex");
    candidates.push("tradecraft");
    const settled = await Promise.allSettled(candidates.map(resolveDirect));
    const ok = settled
      .filter((x) => x.status === "fulfilled")
      .map((x) => (x as PromiseFulfilledResult<SwapTicket>).value);
    if (ok.length === 0) {
      const why = settled.find((r) => r.status === "rejected") as
        | PromiseRejectedResult
        | undefined;
      throw new Error(
        `swap: no venue could quote ${intent.inCanon}/${intent.outCanon}` +
          (why ? ` — ${why.reason instanceof Error ? why.reason.message : String(why.reason)}` : "")
      );
    }
    // Rank by numeric quote, best first; a market-fill ticket carries a non-numeric
    // quote ("unknown ...") and must sort LAST so it never beats a real quote on NaN.
    const q = (t: SwapTicket): number => {
      const n = Number(t.quote);
      return Number.isFinite(n) ? n : -Infinity;
    };
    ok.sort((a, b) => q(b) - q(a));
    ticket = ok[0]!;
    note(
      "info",
      `auto: ${ok.map((t) => `${t.venue} ~${t.quote}`).join(", ")} -> chose ${ticket.venue}`
    );
  } else if (opts.venue === "cantex") {
    if (cantexRuledOut) {
      const reason = `Cantex Connect minimum is ${CANTEX_MIN_INPUT_CC} CC (got ${amount} CC)`;
      if (opts.venueExplicit) {
        throw new Error(`swap: ${reason} — use the tradecraft venue`);
      }
      note("warn", `${reason}; routing to Tradecraft`);
      ticket = await resolveOne("tradecraft");
    } else {
      // Try Cantex; on a quote failure (e.g. its transient token->CC pricing
      // outage) the DEFAULT falls back to Tradecraft, an EXPLICIT cantex surfaces
      // the error. A failed quote sends NO funds, so this cannot strand.
      try {
        ticket = await resolveOne("cantex");
      } catch (e) {
        if (opts.venueExplicit) throw e;
        note(
          "warn",
          `Cantex could not quote (${(e instanceof Error ? e.message : String(e)).slice(0, 120)}); routing to Tradecraft`
        );
        ticket = await resolveOne("tradecraft");
      }
    }
  } else {
    ticket = await resolveOne("tradecraft");
  }

  // Advisory min-input warning for Tradecraft (mirrors its web app; not a hard
  // limit — the pool returns the funds if a small trade will not fill).
  if (ticket.venue === "tradecraft") {
    const minIn = tradecraftMinInput(intent.inCanon);
    if (minIn !== undefined && Number(amount) < minIn) {
      note(
        "warn",
        `${amount} ${intent.inCanon} is below Tradecraft's advertised minimum of ${minIn} ${intent.inCanon} — ` +
          `the trade may be returned unfilled (no loss). Proceeding.`
      );
    }
  }
  return { ticket, notes };
}

/**
 * What bounds the fill, as lines for the user. Cantex Connect fills at its own
 * rate at execution time: the memo carries the buy symbol, not a client minimum,
 * so NOTHING on-ledger bounds what comes back and slippage only sets the delivery
 * threshold the wait loop reports against. Tradecraft enforces the floor from
 * the memo when a memo key rides; with none it is a market fill and slippage did
 * nothing. Said explicitly every time, so a caller who passed a slippage never
 * reads the quiet quote line as a floor.
 */
export function swapFloorNotes(
  ticket: SwapTicket,
  slippagePct: number,
  outCanon: string
): SwapNote[] {
  if (ticket.venue === "cantex") {
    return [
      { level: "info", text: `~${ticket.quote} ${outCanon} expected (Cantex Connect quote)` },
      {
        level: "warn",
        text:
          `no on-ledger floor on Cantex — it fills at its rate when it executes; ` +
          `slippage ${slippagePct}% only sets the delivery threshold this swap reports against`,
      },
    ];
  }
  if (ticket.memoKey) {
    return [{ level: "info", text: `min ${ticket.minOutput} enforced at ${slippagePct}% slippage` }];
  }
  return [
    {
      level: "warn",
      text:
        "no slippage protection on this ticket — filling at market price " +
        "(the swap endpoint set no memo key)",
    },
  ];
}
