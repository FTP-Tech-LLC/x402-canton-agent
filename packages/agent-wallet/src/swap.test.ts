import { describe, it, expect, vi, afterEach } from "vitest";
import {
  computeMinOutput,
  derivePoolParty,
  parseTradecraftQuote,
  parseTradecraftPools,
  resolvePoolPair,
  buildLocalTicket,
  parseEndpointTicket,
  fetchTicketFromEndpoint,
  executeSwap,
  type SwapTicket,
} from "./swap.js";
import * as withdrawMod from "./withdraw.js";
import * as txMod from "./tx.js";

const AMM = "122096fe076cc065af0cb38f94caa60e8ddfecbe8f0cfe10655ae7aa06fab99c66b7";

/** Mock fetch that answers /v1/pools and /v1/quoteForFixedInput. Each pool is
 *  given by its CANONICAL order [A, B] — emitted as lp_token_name "TC A/B LP" and
 *  with token1/token2 DELIBERATELY REVERSED, to prove the parser trusts the LP
 *  name (the pool-party order), not token1/token2. */
function mockTradecraft(pools: Array<[string, string]>, userGets: number) {
  return (async (input: RequestInfo | URL) => {
    const u = String(input);
    if (u.includes("/v1/pools")) {
      return new Response(
        JSON.stringify({
          pools: pools.map(([a, b]) => ({
            token1: b, // reversed on purpose
            token2: a,
            lp_token_name: `TC ${a}/${b} LP`,
          })),
        }),
        { status: 200 }
      );
    }
    if (u.includes("/v1/quoteForFixedInput/")) {
      return new Response(JSON.stringify({ user_gets: userGets }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
}

describe("derivePoolParty", () => {
  it("builds tc-swp_{TOKEN1}-{TOKEN2}::<ammCid> in canonical order", () => {
    expect(derivePoolParty("CC", "USDCx", AMM)).toBe(`tc-swp_CC-USDCx::${AMM}`);
    expect(derivePoolParty("CBTC", "CC", AMM)).toBe(`tc-swp_CBTC-CC::${AMM}`);
  });
});

describe("parseTradecraftPools", () => {
  it("takes the canonical order from lp_token_name, NOT token1/token2", () => {
    // Real CBTC/CC pool: token1=CC,token2=CBTC but the party/LP name is CBTC-CC.
    expect(
      parseTradecraftPools({
        pools: [{ token1: "CC", token2: "CBTC", lp_token_name: "TC CBTC/CC LP" }],
      })
    ).toEqual([{ token1: "CBTC", token2: "CC" }]);
  });
  it("falls back to token1/token2 when lp_token_name is absent/unparseable", () => {
    expect(parseTradecraftPools([{ token1: "CC", token2: "USDCx" }])).toEqual([
      { token1: "CC", token2: "USDCx" },
    ]);
  });
  it("throws on a non-pool shape", () => {
    expect(() => parseTradecraftPools({})).toThrow(/\/pools/);
  });
});

describe("resolvePoolPair", () => {
  const pools = [
    { token1: "CC", token2: "USDCx" },
    { token1: "HANDL", token2: "CC" },
  ];
  it("returns the canonical order regardless of the query order", () => {
    // USDCx→CC must still resolve to the CC/USDCx pool (canonical CC first).
    expect(resolvePoolPair(pools, "USDCx", "CC")).toEqual({ token1: "CC", token2: "USDCx" });
    expect(resolvePoolPair(pools, "CC", "USDCx")).toEqual({ token1: "CC", token2: "USDCx" });
    // case-insensitive
    expect(resolvePoolPair(pools, "cc", "handl")).toEqual({ token1: "HANDL", token2: "CC" });
  });
  it("throws when no pool exists for the pair", () => {
    expect(() => resolvePoolPair(pools, "CC", "CBTC")).toThrow(/no Tradecraft pool/);
  });
});

describe("computeMinOutput", () => {
  it("applies slippage and floors to 10 decimals", () => {
    // 0.6926992848682377 * (1 - 0.03) = 0.671918... floored to 10dp
    expect(computeMinOutput(0.6926992848682377, 3)).toBe("0.6719183063");
  });

  it("0% slippage floors the quote itself to 10 decimals", () => {
    expect(computeMinOutput(0.71268645941, 0)).toBe("0.7126864594");
  });

  it("floors DOWN, never above the true minimum", () => {
    // 1.23456789019 * 1 -> floor to 10dp = 1.2345678901 (not ...902)
    expect(computeMinOutput(1.23456789019, 0)).toBe("1.2345678901");
  });

  it("returns a whole number with no trailing dot when fraction is zero", () => {
    expect(computeMinOutput(5, 0)).toBe("5");
  });

  it("rejects slippage outside [0, 100)", () => {
    expect(() => computeMinOutput(1, -1)).toThrow(/slippage/);
    expect(() => computeMinOutput(1, 100)).toThrow(/slippage/);
  });

  it("rejects a negative or non-finite quote", () => {
    expect(() => computeMinOutput(-1, 0)).toThrow(/quote/);
    expect(() => computeMinOutput(NaN, 0)).toThrow(/quote/);
  });
});

describe("parseTradecraftQuote", () => {
  it("reads user_gets", () => {
    expect(parseTradecraftQuote({ user_gets: 0.69 })).toBe(0.69);
  });
  it("throws on a malformed body", () => {
    expect(() => parseTradecraftQuote({})).toThrow(/Tradecraft quote/);
    expect(() => parseTradecraftQuote({ user_gets: "x" })).toThrow();
    expect(() => parseTradecraftQuote(null)).toThrow();
  });
});

describe("buildLocalTicket", () => {
  it("assembles a ticket from /pools + a live quote (mocked fetch)", async () => {
    const t = await buildLocalTicket({
      tradecraftApi: "https://api.tradecraft.fi",
      ammCid: AMM,
      memoKey: "tc.minOutput",
      inSymbol: "CC",
      outSymbol: "USDCx",
      amount: "6",
      slippagePct: 3,
      inInstrument: null,
      outInstrument: { admin: "reg::1220", id: "USDCx" },
      fetchImpl: mockTradecraft([["CC", "USDCx"]], 0.6926992848682377),
    });
    expect(t.poolParty).toBe(`tc-swp_CC-USDCx::${AMM}`);
    expect(t.minOutput).toBe("0.6719183063");
    expect(t.memoKey).toBe("tc.minOutput");
    expect(t.quote).toBe("0.6926992848682377");
    expect(t.inInstrument).toBeNull();
    expect(t.outInstrument).toEqual({ admin: "reg::1220", id: "USDCx" });
  });

  it("uses the pool's CANONICAL order even when swapping the reverse direction", async () => {
    // USDCx→CC must target the CC/USDCx pool party, not tc-swp_USDCx-CC.
    const t = await buildLocalTicket({
      tradecraftApi: "https://api.tradecraft.fi",
      ammCid: AMM,
      inSymbol: "USDCx",
      outSymbol: "CC",
      amount: "0.5",
      slippagePct: 1,
      inInstrument: { admin: "reg::1220", id: "USDCx" },
      outInstrument: null,
      fetchImpl: mockTradecraft([["CC", "USDCx"]], 4.29),
    });
    expect(t.poolParty).toBe(`tc-swp_CC-USDCx::${AMM}`);
  });

  it("omits memoKey when none is given (market swap, no protection)", async () => {
    const t = await buildLocalTicket({
      tradecraftApi: "https://api.tradecraft.fi",
      ammCid: AMM,
      inSymbol: "CC",
      outSymbol: "USDCx",
      amount: "6",
      slippagePct: 1,
      inInstrument: null,
      outInstrument: null,
      fetchImpl: mockTradecraft([["CC", "USDCx"]], 0.7),
    });
    expect(t.memoKey).toBeUndefined();
    // minOutput is still computed (for display), just not enforced.
    expect(t.minOutput).toBe("0.693");
  });

  it("throws when the pair has no pool", async () => {
    await expect(
      buildLocalTicket({
        tradecraftApi: "https://api.tradecraft.fi",
        ammCid: AMM,
        inSymbol: "CC",
        outSymbol: "USDXLR",
        amount: "6",
        slippagePct: 1,
        inInstrument: null,
        outInstrument: { admin: "reg::1220", id: "USDXLR" },
        fetchImpl: mockTradecraft([["CC", "USDCx"]], 1),
      })
    ).rejects.toThrow(/no Tradecraft pool/);
  });

  it("throws on a non-OK /pools response", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 502 })) as unknown as typeof globalThis.fetch;
    await expect(
      buildLocalTicket({
        tradecraftApi: "https://api.tradecraft.fi",
        ammCid: AMM,
        inSymbol: "CC",
        outSymbol: "USDCx",
        amount: "6",
        slippagePct: 1,
        inInstrument: null,
        outInstrument: null,
        fetchImpl,
      })
    ).rejects.toThrow(/HTTP 502/);
  });
});

describe("parseEndpointTicket", () => {
  it("parses a well-formed endpoint ticket, ignoring extra fields (ammCid)", () => {
    const t = parseEndpointTicket({
      poolParty: `tc-swp_CC-USDCx::${AMM}`,
      minOutput: "0.671",
      memoKey: "tc.min",
      quote: "0.6926",
      inInstrument: null,
      outInstrument: { admin: "reg::1220", id: "USDCx" },
      ammCid: AMM,
    });
    expect(t.poolParty).toBe(`tc-swp_CC-USDCx::${AMM}`);
    expect(t.memoKey).toBe("tc.min");
    expect(t.inInstrument).toBeNull();
    expect(t.outInstrument).toEqual({ admin: "reg::1220", id: "USDCx" });
  });
  it("throws on a malformed ticket or instrument", () => {
    expect(() => parseEndpointTicket({ poolParty: 1, minOutput: "x", quote: "y" })).toThrow(/malformed ticket/);
    expect(() =>
      parseEndpointTicket({ poolParty: "p", minOutput: "1", quote: "1", inInstrument: { admin: 5 } })
    ).toThrow(/malformed instrument/);
  });
});

const USDCX = { admin: "reg::1220", id: "USDCx" };

/** A paying fetch that returns whatever ticket JSON `body` provides. */
function endpointReturning(body: unknown): typeof globalThis.fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof globalThis.fetch;
}
const goodTicket = {
  poolParty: `tc-swp_CC-USDCx::${AMM}`,
  minOutput: "0.671",
  quote: "0.6926",
  inInstrument: null,
  outInstrument: USDCX,
  ammCid: AMM,
};

