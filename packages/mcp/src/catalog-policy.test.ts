import { describe, it, expect } from "vitest";
import type { CatalogEntry } from "./catalog.js";
import type { SpendPolicy } from "./config.js";
import { assertPayAllowed, isCatalogOnly, PolicyError, type PolicyLedger } from "./policy.js";

const ENTRY = "https://api.example.com/v1/agent";
const CATALOG: CatalogEntry[] = [{ resource: ENTRY, accepts: [] }];
const ACCOUNT = "https://pay.ftptech.xyz/account";
const led = (o: Partial<PolicyLedger> = {}): PolicyLedger => ({
  date: "2026-10-06",
  spentTodayCC: 0,
  lifetimeOutCC: 0,
  lifetimeClaimedCC: 0,
  ...o,
});
const userCatalog: SpendPolicy = { allowDomains: "*", fundedCeiling: false, payScope: "catalog", payScopeUrl: ACCOUNT };
const operatorCatalog: SpendPolicy = { allowDomains: "catalog", fundedCeiling: false };

describe("isCatalogOnly", () => {
  it("is the operator's keyword or the owner's choice, nothing else", () => {
    expect(isCatalogOnly({ allowDomains: "*", fundedCeiling: false })).toBe(false);
    expect(isCatalogOnly({ allowDomains: ["api.example.com"], fundedCeiling: false })).toBe(false);
    expect(isCatalogOnly({ allowDomains: "*", fundedCeiling: false, payScope: "any" })).toBe(false);
    expect(isCatalogOnly(userCatalog)).toBe(true);
    expect(isCatalogOnly(operatorCatalog)).toBe(true);
  });
});

describe("assertPayAllowed in catalogue-only mode", () => {
  it("lets a catalogued service through", () => {
    expect(() => assertPayAllowed(userCatalog, led(), `${ENTRY}/run?q=1`, CATALOG)).not.toThrow();
    expect(() => assertPayAllowed(operatorCatalog, led(), ENTRY, CATALOG)).not.toThrow();
  });

  it("refuses anything else and says only the owner can change it", () => {
    for (const url of [`${ENTRY}x`, "http://api.example.com/v1/agent", "https://api.example.com:8443/v1/agent", "https://evil.test/v1/agent"]) {
      expect(() => assertPayAllowed(userCatalog, led(), url, CATALOG), url).toThrow(PolicyError);
    }
    // The query is not echoed back.
    expect(() => assertPayAllowed(userCatalog, led(), `${ENTRY}x?k=secret`, CATALOG)).toThrow(
      "pay blocked: https://api.example.com/v1/agentx is not in the catalogue of verified services " +
        "(find_paid_apis lists them). The wallet's owner chose to pay only catalogue services; only the " +
        "owner can allow any address, on https://pay.ftptech.xyz/account. You cannot change this setting."
    );
    expect(() => assertPayAllowed(operatorCatalog, led(), "https://evil.test/x", CATALOG)).toThrow(
      /This server is set to pay only catalogue services \(--allow-domains catalog\)\./
    );
  });

  it("a catalogue that never loaded pays nothing", () => {
    expect(() => assertPayAllowed(userCatalog, led(), ENTRY, undefined)).toThrow(/the catalogue could not be loaded/);
    expect(() => assertPayAllowed(operatorCatalog, led(), ENTRY)).toThrow(/the catalogue could not be loaded/);
  });

  it("narrows the operator's host list, never widens it", () => {
    const p: SpendPolicy = { allowDomains: ["other.example.com"], fundedCeiling: false, payScope: "catalog" };
    expect(() => assertPayAllowed(p, led(), ENTRY, CATALOG)).toThrow(/not in the allowed payer domains/);
  });

  it("still applies the daily cap and the funded ceiling", () => {
    expect(() => assertPayAllowed({ ...userCatalog, dailyCap: 2 }, led({ spentTodayCC: 2 }), ENTRY, CATALOG)).toThrow(/daily cap/);
    expect(() =>
      assertPayAllowed({ ...userCatalog, fundedCeiling: true }, led({ lifetimeOutCC: 1, lifetimeClaimedCC: 1 }), ENTRY, CATALOG)
    ).toThrow(/funded ceiling/);
  });

  it("an invalid URL is refused as before", () => {
    expect(() => assertPayAllowed(userCatalog, led(), "not a url", CATALOG)).toThrow(/invalid pay url/);
  });

  it("every other wallet is exactly as before and does not need the catalogue", () => {
    expect(() => assertPayAllowed({ allowDomains: "*", fundedCeiling: false }, led(), "https://anything.test/x")).not.toThrow();
    expect(() =>
      assertPayAllowed({ allowDomains: "*", fundedCeiling: false, payScope: "any" }, led(), "https://anything.test/x", undefined)
    ).not.toThrow();
    expect(() => assertPayAllowed({ allowDomains: [], fundedCeiling: false }, led(), "https://x.test/a")).toThrow(/no payer domains allowed/);
  });
});
