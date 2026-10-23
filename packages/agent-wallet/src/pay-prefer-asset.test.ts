import { describe, it, expect } from "vitest";
import type { PaymentRequirements } from "@ftptech/x402-canton-core";
import { buildPreferAssetSelector } from "./pay.js";
import { KNOWN_INSTRUMENTS } from "./registry-parties.js";

const USDCX_ADMIN = KNOWN_INSTRUMENTS.USDCx!.admin;

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
const USDCX = req("USDCx", "USDCx", USDCX_ADMIN);
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
    const usdAlias = req("USD", "USDCx", USDCX_ADMIN);
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

  it("matches a known symbol on the instrument PAID, not the 402's free-text label", () => {
    // A merchant labels a Canton Coin entry "USDCx": `--asset USDCx` (and a
    // USDCx spend cap) must not select it — that is how an uncapped CC payment
    // would slip past a token cap.
    const disguised = req("USDCx", "Amulet", "DSO::1220");
    expect(() => buildPreferAssetSelector("USDCx")!([disguised])).toThrow(/does not offer that instrument/);
    // Same id, a registrar that is not USDCx's: not USDCx either.
    const impostor = req("USDCx", "USDCx", "someone-else::1220");
    expect(() => buildPreferAssetSelector("USDCx")!([impostor])).toThrow(/does not offer/);
  });

  it("matches a known symbol from a registrar trusted via env (testnet/devnet), MainNet's first", () => {
    const prev = process.env.CANTON_AGENT_REGISTRY_TRUSTED_PARTIES;
    process.env.CANTON_AGENT_REGISTRY_TRUSTED_PARTIES = JSON.stringify({
      "testnet-usdcx::1220ab": ["testnet-usdcx-op::1220cd"],
    });
    try {
      const testnet = req("USDCx", "USDCx", "testnet-usdcx::1220ab");
      expect(buildPreferAssetSelector("USDCx")!([CC, testnet])).toBe(testnet);
      // Trust is still required: the same id from an arbitrary admin is not USDCx.
      const impostor = req("USDCx", "USDCx", "someone-else::1220");
      expect(() => buildPreferAssetSelector("USDCx")!([CC, impostor])).toThrow(/does not offer/);
      // Both offered: the MainNet registrar's entry wins.
      expect(buildPreferAssetSelector("USDCx")!([testnet, USDCX])).toBe(USDCX);
    } finally {
      if (prev === undefined) delete process.env.CANTON_AGENT_REGISTRY_TRUSTED_PARTIES;
      else process.env.CANTON_AGENT_REGISTRY_TRUSTED_PARTIES = prev;
    }
  });

  it("an unknown symbol keeps the label/id matching (nothing to anchor it on)", () => {
    const eur = req("EURx", "EURx", "eur-reg::1220");
    expect(buildPreferAssetSelector("eurx")!([CC, eur])).toBe(eur);
  });
});
