/**
 * Tradecraft queued mode, driven against a fake relay that answers with the
 * REAL MainNet prepared transactions captured on 2026-10-17 (see
 * __fixtures__/README.md). Every write must pass the core verify-before-sign
 * assertion and the real hash binding before anything reaches execute.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { generateAgentKey } from "./keys.js";
import { recomputeHash } from "./canton-hash.js";
import type { AgentWallet } from "./store.js";
import type { RelayClient } from "./relay-client.js";
import {
  ALLOCATION_V2_INTERFACE,
  TC_BATCHER_TEMPLATE_REF,
  TC_SWAP_ORDER_TEMPLATE_REF,
  loadTcPool,
  tcOrders,
  tcSetup,
  tcStatus,
  tcWithdraw,
  tcCancel,
  isContractContention,
  type TcContext,
  type TcPool,
} from "./tradecraft-queued.js";

const fixture = (n: string): string =>
  readFileSync(new URL(`./__fixtures__/${n}`, import.meta.url), "utf8").trim();

const AGENT = "agent::12203c17fd2cf108dcb766b7ee23d30e9d21c60a04d10a48abc41bfa51331472fe09";
const VENUE = "CantonSwap::122096fe076cc065af0cb38f94caa60e8ddfecbe8f0cfe10655ae7aa06fab99c66b7";
const VAULT = "cs-vault::1220b4cd6098eebafd4c88efd2b3986e86542bdc391060675432cd195ad26bcf013b";
const DSO = "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";
const CBTC_ADMIN = "cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262";
const AMM_ID = "TC CBTC/CC LP";
const BATCHER_CID =
  "0077114414d6371721317b7e970a813aa29375c532296c0df780676595e62ac297ca121220f980259f817846f7c3302e3b9d17b8bc4265ac9ee25817cd230caaa71cc8fe43";

const POOL: TcPool = {
  ammId: AMM_ID,
  instruments: { CC: { admin: DSO, id: "Amulet" }, CBTC: { admin: CBTC_ADMIN, id: "CBTC" } },
  ammRules: { templateId: "pkg:Obsidian.CantonSwap.V3:AMMRules", contractId: "00rules", createdEventBlob: "b", synchronizerId: "s" },
  amm: { templateId: "pkg:TC.V4:AMM", contractId: "00amm", createdEventBlob: "b", synchronizerId: "s" },
};

function wallet(): AgentWallet {
  const k = generateAgentKey();
  return {
    network: "canton:mainnet",
    relayUrl: "http://relay.test",
    party: AGENT,
    publicKeySpkiB64: k.publicKeySpkiB64,
    privateKeyPkcs8Pem: k.privateKeyPkcs8Pem,
    publicKeyFingerprint: "1220fp",
    createdAt: "2026-10-17T00:00:00Z",
  };
}

const batcherRow = {
  contractId: BATCHER_CID,
  templateId: "97571dd8:TC.V4.OrderBatch:SwapOrderBatcher",
  signatories: [VAULT],
  createArgument: { actor: AGENT, venue: VENUE, vault: VAULT },
};
const allocRow = (id: string, admin: string, funding: string | null, over: Record<string, unknown> = {}) => ({
  contractId: `00alloc-${id}`,
  templateId: "x:Alloc",
  signatories: [],
  createArgument: {},
  interfaceViews: [
    {
      interfaceId: "#splice-api-token-allocation-v2:Splice.Api.Token.AllocationV2:Allocation",
      viewValue: {
        settlement: { executors: [VENUE] },
        allocation: {
          admin,
          authorizer: { owner: AGENT },
          committed: true,
          nextIterationFunding: funding === null ? {} : { [id]: funding },
          meta: { values: { "tradecraft.fi/amm-id": AMM_ID, "tradecraft.fi/instrument-id": id } },
          ...over,
        },
      },
    },
  ],
});

/** A fake relay: reads from `state`, prepare answers `prepared`, with the real hash. */
function fakeRelay(state: { batcher?: boolean; allocs?: unknown[]; orders?: unknown[] }, prepared?: string) {
  const relay = {
    contracts: vi.fn(async (_p: string, q: { templateId?: string; interfaceId?: string }) => {
      if (q.templateId === TC_BATCHER_TEMPLATE_REF) return { party: AGENT, complete: true, contracts: state.batcher ? [batcherRow] : [] };
      if (q.templateId === TC_SWAP_ORDER_TEMPLATE_REF) return { party: AGENT, complete: true, contracts: state.orders ?? [] };
      if (q.interfaceId === ALLOCATION_V2_INTERFACE) return { party: AGENT, complete: true, contracts: state.allocs ?? [] };
      throw new Error(`unexpected read ${JSON.stringify(q)}`);
    }),
    submitPrepare: vi.fn(async () => ({
      preparedTransaction: prepared,
      hash: prepared ? await recomputeHash(prepared) : "",
    })),
    submitExecute: vi.fn(async () => ({ updateId: "u-1" })),
    holdings: vi.fn(),
    resolveAllocationFactory: vi.fn(),
  };
  return relay;
}
/** A linear pool: `quote` per 6 units of input, so a cumulative quote for the
 *  first k orders of 6 is k×quote and each order's own quote is `quote`. */
