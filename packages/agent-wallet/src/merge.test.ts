/**
 * Unit tests for mergeHoldings (merge.ts) — the dust-amulet consolidator.
 *
 * The outbound self-transfer reuses the real `transfer()` machinery; these tests
 * mock at the SAME seam the withdraw/tx tests exercise it, but one level up:
 * mergeHoldings takes an injected `transferFn`, so we stub the transfer executor
 * directly (no relay/prepare/sign chain) and assert the merge orchestration —
 * batching, the whale (Scan) fallback, stale-cid skipping, dry-run, max-rounds —
 * AND the non-negotiable receiver === wallet.party invariant on EVERY call.
 *
 * The relay is a minimal typed stub exposing only the two methods mergeHoldings
 * calls (`balance`, `holdingsScan`); the 413 whale trigger is a real
 * RelayHttpError so `isHoldingsExceedNodeLimitError` matches the production path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mergeHoldings } from "./merge.js";
import {
  RelayHttpError,
  type BalanceResult,
  type HoldingsScanResult,
  type TxAmuletsResult,
  type RelayClient,
} from "./relay-client.js";
import type { transfer } from "./tx.js";
import type { AgentWallet } from "./store.js";

const PARTY = "agent::1220abcd";

function wallet(): AgentWallet {
  return {
    network: "canton:testnet",
    relayUrl: "http://relay",
    party: PARTY,
    publicKeySpkiB64: "spki",
    privateKeyPkcs8Pem: "pem",
    publicKeyFingerprint: "fp",
    createdAt: "t",
  };
}

/** N fabricated Amulet holdings ({cid, amount}); cids are prefix+index. */
function holdings(n: number, prefix = "c"): Array<{ cid: string; amount: string }> {
  return Array.from({ length: n }, (_v, i) => ({ cid: `${prefix}${i}`, amount: "0.001" }));
}

/** A relay stub whose `balance` returns the next queued result (throwing when the
 *  queued entry is an Error), whose `holdingsScan` returns a fixed snapshot, and
 *  whose `txAmulets` resolves a batch's output cids by updateId (the merge output-
 *  chaining seam). `txAmulets` defaults to returning NO outputs (empty pool); pass
 *  `txAmulets` to drive the chain phase, or an Error to exercise the warn+continue
 *  transient-failure path. Only the methods mergeHoldings uses are implemented. */
function stubRelay(opts: {
  balances: Array<BalanceResult | Error>;
  scan?: HoldingsScanResult;
  txAmulets?: (
    updateId: string
  ) => Array<{ cid: string; amount: string }> | Error;
}): {
  relay: RelayClient;
  balanceCalls: () => number;
  scanCalls: () => number;
  txAmuletsCalls: () => string[];
} {
  let bi = 0;
  const balance = vi.fn(async (): Promise<BalanceResult> => {
    const next = opts.balances[Math.min(bi, opts.balances.length - 1)];
    bi++;
    if (next instanceof Error) throw next;
    return next as BalanceResult;
  });
  const holdingsScan = vi.fn(
    async (): Promise<HoldingsScanResult> =>
      opts.scan ?? {
        party: PARTY,
        source: "scan-snapshot",
        recordTime: "2026-07-02T12:00:00Z",
        holdings: [],
        complete: true,
      }
  );
  const txAmulets = vi.fn(
    async (_party: string, updateId: string): Promise<TxAmuletsResult> => {
      const r = opts.txAmulets?.(updateId) ?? [];
      if (r instanceof Error) throw r;
      return { party: PARTY, updateId, amulets: r };
    }
  );
  const relay = { balance, holdingsScan, txAmulets } as unknown as RelayClient;
  return {
    relay,
    balanceCalls: () => balance.mock.calls.length,
    scanCalls: () => holdingsScan.mock.calls.length,
    txAmuletsCalls: () => txAmulets.mock.calls.map((c) => c[1] as string),
  };
}

function balanceOf(hs: Array<{ cid: string; amount: string }>): BalanceResult {
  return { party: PARTY, amulet: hs.length, cc: "1.0", holdings: hs };
}

/** The 413 whale error, shaped exactly like the facilitator's discriminated
 *  balance response so isHoldingsExceedNodeLimitError matches. */
function whale413(): RelayHttpError {
  return new RelayHttpError(
    "relay GET /v1/wallet/x/balance -> 413 holdings_exceed_node_limit",
    413,
    { code: "holdings_exceed_node_limit", party: PARTY }
  );
}

