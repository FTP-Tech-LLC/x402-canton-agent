import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as Tx from "./tx.js";

// Only the headers on the wire matter here; the real prepare+sign is covered in tx.test.ts.
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

const { makePayingFetchForWallet, withDefaultUserAgent, PAY_USER_AGENT } = await import("./pay.js");
const { generateAgentKey } = await import("./keys.js");

const URL_ = "https://api.example.com/ticket?in=CC&out=USDCx&amount=10";
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

/** A merchant that, like Tradecraft's API, refuses `node` and a missing
 *  User-Agent with 403, asks 0.01 CC, and serves once paid. */
function stubMerchant(seen: Array<{ ua: string | null; paid: boolean }>): void {
  const required = {
    x402Version: 2,
    resource: { url: URL_ },
    accepts: [
      {
        scheme: "exact",
        network: "canton:mainnet",
        amount: "100000000",
        asset: "CC",
        payTo: "CantonSwap::1220venue",
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
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      const ua = h.get("user-agent");
      const paid = h.has("payment-signature");
      seen.push({ ua, paid });
      if (ua === null || ua === "node") return new Response("Forbidden", { status: 403 });
      if (paid) return new Response("ticket", { status: 200 });
      return new Response("{}", {
        status: 402,
        headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64") },
      });
    })
  );
}

describe("paid requests carry a User-Agent", () => {
  const prevDso = process.env.CANTON_AGENT_DSO_PARTY;
  beforeEach(() => {
    process.env.CANTON_AGENT_DSO_PARTY = DSO;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevDso === undefined) delete process.env.CANTON_AGENT_DSO_PARTY;
    else process.env.CANTON_AGENT_DSO_PARTY = prevDso;
  });

  it("sends the wallet's User-Agent on the probe and on the paid retry", async () => {
    const seen: Array<{ ua: string | null; paid: boolean }> = [];
    stubMerchant(seen);
    const f = await makePayingFetchForWallet(wallet(), { maxPaymentValue: "0.05" });
    const res = await f(URL_);
    expect(res.status).toBe(200);
    expect(seen.map((s) => s.ua)).toEqual(seen.map(() => PAY_USER_AGENT));
    expect(seen.some((s) => s.paid)).toBe(true);
  });

  it("keeps a User-Agent the caller set", async () => {
    const seen: Array<{ ua: string | null; paid: boolean }> = [];
    stubMerchant(seen);
    const f = await makePayingFetchForWallet(wallet(), { maxPaymentValue: "0.05" });
    const res = await f(URL_, { headers: { "User-Agent": "my-bot/1" } });
    expect(res.status).toBe(200);
    expect(new Set(seen.map((s) => s.ua))).toEqual(new Set(["my-bot/1"]));
  });
});

describe("withDefaultUserAgent", () => {
  it("adds the header to a Request without one and leaves its other headers", async () => {
    const base = vi.fn(async (_i: unknown, init?: RequestInit) => new Response(new Headers(init?.headers).get("user-agent") + "|" + new Headers(init?.headers).get("x-a")));
    const r = await withDefaultUserAgent(base as never)(new Request("https://x.test", { headers: { "x-a": "1" } }));
    expect(await r.text()).toBe(`${PAY_USER_AGENT}|1`);
  });
});
