import { describe, it, expect, vi } from "vitest";
import { mergeHoldings } from "./merge.js";
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
    expect(holdings).toHaveBeenCalledWith(PARTY, { admin: ADMIN, id: "USDCx" });
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