/** A mock transfer executor: records every {receiver, inputHoldingCids}, returns
 *  a sequential updateId. Typed to the real `transfer` signature (no `any`). */
function mockTransfer(): {
  fn: typeof transfer;
  calls: Array<{ receiver: string; cids: string[] | undefined; amount: string }>;
} {
  const calls: Array<{ receiver: string; cids: string[] | undefined; amount: string }> = [];
  const fn = vi.fn(
    async (
      _relay: RelayClient,
      _w: AgentWallet,
      o: Parameters<typeof transfer>[2]
    ): Promise<string> => {
      calls.push({ receiver: o.receiver, cids: o.inputHoldingCids, amount: o.amount });
      return `u${calls.length}`;
    }
  ) as unknown as typeof transfer;
  return { fn, calls };
}

beforeEach(() => {
  // Pin an env DSO so the (default) instrumentAdmin resolve is deterministic and
  // does not depend on the host environment.
  process.env.CANTON_AGENT_DSO_PARTY = "DSO::1220cafe";
});
afterEach(() => {
  delete process.env.CANTON_AGENT_DSO_PARTY;
  vi.restoreAllMocks();
});

describe("mergeHoldings — small wallet (live phase only)", () => {
  it("batches the live balance until it reaches target (2 rounds)", async () => {
    // 180 holdings, batch 90 → round 1 consumes 90 (→ balance 92), round 2
    // consumes 90 (→ balance 2 == target) → stop. Two live rounds.
    const { relay } = stubRelay({
      balances: [
        balanceOf(holdings(180)),
        balanceOf(holdings(92)),
        balanceOf(holdings(2)), // ≤ target → stop
      ],
    });
    const t = mockTransfer();
    const res = await mergeHoldings(relay, wallet(), { batch: 90, transferFn: t.fn });

    expect(res.usedScan).toBe(false);
    expect(res.rounds).toBe(2);
    expect(res.updateIds).toEqual(["u1", "u2"]);
    expect(res.merged).toHaveLength(180);
    expect(res.finalHoldings).toBe(2);
    // Both self-transfers used batches of 90.
    expect(t.calls.map((c) => c.cids?.length)).toEqual([90, 90]);
  });

  it("does nothing when already at/below target", async () => {
    const { relay } = stubRelay({ balances: [balanceOf(holdings(2))] });
    const t = mockTransfer();
    const res = await mergeHoldings(relay, wallet(), { target: 2, transferFn: t.fn });
    expect(res.rounds).toBe(0);
    expect(t.calls).toHaveLength(0);
    expect(res.finalHoldings).toBe(2);
  });

  it("SECURITY: every self-transfer pins receiver === wallet.party and amount 1-atomic", async () => {
    const { relay } = stubRelay({
      balances: [balanceOf(holdings(300)), balanceOf(holdings(210)), balanceOf(holdings(120)), balanceOf(holdings(2))],
    });
    const t = mockTransfer();
    await mergeHoldings(relay, wallet(), { batch: 90, transferFn: t.fn });
    expect(t.calls.length).toBeGreaterThan(0);
    for (const c of t.calls) {
      expect(c.receiver).toBe(PARTY); // never any other destination
      expect(c.amount).toBe("0.0000000001"); // 1 atomic — the change-amulet trick
    }
  });
});

describe("mergeHoldings — whale fallback (Scan snapshot)", () => {
  it("triggers on a 413-shaped balance error and enumerates via holdingsScan", async () => {
    const { relay, scanCalls } = stubRelay({
      // balance 413s first (whale) → holdingsScan used; after the whale pass the
      // live-phase balance is enumerable and already at target.
      balances: [whale413(), balanceOf(holdings(2))],
      scan: {
        party: PARTY,
        source: "scan-snapshot",
        recordTime: "2026-07-02T12:00:00Z",
        holdings: holdings(180, "s"),
        complete: true,
      },
    });
    const t = mockTransfer();
    const res = await mergeHoldings(relay, wallet(), { batch: 90, transferFn: t.fn });

    expect(res.usedScan).toBe(true);
    expect(scanCalls()).toBe(1);
    // Whale pass: 180 snapshot cids / 90 = 2 batches; then the live phase sees
    // target already met → 0 extra rounds.
    expect(res.rounds).toBe(2);
    expect(res.merged).toHaveLength(180);
    // The consumed cids are the SNAPSHOT cids (prefix "s"), proving the Scan list
    // fed the whale pass.
    expect(res.merged.every((c) => c.startsWith("s"))).toBe(true);
    // receiver invariant holds on the whale path too.
    for (const c of t.calls) expect(c.receiver).toBe(PARTY);
    expect(res.finalHoldings).toBe(2);
  });

  it("reports finalHoldings null when the wallet STILL 413s after the whale pass", async () => {
    const { relay } = stubRelay({
      balances: [whale413(), whale413()], // still a whale after the pass
      scan: {
        party: PARTY,
        source: "scan-snapshot",
        recordTime: "2026-07-02T12:00:00Z",
        holdings: holdings(90, "s"),
        complete: false, // page-capped — only a prefix
      },
    });
    const t = mockTransfer();
    const res = await mergeHoldings(relay, wallet(), { batch: 90, transferFn: t.fn });
    expect(res.usedScan).toBe(true);
    expect(res.rounds).toBe(1); // the one whale batch
    expect(res.finalHoldings).toBeNull();
  });
});

