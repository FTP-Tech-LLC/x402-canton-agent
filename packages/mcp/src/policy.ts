/**
 * Spend-policy enforcement + a tiny on-disk ledger.
 *
 * The ledger (`<home>/mcp-policy-ledger.json`, 0600) survives restarts and
 * tracks the spend per UTC day and the lifetime in/out totals that back the
 * funded-ceiling. Enforcement runs BEFORE any signature; outbound is recorded
 * only AFTER a confirmed-success money move.
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { SpendPolicy } from "./config.js";
import type { CatalogEntry } from "./catalog.js";
import { matchesCatalog } from "./catalog-match.js";

export interface PolicyLedger {
  date: string; // YYYY-MM-DD (UTC); rolls daily
  spentTodayCC: number;
  lifetimeOutCC: number;
  lifetimeClaimedCC: number;
  /** USDCx counted against today's USDCx cap (UTC day, its own reset).
   *  Absent reads as 0: ledgers from before USDCx payments have none. */
  spentTodayUSDCx?: number | undefined;
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
  /** Count USDCx against today's USDCx cap. A store without it cannot take
   *  USDCx payments: `pay` refuses them rather than leave them uncounted. */
  recordOutboundUSDCx?(amount: number, now: number): Promise<void>;
}

/** The file-backed ledger in `home`, over the functions below. */
export function createFilePolicyLedgerStore(home: string): PolicyLedgerStore {
  return {
    read: async (now) => readLedger(home, now),
    recordOutbound: async (amountCC, now) => recordOutbound(home, amountCC, now),
    recordClaimedHighWater: async (total, now) => recordClaimedHighWater(home, total, now),
    recordOutboundUSDCx: async (amount, now) => recordOutboundUSDCx(home, amount, now),
  };
}

/** One line of the owner-visible history of money moves. */
export interface OperationRecord {
  /** Money moves; "export" is the owner taking the key out (account page). */
  kind: "pay" | "withdraw" | "swap" | "claim" | "export";
  /** CC that left the wallet (pay, withdraw, a CC swap input), when known. */
  amountCC?: number | undefined;
  /** What a payment was made in when it was not Canton Coin, e.g. "USDCx";
   *  absent = Canton Coin. */
  asset?: string | undefined;
  /** The amount in `asset`, set together with it. */
  amount?: number | undefined;
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

/** The owner's limits page with the limit a move needed filled in (rounded up
 *  to whole CC), so raising it is one confirmation; the page never saves on
 *  its own. Without a need, the page as it is. */
export function limitsLink(url: string, field: "maxPerTx" | "dailyCap", needCC?: number): string {
  if (needCC === undefined || !Number.isFinite(needCC) || needCC <= 0) return url;
  try {
    const u = new URL(url);
    u.searchParams.set(field, String(Math.ceil(needCC)));
    return u.href;
  } catch {
    return url;
  }
}

/** Appended to a refusal at the per-tx or daily cap when the owner can raise it. */
const raiseHint = (policy: SpendPolicy, field: "maxPerTx" | "dailyCap", needCC?: number): string =>
  policy.limitsUrl ? ` The owner can raise this limit on ${limitsLink(policy.limitsUrl, field, needCC)}.` : "";

const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10);
const ledgerPath = (home: string): string => join(home, "mcp-policy-ledger.json");

/** The file as stored. The USDCx counter is an object of its own with its own
 *  date, so a USDCx payment never touches the CC day and the reverse; a file
 *  written by 2.3.0 has no `usdcx` at all. */
interface LedgerFile extends Omit<PolicyLedger, "spentTodayUSDCx"> {
  usdcx?: { date?: unknown; spentToday?: unknown } | undefined;
}

/** Today's USDCx spend in a stored file: 0 when absent or from another day.
 *  A counter of today that is not a finite number >= 0 says nothing about what
 *  was spent, so it reads as Infinity, the cap reached (fail closed), as the
 *  hosted store reads one. */
function usdcxToday(l: LedgerFile, now: number): number {
  const u = l.usdcx;
  if (!u || u.date !== dayOf(now)) return 0;
  const n = u.spentToday;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : Infinity;
}

