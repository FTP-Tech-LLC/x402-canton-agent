/**
 * Amulet merge / consolidate — collapse a wallet's dust Amulet UTXOs into a
 * couple of holdings by self-transferring them in batches.
 *
 * WHY: every accepted incoming Canton transfer creates a fresh Amulet contract,
 * so an active wallet accumulates thousands of dust amulets. The participant's
 * JSON API caps /v2/state/active-contracts result size, so past that cap the
 * wallet can no longer even be ENUMERATED through the ledger (balance → 413
 * holdings_exceed_node_limit) and therefore can no longer PAY (the pay path
 * selects inputHoldingCids from that same enumeration). Merging restores both.
 *
 * HOW: each batch executes ONE self-transfer (sender = receiver = the wallet's
 * OWN party) of 1 atomic ("0.0000000001") consuming the whole batch as inputs.
 * The TransferFactory returns everything else as ONE change amulet to the sender,
 * so a batch of N dust amulets collapses to ~2 amulets. Using 1 atomic sidesteps
 * ALL fee math (the change amulet absorbs the remainder).
 *
 * ONE-RUN CONVERGENCE (whale wallets). The whale pass enumerates from the PUBLIC
 * SV Scan ACS snapshot, which refreshes only ~daily (≈12:00 UTC) and so does NOT
 * reflect the cids a PREVIOUS run consumed. A first run's batches also leave
 * hundreds of fresh OUTPUT amulets that are neither in that snapshot (created
 * after it) nor enumerable via /balance (a whale still exceeds the participant's
 * element cap). To converge WITHOUT waiting for the next snapshot, merge CHAINS on
 * a batch's OWN outputs: after every successful batch it resolves that batch's
 * output amulet cids via the relay (`txAmulets(party, updateId)`) and feeds them
 * into an in-run `pool` of known-live cids; a dedicated chain phase then keeps
 * self-transferring `pool` cids until the count reaches target. So 10,960 → ~244
 * → ~6 → 2 all happens in one run, with zero dependence on snapshot freshness or
 * /balance. Stale batches (snapshot cids a prior run already spent) are SKIPPED,
 * not fatal (see isStaleInputHoldingError, which also matches CONTRACT_NOT_FOUND).
 *
 * The transfer itself reuses the EXISTING outbound `transfer()` machinery — same
 * relay resolve → build → verify-before-sign → local sign → relay execute — so
 * there is no second signing path to audit. mergeHoldings only orchestrates
 * batching, the whale-wallet enumeration fallback, and the output-chaining.
 *
 * SECURITY INVARIANT (non-negotiable): every merge transfer pins
 * `receiver === wallet.party` BEFORE signing, and the verify-before-sign arm
 * (`assertPreparedTransferMatches`, via `transfer()`'s `kind:"cip56"` spec, which
 * pins `expect.receiver`) refuses to sign unless the prepared tx's receiver
 * equals it. A compromised relay therefore cannot turn a "merge" into an outbound
 * drain — the self-transfer receiver is caller intent, never the relay's value.
 */
import { transfer } from "./tx.js";
import {
  isHoldingsExceedNodeLimitError,
  type RelayClient,
} from "./relay-client.js";
import type { AgentWallet } from "./store.js";
import { resolveHashBinding } from "./hash-binding.js";
import { resolveTrustedDsoParty } from "./trusted-dso.js";
import { isStaleInputHoldingError } from "./tx.js";
import { resolveTrustedRegistryParties } from "./registry-parties.js";
import { sumLedgerDecimals } from "@ftptech/x402-canton-core";
import type { HashBindingOptions } from "./verify-prepared.js";

/** 1 atomic Amulet, as a ledger Decimal. The self-transfer moves this token
 *  amount and the factory returns the rest as ONE change amulet — so the amount
 *  never needs to cover fees, and the exact per-batch amount is irrelevant to the
 *  consolidation. Kept a named constant because the "why 1 atomic" is load-bearing. */
const ONE_ATOMIC = "0.0000000001";

/** Whale-pass cost gate: above this many PLANNED whale batches, `merge` refuses to
 *  run without `opts.yes` (CLI `--yes`). Each ~90-input batch consumes significant
 *  Global-Synchronizer traffic (~21.5 KB ≈ 1–1.5 USD per tx on MainNet), so a
 *  122-batch pass is a ~$157 event the operator must opt into. `--dry-run` is never
 *  gated; small merges (≤ this) run without `--yes`, unchanged. */
