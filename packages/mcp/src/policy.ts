/**
 * Spend-policy enforcement + a tiny on-disk ledger.
 *
 * The ledger (`<home>/mcp-policy-ledger.json`, 0600) survives restarts and
 * tracks the rolling daily spend and the lifetime in/out totals that back the
 * funded-ceiling. Enforcement runs BEFORE any signature; outbound is recorded
 * only AFTER a confirmed-success money move.
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { SpendPolicy } from "./config.js";

export interface PolicyLedger {
  date: string; // YYYY-MM-DD (UTC); rolls daily
  spentTodayCC: number;
  lifetimeOutCC: number;
  lifetimeClaimedCC: number;
}

/**
 * Where a spend policy keeps its running totals. The local server keeps them in
 * a file in its home (`createFilePolicyLedgerStore`); a hosted server keeps one
 * per user in its database. The tools only see this interface.
 */
export interface PolicyLedgerStore {
  read(now: number): Promise<PolicyLedger>;
  /** Record a confirmed outbound move (after the money actually left). */
  recordOutbound(amountCC: number, now: number): Promise<void>;
  /** Raise the funded ceiling to a new high-water (never lowers it). */
  recordClaimedHighWater(claimedTotalCC: number, now: number): Promise<void>;
  /** Optional history for the owner (the hosted server keeps one per user and
   *  shows it on the account page). Best effort: a failed write never fails
   *  the money move it describes. */
  recordOperation?(op: OperationRecord, now: number): Promise<void>;
}

/** The file-backed ledger in `home`, over the functions below. */
export function createFilePolicyLedgerStore(home: string): PolicyLedgerStore {
  return {
    read: async (now) => readLedger(home, now),
    recordOutbound: async (amountCC, now) => recordOutbound(home, amountCC, now),
    recordClaimedHighWater: async (total, now) => recordClaimedHighWater(home, total, now),
  };
}

/** One line of the owner-visible history of money moves. */
export interface OperationRecord {
  /** Money moves; "export" is the owner taking the key out (account page). */
  kind: "pay" | "withdraw" | "swap" | "claim" | "export";
  /** CC that left the wallet (pay, withdraw, a CC swap input), when known. */
  amountCC?: number | undefined;
  /** What it was for: the paid host, the destination, the swap pair. */
  detail: string;
  updateId?: string | undefined;
  ok: boolean;
}

/** Thrown when a money move is refused by policy. The caller turns it into a
 *  structured MCP tool error; NOTHING is signed or sent to the relay. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10);
const ledgerPath = (home: string): string => join(home, "mcp-policy-ledger.json");

export function readLedger(home: string, now: number): PolicyLedger {
  let l: PolicyLedger;
  try {
    l = JSON.parse(readFileSync(ledgerPath(home), "utf8")) as PolicyLedger;
  } catch {
    l = { date: dayOf(now), spentTodayCC: 0, lifetimeOutCC: 0, lifetimeClaimedCC: 0 };
  }
  if (l.date !== dayOf(now)) {
    // New UTC day → reset the rolling daily counter (lifetime totals persist).
    l.date = dayOf(now);
    l.spentTodayCC = 0;
  }
  return l;
}

function writeLedger(home: string, l: PolicyLedger): void {
  const p = ledgerPath(home);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(l), { mode: 0o600 });
  renameSync(tmp, p); // atomic
}

/** Pre-call gate for `pay`: the CC price is unknown until mid-dance, so here we
 *  only block on what IS knowable up front — the payer domain and whether the
 *  daily / funded ceilings are ALREADY exhausted. Throws PolicyError if blocked. */
export function assertPayAllowed(
  policy: SpendPolicy,
  ledger: PolicyLedger,
  url: string
): void {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new PolicyError(`invalid pay url: ${url}`);
  }
  if (policy.allowDomains !== "*") {
    if (policy.allowDomains.length === 0) {
      throw new PolicyError(
        "pay blocked: no payer domains allowed. Start the server with " +
          "--allow-domains <host,host> (or '*' to allow any)."
      );
    }
    const ok = policy.allowDomains.some(
      (d) => host === d || host.endsWith(`.${d}`)
    );
    if (!ok) {
      throw new PolicyError(
        `pay blocked: ${host} is not in the allowed payer domains (${policy.allowDomains.join(", ")}).`
      );
    }
  }
  if (policy.dailyCap !== undefined && ledger.spentTodayCC >= policy.dailyCap) {
    throw new PolicyError(
      `pay blocked: daily cap ${policy.dailyCap} CC already reached (spent ${ledger.spentTodayCC} today).`
    );
  }
  if (policy.fundedCeiling && ledger.lifetimeOutCC >= ledger.lifetimeClaimedCC) {
    throw new PolicyError(
      `pay blocked: funded ceiling reached (out ${ledger.lifetimeOutCC} CC >= claimed ${ledger.lifetimeClaimedCC} CC). Claim more funding first.`
    );
  }
}

/**
 * The most `pay` may hand the signer for ONE payment: the per-tx cap, the rest
 * of today's budget and the rest of the funded ceiling, whichever is smallest;
 * undefined when none is configured. The 402 price is unknown until the merchant
 * answers, so the signer (which sees it) enforces this number; the daily cap on
 * its own could only stop a payment from STARTING once it was already spent.
 */
export function payValueCeiling(policy: SpendPolicy, ledger: PolicyLedger): number | undefined {
  const caps: number[] = [];
  if (policy.maxPerTx !== undefined) caps.push(policy.maxPerTx);
  if (policy.dailyCap !== undefined) caps.push(Math.max(0, policy.dailyCap - ledger.spentTodayCC));
  if (policy.fundedCeiling) {
    caps.push(Math.max(0, ledger.lifetimeClaimedCC - ledger.lifetimeOutCC));
  }
  return caps.length === 0 ? undefined : Math.min(...caps);
}

