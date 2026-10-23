import { describe, it, expect } from "vitest";
import { HEADER_PAYMENT_REQUIRED_V2, encodeBase64Json } from "@ftptech/x402-canton-core";
import { peekWalletPayment } from "./pay.js";
import { KNOWN_INSTRUMENTS } from "./registry-parties.js";
import type { AgentWallet } from "./store.js";

const WALLET = {
  party: "agent::1220a",
  privateKeyPkcs8Pem: "x",
  publicKeyFingerprint: "f",
  network: "canton:mainnet",
  relayUrl: "http://relay",
} as unknown as AgentWallet;
const MERCHANT = "merchant-ctai::1220033";
const USDCX = KNOWN_INSTRUMENTS["USDCx"]!;

const entry = (asset: string, amount: string, instrumentId: { admin: string; id: string }) => ({
  scheme: "exact",
  network: "canton:mainnet",
  amount,
  asset,
  payTo: MERCHANT,
  maxTimeoutSeconds: 60,
  extra: {
    assetTransferMethod: "transfer-factory",
    feePayer: "fac::1220",
    synchronizerId: "global-domain::1220",
    instrumentId,
  },
});

/** CanTrust's real shape (2026-09-19): Canton Coin first, then registry tokens. */
function cantrust402(): Response {
  return new Response("payment required", {
    status: 402,
    headers: {
      [HEADER_PAYMENT_REQUIRED_V2]: encodeBase64Json({
        x402Version: 2,
        resource: { url: "https://api.cantrustai.xyz/v1/agent/completions" },
        accepts: [
          entry("CC", "3307888041", { admin: "DSO::1220b1431ef21", id: "Amulet" }),
          entry("USDCx", "351000000", USDCX),
        ],
      }),
    },
  });
}

describe("peekWalletPayment", () => {
  it("names the Canton Coin entry the wallet would pay, in atomic units", () => {
    expect(peekWalletPayment(cantrust402(), WALLET)).toEqual({
      payTo: MERCHANT,
      amountAtomic: "3307888041",
    });
  });

  it("marks a known registry token as one, with the same preferred-asset selection as paying", () => {
    expect(peekWalletPayment(cantrust402(), WALLET, { preferAsset: "USDCx" })).toEqual({
      payTo: MERCHANT,
      amountAtomic: "351000000",
      registryInstrument: { admin: USDCX.admin, id: "USDCx" },
    });
  });

  it("is undefined for anything that is not a payable 402", () => {
    expect(peekWalletPayment(new Response("ok", { status: 200 }), WALLET)).toBeUndefined();
    expect(peekWalletPayment(new Response("x", { status: 402 }), WALLET)).toBeUndefined();
    // A preferred asset the merchant does not offer is "nothing payable", not a throw.
    expect(peekWalletPayment(cantrust402(), WALLET, { preferAsset: "CBTC" })).toBeUndefined();
  });
});