function readLedgerFile(home: string, now: number): LedgerFile {
  let l: LedgerFile;
  try {
    l = JSON.parse(readFileSync(ledgerPath(home), "utf8")) as LedgerFile;
  } catch {
    l = { date: dayOf(now), spentTodayCC: 0, lifetimeOutCC: 0, lifetimeClaimedCC: 0 };
  }
  if (l.date !== dayOf(now)) {
    // New UTC day → reset the daily counter (lifetime totals persist).
    l.date = dayOf(now);
    l.spentTodayCC = 0;
  }
  return l;
}

export function readLedger(home: string, now: number): PolicyLedger {
  const file = readLedgerFile(home, now);
  const { usdcx: _usdcx, ...l } = file;
  return { ...l, spentTodayUSDCx: usdcxToday(file, now) };
}

function writeLedger(home: string, l: LedgerFile): void {
  const p = ledgerPath(home);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(l), { mode: 0o600 });
  renameSync(tmp, p); // atomic
}

/** True when `pay` may reach only services in the catalogue: the operator's
 *  `--allow-domains catalog`, or the hosted owner's own choice. */
export function isCatalogOnly(policy: SpendPolicy): boolean {
  return policy.allowDomains === "catalog" || policy.payScope === "catalog";
}

/** Pre-call gate for `pay`: the CC price is unknown until mid-dance, so here we
 *  only block on what IS knowable up front — the payer domain, the catalogue
 *  (when the wallet pays only catalogue services) and whether the daily /
 *  funded ceilings are ALREADY exhausted. Throws PolicyError if blocked.
 *
 *  `catalog` is read only in catalogue-only mode. There, `undefined` means it
 *  never loaded, and "could not check" is never "allowed" in this package. */
export function assertPayAllowed(
  policy: SpendPolicy,
  ledger: PolicyLedger,
  url: string,
  catalog?: CatalogEntry[] | undefined
): void {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new PolicyError(`invalid pay url: ${url}`);
  }
  const host = target.hostname.toLowerCase();
  if (Array.isArray(policy.allowDomains)) {
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
  if (isCatalogOnly(policy)) {
    if (catalog === undefined) {
      throw new PolicyError(
        "pay blocked: this wallet pays only services in the catalogue, and the catalogue " +
          "could not be loaded. Nothing was paid; try again in a few minutes."
      );
    }
    if (!matchesCatalog(url, catalog)) {
      const who =
        policy.allowDomains === "catalog"
          ? "This server is set to pay only catalogue services (--allow-domains catalog)."
          : "The wallet's owner chose to pay only catalogue services; only the owner can allow any address" +
            (policy.payScopeUrl ? `, on ${policy.payScopeUrl}` : "") +
            ". You cannot change this setting.";
      throw new PolicyError(
        `pay blocked: ${target.origin}${target.pathname} is not in the catalogue of verified services ` +
          `(find_paid_apis lists them). ${who}`
      );
    }
  }
  if (policy.dailyCap !== undefined && ledger.spentTodayCC >= policy.dailyCap) {
    throw new PolicyError(
      `pay blocked: daily cap ${policy.dailyCap} CC already reached (spent ${ledger.spentTodayCC} today).` +
        raiseHint(policy, "dailyCap")
    );
  }
  if (policy.fundedCeiling && ledger.lifetimeOutCC >= ledger.lifetimeClaimedCC) {
    throw new PolicyError(
      `pay blocked: funded ceiling reached (out ${ledger.lifetimeOutCC} CC >= claimed ${ledger.lifetimeClaimedCC} CC). Claim more funding first.`
    );
  }
}

/** Web default ports as `new URL` reports them ("" for the scheme's own). */
const WEB_PORTS = new Set(["", "80", "443"]);

/** Refuses a pay URL on the wallet's own relay: `pay` sends any method and
 *  body, and the relay would see them coming from this server's address, which
 *  a hosted server shares with all its users. Another port on that host is fine. */
