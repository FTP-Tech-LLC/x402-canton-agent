import { describe, it, expect } from "vitest";
import { formatHistory, historyHost, type HistoryRow } from "./history.js";

const T = Date.parse("2026-10-06T12:00:00Z");

describe("formatHistory", () => {
  it("one line per row: time, kind, amount and asset, result, host, updateId", () => {
    expect(
      formatHistory([
        { at: T + 1000, kind: "withdraw", amountCC: 1, detail: "to bob::1220aa", updateId: "1220w", ok: true },
        { at: T, kind: "pay", amountCC: 0.25, detail: "api.example.com (HTTP 200)", updateId: "1220p", ok: true },
        { at: T - 1000, kind: "claim", detail: "1 incoming transfer(s)", ok: true },
      ]).split("\n")
    ).toEqual([
      "3 latest operations, newest first:",
      "2026-10-06T12:00:01Z · withdraw · 1 CC · ok · to bob::1220aa · updateId 1220w",
      "2026-10-06T12:00:00Z · pay · 0.25 CC · ok · host api.example.com · HTTP 200 · updateId 1220p",
      "2026-10-06T11:59:59Z · claim · ok · 1 incoming transfer(s)",
    ]);
  });

  it("shows the amount paid even when the stored balance delta lands just below it", () => {
    const line = formatHistory([{ at: T, kind: "pay", amountCC: 1 - 0.9, detail: "api.example.com (HTTP 200)", ok: true }]);
    expect(line).toContain(" · pay · 0.1 CC · ");
  });

  it("says why a swap was not done, and never shows a pay row's URL", () => {
    const out = formatHistory([
      { at: T, kind: "swap", amountCC: 0.01, detail: "5 USDCx -> CC not done: swap blocked: 5 CC exceeds the per-tx cap of 1 CC.", ok: false },
      { at: T - 1, kind: "pay", amountCC: 5, detail: "https://api.example.com/v1/x?api_key=SECRET (failed after paying)", ok: false },
    ]);
    expect(out).toContain("swap · 0.01 CC · failed · 5 USDCx -> CC not done: swap blocked: 5 CC exceeds the per-tx cap of 1 CC.");
    expect(out).toContain("pay · 5 CC · failed · host api.example.com · failed after paying");
    expect(out).not.toContain("SECRET");
  });

  it("an empty history says so", () => {
    expect(formatHistory([])).toBe("No money moves yet.");
  });
});

describe("historyHost", () => {
  it("an old failed-after-paying row shows only its host, never the query", () => {
    const row: HistoryRow = {
      at: T,
      kind: "pay",
      amountCC: 5,
      detail: "https://api.example.com:8443/v1/x?api_key=SECRET (failed after paying)",
      ok: false,
    };
    expect(historyHost(row)).toBe("api.example.com:8443");
    expect(formatHistory([row])).not.toContain("SECRET");
  });

  it("only pay rows have a host", () => {
    expect(historyHost({ at: T, kind: "withdraw", detail: "to bob::1220aa", ok: true })).toBeUndefined();
  });
});

describe("formatHistory with USDCx", () => {
  it("a USDCx payment shows its USDCx amount, not CC", () => {
    expect(
      formatHistory([{ at: T, kind: "pay", asset: "USDCx", amount: 0.05, detail: "api.example.com (HTTP 200)", ok: true }]).split("\n")[1]
    ).toBe("2026-10-06T12:00:00Z · pay · 0.05 USDCx · ok · host api.example.com · HTTP 200");
  });

  it("a USDCx payment during which CC also moved shows both amounts", () => {
    expect(
      formatHistory([
        { at: T, kind: "pay", asset: "USDCx", amount: 0.05000000000000002, amountCC: 0.001, detail: "api.example.com (HTTP 200)", ok: true },
      ]).split("\n")[1]
    ).toBe("2026-10-06T12:00:00Z · pay · 0.05 USDCx and 0.001 CC · ok · host api.example.com · HTTP 200");
  });
});
