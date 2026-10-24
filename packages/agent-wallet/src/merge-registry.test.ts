import { describe, it, expect, vi } from "vitest";
import { mergeHoldings, mergeAllRegistryHoldings } from "./merge.js";
import { sumLedgerDecimals } from "@ftptech/x402-canton-core";
import type { RelayClient } from "./relay-client.js";
import type { AgentWallet } from "./store.js";
import type { transfer } from "./tx.js";

// Registry-token branch of `merge`: holdings come from the HoldingV1 read, each
// batch is self-transferred for its FULL exact sum (a registry self-transfer
// collapses only on the full amount — measured on MainNet), and the ACS is
// re-read after every round. The transfer executor is injected, so these
// tests pin what is SENT, not the relay/prepare/sign chain.

const PARTY = "agent::1220aa";
const ADMIN = "usdcx-registrar::1220bb";
const wallet = (): AgentWallet =>
  ({ party: PARTY, relayUrl: "http://relay", network: "mainnet" }) as unknown as AgentWallet;

type Holding = { cid: string; amount: string; locked: boolean };
function relayWith(snapshots: Holding[][]): { relay: RelayClient; holdings: ReturnType<typeof vi.fn> } {
  let i = 0;
  const holdings = vi.fn(async (_party: string, ins?: { admin: string; id: string }) => {
    const rows = snapshots[Math.min(i++, snapshots.length - 1)]!;
    return {
      party: PARTY,
      instruments: [{ admin: ins?.admin ?? ADMIN, id: ins?.id ?? "USDCx", total: "0", holdings: rows }],
      complete: true, // RelayClient.holdings always answers a boolean
    };
  });
  return { relay: { holdings } as unknown as RelayClient, holdings };
}
function recorder(): { fn: typeof transfer; calls: Array<Parameters<typeof transfer>[2]> } {
  const calls: Array<Parameters<typeof transfer>[2]> = [];
  const fn = (async (_r: unknown, _w: unknown, o: Parameters<typeof transfer>[2]) => {
    calls.push(o);
    return `upd-${calls.length}`;
  }) as unknown as typeof transfer;
  return { fn, calls };
}
const TRUSTED = new Set(["operator::1", "bridge::2"]);

describe("sumLedgerDecimals", () => {
  it("sums exactly, no float drift, always 10 places", () => {
    expect(sumLedgerDecimals(["0.1", "0.2"])).toBe("0.3000000000");
    expect(sumLedgerDecimals(["0.0100000000", "0.0050000000"])).toBe("0.0150000000");
    expect(sumLedgerDecimals(["123456789.1234567891", "0.0000000009"])).toBe("123456789.1234567900");
    expect(() => sumLedgerDecimals(["1e3"])).toThrow(/invalid CC decimal/);
  });
});