describe("mergeHoldings — stale-cid batch is skipped", () => {
  it("skips a whale batch whose input cid is stale/archived and continues", async () => {
    const staleErr = Object.assign(new Error("input contracts have been archived"), {});
    const { relay } = stubRelay({
      balances: [whale413(), balanceOf(holdings(2))],
      scan: {
        party: PARTY,
        source: "scan-snapshot",
        recordTime: "2026-07-02T12:00:00Z",
        holdings: holdings(180, "s"), // 2 batches of 90
        complete: true,
      },
    });
    // First batch throws a stale-input error (skipped), second succeeds.
    let n = 0;
    const calls: string[] = [];
    const fn = vi.fn(
      async (
        _r: RelayClient,
        _w: AgentWallet,
        o: Parameters<typeof transfer>[2]
      ): Promise<string> => {
        n++;
        calls.push(o.receiver);
        if (n === 1) throw staleErr;
        return `u${n}`;
      }
    ) as unknown as typeof transfer;

    const res = await mergeHoldings(relay, wallet(), { batch: 90, transferFn: fn });
    // Only the SECOND batch counts as an executed round; the stale one is skipped.
    expect(res.rounds).toBe(1);
    expect(res.updateIds).toEqual(["u2"]);
    expect(res.merged).toHaveLength(90); // only the successful batch's cids
    expect(calls).toHaveLength(2); // both batches were attempted
  });

  it("aborts the whale pass on a NON-stale (real) error", async () => {
    const { relay } = stubRelay({
      balances: [whale413()],
      scan: {
        party: PARTY,
        source: "scan-snapshot",
        recordTime: "2026-07-02T12:00:00Z",
        holdings: holdings(90, "s"),
        complete: true,
      },
    });
    const fn = vi.fn(async (): Promise<string> => {
      throw new Error("verify-before-sign refused: receiver mismatch");
    }) as unknown as typeof transfer;
    await expect(
      mergeHoldings(relay, wallet(), { batch: 90, transferFn: fn })
    ).rejects.toThrow(/merge aborted during whale batch/);
  });
});

describe("mergeHoldings — dry run", () => {
  it("enumerates + reports the plan but executes NO transfers", async () => {
    const { relay } = stubRelay({ balances: [balanceOf(holdings(250))] });
    const t = mockTransfer();
    const lines: string[] = [];
    const res = await mergeHoldings(relay, wallet(), {
      batch: 90,
      dryRun: true,
      transferFn: t.fn,
      onProgress: (l) => lines.push(l),
    });
    expect(t.calls).toHaveLength(0); // executed nothing
    expect(res.rounds).toBe(0);
    expect(res.plannedBatches).toBe(3); // ceil(250 / 90)
    expect(res.finalHoldings).toBe(250);
    expect(lines.join("\n")).toMatch(/dry run: 250 holding/);
  });

  it("dry run over a whale wallet reports the Scan-enumerated plan (finalHoldings null)", async () => {
    const { relay } = stubRelay({
      balances: [whale413()],
      scan: {
        party: PARTY,
        source: "scan-snapshot",
        recordTime: "2026-07-02T12:00:00Z",
        holdings: holdings(450, "s"),
        complete: true,
      },
    });
    const t = mockTransfer();
    const res = await mergeHoldings(relay, wallet(), { batch: 90, dryRun: true, transferFn: t.fn });
    expect(t.calls).toHaveLength(0);
    expect(res.usedScan).toBe(true);
    expect(res.plannedBatches).toBe(5); // ceil(450 / 90)
    expect(res.finalHoldings).toBeNull(); // whale — not enumerable on-ledger
  });
});