function ctxWith(relay: ReturnType<typeof fakeRelay>, quote = 0.0000072118, env: NodeJS.ProcessEnv = {}): TcContext {
  return {
    relay: relay as unknown as RelayClient,
    wallet: wallet(),
    env: { CANTON_AGENT_DSO_PARTY: DSO, ...env },
    hashBinding: { recomputeHash },
    fetchImpl: vi.fn(async (url: unknown) => {
      const giving = Number(new URL(String(url)).searchParams.get("givingAmount"));
      return new Response(JSON.stringify({ user_gets: (quote * giving) / 6 }), { status: 200 });
    }) as never,
  };
}

describe("loadTcPool", () => {
  const disclosures = (i1: unknown, i2: unknown) =>
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          amm: { templateId: "t", contractId: "a", createdEventBlob: "b", synchronizerId: "s" },
          amm_rules: { templateId: "t", contractId: "r", createdEventBlob: "b", synchronizerId: "s" },
          amm_data: { amm_id: AMM_ID, instrument1: i1, instrument2: i2 },
        }),
        { status: 200 }
      )
    );

  it("loads a pool whose instruments are the trusted ones, in either order", async () => {
    const ctx = { ...ctxWith(fakeRelay({})), fetchImpl: disclosures({ admin: DSO, id: "Amulet" }, { admin: CBTC_ADMIN, id: "CBTC" }) as never };
    const p = await loadTcPool(ctx, "CBTC", "CC");
    expect(p.ammId).toBe(AMM_ID);
    expect(p.instruments.CC).toEqual({ admin: DSO, id: "Amulet" });
  });

  it("refuses a pool trading a look-alike instrument", async () => {
    const ctx = { ...ctxWith(fakeRelay({})), fetchImpl: disclosures({ admin: DSO, id: "Amulet" }, { admin: "fake-cbtc::1220", id: "CBTC" }) as never };
    await expect(loadTcPool(ctx, "CC", "CBTC")).rejects.toThrow(/not the instruments this wallet trusts/);
  });

  it("refuses an unknown symbol before any request", async () => {
    const ctx = ctxWith(fakeRelay({}));
    await expect(loadTcPool(ctx, "CC", "NOPE")).rejects.toThrow(/not a known instrument/);
  });
});