describe("fetchTicketFromEndpoint", () => {
  it("pays the 402 and returns the endpoint's ticket when it matches intent", async () => {
    let calledUrl = "";
    const payingFetch = (async (input: RequestInfo | URL) => {
      calledUrl = String(input);
      return new Response(JSON.stringify(goodTicket), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const t = await fetchTicketFromEndpoint({
      swapUrl: "https://swap.example",
      inSymbol: "CC",
      outSymbol: "USDCx",
      amount: "6",
      slippagePct: 1,
      payingFetch,
      inInstrument: null,
      outInstrument: USDCX,
      trustedAmmCid: AMM,
    });
    expect(calledUrl).toBe("https://swap.example/swap?in=CC&out=USDCx&amount=6&slippage=1");
    expect(t.poolParty).toBe(`tc-swp_CC-USDCx::${AMM}`);
  });

  it("accepts the reverse canonical pool order (tc-swp_USDCx-CC) too", async () => {
    const t = await fetchTicketFromEndpoint({
      swapUrl: "https://swap.example",
      inSymbol: "CC",
      outSymbol: "USDCx",
      amount: "6",
      slippagePct: 1,
      payingFetch: endpointReturning({ ...goodTicket, poolParty: `tc-swp_USDCx-CC::${AMM}` }),
      inInstrument: null,
      outInstrument: USDCX,
      trustedAmmCid: AMM,
    });
    expect(t.poolParty).toBe(`tc-swp_USDCx-CC::${AMM}`);
  });

  it("REFUSES a pool party under an attacker namespace (fund-redirect defense)", async () => {
    await expect(
      fetchTicketFromEndpoint({
        swapUrl: "https://swap.example",
        inSymbol: "CC",
        outSymbol: "USDCx",
        amount: "6",
        slippagePct: 1,
        // hostile endpoint: pool party under the attacker's own namespace
        payingFetch: endpointReturning({ ...goodTicket, poolParty: "attacker::1220dead" }),
        inInstrument: null,
        outInstrument: USDCX,
        trustedAmmCid: AMM,
      })
    ).rejects.toThrow(/not the trusted CC\/USDCx pool/);
  });

  it("REFUSES a pool party under a DIFFERENT amm_cid (cannot forge our amm_cid)", async () => {
    await expect(
      fetchTicketFromEndpoint({
        swapUrl: "https://swap.example",
        inSymbol: "CC",
        outSymbol: "USDCx",
        amount: "6",
        slippagePct: 1,
        payingFetch: endpointReturning({ ...goodTicket, poolParty: "tc-swp_CC-USDCx::1220evilamm" }),
        inInstrument: null,
        outInstrument: USDCX,
        trustedAmmCid: AMM,
      })
    ).rejects.toThrow(/not the trusted/);
  });

  it("REFUSES a swapped input instrument (endpoint cannot change what is sent)", async () => {
    await expect(
      fetchTicketFromEndpoint({
        swapUrl: "https://swap.example",
        inSymbol: "CC",
        outSymbol: "USDCx",
        amount: "6",
        slippagePct: 1,
        // endpoint tries to make the agent send USDCx instead of CC
        payingFetch: endpointReturning({ ...goodTicket, inInstrument: USDCX }),
        inInstrument: null,
        outInstrument: USDCX,
        trustedAmmCid: AMM,
      })
    ).rejects.toThrow(/different input instrument/);
  });

  it("REFUSES a non-numeric minOutput", async () => {
    await expect(
      fetchTicketFromEndpoint({
        swapUrl: "https://swap.example",
        inSymbol: "CC",
        outSymbol: "USDCx",
        amount: "6",
        slippagePct: 1,
        payingFetch: endpointReturning({ ...goodTicket, minOutput: "not-a-number" }),
        inInstrument: null,
        outInstrument: USDCX,
        trustedAmmCid: AMM,
      })
    ).rejects.toThrow(/non-numeric minOutput/);
  });

  it("throws on a non-OK endpoint response", async () => {
    const payingFetch = (async () =>
      new Response("nope", { status: 502 })) as unknown as typeof globalThis.fetch;
    await expect(
      fetchTicketFromEndpoint({
        swapUrl: "https://swap.example",
        inSymbol: "CC",
        outSymbol: "USDCx",
        amount: "6",
        slippagePct: 1,
        payingFetch,
        inInstrument: null,
        outInstrument: USDCX,
        trustedAmmCid: AMM,
      })
    ).rejects.toThrow(/HTTP 502/);
  });
});

describe("executeSwap waits for the output to land", () => {
  const WALLET = { party: "agent::1220a", privateKeyPkcs8Pem: "x", publicKeyFingerprint: "f", network: "canton:mainnet", relayUrl: "http://r" } as never;
  const USDCX = { admin: "usdcx-admin::1220", id: "USDCx" };
  const noSleep = async () => {};

  afterEach(() => vi.restoreAllMocks());

  // A relay whose output balance (holdings for a registry token, cc for CC) reads
  // from a scripted sequence — one entry consumed per read.
  function mockRelay(reads: string[], opts: { hasPreapproval?: boolean } = {}) {
    let i = 0;
    const next = () => reads[Math.min(i++, reads.length - 1)]!;
    return {
      preapprovalStatus: async () => ({ hasPreapproval: opts.hasPreapproval ?? true }),
      holdings: async () => ({ instruments: [{ admin: USDCX.admin, id: USDCX.id, holdings: [{ cid: "h", amount: next(), locked: false }] }] }),
      balance: async () => ({ cc: next() }),
    } as never;
  }
  const buyTicket: SwapTicket = { poolParty: "tc-swp_CC-USDCx::1220amm", minOutput: "0.5", quote: "0.59", inInstrument: null, outInstrument: USDCX, ammCid: "1220amm" };
  const sellTicket: SwapTicket = { poolParty: "tc-swp_CC-USDCx::1220amm", minOutput: "5", quote: "6", inInstrument: USDCX, outInstrument: null, ammCid: "1220amm" };

  it("BUY (preapproved registry output): waits for direct delivery, reports delivered", async () => {
    vi.spyOn(withdrawMod, "withdraw").mockResolvedValue({ updateId: "sent", amount: "5" });
    vi.spyOn(txMod, "claimAll").mockResolvedValue({ claimed: 0, updateIds: [] });
    // baseline 0, then 0, then 0.59 arrives directly (>= min 0.5)
    const relay = mockRelay(["0", "0", "0.5900000000"]);
    const r = await executeSwap({ amount: "5", ticket: buyTicket, wallet: WALLET, relay, hashBinding: {}, sleep: noSleep, claimAttempts: 5, claimIntervalMs: 1 });
    expect(r.delivered).toBe("0.5900000000");
    expect(r.timedOut).toBe(false);
    expect(r.claimed).toBe(0);
    expect(r.pollErrors).toBe(0);
  });

  it("SELL (CC output): claims the returning offer and detects the CC rise", async () => {
    vi.spyOn(withdrawMod, "withdraw").mockResolvedValue({ updateId: "sent", amount: "5" });
    vi.spyOn(txMod, "claimAll")
      .mockResolvedValueOnce({ claimed: 0, updateIds: [] }) // pre-send baseline claim
      .mockResolvedValueOnce({ claimed: 0, updateIds: [] }) // tick 1
      .mockResolvedValueOnce({ claimed: 1, updateIds: ["u1"] }); // tick 2: the return
    // baseline 10, then 10 (tick 1), then 16 after the claim (rise 6 >= min 5)
    const relay = mockRelay(["10.0000000000", "10.0000000000", "16.0000000000"]);
    const r = await executeSwap({ amount: "5", ticket: sellTicket, wallet: WALLET, relay, hashBinding: {}, sleep: noSleep, claimAttempts: 5, claimIntervalMs: 1 });
    expect(r.delivered).toBe("6.0000000000");
    expect(r.timedOut).toBe(false);
    expect(r.claimed).toBe(1);
    expect(r.claimedUpdateIds).toEqual(["u1"]);
  });

  it("times out cleanly when the output never arrives (below-minimum return)", async () => {
    vi.spyOn(withdrawMod, "withdraw").mockResolvedValue({ updateId: "sent", amount: "5" });
    vi.spyOn(txMod, "claimAll").mockResolvedValue({ claimed: 0, updateIds: [] });
    const relay = mockRelay(["0"]); // never rises
    const r = await executeSwap({ amount: "5", ticket: buyTicket, wallet: WALLET, relay, hashBinding: {}, sleep: noSleep, claimAttempts: 3, claimIntervalMs: 1 });
    expect(r.delivered).toBeUndefined();
    expect(r.partialRise).toBeUndefined();
    expect(r.timedOut).toBe(true);
  });

  it("--no-wait (waitForOutput:false): returns immediately, never polls the balance", async () => {
    vi.spyOn(withdrawMod, "withdraw").mockResolvedValue({ updateId: "sent", amount: "5" });
    const claimSpy = vi.spyOn(txMod, "claimAll");
    let balanceReads = 0;
    const relay = { preapprovalStatus: async () => ({ hasPreapproval: true }), holdings: async () => { balanceReads++; return { instruments: [] }; }, balance: async () => { balanceReads++; return { cc: "0" }; } } as never;
    const r = await executeSwap({ amount: "5", ticket: buyTicket, wallet: WALLET, relay, hashBinding: {}, waitForOutput: false, sleep: noSleep });
    expect(r.timedOut).toBe(false);
    expect(r.delivered).toBeUndefined();
    expect(balanceReads).toBe(0); // no baseline, no poll
    expect(claimSpy).not.toHaveBeenCalled();
  });

  it("a sub-minimum rise (unrelated inbound) does NOT end the wait as a fill — reported as partialRise", async () => {
    vi.spyOn(withdrawMod, "withdraw").mockResolvedValue({ updateId: "sent", amount: "5" });
    vi.spyOn(txMod, "claimAll").mockResolvedValue({ claimed: 0, updateIds: [] });
    // an unrelated 0.001 arrives; min is 0.5 — must keep polling, then time out honestly
    const relay = mockRelay(["0", "0.0010000000"]);
    const r = await executeSwap({ amount: "5", ticket: buyTicket, wallet: WALLET, relay, hashBinding: {}, sleep: noSleep, claimAttempts: 3, claimIntervalMs: 1 });
    expect(r.delivered).toBeUndefined();
    expect(r.timedOut).toBe(true);
    expect(r.partialRise).toBe("0.0010000000");
  });

  it("a transient relay error mid-wait NEVER throws — sentUpdateId survives, the poll continues", async () => {
    vi.spyOn(withdrawMod, "withdraw").mockResolvedValue({ updateId: "sent-and-must-survive", amount: "5" });
    vi.spyOn(txMod, "claimAll").mockResolvedValue({ claimed: 0, updateIds: [] });
    let calls = 0;
    const relay = {
      preapprovalStatus: async () => ({ hasPreapproval: true }),
      holdings: async () => {
        calls++;
        if (calls === 2) throw new Error("502 relay blip"); // first poll tick fails
        return { instruments: [{ admin: USDCX.admin, id: USDCX.id, holdings: [{ cid: "h", amount: calls >= 3 ? "0.5900000000" : "0", locked: false }] }] };
      },
      balance: async () => ({ cc: "0" }),
    } as never;
    const r = await executeSwap({ amount: "5", ticket: buyTicket, wallet: WALLET, relay, hashBinding: {}, sleep: noSleep, claimAttempts: 4, claimIntervalMs: 1 });
    expect(r.sentUpdateId).toBe("sent-and-must-survive");
    expect(r.delivered).toBe("0.5900000000");
    expect(r.pollErrors).toBe(1);
  });

  it("claims pre-existing pending offers INTO the baseline — claim runs BEFORE the baseline read", async () => {
    const order: string[] = [];
    vi.spyOn(withdrawMod, "withdraw").mockImplementation(async () => { order.push("send"); return { updateId: "sent", amount: "5" }; });
    vi.spyOn(txMod, "claimAll").mockImplementation(async () => { order.push("claim"); return { claimed: 0, updateIds: [] }; });
    let reads = 0;
    const seq = ["5.0000000000", "5.0000000000", "5.5900000000"];
    const relay = {
      preapprovalStatus: async () => ({ hasPreapproval: true }),
      holdings: async () => { order.push("read"); return { instruments: [{ admin: USDCX.admin, id: USDCX.id, holdings: [{ cid: "h", amount: seq[Math.min(reads++, seq.length - 1)]!, locked: false }] }] }; },
      balance: async () => ({ cc: "0" }),
    } as never;
    const r = await executeSwap({ amount: "5", ticket: buyTicket, wallet: WALLET, relay, hashBinding: {}, sleep: noSleep, claimAttempts: 5, claimIntervalMs: 1 });
    // a pre-existing offer must be folded into the BASELINE, so the claim must
    // precede both the baseline read and the send — otherwise it lands mid-loop
    // and its amount is misreported as the swap's fill
    expect(order.slice(0, 3)).toEqual(["claim", "read", "send"]);
    expect(r.delivered).toBe("0.5900000000");
  });

  it("locked holdings are excluded from the output balance (their archival cannot mask arrival)", async () => {
    vi.spyOn(withdrawMod, "withdraw").mockResolvedValue({ updateId: "sent", amount: "5" });
    vi.spyOn(txMod, "claimAll").mockResolvedValue({ claimed: 0, updateIds: [] });
    let i = 0;
    const scripted = [
      // baseline: 9.0 locked (pending outbound) + 0 unlocked → baseline 0
      [{ cid: "L", amount: "9.0000000000", locked: true }, { cid: "u0", amount: "0.0000000000", locked: false }],
      // tick 1: the locked holding archived (counterparty accepted) AND the pool
      // delivered 0.59 unlocked — old code saw 9.0 → 0.59 as a DROP and timed out
      [{ cid: "u1", amount: "0.5900000000", locked: false }],
    ];
    const relay = {
      preapprovalStatus: async () => ({ hasPreapproval: true }),
      holdings: async () => ({ instruments: [{ admin: USDCX.admin, id: USDCX.id, holdings: scripted[Math.min(i++, scripted.length - 1)] }] }),
      balance: async () => ({ cc: "0" }),
    } as never;
    const r = await executeSwap({ amount: "5", ticket: buyTicket, wallet: WALLET, relay, hashBinding: {}, sleep: noSleep, claimAttempts: 3, claimIntervalMs: 1 });
    expect(r.delivered).toBe("0.5900000000");
    expect(r.timedOut).toBe(false);
  });
});