const WHALE_COST_GATE_BATCHES = 20;

export interface MergeOptions {
  /** Stop once the LIVE holding count is at or below this (default 2 — the two
   *  amulets a single self-transfer already collapses a batch into). */
  target?: number;
  /** Input amulets consumed per self-transfer (default 90). Bounded well under
   *  the participant's per-tx input limit; each batch → ~2 amulets. */
  batch?: number;
  /** Max live-phase rounds after the whale pass (default 30). A hard stop so a
   *  pathological wallet can never loop unbounded. */
  maxRounds?: number;
  /** Enumerate + report the plan only; execute NO transfers. */
  dryRun?: boolean;
  /** Acknowledge the Global-Synchronizer traffic cost of a LARGE whale pass. When
   *  the planned whale batches exceed WHALE_COST_GATE_BATCHES (20) and this is not
   *  set, `merge` ABORTS before any submission (each ~90-input batch consumes
   *  significant GS traffic, ≈1–1.5 USD on MainNet). `--dry-run` is never gated.
   *  Small merges (≤20 planned batches) run without it, as before. */
  yes?: boolean;
  /** Hash-binding policy for the self-transfers; defaults to the env-resolved
   *  binding (real V2 recompute unless CANTON_AGENT_TRUST_RELAY_HASH). */
  hashBinding?: HashBindingOptions;
  /** Independently-trusted Amulet DSO (instrument admin) to pin on each transfer,
   *  exactly like `withdraw`. Defaults to CANTON_AGENT_DSO_PARTY / the network
   *  constant; without it a self-transfer carrying the DSO in its consequences
   *  fails closed (see trusted-dso.ts). */
  instrumentAdmin?: string;
  /** Registry (CIP-56) token to consolidate instead of Canton Coin — the
   *  instrument id (e.g. "USDCx"); `instrumentAdmin` is then its registrar.
   *  Enumerates the token's UNLOCKED holdings through the HoldingV1 read
   *  (`relay.holdings`) and self-transfers each batch for its FULL amount:
   *  measured on MainNet, a registry self-transfer does not collapse on a
   *  1-atomic amount (2 inputs → 2 outputs) but does on the full sum (→ 1). */
  instrumentId?: string;
  /** Independently-trusted registry parties (operator/bridge) pinned in
   *  verify-before-sign for a registry merge, exactly like `withdraw`. Defaults
   *  to the env-resolved set. */
  trustedRegistryParties?: ReadonlySet<string>;
  /** @internal Injected transfer executor (defaults to the real `transfer`). Lets
   *  unit tests mock the outbound seam and assert receiver === wallet.party on
   *  every call without stubbing the whole relay/prepare/sign chain. */
  transferFn?: typeof transfer;
  /** @internal Progress sink (defaults to no-op). The CLI passes a logger. */
  onProgress?: (line: string) => void;
}

export interface MergeResult {
  /** Number of batch self-transfers that were EXECUTED (0 for a dry run). Includes
   *  whale, chain, and live batches. */
  rounds: number;
  /** Every input amulet cid consumed across all executed batches. */
  merged: string[];
  /** The updateId of each executed batch self-transfer. */
  updateIds: string[];
  /** The final LIVE holding count, or null when the wallet still 413s on balance
   *  (i.e. it is STILL a whale — extremely large; another `merge` run continues,
   *  or the leftovers predate this run and await the next Scan snapshot). */
  finalHoldings: number | null;
  /** True when enumeration used the Scan-snapshot whale path (balance 413'd). */
  usedScan: boolean;
  /** Whale batches SKIPPED because their snapshot cids were already consumed by a
   *  prior run (stale/archived/CONTRACT_NOT_FOUND) — expected on a repeat run over
   *  the same daily snapshot; not an error. */
  skippedStale: number;
  /** Chain-phase rounds: self-transfers over the in-run `pool` of a batch's own
   *  output cids (the mechanism that makes a whale converge in ONE run without the
   *  next Scan snapshot). */
  chainedRounds: number;
  /** For a dry run: the planned batch count over the enumerated holdings. */
  plannedBatches?: number;
}

/** Split `cids` into consecutive chunks of at most `size`. */
function chunk<T>(cids: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < cids.length; i += size) out.push(cids.slice(i, i + size));
  return out;
}