describe("tcOrders", () => {
  beforeEach(() => {
    // The capture's ledger-time bound is its prepare instant; sign 5 s later.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Number(1792243120072657n / 1000n) + 5_000));
  });
  afterEach(() => vi.useRealTimers());
  const ready = { batcher: true, allocs: [allocRow("Amulet", DSO, "20.0000000000"), allocRow("CBTC", CBTC_ADMIN, null)] };

  it("queues the intended orders: verified, hash-bound, signed, executed", async () => {
    const relay = fakeRelay(ready, fixture("mainnet-tc-orders-2.b64"));
    const r = await tcOrders(ctxWith(relay), POOL, "CC", ["6", "6"], 0);
    expect(r.updateId).toBe("u-1");
    expect(r.orders.map((o) => o.minOut)).toEqual(["0.0000072118", "0.0000072118"]);
    const cmd = (relay.submitPrepare.mock.calls[0] as unknown as [{ commands: Array<{ ExerciseCommand: { contractId: string; choice: string } }> }])[0].commands[0]!;
    expect(cmd.ExerciseCommand.contractId).toBe(BATCHER_CID);
    expect(cmd.ExerciseCommand.choice).toBe("SwapOrderBatcher_CreateOrdersV2");
    expect(relay.submitExecute).toHaveBeenCalledTimes(1);
  });

  it("never signs bytes that do not match the intended orders", async () => {
    const relay = fakeRelay(ready, fixture("mainnet-tc-orders-2.b64"));
    await expect(tcOrders(ctxWith(relay), POOL, "CC", ["7", "7"], 0)).rejects.toThrow(/refusing to sign/);
    expect(relay.submitExecute).not.toHaveBeenCalled();
  });

  it("never signs a relay's tighter or looser minimum", async () => {
    const relay = fakeRelay(ready, fixture("mainnet-tc-orders-2.b64"));
    await expect(tcOrders(ctxWith(relay, 0.0000072119), POOL, "CC", ["6", "6"], 0)).rejects.toThrow(/minOut/);
    expect(relay.submitExecute).not.toHaveBeenCalled();
  });

  it("refuses before preparing when setup is missing or underfunded", async () => {
    for (const state of [
      { batcher: false, allocs: ready.allocs },
      { batcher: true, allocs: [allocRow("Amulet", DSO, "20.0000000000")] },
      { batcher: true, allocs: [allocRow("Amulet", DSO, "10.0000000000"), allocRow("CBTC", CBTC_ADMIN, null)] },
    ]) {
      const relay = fakeRelay(state);
      await expect(tcOrders(ctxWith(relay), POOL, "CC", ["6", "6"], 1)).rejects.toThrow(/tradecraft:/);
      expect(relay.submitPrepare).not.toHaveBeenCalled();
    }
  });

  it("quotes each order after the ones before it (cumulative), so later minimums carry the price impact", async () => {
    const relay = fakeRelay(ready);
    const ctx = ctxWith(relay);
    // A concave pool: the second 6 buys less than the first.
    ctx.fetchImpl = vi.fn(async (url: unknown) => {
      const g = Number(new URL(String(url)).searchParams.get("givingAmount"));
      return new Response(JSON.stringify({ user_gets: g === 6 ? 0.00001 : 0.000018 }), { status: 200 });
    }) as never;
    await expect(tcOrders(ctx, POOL, "CC", ["6", "6"], 0)).rejects.toThrow(); // bytes carry other minimums
    const urls = (ctx.fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(urls.map((u) => new URL(u).searchParams.get("givingAmount"))).toEqual(["6", "12"]);
    const call = relay.submitPrepare.mock.calls[0] as unknown as [{ commands: Array<{ ExerciseCommand: { choiceArgument: { orders: Array<{ minOut: string }> } } }> }];
    expect(call[0].commands[0]!.ExerciseCommand.choiceArgument.orders.map((o) => o.minOut)).toEqual(["0.00001", "0.000008"]);
  });

  it("refuses to act on a partial (prefix) read of the wallet's contracts", async () => {
    const relay = fakeRelay(ready);
    relay.contracts.mockResolvedValueOnce({ party: AGENT, complete: false, contracts: [batcherRow] } as never);
    await expect(tcOrders(ctxWith(relay), POOL, "CC", ["6"], 1)).rejects.toThrow(/incomplete view/);
    expect(relay.submitPrepare).not.toHaveBeenCalled();
  });

  it("refuses an order below the pool's minimum input", async () => {
    const relay = fakeRelay(ready);
    await expect(tcOrders(ctxWith(relay), POOL, "CC", ["1"], 1)).rejects.toThrow(/minimum input/);
    expect(relay.submitPrepare).not.toHaveBeenCalled();
  });

  it("ignores allocations it would not have created (foreign executor, other pool, not committed)", async () => {
    const relay = fakeRelay({
      batcher: true,
      allocs: [
        allocRow("Amulet", DSO, "20.0000000000", {}),
        { ...allocRow("CBTC", CBTC_ADMIN, null), interfaceViews: [{ interfaceId: "#x:Splice.Api.Token.AllocationV2:Allocation", viewValue: { settlement: { executors: ["evil::1220"] }, allocation: allocRow("CBTC", CBTC_ADMIN, null).interfaceViews[0]!.viewValue.allocation } }] },
      ],
    });
    await expect(tcOrders(ctxWith(relay), POOL, "CC", ["6"], 1)).rejects.toThrow(/setup is incomplete/);
  });
});

describe("tcWithdraw", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Number(1792243400682338n / 1000n) + 5_000));
  });
  afterEach(() => vi.useRealTimers());

  const funded = { allocs: [allocRow("Amulet", DSO, "8.0000000000"), allocRow("CBTC", CBTC_ADMIN, "0.0000151825")] };

  it("refuses before sending to withdraw an empty or missing allocation", async () => {
    const relay = fakeRelay({ allocs: [allocRow("Amulet", DSO, null)] });
    await expect(tcWithdraw(ctxWith(relay), POOL, "CC")).rejects.toThrow(/is empty/);
    await expect(tcWithdraw(ctxWith(relay), POOL, "CBTC")).rejects.toThrow(/no CBTC allocation/);
    expect(relay.submitPrepare).not.toHaveBeenCalled();
  });

  it("requests the release of the intended allocation, naming Tradecraft's package by id", async () => {
    const relay = fakeRelay(funded, fixture("mainnet-tc-withdrawal-request-cc.b64"));
    expect(await tcWithdraw(ctxWith(relay), POOL, "CC")).toBe("u-1");
    const call = relay.submitPrepare.mock.calls[0] as unknown as [{ commands: Array<{ CreateCommand: { templateId: string } }> }];
    expect(call[0].commands[0]!.CreateCommand.templateId).toBe(
      "97571dd8610f5d98ec99ebd5bee9edb09d44a7a025b9d088517bde0bfb3bc2dc:TC.V4.Settle.WithdrawalRequest:SettlementWithdrawalRequest"
    );
  });

  it("never signs a request whose package is not a trusted Tradecraft package", async () => {
    const relay = fakeRelay(funded, fixture("mainnet-tc-withdrawal-request-cc.b64"));
    const ctx = ctxWith(relay, undefined, { CANTON_AGENT_TRADECRAFT_PACKAGE_IDS: "ab".repeat(32) });
    await expect(tcWithdraw(ctx, POOL, "CC")).rejects.toThrow(/not Tradecraft's/);
    expect(relay.submitExecute).not.toHaveBeenCalled();
  });

  it("never signs a request for the other instrument", async () => {
    const relay = fakeRelay(funded, fixture("mainnet-tc-withdrawal-request-cc.b64"));
    await expect(tcWithdraw(ctxWith(relay), POOL, "CBTC")).rejects.toThrow(/refusing to sign/);
    expect(relay.submitExecute).not.toHaveBeenCalled();
  });
});