describe("mergeHoldings — maxRounds bound", () => {
  it("stops the live phase at maxRounds even if target is not reached", async () => {
    // Balance never drops below target within the budget: always return a big set
    // so each round batches but the stop is maxRounds, not target.
    const { relay } = stubRelay({ balances: [balanceOf(holdings(1000))] });
    const t = mockTransfer();
    const res = await mergeHoldings(relay, wallet(), {
      batch: 90,
      maxRounds: 3,
      transferFn: t.fn,
    });
    expect(res.rounds).toBe(3); // exactly maxRounds live rounds
    expect(t.calls).toHaveLength(3);
  });
});

describe("mergeHoldings — the default executor is the real transfer", () => {
  it("uses `transfer` from tx.ts when no transferFn is injected", async () => {
    // With target already met, no transfer is attempted, so this exercises the
    // default-parameter wiring without needing to stub the whole relay chain.
    const { relay } = stubRelay({ balances: [balanceOf(holdings(1))] });
    const res = await mergeHoldings(relay, wallet(), { target: 2 });
    expect(res.rounds).toBe(0);
    expect(res.finalHoldings).toBe(1);
  });
});

// ── Fix 1: CONTRACT_NOT_FOUND (the live-report shape) is treated as stale ──
// On a REPEAT run the whale pass re-enumerates the SAME daily Scan snapshot, so
// batch 1 references cids a previous run already consumed. The relay wraps the
// participant 404 into a 502 whose detail carries CONTRACT_NOT_FOUND / "Contract
// could not be found" — that batch must be SKIPPED (counted skippedStale), not
// abort the run.
describe("mergeHoldings — CONTRACT_NOT_FOUND batch is skipped (repeat-run snapshot)", () => {
  /** The exact production error: RelayHttpError 502 whose message carries the
   *  participant's 404 CONTRACT_NOT_FOUND detail. */
  const contractNotFound = (): RelayHttpError =>
    new RelayHttpError(
      "relay POST /v1/wallet/submit/prepare -> 502 " +
        '{"error":"wallet relay submit/prepare failed","detail":"POST ' +
        "/v2/interactive-submission/prepare returned HTTP 404 [CONTRACT_NOT_FOUND: " +
        'Contract could not be found with id 005e1234abcd]"}',
      502,
      {
        error: "wallet relay submit/prepare failed",
        detail:
          "POST /v2/interactive-submission/prepare returned HTTP 404 " +
          "[CONTRACT_NOT_FOUND: Contract could not be found with id 005e1234abcd]",
      }
    );

  it("skips the CONTRACT_NOT_FOUND batch, counts skippedStale, and continues", async () => {
    const { relay } = stubRelay({
      balances: [whale413(), balanceOf(holdings(2))],
      scan: {
        party: PARTY,
        source: "scan-snapshot",
        recordTime: "2026-07-02T12:00:00Z",
        holdings: holdings(180, "s"), // 2 batches of 90
        complete: true,
      },
    });
    let n = 0;
    const fn = vi.fn(
      async (
        _r: RelayClient,
        _w: AgentWallet,
        _o: Parameters<typeof transfer>[2]
      ): Promise<string> => {
        n++;
        if (n === 1) throw contractNotFound(); // batch 1 already consumed
        return `u${n}`;
      }
    ) as unknown as typeof transfer;

    const res = await mergeHoldings(relay, wallet(), { batch: 90, transferFn: fn });
    expect(res.usedScan).toBe(true);
    expect(res.skippedStale).toBe(1); // the CONTRACT_NOT_FOUND batch
    expect(res.rounds).toBe(1); // only the second whale batch executed
    expect(res.updateIds).toEqual(["u2"]);
    expect(res.merged).toHaveLength(90);
  });
});