/** Enumerate the wallet's Amulet holding cids. Tries the ledger (`balance`)
 *  first; on the discriminated 413 holdings_exceed_node_limit falls back to the
 *  PUBLIC Scan snapshot (whale path). Returns the cids + whether Scan was used. */
async function enumerateHoldingCids(
  relay: RelayClient,
  party: string
): Promise<{ cids: string[]; usedScan: boolean }> {
  try {
    const bal = await relay.balance(party);
    return { cids: bal.holdings.map((h) => h.cid), usedScan: false };
  } catch (err) {
    if (!isHoldingsExceedNodeLimitError(err)) throw err;
    // Whale: the ledger can't enumerate this party — read the snapshot instead.
    const scan = await relay.holdingsScan(party);
    return { cids: scan.holdings.map((h) => h.cid), usedScan: true };
  }
}

/**
 * Consolidate the wallet's dust Amulet holdings.
 *
 * Phases:
 *  1. ENUMERATE — `balance` if it works, else the Scan snapshot (whale).
 *  1b. COST GATE — when the whale pass would run > WHALE_COST_GATE_BATCHES (20)
 *      batches and `opts.yes` is not set, ABORT before any submission (the pass is
 *      an expensive GS-traffic event). `--dry-run` skips the gate.
 *  2. WHALE PASS (only when enumeration used Scan) — ONE pass over the snapshot
 *     list in batches of `batch`; each batch is one self-transfer. The snapshot
 *     lags: a batch whose cids a PRIOR run already consumed fails
 *     stale/CONTRACT_NOT_FOUND and is SKIPPED (counted `skippedStale`), the pass
 *     continues; any other failure aborts. Each SUCCESSFUL batch's OWN output cids
 *     are resolved via `txAmulets` and pushed into the in-run `pool`.
 *  3. CHAIN PHASE — while `pool.length > target` and rounds remain: self-transfer
 *     up to `batch` cids FROM THE POOL; the outputs go back into the pool. This
 *     converges a whale in ONE run using only the batches' own outputs — no
 *     dependence on the next Scan snapshot or on /balance.
 *  4. FINAL PHASE — try LIVE `balance`: if it works and holdings > target, run
 *     bounded live rounds (catches pre-existing leftovers not in the pool); if it
 *     still 413s, END SUCCESSFULLY — the leftovers predate this run and are not yet
 *     enumerable; re-run after the next Scan snapshot (~12:00 UTC). NOT an error.
 *
 * `maxRounds` bounds the CHAIN + LIVE rounds together; the whale pass keeps its own
 * accounting. Every self-transfer pins receiver = wallet.party (verify-before-sign
 * enforced) — whale, chain, and live alike.
 */
/** Registry-token branch of `merge`. Same invariant (receiver == this wallet,
 *  enforced by verify-before-sign), different mechanics: there is no Scan
 *  snapshot / whale pass for a registry token, holdings come from the HoldingV1
 *  read, and each batch is self-transferred for its FULL sum so the registry
 *  collapses it into one Holding (see MergeOptions.instrumentId). The ACS is
 *  re-read after every round, so no output chaining is needed. */
