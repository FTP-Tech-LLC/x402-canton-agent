import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as Tx from "./tx.js";

/** makePayingFetch forwards `paidResends` to the client. The real prepare and
 *  sign are covered in tx.test.ts. */
vi.mock("./tx.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Tx>()),
  payViaTransferFactory: vi.fn(async (_relay: unknown, wallet: { party: string }) => ({
    payerParty: wallet.party,
    txHash: "AAAA",
    preparedTxHashHex: "00",
    preparedTransactionBytes: new Uint8Array([1]),
    signatureB64: "c2ln",
    hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2" as const,
  })),
}));

const { makePayingFetchForWallet } = await import("./pay.js");
const { generateAgentKey } = await import("./keys.js");

const URL_ = "https://api.example.com/data";
const DSO = "DSO::1220dso";

function wallet() {
  const k = generateAgentKey();
  return {
    network: "canton:mainnet",
    relayUrl: "http://relay",
    party: "agent::12201",
    publicKeySpkiB64: k.publicKeySpkiB64,
    privateKeyPkcs8Pem: k.privateKeyPkcs8Pem,
    publicKeyFingerprint: "12201fp",
    createdAt: "t",
  };
}

/** A merchant that challenges, then answers every paid send 502. */
function stubMerchant(paid: string[]): void {
  const required = {
    x402Version: 2,
    resource: { url: URL_ },
    accepts: [
      {
        scheme: "exact",
        network: "canton:mainnet",
        amount: "100000000",
        asset: "CC",
        payTo: "merchant::1220m",
        maxTimeoutSeconds: 120,
        extra: {
          assetTransferMethod: "transfer-factory",
          feePayer: "fac::1220f",
          synchronizerId: "global-domain::1220s",
          instrumentId: { admin: DSO, id: "Amulet" },
        },
      },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const sig = new Request(input, init).headers.get("payment-signature");
      if (sig === null) {
        return new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64") },
        });
      }
      paid.push(sig);
      return new Response("", { status: 502 });
    })
  );
}

describe("makePayingFetch forwards paidResends", () => {
  const prevDso = process.env.CANTON_AGENT_DSO_PARTY;
  beforeEach(() => {
    process.env.CANTON_AGENT_DSO_PARTY = DSO;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevDso === undefined) delete process.env.CANTON_AGENT_DSO_PARTY;
    else process.env.CANTON_AGENT_DSO_PARTY = prevDso;
  });

  it("0: the paid request is sent once and the 5xx is PAYMENT_UNCONFIRMED", async () => {
    const paid: string[] = [];
    stubMerchant(paid);
    const f = await makePayingFetchForWallet(wallet(), { maxPaymentValue: "0.05", paidResends: 0 });
    const err = await f(URL_).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("PAYMENT_UNCONFIRMED");
    expect(paid).toHaveLength(1);
  });
});