describe("mergeHoldings — registry token", () => {
  it("self-transfers the batch for its FULL exact sum with the registry pins, and stops at one holding", async () => {
    const { relay, holdings } = relayWith([
      [
        { cid: "h1", amount: "0.0100000000", locked: false },
        { cid: "h2", amount: "0.0050000000", locked: false },
        { cid: "hL", amount: "9.0000000000", locked: true }, // locked: never an input
      ],
      [{ cid: "h3", amount: "0.0150000000", locked: false }],
    ]);
    const t = recorder();
    const res = await mergeHoldings(relay, wallet(), {
      instrumentAdmin: ADMIN,
      instrumentId: "USDCx",
      trustedRegistryParties: TRUSTED,
      transferFn: t.fn,
    });
    expect(t.calls).toHaveLength(1);
    const c = t.calls[0]!;
    expect(c.receiver).toBe(PARTY); // the invariant
    expect(c.amount).toBe("0.0150000000"); // full sum of the UNLOCKED inputs
    expect(c.inputHoldingCids).toEqual(["h1", "h2"]);
    expect(c.registryInstrument).toBe(true);
    expect(c.expectInstrumentAdmin).toBe(ADMIN);
    expect(c.expectInstrumentId).toBe("USDCx");
    expect(c.trustedRegistryParties).toBe(TRUSTED);
    expect(holdings).toHaveBeenCalledWith(PARTY, { admin: ADMIN, id: "USDCx" }, { slice: true });
    expect(res).toMatchObject({ rounds: 1, merged: ["h1", "h2"], updateIds: ["upd-1"], finalHoldings: 1, usedScan: false });
  });

  it("does nothing when already at target, and a dry run executes no transfer", async () => {
    const one = [{ cid: "h1", amount: "1.0000000000", locked: false }];
    const t = recorder();
    const res = await mergeHoldings(relayWith([one]).relay, wallet(), {
      instrumentAdmin: ADMIN, instrumentId: "USDCx", transferFn: t.fn, trustedRegistryParties: TRUSTED,
    });
    expect(t.calls).toHaveLength(0);
    expect(res.finalHoldings).toBe(1);
    const two = [...one, { cid: "h2", amount: "1.0000000000", locked: false }];
    const dry = await mergeHoldings(relayWith([two]).relay, wallet(), {
      instrumentAdmin: ADMIN, instrumentId: "USDCx", transferFn: t.fn, dryRun: true, trustedRegistryParties: TRUSTED,
    });
    expect(t.calls).toHaveLength(0);
    expect(dry).toMatchObject({ rounds: 0, plannedBatches: 1, finalHoldings: 2 });
  });

  it("batches by `batch` and re-reads the ACS each round (no output chaining)", async () => {
    const mk = (n: number, p: string): Holding[] =>
      Array.from({ length: n }, (_, i) => ({ cid: `${p}${i}`, amount: "0.0010000000", locked: false }));
    const { relay } = relayWith([mk(5, "a"), [...mk(2, "b"), ...mk(3, "a").slice(0, 3)], mk(1, "c")]);
    const t = recorder();
    const res = await mergeHoldings(relay, wallet(), {
      instrumentAdmin: ADMIN, instrumentId: "USDCx", batch: 2, transferFn: t.fn, trustedRegistryParties: TRUSTED,
    });
    expect(t.calls.map((c) => c.inputHoldingCids)).toEqual([["a0", "a1"], ["b0", "b1"]]);
    expect(t.calls.every((c) => c.receiver === PARTY && c.amount === "0.0020000000")).toBe(true);
    expect(res).toMatchObject({ rounds: 2, finalHoldings: 1 });
  });

  it("refuses a registry merge without its registrar, and refuses Amulet as a registry id", async () => {
    const t = recorder();
    await expect(
      mergeHoldings(relayWith([[]]).relay, wallet(), { instrumentId: "USDCx", transferFn: t.fn })
    ).rejects.toThrow(/needs instrumentAdmin/);
    await expect(
      mergeHoldings(relayWith([[]]).relay, wallet(), { instrumentAdmin: ADMIN, instrumentId: "Amulet", transferFn: t.fn })
    ).rejects.toThrow(/omit instrumentId/);
    expect(t.calls).toHaveLength(0);
  });
});

// A wallet with more holdings than the participant lists in one read: the
// relay answers a bounded slice of the oldest holdings with complete:false.
type Ins = { admin: string; id: string; holdings: Holding[] };
function sliceRelay(views: Array<{ instruments: Ins[]; complete: boolean }>) {
  let i = 0;
  const holdings = vi.fn(async (_p: string, ins?: { admin: string; id: string }) => {
    const v = views[Math.min(i++, views.length - 1)]!;
    const instruments = (ins ? v.instruments.filter((x) => x.admin === ins.admin && x.id === ins.id) : v.instruments)
      .map((x) => ({ ...x, total: "0" }));
    return { party: PARTY, instruments, complete: v.complete };
  });
  return { relay: { holdings } as unknown as RelayClient, holdings };
}
const h = (prefix: string, n: number, amount = "0.0100000000"): Holding[] =>
  Array.from({ length: n }, (_, k) => ({ cid: `${prefix}${k}`, amount, locked: false }));
const USDCX = "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef";
const CBTC = "cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262";
const DSO = "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";