async function mergeRegistryHoldings(
  relay: RelayClient,
  wallet: AgentWallet,
  opts: MergeOptions,
  admin: string,
  id: string
): Promise<MergeResult> {
  const target = opts.target ?? 1; // a full-amount self-transfer leaves ONE holding
  const batchSize = opts.batch ?? 90;
  const maxRounds = opts.maxRounds ?? 30;
  const doTransfer = opts.transferFn ?? transfer;
  const log = opts.onProgress ?? ((): void => {});
  const hashBinding = opts.hashBinding ?? resolveHashBinding();
  const trustedRegistryParties =
    opts.trustedRegistryParties ?? resolveTrustedRegistryParties(admin, process.env);

  const enumerate = async (): Promise<Array<{ cid: string; amount: string }>> => {
    const h = await relay.holdings(wallet.party, { admin, id });
    const ins = h.instruments.find((i) => i.admin === admin && i.id === id);
    return (ins?.holdings ?? []).filter((x) => !x.locked).map(({ cid, amount }) => ({ cid, amount }));
  };

  let live = await enumerate();
  const plannedBatches = Math.ceil(live.length / batchSize);
  if (opts.dryRun) {
    log(
      `dry run: ${live.length} unlocked ${id} holding(s) → ${plannedBatches} batch(es) ` +
        `of up to ${batchSize} → target ${target}. Nothing executed.`
    );
    return {
      rounds: 0,
      merged: [],
      updateIds: [],
      finalHoldings: live.length,
      usedScan: false,
      skippedStale: 0,
      chainedRounds: 0,
      plannedBatches,
    };
  }

  const merged: string[] = [];
  const updateIds: string[] = [];
  let rounds = 0;
  let skippedStale = 0;
  while (live.length > target && rounds + skippedStale < maxRounds) {
    const b = live.slice(0, batchSize);
    const amount = sumLedgerDecimals(b.map((x) => x.amount));
    try {
      const updateId = await doTransfer(relay, wallet, {
        receiver: wallet.party, // SELF-transfer — the non-negotiable invariant.
        amount, // FULL sum: the registry collapses the batch into one Holding.
        inputHoldingCids: b.map((x) => x.cid),
        hashBinding,
        registryInstrument: true,
        expectInstrumentAdmin: admin,
        expectInstrumentId: id,
        trustedRegistryParties,
      });
      rounds++;
      merged.push(...b.map((x) => x.cid));
      updateIds.push(updateId);
      log(`  round ${rounds}: merged ${b.length} ${id} holding(s) (${amount}) → updateId ${updateId}`);
    } catch (err) {
      if (!isStaleInputHoldingError(err)) throw err;
      skippedStale++;
      log(`  round ${rounds + skippedStale}: stale (already consumed) — re-enumerating`);
    }
    live = await enumerate();
  }
  if (live.length > target) log(`reached maxRounds (${maxRounds}); ${live.length} holding(s) remain.`);
  else log(`done: ${live.length} ${id} holding(s) ≤ target ${target}.`);
  return {
    rounds,
    merged,
    updateIds,
    finalHoldings: live.length,
    usedScan: false,
    skippedStale,
    chainedRounds: 0,
  };
}

