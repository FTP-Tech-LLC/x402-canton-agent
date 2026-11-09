import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as Tx from "./tx.js";

const signed: string[] = [];

// The real prepare+sign needs a relay and a faithful prepared transaction
// (tx.test.ts covers it); here only what reaches the signer matters.
vi.mock("./tx.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Tx>()),
  payViaTransferFactory: vi.fn(async (_relay: unknown, wallet: { party: string }, o: { amount: string }) => {
    signed.push(o.amount);
    return {
      payerParty: wallet.party,
      txHash: "AAAA",
      preparedTxHashHex: "00",
      preparedTransactionBytes: new Uint8Array([1]),
      signatureB64: "c2ln",
      hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2" as const,
    };
  }),
}));

const { makePayingFetchForWallet } = await import("./pay.js");
const { generateAgentKey } = await import("./keys.js");
const { KNOWN_INSTRUMENTS, instrumentKey } = await import("./registry-parties.js");

const USDCX = KNOWN_INSTRUMENTS.USDCx!;
const USDCX_KEY = instrumentKey(USDCX.admin, USDCX.id);
const URL_ = "https://api.example.com/x";

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

/** A merchant that asks 0.05 USDCx and serves the resource once paid. */
function stubMerchant(): void {
  const required = {
    x402Version: 2,
    resource: { url: URL_ },
    accepts: [
      {
        scheme: "exact",
        network: "canton:mainnet",
        amount: "500000000",
        asset: "USDCx",
        payTo: "merchant::1220m",
        maxTimeoutSeconds: 120,
        extra: {
          assetTransferMethod: "transfer-factory",
          feePayer: "fac::1220f",
          synchronizerId: "global-domain::1220s",
          instrumentId: { admin: USDCX.admin, id: USDCX.id },
        },
      },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (new Headers(init?.headers).has("payment-signature")) {
        return new Response("paid content", { status: 200 });
      }
      return new Response("{}", {
        status: 402,
        headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64") },
      });
    })
  );
}

/**
 * makeRelaySigner has always taken `payableInstruments`, but the paying fetch
 * never passed it on, so the only way to consent to a token was the process
 * env. A hosted server pays for many users from one process and cannot use
 * that; it must consent per call.
 */
describe("makePayingFetchForWallet forwards consent and the signed-amount hook", () => {
  const prevEnv = process.env.CANTON_AGENT_PAYABLE_INSTRUMENTS;
  beforeEach(() => {
    signed.length = 0;
    delete process.env.CANTON_AGENT_PAYABLE_INSTRUMENTS;
    stubMerchant();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevEnv === undefined) delete process.env.CANTON_AGENT_PAYABLE_INSTRUMENTS;
    else process.env.CANTON_AGENT_PAYABLE_INSTRUMENTS = prevEnv;
  });

  it("without payableInstruments a USDCx 402 is refused, as before, and nothing is signed", async () => {
    const f = await makePayingFetchForWallet(wallet(), {});
    await expect(f(URL_)).rejects.toThrow(/not configured to spend/);
    expect(signed).toEqual([]);
  });

  it("payableInstruments + an instrument cap pay it, and onSigned reports what was signed", async () => {
    const seen: Array<{ instrument: string; amount: string }> = [];
    const f = await makePayingFetchForWallet(wallet(), {
      preferAsset: "USDCx",
      payableInstruments: [USDCX_KEY],
      maxPaymentValueByInstrument: { [USDCX_KEY]: "1" },
      onSigned: (s) => seen.push(s),
    });
    const res = await f(URL_);
    expect(res.status).toBe(200);
    expect(signed).toEqual(["0.0500000000"]);
    expect(seen).toEqual([{ instrument: USDCX_KEY, amount: "0.0500000000" }]);
  });
});