describe("mergeHoldings — registry token on a wallet past the list cap", () => {
  it("refuses to start without --yes when the size is unknown (incomplete slice)", async () => {
    const { relay } = sliceRelay([{ instruments: [{ admin: ADMIN, id: "USDCx", holdings: h("u", 50) }], complete: false }]);
    const t = recorder();
    await expect(
      mergeHoldings(relay, wallet(), { instrumentAdmin: ADMIN, instrumentId: "USDCx", trustedRegistryParties: TRUSTED, transferFn: t.fn })
    ).rejects.toThrow(/--yes/);
    expect(t.calls).toHaveLength(0);
  });

  it("keeps merging as the slice moves, and does NOT report done while the slice is incomplete", async () => {
    const { relay } = sliceRelay([
      { instruments: [{ admin: ADMIN, id: "USDCx", holdings: h("a", 90) }], complete: false },
      { instruments: [{ admin: ADMIN, id: "USDCx", holdings: h("b", 30) }], complete: false },
      { instruments: [{ admin: ADMIN, id: "USDCx", holdings: h("c", 1) }], complete: false },
    ]);
    const t = recorder();
    const lines: string[] = [];
    const res = await mergeHoldings(relay, wallet(), {
      instrumentAdmin: ADMIN, instrumentId: "USDCx", trustedRegistryParties: TRUSTED, transferFn: t.fn, yes: true,
      onProgress: (l) => lines.push(l),
    });
    expect(t.calls.map((c) => c.inputHoldingCids!.length)).toEqual([90, 30]);
    expect(t.calls.every((c) => c.receiver === PARTY)).toBe(true);
    expect(res.finalHoldings).toBeNull(); // unknown — never "1 holding left"
    expect(lines.join("\n")).toMatch(/--all-tokens/);
    expect(lines.join("\n")).not.toMatch(/^done/m);
  });

  it("a dry run on an incomplete slice says the total is unknown", async () => {
    const { relay } = sliceRelay([{ instruments: [{ admin: ADMIN, id: "USDCx", holdings: h("u", 7) }], complete: false }]);
    const lines: string[] = [];
    const res = await mergeHoldings(relay, wallet(), { instrumentAdmin: ADMIN, instrumentId: "USDCx", dryRun: true, onProgress: (l) => lines.push(l) });
    expect(res).toMatchObject({ rounds: 0, finalHoldings: null });
    expect(lines[0]).toMatch(/at least 7/);
  });
});

describe("mergeAllRegistryHoldings (merge --all-tokens)", () => {
  it("works through a mixed wallet: always the largest trusted token in the slice, never Canton Coin, never an untrusted registrar", async () => {
    const amulet: Ins = { admin: DSO, id: "Amulet", holdings: h("cc", 5) };
    const junk: Ins = { admin: "junk-registrar::1220ff", id: "JUNK", holdings: h("j", 40) };
    const { relay } = sliceRelay([
      { instruments: [amulet, junk, { admin: CBTC, id: "CBTC", holdings: h("b", 120) }, { admin: USDCX, id: "USDCx", holdings: h("u", 35) }], complete: false },
      { instruments: [amulet, junk, { admin: CBTC, id: "CBTC", holdings: h("b2", 31) }, { admin: USDCX, id: "USDCx", holdings: h("u", 35) }], complete: false },
      { instruments: [amulet, junk, { admin: CBTC, id: "CBTC", holdings: h("b3", 1) }, { admin: USDCX, id: "USDCx", holdings: h("u", 35) }], complete: true },
      { instruments: [amulet, junk, { admin: CBTC, id: "CBTC", holdings: h("b3", 1) }, { admin: USDCX, id: "USDCx", holdings: h("u2", 1) }], complete: true },
    ]);
    const t = recorder();
    const res = await mergeAllRegistryHoldings(relay, wallet(), { transferFn: t.fn, yes: true });
    // Reads: CBTC 120 > USDCx 35 → CBTC 90; then USDCx 35 > CBTC 31 → USDCx; then USDCx 35 again.
    expect(t.calls.map((c) => `${c.expectInstrumentId}:${c.inputHoldingCids!.length}`)).toEqual([
      "CBTC:90",
      "USDCx:35",
      "USDCx:35",
    ]);
    // Every call: a self-transfer of a trusted registry token for its full sum.
    for (const c of t.calls) {
      expect(c.receiver).toBe(PARTY);
      expect(c.registryInstrument).toBe(true);
      expect([CBTC, USDCX]).toContain(c.expectInstrumentAdmin);
      expect(c.amount).toBe(sumLedgerDecimals(Array(c.inputHoldingCids!.length).fill("0.0100000000")));
    }
    expect(t.calls[0]!.expectInstrumentId).toBe("CBTC"); // the largest group first
    expect(t.calls.some((c) => c.expectInstrumentId === "JUNK" || c.expectInstrumentId === "Amulet")).toBe(false);
    expect(res.untrusted).toEqual(["JUNK@junk-registrar::1220ff"]);
    expect(res.finalHoldings).toBe(2);
  });

  it("refuses to start without --yes on an incomplete slice, and a dry run executes nothing", async () => {
    const view = { instruments: [{ admin: CBTC, id: "CBTC", holdings: h("b", 10) }], complete: false };
    const t = recorder();
    await expect(mergeAllRegistryHoldings(sliceRelay([view]).relay, wallet(), { transferFn: t.fn })).rejects.toThrow(/--yes/);
    const dry = await mergeAllRegistryHoldings(sliceRelay([view]).relay, wallet(), { transferFn: t.fn, dryRun: true });
    expect(dry.rounds).toBe(0);
    expect(t.calls).toHaveLength(0);
  });

  it("stops at maxRounds and says so", async () => {
    const view = { instruments: [{ admin: CBTC, id: "CBTC", holdings: h("b", 200) }], complete: false };
    const t = recorder();
    const lines: string[] = [];
    const res = await mergeAllRegistryHoldings(sliceRelay([view]).relay, wallet(), {
      transferFn: t.fn, yes: true, maxRounds: 3, onProgress: (l) => lines.push(l),
    });
    expect(res.rounds).toBe(3);
    expect(lines.join("\n")).toMatch(/maxRounds/);
  });

  it("a view filled with Canton Coin dust says to run plain `merge` first", async () => {
    const view = {
      instruments: [
        { admin: DSO, id: "Amulet", holdings: h("cc", 199) },
        { admin: CBTC, id: "CBTC", holdings: h("b", 1) },
      ],
      complete: false,
    };
    const lines: string[] = [];
    const t = recorder();
    await mergeAllRegistryHoldings(sliceRelay([view]).relay, wallet(), { transferFn: t.fn, yes: true, onProgress: (l) => lines.push(l) });
    expect(t.calls).toHaveLength(0);
    expect(lines.join("\n")).toMatch(/199 Canton Coin holdings — run `canton-agent-wallet merge` first/);
  });
});