export function assertNotRelay(url: string, relayUrl: string): void {
  const place = (raw: string): string => {
    const u = new URL(raw);
    return `${u.hostname.toLowerCase().replace(/\.+$/, "")} ${WEB_PORTS.has(u.port) ? "" : u.port}`;
  };
  if (place(url) === place(relayUrl)) {
    throw new PolicyError("pay blocked: that address is the relay, not a paid service.");
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
      `withdraw blocked: ${amountCC} CC exceeds the per-tx cap of ${policy.maxPerTx} CC.` +
        raiseHint(policy, "maxPerTx", amountCC)
    );
  }
  if (
    policy.dailyCap !== undefined &&
    ledger.spentTodayCC + amountCC > policy.dailyCap
  ) {
    throw new PolicyError(
      `withdraw blocked: ${amountCC} CC would exceed the daily cap of ${policy.dailyCap} CC (already spent ${ledger.spentTodayCC} today).` +
        raiseHint(policy, "dailyCap", ledger.spentTodayCC + amountCC)
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
      `swap blocked: ${what} exceeds the per-tx cap of ${policy.maxPerTx} CC.` + raiseHint(policy, "maxPerTx", ccValue)
    );
  }
  if (!inputIsCC) return;
  if (
    policy.dailyCap !== undefined &&
    ledger.spentTodayCC + ccValue > policy.dailyCap
  ) {
    throw new PolicyError(
      `swap blocked: ${what} would exceed the daily cap of ${policy.dailyCap} CC (already spent ${ledger.spentTodayCC} today).` +
        raiseHint(policy, "dailyCap", ledger.spentTodayCC + ccValue)
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
  const l = readLedgerFile(home, now);
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
  const l = readLedgerFile(home, now);
  if (claimedTotalCC > l.lifetimeClaimedCC) {
    l.lifetimeClaimedCC = claimedTotalCC;
    writeLedger(home, l);
  }
}

/** Count USDCx against today's USDCx cap. Only the `usdcx` object changes. */
export function recordOutboundUSDCx(home: string, amount: number, now: number): void {
  if (!(amount > 0)) return;
  const l = readLedgerFile(home, now);
  l.usdcx = { date: dayOf(now), spentToday: usdcxToday(l, now) + amount };
  writeLedger(home, l);
}

/**
 * Today's USDCx spend as the USDCx caps count it. A counter that is not a
 * finite number says nothing about what was spent, so it counts as the whole
 * day: Infinity, the cap reached (fail closed), never as nothing spent.
 */
export function usdcxSpentToday(ledger: PolicyLedger): number {
  const spent = ledger.spentTodayUSDCx ?? 0;
  return Number.isFinite(spent) ? spent : Infinity;
}

/**
 * The most one USDCx payment may be signed for: the USDCx per-payment cap or
 * what is left of today's USDCx cap, whichever is smaller. undefined when
 * either cap is unset, which means no USDCx payments at all; 0 when today's
 * counter is not a number (usdcxSpentToday).
 */
export function usdcxPayCeiling(policy: SpendPolicy, ledger: PolicyLedger): number | undefined {
  if (policy.usdcxMaxPerTx === undefined || policy.usdcxDailyCap === undefined) return undefined;
  const spent = usdcxSpentToday(ledger);
  if (!Number.isFinite(spent)) return 0;
  return Math.max(0, Math.min(policy.usdcxMaxPerTx, policy.usdcxDailyCap - spent));
}

/** Pre-call gate for a USDCx payment. Returns the ceiling to hand the signer
 *  (always > 0); throws PolicyError when there is none. */
export function assertUsdcxPayAllowed(policy: SpendPolicy, ledger: PolicyLedger): number {
  const ceiling = usdcxPayCeiling(policy, ledger);
  if (ceiling === undefined) {
    throw new PolicyError(
      "pay in USDCx blocked: the owner has not set both USDCx caps " +
        "(--usdcx-max-per-tx and --usdcx-daily-cap). An unset cap is not \"no cap\"."
    );
  }
  if (!(ceiling > 0)) {
    throw new PolicyError(
      policy.usdcxMaxPerTx === 0
        ? "pay in USDCx blocked: the USDCx per-payment cap is 0."
        : !Number.isFinite(usdcxSpentToday(ledger))
          ? "pay in USDCx blocked: today's USDCx spending could not be read, so the daily USDCx cap counts as reached."
          : `pay in USDCx blocked: daily USDCx cap ${policy.usdcxDailyCap} already reached (spent ${ledger.spentTodayUSDCx ?? 0} today).`
    );
  }
  return ceiling;
}
