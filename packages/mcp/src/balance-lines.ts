/**
 * The lines get_balance prints under its first line when newTools is on. The
 * first line (`<cc> CC (<n> amulets) for <party>`) is not built here and never
 * changes: hosted-e2e.mjs and the 2.3.0 tests read it.
 */
import { KNOWN_INSTRUMENTS, type HoldingsResult } from "@ftptech/canton-agent-wallet";
import type { SpendPolicy } from "./config.js";
import { payValueCeiling, usdcxPayCeiling, usdcxSpentToday, type PolicyLedger } from "./policy.js";
import { capDecimal10, decimal10 } from "./amounts.js";

/** The symbol of a token this package knows by admin AND id; undefined for any
 *  other, which is then shown with its issuer so a look-alike id cannot pass. */
function knownSymbol(admin: string, id: string): string | undefined {
  return Object.entries(KNOWN_INSTRUMENTS).find(([, k]) => k.admin === admin && k.id === id)?.[0];
}

const sumDecimals = (xs: string[]): number => xs.reduce((a, x) => a + (Number.isFinite(Number(x)) ? Number(x) : 0), 0);

/** One line per token (Canton Coin is the first line already). An incomplete
 *  read gives lower bounds, marked with ≥ and said once. */
export function holdingsLines(h: HoldingsResult): string[] {
  const ge = h.complete ? "" : "≥ ";
  const lines: string[] = [];
  for (const ins of h.instruments) {
    if (ins.id === "Amulet") continue;
    const n = ins.holdings.length;
    const symbol = knownSymbol(ins.admin, ins.id);
    // A locked holding sits in an offer the receiver has not taken (a token
    // sale a venue left unaccepted) or in an allocation (Tradecraft queued
    // mode): counted in the total, not spendable.
    const locked = sumDecimals(ins.holdings.filter((x) => x.locked).map((x) => x.amount));
    lines.push(
      `${ge}${ins.total} ${symbol ?? ins.id} (${ge}${n} holding${n === 1 ? "" : "s"}` +
        (locked > 0
          ? `; ${decimal10(locked)} of it locked, in an offer or an allocation, and not spendable now`
          : "") +
        ")" +
        (symbol ? "" : ` @ ${ins.admin}`)
    );
  }
  if (!h.complete) lines.push("token totals are lower bounds: this wallet holds more than one read lists");
  return lines;
}

/** What is left today and the most one payment may cost, from the same numbers
 *  `pay` hands the signer. That cap holds per signed payment, and a pay call
 *  without max_cc can make more than one, so the line says what caps a call.
 *  With `usdcx`, a second line for the USDCx budget. */
export function limitLines(policy: SpendPolicy, led: PolicyLedger, opts: { usdcx?: boolean } = {}): string[] {
  const day =
    policy.dailyCap === undefined
      ? "no daily cap"
      : `today ${decimal10(Math.max(0, policy.dailyCap - led.spentTodayCC))} of ${policy.dailyCap} CC left`;
  const ceiling = payValueCeiling(policy, led);
  const per = ceiling === undefined ? "no per-payment cap" : `up to ${decimal10(ceiling)} CC per payment`;
  const cc = `limits: ${day}, ${per}; max_cc caps a whole pay call`;
  return opts.usdcx ? [cc, usdcxLimitLine(policy, led)] : [cc];
}

/** The USDCx budget: its own day and its own per-payment cap, from the same
 *  numbers `pay` hands the signer for a USDCx payment (one per pay call). */
export function usdcxLimitLine(policy: SpendPolicy, led: PolicyLedger): string {
  const ceiling = usdcxPayCeiling(policy, led);
  if (ceiling === undefined || policy.usdcxDailyCap === undefined) {
    return "limits in USDCx: none set, so USDCx payments are off";
  }
  // A counter that is not a number reads as the day used up, as in pay.
  const left = Math.max(0, policy.usdcxDailyCap - usdcxSpentToday(led));
  return (
    `limits in USDCx: today ${capDecimal10(left, policy.usdcxDailyCap)} of ${policy.usdcxDailyCap} USDCx left, ` +
    `up to ${capDecimal10(ceiling, policy.usdcxDailyCap)} USDCx per payment`
  );
}