/** Full pre-call gate for `withdraw` (the amount IS known up front). Throws
 *  PolicyError if the requested amount breaches any cap. Never silently clamps. */
export function assertWithdrawAllowed(
  policy: SpendPolicy,
  ledger: PolicyLedger,
  amountCC: number,
  to?: string
): void {
  if (policy.withdrawAllowlist !== undefined && (to === undefined || !policy.withdrawAllowlist.includes(to))) {
    throw new PolicyError(
      `withdraw blocked: ${to ?? "the destination"} is not a withdrawal address the owner confirmed.` +
        (policy.withdrawAllowlistUrl ? ` The owner can add it on ${policy.withdrawAllowlistUrl}.` : "")
    );
  }
  if (!(amountCC > 0)) {
    throw new PolicyError(`withdraw blocked: non-positive amount ${amountCC}`);
  }
  if (policy.maxPerTx !== undefined && amountCC > policy.maxPerTx) {
    throw new PolicyError(
      `withdraw blocked: ${amountCC} CC exceeds the per-tx cap of ${policy.maxPerTx} CC.`
    );
  }
  if (
    policy.dailyCap !== undefined &&
    ledger.spentTodayCC + amountCC > policy.dailyCap
  ) {
    throw new PolicyError(
      `withdraw blocked: ${amountCC} CC would exceed the daily cap of ${policy.dailyCap} CC (already spent ${ledger.spentTodayCC} today).`
    );
  }
  if (
    policy.fundedCeiling &&
    ledger.lifetimeOutCC + amountCC > ledger.lifetimeClaimedCC
  ) {
    throw new PolicyError(
      `withdraw blocked: ${amountCC} CC would exceed the funded ceiling (out ${ledger.lifetimeOutCC} CC, claimed ${ledger.lifetimeClaimedCC} CC).`
    );
  }
}

/**
 * Pre-send gate for `swap`. A swap's input goes to a PINNED venue party and the
 * counter-asset comes back, so the caps bound EXPOSURE (venue + slippage risk on
 * the amount), not a one-way loss — and the CC leg is what they can be stated in.
 *
 *  - CC input: `ccValue` is the exact amount leaving, known up front. Per-tx,
 *    daily and funded ceilings all apply, exactly as for `withdraw`.
 *  - Token input: `ccValue` is the venue's QUOTED CC output — the closest CC
 *    figure for what leaves. Only the per-tx cap applies: the daily cap and the
 *    funded ceiling bound CC LEAVING the wallet, and this swap brings CC in
 *    (counting it out would later block withdrawing the very CC it delivered).
 *  - No CC value (neither leg is CC, or a market-fill ticket carried no numeric
 *    quote): with any per-tx or daily cap set that is a refusal — "cannot apply
 *    the cap" is never "no cap" in this package.
 *
 * Throws PolicyError; nothing has been quoted for a fee or signed when it does.
 */
export function assertSwapAllowed(
  policy: SpendPolicy,
  ledger: PolicyLedger,
  args: { ccValue: number; inputIsCC: boolean }
): void {
  const { ccValue, inputIsCC } = args;
  if (!Number.isFinite(ccValue)) {
    if (policy.maxPerTx !== undefined || policy.dailyCap !== undefined) {
      throw new PolicyError(
        "swap blocked: a spend cap is set but no CC value could be put on this swap " +
          "(neither leg is CC, or the venue gave no numeric quote) — the caps are in CC. " +
          "Swap through CC in two steps, or retry once the venue quotes."
      );
    }
    return;
  }
  const what = inputIsCC ? `${ccValue} CC` : `${ccValue} CC (the venue's quoted value)`;
  if (!(ccValue > 0)) {
    throw new PolicyError(`swap blocked: non-positive amount ${ccValue}`);
  }
  if (policy.maxPerTx !== undefined && ccValue > policy.maxPerTx) {
    throw new PolicyError(
      `swap blocked: ${what} exceeds the per-tx cap of ${policy.maxPerTx} CC.`
    );
  }
  if (!inputIsCC) return;
  if (
    policy.dailyCap !== undefined &&
    ledger.spentTodayCC + ccValue > policy.dailyCap
  ) {
    throw new PolicyError(
      `swap blocked: ${what} would exceed the daily cap of ${policy.dailyCap} CC (already spent ${ledger.spentTodayCC} today).`
    );
  }
  if (
    policy.fundedCeiling &&
    ledger.lifetimeOutCC + ccValue > ledger.lifetimeClaimedCC
  ) {
    throw new PolicyError(
      `swap blocked: ${what} would exceed the funded ceiling (out ${ledger.lifetimeOutCC} CC, claimed ${ledger.lifetimeClaimedCC} CC).`
    );
  }
}

/** Record a confirmed outbound move (pay/withdraw) into the rolling + lifetime
 *  counters. Call AFTER the money actually left (balance-delta or returned amount). */
export function recordOutbound(home: string, amountCC: number, now: number): void {
  if (!(amountCC > 0)) return;
  const l = readLedger(home, now);
  l.spentTodayCC += amountCC;
  l.lifetimeOutCC += amountCC;
  writeLedger(home, l);
}

/** Raise the funded ceiling after a claim. `claimedTotalCC` is the wallet's
 *  post-claim on-ledger balance plus what has already gone out — i.e. the
 *  high-water of everything ever funded in. Monotonic (never lowers). */
export function recordClaimedHighWater(
  home: string,
  claimedTotalCC: number,
  now: number
): void {
  const l = readLedger(home, now);
  if (claimedTotalCC > l.lifetimeClaimedCC) {
    l.lifetimeClaimedCC = claimedTotalCC;
    writeLedger(home, l);
  }
}
