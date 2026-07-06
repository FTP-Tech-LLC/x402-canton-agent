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

/** Full pre-call gate for `withdraw` (the amount IS known up front). Throws
 *  PolicyError if the requested amount breaches any cap. Never silently clamps. */
export function assertWithdrawAllowed(
  policy: SpendPolicy,
  ledger: PolicyLedger,
  amountCC: number
): void {
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