// ── Fix 2 + 3: the CHAIN phase converges in ONE run via output chaining ──
// Each successful batch's OWN output cids (resolved via relay.txAmulets) feed an
// in-run pool; the chain phase self-transfers pool cids until ≤ target — with NO
// dependence on the next Scan snapshot or on /balance.
describe("mergeHoldings — chain phase converges via a batch's own outputs", () => {
  /** txAmulets returns 2 UNIQUE output cids per batch (the ~2 amulets a merge
   *  batch collapses to). Unique per updateId so the pool dedup never rejects them. */
  const twoOutputs = (updateId: string) => [
    { cid: `${updateId}-o1`, amount: "0.5" },
    { cid: `${updateId}-o2`, amount: "0.5" },
  ];

  it("chains whale outputs down to target in one run (chainedRounds > 0)", async () => {
    // batch 3, snapshot 6 → 2 whale batches; each whale batch → 2 pooled outputs →
    // pool 4. Chain: 4→(take3,+2)→3→(take3,+2)→2 → stop. 2 chain rounds. The FINAL
    // balance is enumerable at target, so the live phase adds nothing.
    const { relay, txAmuletsCalls } = stubRelay({
      balances: [whale413(), balanceOf(holdings(2))],
      scan: {
        party: PARTY,
        source: "scan-snapshot",
        recordTime: "2026-07-02T12:00:00Z",
        holdings: holdings(6, "s"),
        complete: true,
      },
      txAmulets: twoOutputs,
    });
    const t = mockTransfer();
    const res = await mergeHoldings(relay, wallet(), { batch: 3, transferFn: t.fn });

    expect(res.usedScan).toBe(true);
    expect(res.chainedRounds).toBe(2); // 2 chain rounds drained the pool to target
    expect(res.rounds).toBe(4); // 2 whale + 2 chain batches
    // Every self-transfer (whale AND chain) pins receiver === wallet.party.
    for (const c of t.calls) expect(c.receiver).toBe(PARTY);
    // The chain batches consumed the whale outputs (cids ending -o1/-o2), proving
    // the pool — not a fresh snapshot/balance — drove convergence.
    const chainInputs = t.calls.slice(2).flatMap((c) => c.cids ?? []);
    expect(chainInputs.some((c) => c.endsWith("-o1") || c.endsWith("-o2"))).toBe(true);
    // txAmulets was resolved for every executed batch (whale + chain).
    expect(txAmuletsCalls()).toEqual(res.updateIds);
    expect(res.finalHoldings).toBe(2);
  });

  it("does not chain when the pool is already at/below target", async () => {
    // 90 snapshot → 1 whale batch → 2 outputs → pool 2 == target → no chain round.
    const { relay } = stubRelay({
      balances: [whale413(), balanceOf(holdings(2))],
      scan: {
        party: PARTY,
        source: "scan-snapshot",
        recordTime: "2026-07-02T12:00:00Z",
        holdings: holdings(90, "s"),
        complete: true,
      },
      txAmulets: twoOutputs,
    });
    const t = mockTransfer();
    const res = await mergeHoldings(relay, wallet(), { batch: 90, transferFn: t.fn });
    expect(res.chainedRounds).toBe(0);
    expect(res.rounds).toBe(1); // just the whale batch
  });
});

// ── Fix 3 (reporter's stuck state): all whale batches skipped + pool empty +
// balance still 413 → SUCCESS (no throw) with the snapshot-stale message. ──
describe("mergeHoldings — all-stale + still-413 balance is a clean SUCCESS", () => {
  it("returns (does not throw) with finalHoldings null and the re-run message", async () => {
    const stale = (): Error =>
      new Error(
        "wallet relay submit/prepare failed: HTTP 404 [CONTRACT_NOT_FOUND: " +
          "Contract could not be found with id 005eabcd]"
      );
    const { relay } = stubRelay({
      // enumerate 413s → snapshot; after the (all-skipped) pass the balance STILL
      // 413s — nothing this run can do until the next snapshot.
      balances: [whale413(), whale413()],
      scan: {
        party: PARTY,
        source: "scan-snapshot",
        recordTime: "2026-07-02T12:00:00Z",
        holdings: holdings(180, "s"), // 2 batches — both stale
        complete: true,
      },
    });
    const fn = vi.fn(async (): Promise<string> => {
      throw stale();
    }) as unknown as typeof transfer;

    const lines: string[] = [];
    const res = await mergeHoldings(relay, wallet(), {
      batch: 90,
      transferFn: fn,
      onProgress: (l) => lines.push(l),
    });
    // Not an error: every batch was stale, pool empty, balance still un-enumerable.
    expect(res.usedScan).toBe(true);
    expect(res.skippedStale).toBe(2);
    expect(res.rounds).toBe(0);
    expect(res.chainedRounds).toBe(0);
    expect(res.finalHoldings).toBeNull();
    // The message tells the operator to re-run after the next daily snapshot.
    expect(lines.join("\n")).toMatch(/predate this run/);
    expect(lines.join("\n")).toMatch(/12:00 UTC/);
  });
});

