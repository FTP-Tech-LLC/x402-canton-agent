import { describe, it, expect } from "vitest";
import { KNOWN_INSTRUMENTS } from "@ftptech/canton-agent-wallet";
import { holdingsLines, limitLines } from "./balance-lines.js";

const USDCX = KNOWN_INSTRUMENTS["USDCx"]!;
const led = (spent: number, claimed = 0, out = spent) => ({
  date: "2026-10-06",
  spentTodayCC: spent,
  lifetimeOutCC: out,
  lifetimeClaimedCC: claimed,
});

describe("holdingsLines", () => {
  it("one line per token, Canton Coin skipped, a known token by its symbol and an unknown one with its issuer", () => {
    expect(
      holdingsLines({
        party: "p",
        complete: true,
        instruments: [
          { admin: "DSO::1220", id: "Amulet", total: "9.0000000000", holdings: [] },
          { ...USDCX, total: "1.5000000000", holdings: [{ cid: "a", amount: "1", locked: false }, { cid: "b", amount: "0.5", locked: false }] },
          { admin: "reg::1220abc", id: "TOK", total: "3.0000000000", holdings: [{ cid: "c", amount: "3", locked: false }] },
        ],
      })
    ).toEqual(["1.5000000000 USDCx (2 holdings)", "3.0000000000 TOK (1 holding) @ reg::1220abc"]);
  });

  it("an incomplete read says ≥ and why", () => {
    expect(
      holdingsLines({ party: "p", complete: false, instruments: [{ ...USDCX, total: "1.5000000000", holdings: [{ cid: "a", amount: "1.5", locked: false }] }] })
    ).toEqual([
      "≥ 1.5000000000 USDCx (≥ 1 holding)",
      "token totals are lower bounds: this wallet holds more than one read lists",
    ]);
  });
});

describe("limitLines", () => {
  it("what is left today and the most one payment may cost", () => {
    expect(limitLines({ allowDomains: "*", maxPerTx: 5, dailyCap: 20, fundedCeiling: false }, led(4.5))).toEqual([
      "limits: today 15.5 of 20 CC left, up to 5 CC per payment; max_cc caps a whole pay call",
    ]);
    expect(limitLines({ allowDomains: "*", maxPerTx: 5, dailyCap: 20, fundedCeiling: false }, led(19.5))).toEqual([
      "limits: today 0.5 of 20 CC left, up to 0.5 CC per payment; max_cc caps a whole pay call",
    ]);
  });

  it("no caps, and the funded ceiling alone", () => {
    expect(limitLines({ allowDomains: "*", fundedCeiling: false }, led(1))).toEqual([
      "limits: no daily cap, no per-payment cap; max_cc caps a whole pay call",
    ]);
    expect(limitLines({ allowDomains: [], fundedCeiling: true }, led(0.25, 1, 0.25))).toEqual([
      "limits: no daily cap, up to 0.75 CC per payment; max_cc caps a whole pay call",
    ]);
  });

  it("does not let a per-payment cap read as a cap on a pay call", () => {
    for (const line of [
      ...limitLines({ allowDomains: "*", maxPerTx: 5, dailyCap: 20, fundedCeiling: false }, led(4.5)),
      ...limitLines({ allowDomains: "*", fundedCeiling: false }, led(1)),
    ]) {
      expect(line).toMatch(/max_cc caps a whole pay call$/);
    }
  });

  it("never says incoming", () => {
    expect(limitLines({ allowDomains: "*", maxPerTx: 1, dailyCap: 2, fundedCeiling: false }, led(0)).join(" ")).not.toMatch(/incoming/i);
  });
});

describe("limitLines with the USDCx budget", () => {
  const both = { allowDomains: "*" as const, maxPerTx: 5, dailyCap: 20, fundedCeiling: false, usdcxMaxPerTx: 1, usdcxDailyCap: 5 };

  it("adds the USDCx line under the CC line only when asked", () => {
    expect(limitLines(both, { ...led(4.5), spentTodayUSDCx: 4.25 }, { usdcx: true })).toEqual([
      "limits: today 15.5 of 20 CC left, up to 5 CC per payment; max_cc caps a whole pay call",
      "limits in USDCx: today 0.75 of 5 USDCx left, up to 0.75 USDCx per payment",
    ]);
    expect(limitLines(both, led(4.5))).toEqual([
      "limits: today 15.5 of 20 CC left, up to 5 CC per payment; max_cc caps a whole pay call",
    ]);
  });

  it("shows the USDCx cap the signer is handed, exactly", () => {
    expect(limitLines({ ...both, usdcxMaxPerTx: 0.57 }, led(0), { usdcx: true })[1]).toBe(
      "limits in USDCx: today 5 of 5 USDCx left, up to 0.57 USDCx per payment"
    );
  });

  it("a USDCx day counter that is not a number shows the day as used up", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(limitLines(both, { ...led(0), spentTodayUSDCx: bad }, { usdcx: true })[1]).toBe(
        "limits in USDCx: today 0 of 5 USDCx left, up to 0 USDCx per payment"
      );
    }
  });

  it("a ledger from before USDCx reads as nothing spent", () => {
    expect(limitLines(both, led(0), { usdcx: true })[1]).toBe(
      "limits in USDCx: today 5 of 5 USDCx left, up to 1 USDCx per payment"
    );
  });

  it("says USDCx payments are off without both caps", () => {
    expect(limitLines({ allowDomains: "*", fundedCeiling: false, usdcxMaxPerTx: 1 }, led(0), { usdcx: true })[1]).toBe(
      "limits in USDCx: none set, so USDCx payments are off"
    );
  });
});

describe("holdingsLines with a locked holding", () => {
  it("says how much of a token sits in an offer, not spendable", () => {
    const lines = holdingsLines({
      party: "p",
      complete: true,
      instruments: [
        {
          ...USDCX,
          total: "1.5000000000",
          holdings: [
            { cid: "a", amount: "1.2", locked: true },
            { cid: "b", amount: "0.3", locked: false },
          ],
        },
      ],
    });
    expect(lines[0]).toBe(
      "1.5000000000 USDCx (2 holdings; 1.2 of it locked, in an offer or an allocation, and not spendable now)"
    );
  });
});
