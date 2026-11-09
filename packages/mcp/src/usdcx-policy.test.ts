import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PolicyError,
  assertUsdcxPayAllowed,
  payValueCeiling,
  readLedger,
  recordOutbound,
  recordOutboundUSDCx,
  usdcxPayCeiling,
  type PolicyLedger,
} from "./policy.js";

const D1 = Date.parse("2026-10-06T10:00:00Z");
const D2 = D1 + 24 * 3600_000;
const home = () => mkdtempSync(join(tmpdir(), "x402mcp-usdcx-"));
const file = (h: string) => join(h, "mcp-policy-ledger.json");

describe("the local ledger file keeps USDCx apart", () => {
  it("reads a file written by 2.3.0 (no usdcx object) as 0 USDCx, CC untouched", () => {
    const h = home();
    writeFileSync(
      file(h),
      JSON.stringify({ date: "2026-10-06", spentTodayCC: 3, lifetimeOutCC: 7, lifetimeClaimedCC: 10 })
    );
    expect(readLedger(h, D1)).toEqual({
      date: "2026-10-06",
      spentTodayCC: 3,
      lifetimeOutCC: 7,
      lifetimeClaimedCC: 10,
      spentTodayUSDCx: 0,
    });
  });

  const withUsdcx = (h: string, usdcx: unknown) =>
    writeFileSync(
      file(h),
      JSON.stringify({ date: "2026-10-06", spentTodayCC: 0, lifetimeOutCC: 0, lifetimeClaimedCC: 0, usdcx })
    );
  const policy = { allowDomains: "*" as const, fundedCeiling: false, usdcxMaxPerTx: 1, usdcxDailyCap: 5 };

  it("reads a same-day usdcx counter that is not a number >= 0 as the cap reached (fail closed)", () => {
    for (const spentToday of ["lots", "3", null, -1, true, {}]) {
      const h = home();
      withUsdcx(h, { date: "2026-10-06", spentToday });
      const l = readLedger(h, D1);
      expect(l.spentTodayUSDCx).toBe(Infinity);
      expect(() => assertUsdcxPayAllowed(policy, l)).toThrow(/could not be read, so the daily USDCx cap counts as reached/);
    }
  });

  it("reads a usdcx counter of another day as 0, whatever it holds", () => {
    for (const spentToday of ["lots", null, -1, 4.5]) {
      const h = home();
      withUsdcx(h, { date: "2026-10-05", spentToday });
      expect(readLedger(h, D1).spentTodayUSDCx).toBe(0);
    }
  });

  it("reads a same-day counter of 0 as 0", () => {
    const h = home();
    withUsdcx(h, { date: "2026-10-06", spentToday: 0 });
    expect(readLedger(h, D1).spentTodayUSDCx).toBe(0);
  });

  it("adds up USDCx within a day and resets it on its own date", () => {
    const h = home();
    recordOutboundUSDCx(h, 0.5, D1);
    recordOutboundUSDCx(h, 0.25, D1);
    recordOutboundUSDCx(h, 0, D1); // ignored
    expect(readLedger(h, D1).spentTodayUSDCx).toBeCloseTo(0.75, 10);
    expect(readLedger(h, D2).spentTodayUSDCx).toBe(0);
    // Only the usdcx object was written; the CC counters are as they were.
    const raw = JSON.parse(readFileSync(file(h), "utf8"));
    expect(raw.usdcx).toEqual({ date: "2026-10-06", spentToday: 0.75 });
    expect(raw.spentTodayCC).toBe(0);
    expect(raw.lifetimeOutCC).toBe(0);
  });

  it("a CC write keeps the usdcx object", () => {
    const h = home();
    recordOutboundUSDCx(h, 1, D1);
    recordOutbound(h, 2, D1);
    const l = readLedger(h, D1);
    expect(l.spentTodayCC).toBe(2);
    expect(l.spentTodayUSDCx).toBe(1);
  });

  it("19 CC on day 1, USDCx on day 2: a 5 CC payment on day 2 is allowed", () => {
    const h = home();
    recordOutbound(h, 19, D1);
    recordOutboundUSDCx(h, 1, D2);
    const l = readLedger(h, D2);
    expect(l.spentTodayCC).toBe(0);
    expect(payValueCeiling({ allowDomains: "*", fundedCeiling: false, maxPerTx: 5, dailyCap: 20 }, l)).toBe(5);
  });

  it("4.5 USDCx on day 1, CC on day 2: a 1 USDCx payment on day 2 is allowed", () => {
    const h = home();
    recordOutboundUSDCx(h, 4.5, D1);
    recordOutbound(h, 1, D2);
    const l = readLedger(h, D2);
    expect(l.spentTodayUSDCx).toBe(0);
    expect(usdcxPayCeiling({ allowDomains: "*", fundedCeiling: false, usdcxMaxPerTx: 1, usdcxDailyCap: 5 }, l)).toBe(1);
  });
});

describe("the USDCx ceiling", () => {
  const led = (spentTodayUSDCx?: number): PolicyLedger => ({
    date: "2026-10-06",
    spentTodayCC: 19.9,
    lifetimeOutCC: 19.9,
    lifetimeClaimedCC: 0,
    ...(spentTodayUSDCx !== undefined ? { spentTodayUSDCx } : {}),
  });
  const both = { allowDomains: "*" as const, fundedCeiling: true, dailyCap: 20, usdcxMaxPerTx: 1, usdcxDailyCap: 5 };

  it("is the per-payment cap while the day has room, whatever the CC budget says", () => {
    expect(assertUsdcxPayAllowed(both, led(0))).toBe(1);
    expect(assertUsdcxPayAllowed(both, led())).toBe(1);
  });

  it("is what is left of the day when that is smaller", () => {
    expect(assertUsdcxPayAllowed(both, led(4.25))).toBe(0.75);
  });

  it("refuses before signing once the day is used up", () => {
    expect(() => assertUsdcxPayAllowed(both, led(5))).toThrow(PolicyError);
    expect(() => assertUsdcxPayAllowed(both, led(5))).toThrow(/daily USDCx cap 5 already reached/);
  });

  it("refuses when either cap is unset: unset is not uncapped", () => {
    const { usdcxDailyCap: _d, ...onlyPerTx } = both;
    const { usdcxMaxPerTx: _p, ...onlyDaily } = both;
    expect(usdcxPayCeiling(onlyPerTx, led(0))).toBeUndefined();
    expect(() => assertUsdcxPayAllowed(onlyPerTx, led(0))).toThrow(/not set both USDCx caps/);
    expect(() => assertUsdcxPayAllowed(onlyDaily, led(0))).toThrow(/not set both USDCx caps/);
  });

  it("a per-payment cap of 0 refuses", () => {
    expect(() => assertUsdcxPayAllowed({ ...both, usdcxMaxPerTx: 0 }, led(0))).toThrow(/per-payment cap is 0/);
  });

  for (const bad of [NaN, Infinity, -Infinity]) {
    it(`a day counter of ${bad} counts as the day used up (fail closed)`, () => {
      expect(usdcxPayCeiling(both, led(bad))).toBe(0);
      expect(() => assertUsdcxPayAllowed(both, led(bad))).toThrow(PolicyError);
      expect(() => assertUsdcxPayAllowed(both, led(bad))).toThrow(
        /today's USDCx spending could not be read, so the daily USDCx cap counts as reached/
      );
    });
  }
});