describe("tcCancel", () => {
  const ORDER =
    "0048b7592c7917bb56ccc671264242ac9b785c957b7a9440188d2fb4b190992322ca12122090eec475f0218623e4a3c8cdb6dafb626ab1f3e8e4d556fdedcbaeb1759721ec";
  const openOrder = { contractId: ORDER, templateId: "97571dd8:TC.V4.SwapOrderV2:SwapOrder", signatories: [AGENT, VAULT], createArgument: { actor: AGENT, ammId: AMM_ID } };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Number(1792254314557232n / 1000n) + 5_000));
  });
  afterEach(() => vi.useRealTimers());

  it("cancels the pending order: verified, hash-bound, executed", async () => {
    const relay = fakeRelay({ orders: [openOrder] }, fixture("mainnet-tc-cancel-order.b64"));
    expect(await tcCancel(ctxWith(relay), POOL)).toEqual([{ orderCid: ORDER, updateId: "u-1" }]);
  });

  it("reports an order the venue already settled as gone, not as a failure", async () => {
    const relay = fakeRelay({ orders: [openOrder] }, fixture("mainnet-tc-cancel-order.b64"));
    relay.submitExecute.mockRejectedValueOnce(new Error("relay -> 502 CONTRACT_NOT_FOUND"));
    expect(await tcCancel(ctxWith(relay), POOL)).toEqual([{ orderCid: ORDER, gone: true }]);
  });

  it("never signs a cancel of another order than the listed one", async () => {
    const relay = fakeRelay({ orders: [{ ...openOrder, contractId: "00" + "cd".repeat(68) }] }, fixture("mainnet-tc-cancel-order.b64"));
    await expect(tcCancel(ctxWith(relay), POOL)).rejects.toThrow(/refusing to sign/);
    expect(relay.submitExecute).not.toHaveBeenCalled();
  });
});

