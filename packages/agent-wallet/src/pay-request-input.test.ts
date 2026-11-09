import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as Tx from "./tx.js";

/**
 * makePayingFetch given a Request (ky's form): the unpaid probe used to read
 * the Request's body, so the pay that followed failed before signing, and the
 * paid retry dropped the Request's headers. Only what reaches the merchant
 * matters here; the real prepare and sign are covered in tx.test.ts.
 */
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

const { makePayingFetchForWallet, PAY_USER_AGENT } = await import("./pay.js");
const { generateAgentKey } = await import("./keys.js");
const tx = await import("./tx.js");

const URL_ = "https://api.example.com/rpc";
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

interface Seen {
  paid: boolean;
  method: string;
  authorization: string | null;
  userAgent: string | null;
  body: string;
}

/** A merchant behind a fetch that behaves like the real one: it reads the
 *  Request (and its body) the way fetch(input, init) does. */
function stubMerchant(seen: Seen[]): void {
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
      const req = new Request(input, init);
      const paid = req.headers.has("payment-signature");
      seen.push({
        paid,
        method: req.method,
        authorization: req.headers.get("authorization"),
        userAgent: req.headers.get("user-agent"),
        body: await req.text(),
      });
      if (paid) return new Response("served", { status: 200 });
      return new Response("{}", {
        status: 402,
        headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64") },
      });
    })
  );
}

describe("makePayingFetch pays a Request as it was sent", () => {
  const prevDso = process.env.CANTON_AGENT_DSO_PARTY;
  beforeEach(() => {
    process.env.CANTON_AGENT_DSO_PARTY = DSO;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(tx.payViaTransferFactory).mockClear();
    if (prevDso === undefined) delete process.env.CANTON_AGENT_DSO_PARTY;
    else process.env.CANTON_AGENT_DSO_PARTY = prevDso;
  });

  it("a POST Request keeps its body and its Authorization on every send", async () => {
    const seen: Seen[] = [];
    stubMerchant(seen);
    const f = await makePayingFetchForWallet(wallet(), { maxPaymentValue: "0.05" });
    const res = await f(
      new Request(URL_, { method: "POST", headers: { authorization: "Bearer T" }, body: '{"q":1}' })
    );
    expect(res.status).toBe(200);
    expect(seen.every((s) => s.method === "POST" && s.body === '{"q":1}')).toBe(true);
    expect(seen.every((s) => s.authorization === "Bearer T")).toBe(true);
    expect(seen.filter((s) => s.paid)).toHaveLength(1);
    expect(tx.payViaTransferFactory).toHaveBeenCalledTimes(1);
  });

  it("the paid retry keeps the Request's own User-Agent", async () => {
    const seen: Seen[] = [];
    stubMerchant(seen);
    const f = await makePayingFetchForWallet(wallet(), { maxPaymentValue: "0.05" });
    await f(new Request(URL_, { headers: { "user-agent": "my-bot/1" } }));
    expect(new Set(seen.map((s) => s.userAgent))).toEqual(new Set(["my-bot/1"]));
  });

  it("a Request without a User-Agent gets the wallet's on every send", async () => {
    const seen: Seen[] = [];
    stubMerchant(seen);
    const f = await makePayingFetchForWallet(wallet(), { maxPaymentValue: "0.05" });
    await f(new Request(URL_));
    expect(seen.map((s) => s.userAgent)).toEqual(seen.map(() => PAY_USER_AGENT));
    expect(seen.some((s) => s.paid)).toBe(true);
  });
});