export async function mergeHoldings(
  relay: RelayClient,
  wallet: AgentWallet,
  opts: MergeOptions = {}
): Promise<MergeResult> {
  if (opts.instrumentId !== undefined) {
    if (opts.instrumentAdmin === undefined) {
      throw new Error("merge: instrumentId needs instrumentAdmin (the token's registrar)");
    }
    if (opts.instrumentId === "Amulet") {
      throw new Error("merge: Amulet is Canton Coin — omit instrumentId to merge CC");
    }
    return mergeRegistryHoldings(relay, wallet, opts, opts.instrumentAdmin, opts.instrumentId);
  }
  const target = opts.target ?? 2;
  const batchSize = opts.batch ?? 90;
  const maxRounds = opts.maxRounds ?? 30;
  const doTransfer = opts.transferFn ?? transfer;
  const log = opts.onProgress ?? ((): void => {});
  const hashBinding = opts.hashBinding ?? resolveHashBinding();
  const instrumentAdmin =
    opts.instrumentAdmin ?? resolveTrustedDsoParty(process.env, wallet.network);

  // One self-transfer of a single batch. receiver === wallet.party is the merge
  // security invariant — pinned here (caller intent) and re-checked by
  // verify-before-sign inside `transfer` before it signs.
  const mergeBatch = (cids: string[]): Promise<string> =>
    doTransfer(relay, wallet, {
      receiver: wallet.party, // SELF-transfer — the non-negotiable invariant.
      amount: ONE_ATOMIC, // 1 atomic; the change amulet absorbs the rest (no fee math).
      inputHoldingCids: cids,
      hashBinding,
      ...(instrumentAdmin !== undefined ? { expectInstrumentAdmin: instrumentAdmin } : {}),
    });

  const { cids: initialCids, usedScan } = await enumerateHoldingCids(
    relay,
    wallet.party
  );

  // ── Dry run: report the plan, execute nothing (never gated). ──
  if (opts.dryRun) {
    const plannedBatches = Math.ceil(initialCids.length / batchSize);
    log(
      `dry run: ${initialCids.length} holding(s)` +
        `${usedScan ? " (via Scan snapshot — wallet too large to enumerate on-ledger)" : ""}` +
        ` → ${plannedBatches} batch(es) of up to ${batchSize} → target ${target}.` +
        (plannedBatches > WHALE_COST_GATE_BATCHES
          ? ` This exceeds ${WHALE_COST_GATE_BATCHES} batches — a real run needs --yes` +
            ` (large batches consume Global Synchronizer traffic, ~1–1.5 USD per` +
            ` 90-input transaction on MainNet).`
          : "") +
        ` Nothing executed.`
    );
    return {
      rounds: 0,
      merged: [],
      updateIds: [],
      finalHoldings: usedScan ? null : initialCids.length,
      usedScan,
      skippedStale: 0,
      chainedRounds: 0,
      plannedBatches,
    };
  }

  // ── Cost gate: a large whale pass is an expensive GS-traffic event. Refuse to
  // submit ANYTHING when the planned whale batches exceed the gate and --yes was
  // not given. Only the whale (snapshot) pass is gated — a small/enumerable wallet
  // (usedScan === false) runs unchanged. ──
  if (usedScan) {
    const plannedWhaleBatches = Math.ceil(initialCids.length / batchSize);
    if (plannedWhaleBatches > WHALE_COST_GATE_BATCHES && !opts.yes) {
      throw new Error(
        `merge would run ${plannedWhaleBatches} large batches (${initialCids.length} ` +
          `holdings / ${batchSize} per batch), which exceeds the ${WHALE_COST_GATE_BATCHES}-batch ` +
          `safety gate. Each large batch consumes significant Global Synchronizer ` +
          `traffic (~1–1.5 USD per 90-input transaction on MainNet), so this pass ` +
          `is a meaningful cost. Re-run with --yes to proceed, or --dry-run to preview.`
      );
    }
  }

  const merged: string[] = [];
  const updateIds: string[] = [];
  let rounds = 0;
  let skippedStale = 0;
  let chainedRounds = 0;

  // The in-run POOL of KNOWN-LIVE Amulet cids: a batch's own output amulets,
  // resolved by updateId via the relay right after the batch commits. This is what
  // lets a whale converge in ONE run — the outputs are neither in the (daily) Scan
  // snapshot nor enumerable via /balance, so without chaining a repeat run makes no
  // progress until the next snapshot. Deduped (a cid must enter the pool once).
  const pool: string[] = [];
  const poolSeen = new Set<string>();
  const addToPool = (cids: readonly string[]): void => {
    for (const c of cids) {
      if (!poolSeen.has(c)) {
        poolSeen.add(c);
        pool.push(c);
      }
    }
  };

  // Resolve a committed batch's OWN output amulet cids (relay.txAmulets by
  // updateId) and feed them into the pool. A transient txAmulets failure is NOT
  // fatal: warn and continue — the final balance() phase still catches leftovers.
  const absorbOutputs = async (updateId: string): Promise<void> => {
    try {
      const out = await relay.txAmulets(wallet.party, updateId);
      addToPool(out.amulets.map((a) => a.cid));
    } catch (err) {
      log(
        `  (could not resolve outputs of ${updateId}: ` +
          `${err instanceof Error ? err.message : String(err)} — continuing)`
      );
    }
  };

  // ── Phase 2: whale pass over the snapshot list (only when Scan was needed). ──
  // Each batch collapses ~batch dust amulets to ~2; a batch whose snapshot cids a
  // prior run already consumed is SKIPPED (stale/CONTRACT_NOT_FOUND) — expected on
  // a repeat run over the same daily snapshot. Every SUCCESSFUL batch's outputs go
  // into the pool for the chain phase to finish the job.
  if (usedScan) {
    const batches = chunk(initialCids, batchSize);
    log(
      `whale pass: ${initialCids.length} holdings (Scan snapshot) → ${batches.length} batch(es) of up to ${batchSize}.`
    );
    for (let i = 0; i < batches.length; i++) {
      const b = batches[i]!;
      try {
        const updateId = await mergeBatch(b);
        rounds++;
        merged.push(...b);
        updateIds.push(updateId);
        log(`  whale batch ${i + 1}/${batches.length}: merged ${b.length} → updateId ${updateId}`);
        await absorbOutputs(updateId);
      } catch (err) {
        // Snapshot cids a PRIOR run already consumed resolve to nothing at prepare
        // (stale/archived/CONTRACT_NOT_FOUND) — SKIP that batch and keep going. Any
        // other failure is real: abort with a clear message.
        if (isStaleInputHoldingError(err)) {
          skippedStale++;
          log(`  whale batch ${i + 1}/${batches.length}: stale (already consumed) — skipped`);
          continue;
        }
        throw new Error(
          `merge aborted during whale batch ${i + 1}/${batches.length}: ` +
            (err instanceof Error ? err.message : String(err))
        );
      }
    }
  }

  // `maxRounds` bounds the CHAIN + LIVE rounds together (whale batches have their
  // own accounting above), so a pathological wallet can never loop unbounded.
  let boundedRounds = 0;
  const budgetLeft = (): boolean => boundedRounds < maxRounds;

  // ── Phase 3: chain phase — self-transfer the pool's own output cids until the
  // pool reaches target. This is the snapshot-independent convergence: the whale
  // pass left ~2 outputs per successful batch in the pool (e.g. 244), and each
  // chain round collapses up to `batch` of them back to ~2, so 244 → ~6 → 2 in a
  // few rounds. Each round removes its inputs from the pool and adds its outputs. ──
  while (pool.length > target && budgetLeft()) {
    const b = pool.splice(0, batchSize); // take up to `batch` cids OUT of the pool
    for (const c of b) poolSeen.delete(c); // consumed on-ledger — no longer live
    const updateId = await mergeBatch(b);
    rounds++;
    chainedRounds++;
    boundedRounds++;
    merged.push(...b);
    updateIds.push(updateId);
    log(`  chain round ${chainedRounds}: merged ${b.length} → updateId ${updateId}`);
    await absorbOutputs(updateId); // outputs re-enter the pool for the next round
  }

  // ── Phase 4: final phase — reconcile against the LIVE balance. This catches
  // pre-existing leftovers NOT produced by this run (so not in the pool), and is
  // the authoritative stop condition. If the wallet STILL exceeds the participant's
  // element cap, those leftovers predate this run and are not yet enumerable — end
  // SUCCESSFULLY and tell the user to re-run after the next Scan snapshot. ──
  let finalHoldings: number | null = pool.length;
  let liveRoundCount = 0;
  // NON-whale wallets never populated the pool (usedScan false) and already have a
  // live enumeration in hand — reuse it for the FIRST iteration instead of reading
  // /balance twice. The whale path leaves this undefined so the loop reads the true
  // post-pass state. A `null` from a read means the wallet still 413s (un-
  // enumerable) — the terminal "predates this run" success case.
  let prefetched: string[] | undefined = usedScan ? undefined : initialCids;
  for (;;) {
    let liveCids: string[];
    if (prefetched !== undefined) {
      liveCids = prefetched;
      prefetched = undefined;
    } else {
      try {
        const bal = await relay.balance(wallet.party);
        liveCids = bal.holdings.map((h) => h.cid);
      } catch (err) {
        if (isHoldingsExceedNodeLimitError(err)) {
          // Still a whale on /balance. Any pool cids are already consolidated; the
          // remaining un-enumerable holdings predate this run (not in this run's
          // snapshot, not produced by it) — the reporter's stuck state. NOT an
          // error: converge further after the next snapshot. finalHoldings = null.
          finalHoldings = null;
          log(
            "remaining holdings predate this run and are not yet enumerable on-ledger " +
              "(a whale still exceeds the participant's element cap). They will appear " +
              "in the next Scan snapshot (~12:00 UTC daily) — re-run `merge` then to " +
              "continue consolidating. This run made all the progress it can; not an error."
          );
          break;
        }
        throw err;
      }
    }
    finalHoldings = liveCids.length;
    if (liveCids.length <= target) {
      log(`done: ${liveCids.length} holding(s) ≤ target ${target}.`);
      break;
    }
    if (!budgetLeft()) {
      log(`reached maxRounds (${maxRounds}); ${liveCids.length} holding(s) remain.`);
      break;
    }
    const b = liveCids.slice(0, batchSize);
    const updateId = await mergeBatch(b);
    rounds++;
    liveRoundCount++;
    boundedRounds++;
    merged.push(...b);
    updateIds.push(updateId);
    log(`  live round ${liveRoundCount}: merged ${b.length} → updateId ${updateId}`);
  }

  return {
    rounds,
    merged,
    updateIds,
    finalHoldings,
    usedScan,
    skippedStale,
    chainedRounds,
  };
}
