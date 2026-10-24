import { describe, it, expect, vi } from "vitest";
import {
  resolveSwapIntent,
  resolveSwapTicket,
  swapFloorNotes,
  parseSwapVenue,
  parseSlippagePct,
  DEFAULT_TRADECRAFT_AMM_CID,
  type SwapNote,
} from "./swap-route.js";
import { CANTEX_CONNECT_PARTY, CANTEX_MEMO_KEY, type SwapTicket } from "./swap.js";
import { KNOWN_INSTRUMENTS } from "./registry-parties.js";

const USDCX = KNOWN_INSTRUMENTS["USDCx"]!;
const DSO = "DSO::1220dso";

const ccToUsdcx = resolveSwapIntent("CC", "USDCx");

const cantexTicket = (quote: string): SwapTicket => ({
  venue: "cantex",
  poolParty: CANTEX_CONNECT_PARTY,
  minOutput: quote,
  memoKey: CANTEX_MEMO_KEY,
  memoValue: "USDCx",
  quote,
  inInstrument: null,
  outInstrument: USDCX,
});
const tradecraftTicket = (quote: string, memo = true): SwapTicket => ({
  venue: "tradecraft",
  poolParty: `tc-swp_CC-USDCx::${DEFAULT_TRADECRAFT_AMM_CID}`,
  minOutput: quote,
  ...(memo ? { memoKey: CANTEX_MEMO_KEY, memoValue: quote } : {}),
  quote,
  inInstrument: null,
  outInstrument: USDCX,
});

/** A routing harness: every quote builder is a spy, nothing touches the network. */
function harness(o: {
  cantex?: () => Promise<SwapTicket>;
  local?: () => Promise<SwapTicket>;
  endpoint?: (opts: { venue?: string }) => Promise<SwapTicket>;
}) {
  const deps = {
    buildCantexTicket: vi.fn(o.cantex ?? (async () => cantexTicket("60"))),
    buildLocalTicket: vi.fn(o.local ?? (async () => tradecraftTicket("59"))),
    fetchTicketFromEndpoint: vi.fn(o.endpoint ?? (async () => cantexTicket("61"))),
  };
  const payingFetch = vi.fn(async () => globalThis.fetch);
  const notes: SwapNote[] = [];
  return { deps, payingFetch, notes, onNote: (n: SwapNote) => notes.push(n) };
}

describe("resolveSwapIntent — fail closed on the legs", () => {
  it("resolves canonical casing and a null instrument for CC", () => {
    const i = resolveSwapIntent("usdcx", "cc");
    expect(i.inCanon).toBe("USDCx");
    expect(i.outCanon).toBe("CC");
    expect(i.inInstrument).toEqual(USDCX);
    expect(i.outInstrument).toBeNull();
  });

  it("an unknown symbol is an error naming the caller's label, never a CC fallback", () => {
    expect(() => resolveSwapIntent("USDC", "CC", { in: "--in", out: "--out" })).toThrow(
      /--in "USDC" is not a known instrument/
    );
    expect(() => resolveSwapIntent("CC", "nope")).toThrow(/out "nope" is not a known instrument/);
  });

  it("CC for CC is refused", () => {
    expect(() => resolveSwapIntent("CC", "amulet")).toThrow(/both CC/);
  });
});

describe("parseSwapVenue / parseSlippagePct", () => {
  it("defaults, lowercases, and rejects anything else", () => {
    expect(parseSwapVenue(undefined)).toBe("cantex");
    expect(parseSwapVenue("Tradecraft")).toBe("tradecraft");
    expect(parseSwapVenue("AUTO")).toBe("auto");
    expect(() => parseSwapVenue("uniswap")).toThrow(/cantex, tradecraft, or auto/);
  });
  it("slippage defaults to 1 and must sit in [0, 100)", () => {
    expect(parseSlippagePct(undefined)).toBe(1);
    expect(parseSlippagePct("0")).toBe(0);
    expect(parseSlippagePct(2.5)).toBe(2.5);
    for (const bad of ["100", "-1", "abc"]) {
      expect(() => parseSlippagePct(bad)).toThrow(/\[0, 100\)/);
    }
  });
});