describe("merge --all-tokens on a view with nothing to merge", () => {
  it("asks the relay for the registry tokens only (class=registry)", async () => {
    const { relay, holdings } = sliceRelay([{ instruments: [{ admin: CBTC, id: "CBTC", holdings: h("b", 1) }], complete: true }]);
    await mergeAllRegistryHoldings(relay, wallet(), { transferFn: recorder().fn });
    expect(holdings).toHaveBeenCalledWith(PARTY, undefined, { slice: true, registryOnly: true });
  });

  it("an incomplete view filled by Canton Coin dust needs NO --yes: nothing runs, and it says to run plain `merge` first", async () => {
    const view = {
      instruments: [
        { admin: DSO, id: "Amulet", holdings: h("cc", 199) },
        { admin: CBTC, id: "CBTC", holdings: h("b", 1) },
      ],
      complete: false,
    };
    const lines: string[] = [];
    const t = recorder();
    // No `yes`: the gate must not demand it for a run that would merge nothing.
    const res = await mergeAllRegistryHoldings(sliceRelay([view]).relay, wallet(), { transferFn: t.fn, onProgress: (l) => lines.push(l) });
    expect(t.calls).toHaveLength(0);
    expect(res.rounds).toBe(0);
    expect(lines.join("\n")).toMatch(/199 Canton Coin holdings — run `canton-agent-wallet merge` first/);
    expect(lines.join("\n")).not.toMatch(/--yes/);
  });

  it("with no filler it can name (a current relay lists no Canton Coin rows), the advice still points at plain `merge`", async () => {
    const view = { instruments: [{ admin: CBTC, id: "CBTC", holdings: [{ cid: "b0", amount: "1.0000000000", locked: false }, { cid: "bL", amount: "1.0000000000", locked: true }] }], complete: false };
    const lines: string[] = [];
    await mergeAllRegistryHoldings(sliceRelay([view]).relay, wallet(), { transferFn: recorder().fn, onProgress: (l) => lines.push(l) });
    expect(lines.join("\n")).toMatch(/locked holdings, or by Canton Coin dust.*plain `canton-agent-wallet merge` first/);
  });

  it("a dry run of such a view does not claim a real run would need --yes", async () => {
    const view = { instruments: [{ admin: DSO, id: "Amulet", holdings: h("cc", 150) }], complete: false };
    const lines: string[] = [];
    await mergeAllRegistryHoldings(sliceRelay([view]).relay, wallet(), { dryRun: true, onProgress: (l) => lines.push(l) });
    expect(lines.join("\n")).not.toMatch(/needs --yes/);
    expect(lines.join("\n")).toMatch(/Nothing to merge in view.*150 Canton Coin holdings/);
  });

  it("an incomplete view WITH something to merge still needs --yes (size unknown)", async () => {
    const view = { instruments: [{ admin: CBTC, id: "CBTC", holdings: h("b", 5) }], complete: false };
    await expect(mergeAllRegistryHoldings(sliceRelay([view]).relay, wallet(), { transferFn: recorder().fn })).rejects.toThrow(/--yes/);
  });
});
