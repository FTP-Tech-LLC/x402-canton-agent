import { describe, it, expect } from "vitest";
import type { PaymentRequirements } from "@ftptech/x402-canton-core";
import { buildPreferAssetSelector } from "./pay.js";

/** Minimal transfer-factory accepts[] entry for the given asset/instrument. */
function req(asset: string, id: string, admin = "reg::1220"): PaymentRequirements {
  return {
    scheme: "exact",
    network: "canton:mainnet",
    amount: "1000000000",
    asset,
    payTo: "merchant::1220",
    maxTimeoutSeconds: 120,
    extra: {
      assetTransferMethod: "transfer-factory",
      feePayer: "fac::1220",
      synchronizerId: "global-domain::1220",
      instrumentId: { admin, id },
    },
  } as PaymentRequirements;
}

const CC = req("CC", "Amulet", "DSO::1220");
const USDCX = req("USDCx", "USDCx", "decentralized-usdc-interchain-rep::1220");
const CANDS = [CC, USDCX];

describe("buildPreferAssetSelector", () => {
  it("returns undefined when no asset is preferred (keeps client default)", () => {
    expect(buildPreferAssetSelector(undefined)).toBeUndefined();
    expect(buildPreferAssetSelector("")).toBeUndefined();
  });

  it("prefers the entry matching the asset symbol", () => {
    const pick = buildPreferAssetSelector("USDCx")!;
    expect(pick(CANDS)).toBe(USDCX);
  });

  it("prefers Canton Coin via the CC symbol", () => {
    const pick = buildPreferAssetSelector("CC")!;
    expect(pick(CANDS)).toBe(CC);
  });

  it("matches by structured instrumentId.id as a fallback", () => {
    // A merchant advertising asset "USD" but instrumentId.id "USDCx".
    const usdAlias = req("USD", "USDCx");
    const pick = buildPreferAssetSelector("USDCx")!;
    expect(pick([CC, usdAlias])).toBe(usdAlias);
  });

  it("FAILS CLOSED when the explicitly requested asset is absent — never a silent fallback", () => {
    const pick = buildPreferAssetSelector("EURx")!;
    expect(() => pick(CANDS)).toThrow(/does not offer that instrument \(offered: Amulet, USDCx\)/);
  });

  it("matches case-insensitively — usdcx / USDCX still select the USDCx entry", () => {
    expect(buildPreferAssetSelector("usdcx")!(CANDS)).toBe(USDCX);
    expect(buildPreferAssetSelector("USDCX")!(CANDS)).toBe(USDCX);
  });
});