describe("tcSetup / tcStatus", () => {
  it("does nothing when the batcher and both allocations exist", async () => {
    const relay = fakeRelay({ batcher: true, allocs: [allocRow("Amulet", DSO, "8.0000000000"), allocRow("CBTC", CBTC_ADMIN, "0.0000151825")] });
    const r = await tcSetup(ctxWith(relay), POOL);
    expect(r.batcher.created).toBe(false);
    expect(r.allocations).toEqual({ CC: { created: false, funding: "8.0000000000" }, CBTC: { created: false, funding: "0.0000151825" } });
    expect(relay.submitPrepare).not.toHaveBeenCalled();
  });

  it("tops up an existing allocation (verified, hash-bound, executed)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Number(1792248875467357n / 1000n) + 5_000));
    try {
      const USDCX_POOL: TcPool = {
        ...POOL,
        ammId: "TC CC/USDCx LP",
        instruments: { CC: { admin: DSO, id: "Amulet" }, USDCx: { admin: "usdcx::1220", id: "USDCx" } },
      };
      const ccAlloc = {
        ...allocRow("Amulet", DSO, null),
        contractId:
          "0066384937ba8b874e35c0e37a6de851dce8cd84ea07452ba834a59201a4cb4f9dca1212202090ed4333ef37961013357e13e0bcdc5e3f9699c5fd9db46fa8cd1a2a79f9ac",
      };
      (ccAlloc.interfaceViews[0]!.viewValue.allocation.meta as { values: Record<string, string> }).values["tradecraft.fi/amm-id"] =
        "TC CC/USDCx LP";
      const usdcxAlloc = allocRow("USDCx", "usdcx::1220", null);
      (usdcxAlloc.interfaceViews[0]!.viewValue.allocation.meta as { values: Record<string, string> }).values["tradecraft.fi/amm-id"] =
        "TC CC/USDCx LP";
      const relay = fakeRelay({ batcher: true, allocs: [ccAlloc, usdcxAlloc] }, fixture("mainnet-tc-fund-cc.b64"));
      relay.holdings.mockResolvedValue({ party: AGENT, complete: true, instruments: [{ admin: DSO, id: "Amulet", total: "20", holdings: [{ cid: "h1", amount: "20.0000000000", locked: false }] }] });
      const factory = { factoryId: "00f", choiceContextData: { values: {} }, disclosedContracts: [] };
      relay.resolveAllocationFactory.mockResolvedValue(factory);
      (relay as unknown as { resolveSettlementFactory: unknown }).resolveSettlementFactory = vi.fn(async () => factory);
      const r = await tcSetup(ctxWith(relay), USDCX_POOL, { CC: "6" });
      expect(r.allocations.CC).toEqual({ created: false, toppedUp: true, funding: "6" });
      expect(relay.submitExecute).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a top-up the participant refused for a contract in use, with the allocation re-read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Number(1792248875467357n / 1000n) + 5_000));
    try {
      const USDCX_POOL: TcPool = {
        ...POOL,
        ammId: "TC CC/USDCx LP",
        instruments: { CC: { admin: DSO, id: "Amulet" }, USDCx: { admin: "usdcx::1220", id: "USDCx" } },
      };
      const ccAlloc = {
        ...allocRow("Amulet", DSO, null),
        contractId:
          "0066384937ba8b874e35c0e37a6de851dce8cd84ea07452ba834a59201a4cb4f9dca1212202090ed4333ef37961013357e13e0bcdc5e3f9699c5fd9db46fa8cd1a2a79f9ac",
      };
      (ccAlloc.interfaceViews[0]!.viewValue.allocation.meta as { values: Record<string, string> }).values["tradecraft.fi/amm-id"] =
        "TC CC/USDCx LP";
      const relay = fakeRelay({ batcher: true, allocs: [ccAlloc, allocRow("USDCx", "usdcx::1220", null)] }, fixture("mainnet-tc-fund-cc.b64"));
      const usdcxAlloc = allocRow("USDCx", "usdcx::1220", null);
      (usdcxAlloc.interfaceViews[0]!.viewValue.allocation.meta as { values: Record<string, string> }).values["tradecraft.fi/amm-id"] =
        "TC CC/USDCx LP";
      relay.contracts.mockImplementation(async (_p: string, q: { templateId?: string; interfaceId?: string }) => {
        if (q.templateId === TC_BATCHER_TEMPLATE_REF) return { party: AGENT, complete: true, contracts: [batcherRow] };
        return { party: AGENT, complete: true, contracts: [ccAlloc, usdcxAlloc] };
      });
      relay.holdings.mockResolvedValue({ party: AGENT, complete: true, instruments: [{ admin: DSO, id: "Amulet", total: "20", holdings: [{ cid: "h1", amount: "20.0000000000", locked: false }] }] });
      const factory = { factoryId: "00f", choiceContextData: { values: {} }, disclosedContracts: [] };
      relay.resolveAllocationFactory.mockResolvedValue(factory);
      (relay as unknown as { resolveSettlementFactory: unknown }).resolveSettlementFactory = vi.fn(async () => factory);
      relay.submitExecute
        .mockRejectedValueOnce(new Error("relay POST /v1/wallet/submit/execute -> 502 interactive submission rejected: LOCAL_VERDICT_LOCKED_CONTRACTS"))
        .mockResolvedValueOnce({ updateId: "u-2" });
      const slept: number[] = [];
      const ctx = { ...ctxWith(relay), sleep: async (ms: number) => void slept.push(ms) };
      const r = await tcSetup(ctx, USDCX_POOL, { CC: "6" });
      expect(slept).toEqual([5_000]);
      expect(r.allocations.CC!.toppedUp).toBe(true);
      expect(relay.submitExecute).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recognises contract contention, and nothing else, as retryable", () => {
    expect(isContractContention(new Error("... LOCAL_VERDICT_LOCKED_CONTRACTS ..."))).toBe(true);
    expect(isContractContention(new Error("CONTRACT_NOT_FOUND"))).toBe(true);
    expect(isContractContention(new Error("LOCAL_VERDICT_INACTIVE_CONTRACTS(11,19824bf3): Rejected transaction is referring to inactive contracts"))).toBe(true);
    expect(isContractContention(new Error("refusing to sign"))).toBe(false);
    expect(isContractContention(new Error("submission_outcome_unknown"))).toBe(false);
  });

  it("reports funding and open orders", async () => {
    const relay = fakeRelay({
      batcher: true,
      allocs: [allocRow("Amulet", DSO, "8.0000000000"), allocRow("CBTC", CBTC_ADMIN, "0.0000151825")],
      orders: [{ contractId: "o1", templateId: "t", signatories: [], createArgument: { actor: AGENT, ammId: AMM_ID } }],
    });
    const st = await tcStatus(ctxWith(relay), POOL);
    expect(st.batcher).toBe(BATCHER_CID);
    expect(st.allocations.CBTC!.funding).toBe("0.0000151825");
    expect(st.openOrders).toBe(1);
  });
});