// ── Fix 2 (resilience): a transient txAmulets failure warns + continues ──
describe("mergeHoldings — txAmulets transient failure is non-fatal", () => {
  it("warns and continues when a batch's output resolve fails", async () => {
    const { relay } = stubRelay({
      balances: [whale413(), balanceOf(holdings(2))],
      scan: {
        party: PARTY,
        source: "scan-snapshot",
        recordTime: "2026-07-02T12:00:00Z",
        holdings: holdings(90, "s"), // 1 whale batch
        complete: true,
      },
      // Output resolve fails transiently — must NOT abort the run.
      txAmulets: () => new Error("relay GET .../tx-amulets -> 502 transient"),
    });
    const t = mockTransfer();
    const lines: string[] = [];
    const res = await mergeHoldings(relay, wallet(), {
      batch: 90,
      transferFn: t.fn,
      onProgress: (l) => lines.push(l),
    });
    // The whale batch still counted; the run completed against the live balance.
    expect(res.rounds).toBe(1);
    expect(res.chainedRounds).toBe(0); // pool never populated (resolve failed)
    expect(res.finalHoldings).toBe(2);
    expect(lines.join("\n")).toMatch(/could not resolve outputs/);
  });
});

// ── Fix D: the --yes cost gate blocks a LARGE whale pass, allows it with yes ──
describe("mergeHoldings — whale-pass cost gate (--yes)", () => {
  /** A whale snapshot of `batches * 90` cids → exactly `batches` planned batches. */
  const whaleScan = (batches: number): HoldingsScanResult => ({
    party: PARTY,
    source: "scan-snapshot",
    recordTime: "2026-07-02T12:00:00Z",
    holdings: holdings(batches * 90, "s"),
    complete: true,
  });

  it("ABORTS before any submission when >20 batches and yes is not set", async () => {
    const { relay } = stubRelay({
      balances: [whale413()],
      scan: whaleScan(21), // 21 > 20
    });
    const fn = vi.fn(async (): Promise<string> => {
      throw new Error("must not submit when gated");
    }) as unknown as typeof transfer;
    await expect(
      mergeHoldings(relay, wallet(), { batch: 90, transferFn: fn })
    ).rejects.toThrow(/exceeds the 20-batch safety gate|--yes/);
    // The gate fires BEFORE any transfer.
    expect(fn).not.toHaveBeenCalled();
  });

  it("names the batch count and the GS-traffic cost in the abort message", async () => {
    const { relay } = stubRelay({ balances: [whale413()], scan: whaleScan(122) });
    const fn = vi.fn(async (): Promise<string> => "u") as unknown as typeof transfer;
    await expect(
      mergeHoldings(relay, wallet(), { batch: 90, transferFn: fn })
    ).rejects.toThrow(/122 large batches[\s\S]*Global Synchronizer|Global Synchronizer[\s\S]*--yes/);
  });

  it("proceeds past the gate when yes:true (submission happens)", async () => {
    const { relay } = stubRelay({
      // After the whale pass the balance is enumerable at target, so the run ends.
      balances: [whale413(), balanceOf(holdings(2))],
      scan: whaleScan(21),
    });
    const t = mockTransfer();
    const res = await mergeHoldings(relay, wallet(), {
      batch: 90,
      yes: true,
      transferFn: t.fn,
    });
    expect(t.calls.length).toBe(21); // all 21 whale batches submitted
    expect(res.rounds).toBe(21);
    for (const c of t.calls) expect(c.receiver).toBe(PARTY);
  });

  it("does NOT gate a small whale pass (≤20 batches) without yes", async () => {
    const { relay } = stubRelay({
      balances: [whale413(), balanceOf(holdings(2))],
      scan: whaleScan(20), // exactly 20 — not > 20, so ungated
    });
    const t = mockTransfer();
    const res = await mergeHoldings(relay, wallet(), { batch: 90, transferFn: t.fn });
    expect(res.rounds).toBe(20); // ran without --yes
  });

  it("never gates a dry run (only reports, submits nothing) even at >20 batches", async () => {
    const { relay } = stubRelay({ balances: [whale413()], scan: whaleScan(122) });
    const t = mockTransfer();
    const lines: string[] = [];
    const res = await mergeHoldings(relay, wallet(), {
      batch: 90,
      dryRun: true,
      transferFn: t.fn,
      onProgress: (l) => lines.push(l),
    });
    expect(t.calls).toHaveLength(0); // dry run submits nothing
    expect(res.plannedBatches).toBe(122);
    // The dry-run plan flags that a real run of this size needs --yes.
    expect(lines.join("\n")).toMatch(/--yes/);
  });
});