describe("resolveSwapTicket — venue routing", () => {
  const base = {
    intent: ccToUsdcx,
    amount: "60",
    slippagePct: 1,
    dsoParty: DSO,
    env: {} as NodeJS.ProcessEnv,
  };

  it("default (cantex, not explicit): a CC input under the 50 CC minimum routes to Tradecraft with a warning, paying no fee", async () => {
    const h = harness({});
    const r = await resolveSwapTicket({
      ...base,
      amount: "10",
      venue: "cantex",
      venueExplicit: false,
      direct: true,
      deps: h.deps,
      payingFetch: h.payingFetch,
      onNote: h.onNote,
    });
    expect(r.ticket.venue).toBe("tradecraft");
    expect(h.deps.buildCantexTicket).not.toHaveBeenCalled();
    expect(h.deps.buildLocalTicket).toHaveBeenCalledTimes(1);
    expect(h.payingFetch).not.toHaveBeenCalled();
    expect(r.notes).toEqual(h.notes);
    expect(r.notes[0]).toEqual({
      level: "warn",
      text: "Cantex Connect minimum is 50 CC (got 10 CC); routing to Tradecraft",
    });
  });

  it("explicit cantex under the minimum is an ERROR — nothing is quoted", async () => {
    const h = harness({});
    await expect(
      resolveSwapTicket({ ...base, amount: "10", venue: "cantex", venueExplicit: true, direct: true, deps: h.deps })
    ).rejects.toThrow(/Cantex Connect minimum is 50 CC \(got 10 CC\) — use the tradecraft venue/);
    expect(h.deps.buildCantexTicket).not.toHaveBeenCalled();
    expect(h.deps.buildLocalTicket).not.toHaveBeenCalled();
  });

  it("default: a Cantex quote failure falls back to Tradecraft (warn); explicit cantex surfaces it", async () => {
    const boom = async () => {
      throw new Error("Cantex Connect could not quote after 4 attempts");
    };
    const h = harness({ cantex: boom });
    const r = await resolveSwapTicket({ ...base, venue: "cantex", venueExplicit: false, direct: true, deps: h.deps, onNote: h.onNote });
    expect(r.ticket.venue).toBe("tradecraft");
    expect(h.notes[0]?.level).toBe("warn");
    expect(h.notes[0]?.text).toMatch(/^Cantex could not quote \(Cantex Connect could not quote.*\); routing to Tradecraft$/);

    const h2 = harness({ cantex: boom });
    await expect(
      resolveSwapTicket({ ...base, venue: "cantex", venueExplicit: true, direct: true, deps: h2.deps })
    ).rejects.toThrow(/could not quote after 4 attempts/);
    expect(h2.deps.buildLocalTicket).not.toHaveBeenCalled();
  });

  it("cantex direct without a DSO party cannot quote Cantex; the default still lands on Tradecraft", async () => {
    const h = harness({});
    const r = await resolveSwapTicket({ ...base, dsoParty: undefined, venue: "cantex", venueExplicit: false, direct: true, deps: h.deps, onNote: h.onNote });
    expect(r.ticket.venue).toBe("tradecraft");
    expect(h.notes[0]?.text).toContain("CANTON_AGENT_DSO_PARTY");
  });

  it("tradecraft: Tradecraft only, and the advisory minimum is a warning, not a block", async () => {
    const h = harness({});
    const r = await resolveSwapTicket({ ...base, amount: "5", venue: "tradecraft", venueExplicit: true, direct: true, deps: h.deps, onNote: h.onNote });
    expect(r.ticket.venue).toBe("tradecraft");
    expect(h.deps.buildCantexTicket).not.toHaveBeenCalled();
    expect(h.notes).toEqual([
      {
        level: "warn",
        text: "5 CC is below Tradecraft's advertised minimum of 6 CC — the trade may be returned unfilled (no loss). Proceeding.",
      },
    ]);
  });

  it("auto: free direct quotes from every eligible venue, best output wins, and the endpoint is never paid", async () => {
    const h = harness({ cantex: async () => cantexTicket("60"), local: async () => tradecraftTicket("61.5") });
    const r = await resolveSwapTicket({ ...base, venue: "auto", venueExplicit: true, direct: false, deps: h.deps, payingFetch: h.payingFetch, onNote: h.onNote });
    expect(r.ticket.venue).toBe("tradecraft");
    expect(h.deps.fetchTicketFromEndpoint).not.toHaveBeenCalled();
    expect(h.payingFetch).not.toHaveBeenCalled();
    expect(h.notes).toEqual([{ level: "info", text: "auto: tradecraft ~61.5, cantex ~60 -> chose tradecraft" }]);
  });

  it("auto: a market-fill ticket (non-numeric quote) never beats a real quote on NaN", async () => {
    const h = harness({
      cantex: async () => cantexTicket("0.5"),
      local: async () => tradecraftTicket("unknown (Tradecraft quote API unavailable)", false),
    });
    const r = await resolveSwapTicket({ ...base, venue: "auto", venueExplicit: true, direct: true, deps: h.deps });
    expect(r.ticket.venue).toBe("cantex");
  });

  it("auto: one venue erroring uses the other; both erroring is an error carrying a reason", async () => {
    const boom = async () => {
      throw new Error("pools down");
    };
    const h = harness({ local: boom });
    const r = await resolveSwapTicket({ ...base, venue: "auto", venueExplicit: true, direct: true, deps: h.deps });
    expect(r.ticket.venue).toBe("cantex");

    const h2 = harness({ local: boom, cantex: boom });
    await expect(
      resolveSwapTicket({ ...base, venue: "auto", venueExplicit: true, direct: true, deps: h2.deps })
    ).rejects.toThrow(/no venue could quote CC\/USDCx — pools down/);
  });

  it("auto skips Cantex for a CC input under its minimum", async () => {
    const h = harness({});
    const r = await resolveSwapTicket({ ...base, amount: "10", venue: "auto", venueExplicit: true, direct: true, deps: h.deps });
    expect(r.ticket.venue).toBe("tradecraft");
    expect(h.deps.buildCantexTicket).not.toHaveBeenCalled();
  });

  it("endpoint path: the paying fetch is built exactly once, only when taken, and the venue is passed through", async () => {
    const h = harness({
      endpoint: async (o) => (o.venue === "tradecraft" ? tradecraftTicket("59") : cantexTicket("61")),
    });
    const r = await resolveSwapTicket({ ...base, venue: "tradecraft", venueExplicit: true, direct: false, deps: h.deps, payingFetch: h.payingFetch });
    expect(r.ticket.venue).toBe("tradecraft");
    expect(h.payingFetch).toHaveBeenCalledTimes(1);
    expect(h.deps.fetchTicketFromEndpoint).toHaveBeenCalledTimes(1);
    expect(h.deps.fetchTicketFromEndpoint.mock.calls[0]![0]).toMatchObject({
      venue: "tradecraft",
      swapUrl: "https://swap.ftptech.xyz",
      trustedAmmCid: DEFAULT_TRADECRAFT_AMM_CID,
      trustedCantexParty: CANTEX_CONNECT_PARTY,
      inInstrument: null,
      outInstrument: USDCX,
    });
    expect(h.deps.buildLocalTicket).not.toHaveBeenCalled();
  });

  it("endpoint path without a paying fetch fails closed instead of quoting locally", async () => {
    const h = harness({});
    await expect(
      resolveSwapTicket({ ...base, venue: "tradecraft", venueExplicit: true, direct: false, deps: h.deps })
    ).rejects.toThrow(/needs a paying fetch/);
    expect(h.deps.buildLocalTicket).not.toHaveBeenCalled();
  });

  it("direct never constructs the paying fetch", async () => {
    const h = harness({});
    await resolveSwapTicket({ ...base, venue: "cantex", venueExplicit: true, direct: true, deps: h.deps, payingFetch: h.payingFetch });
    expect(h.payingFetch).not.toHaveBeenCalled();
    expect(h.deps.fetchTicketFromEndpoint).not.toHaveBeenCalled();
  });

  it("env overrides reach the local builders (amm cid, memo key, api, swap url)", async () => {
    const h = harness({});
    const env = {
      CANTON_AGENT_TRADECRAFT_AMM_CID: "1220custom",
      CANTON_AGENT_TRADECRAFT_MEMO_KEY: "k",
      CANTON_AGENT_TRADECRAFT_API: "https://tc.test",
      CANTON_AGENT_SWAP_URL: "https://swap.test",
    } as NodeJS.ProcessEnv;
    await resolveSwapTicket({ ...base, env, venue: "tradecraft", venueExplicit: true, direct: true, deps: h.deps });
    expect(h.deps.buildLocalTicket.mock.calls[0]![0]).toMatchObject({
      tradecraftApi: "https://tc.test",
      ammCid: "1220custom",
      memoKey: "k",
    });
    const h2 = harness({});
    await resolveSwapTicket({ ...base, env, venue: "tradecraft", venueExplicit: true, direct: false, deps: h2.deps, payingFetch: h2.payingFetch });
    expect(h2.deps.fetchTicketFromEndpoint.mock.calls[0]![0]).toMatchObject({
      swapUrl: "https://swap.test",
      trustedAmmCid: "1220custom",
    });
  });
});

describe("swapFloorNotes — what bounds the fill is always said", () => {
  it("Cantex: the quote is expected, not a floor", () => {
    const n = swapFloorNotes(cantexTicket("60"), 1, "USDCx");
    expect(n.map((x) => x.level)).toEqual(["info", "warn"]);
    expect(n[0]!.text).toBe("~60 USDCx expected (Cantex Connect quote)");
    expect(n[1]!.text).toMatch(/^no on-ledger floor on Cantex/);
    expect(n[1]!.text).toContain("slippage 1% only sets the delivery threshold");
  });
  it("Tradecraft with a memo key: the minimum is enforced", () => {
    expect(swapFloorNotes(tradecraftTicket("59"), 2, "USDCx")).toEqual([
      { level: "info", text: "min 59 enforced at 2% slippage" },
    ]);
  });
  it("Tradecraft without a memo key: market fill, said as a warning", () => {
    const n = swapFloorNotes(tradecraftTicket("59", false), 1, "USDCx");
    expect(n).toHaveLength(1);
    expect(n[0]!.level).toBe("warn");
    expect(n[0]!.text).toMatch(/^no slippage protection on this ticket/);
  });
});
