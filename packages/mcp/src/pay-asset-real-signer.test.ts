import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { KNOWN_INSTRUMENTS, generateAgentKey, makePayingFetchForWallet } from "@ftptech/canton-agent-wallet";
import { registerWalletTools } from "./tools.js";

const U = KNOWN_INSTRUMENTS.USDCx!;
const DSO = "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";
const RELAY = "https://relay.test";
const URL_ = "https://api.example.com/x";

const entry = (asset: string, admin: string, id: string) => ({
  scheme: "exact",
  network: "canton:mainnet",
  amount: "500000000",
  asset,
  payTo: "merchant::1220m",
  maxTimeoutSeconds: 120,
  extra: {
    assetTransferMethod: "transfer-factory",
    feePayer: "fac::1220f",
    synchronizerId: "global-domain::1220s",
    instrumentId: { admin, id },
  },
});

/** A merchant whose 402 lists USDCx FIRST and Canton Coin second. The relay
 *  refuses everything: a payment that reaches it got past every check in the
 *  signer (consent, ceilings), which is what these tests look at. */
let relayCalls = 0;
function stubNetwork(): void {
  relayCalls = 0;
  const required = {
    x402Version: 2,
    resource: { url: URL_ },
    accepts: [entry("USDCx", U.admin, U.id), entry("CC", DSO, "Amulet")],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(RELAY)) {
        relayCalls += 1;
        throw new Error("relay reached");
      }
      return new Response("{}", {
        status: 402,
        headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64") },
      });
    })
  );
}

async function pay(args: Record<string, unknown>, o: { newTools?: boolean; maxPerTx?: number } = {}): Promise<string> {
  const k = generateAgentKey();
  const wallet = {
    network: "canton:mainnet",
    relayUrl: RELAY,
    party: "agent::1220aaa",
    publicKeySpkiB64: k.publicKeySpkiB64,
    privateKeyPkcs8Pem: k.privateKeyPkcs8Pem,
    publicKeyFingerprint: "fp",
    createdAt: "t",
  };
  const server = new McpServer({ name: "t", version: "0" });
  registerWalletTools(server, {
    getWallet: async () => wallet,
    relayFor: () =>
      ({
        balance: async () => ({ cc: "10", amulet: 1 }),
        holdings: async () => ({ party: wallet.party, complete: true, instruments: [] }),
      }) as never,
    // The real paying fetch and the real signer; only the network is fake.
    payingFetchFor: (w, o) => makePayingFetchForWallet(w, { ...o, maxPaymentRetries: 0 }),
    policy: { allowDomains: "*", fundedCeiling: false, maxPerTx: o.maxPerTx ?? 5, dailyCap: 20, usdcxMaxPerTx: 1, usdcxDailyCap: 5 },
    ledger: {
      read: async () => ({ date: "2026-10-06", spentTodayCC: 0, lifetimeOutCC: 0, lifetimeClaimedCC: 0 }),
      recordOutbound: async () => undefined,
      recordClaimedHighWater: async () => undefined,
      recordOutboundUSDCx: async () => undefined,
    },
    usdcx: true,
    ...(o.newTools === false ? {} : { newTools: { maxResponseChars: 4000 } }),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  const r = (await client.callTool({ name: "pay", arguments: { url: URL_, ...args } })) as {
    content: Array<{ text: string }>;
  };
  return r.content.map((c) => c.text).join("\n");
}

describe("pay against a 402 that lists USDCx first, through the real signer", () => {
  const prev = process.env.CANTON_AGENT_PAYABLE_INSTRUMENTS;
  beforeEach(() => {
    delete process.env.CANTON_AGENT_PAYABLE_INSTRUMENTS;
    stubNetwork();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (prev !== undefined) process.env.CANTON_AGENT_PAYABLE_INSTRUMENTS = prev;
  });

  it("asset omitted: the Canton Coin entry is paid, although USDCx is listed first", async () => {
    const said = await pay({});
    expect(said).not.toMatch(/not configured to spend/);
    expect(relayCalls).toBeGreaterThan(0);
  });

  it("asset omitted, the CC entry over the CC cap: refused by the signer before the relay", async () => {
    const said = await pay({}, { maxPerTx: 0.01 });
    expect(said).toMatch(/exceeds the max payment value/);
    expect(relayCalls).toBe(0);
  });

  it("asset omitted without newTools: exactly as 2.3.0, the first entry (USDCx) is refused, nothing reaches the relay", async () => {
    const said = await pay({}, { newTools: false });
    expect(said).toMatch(/not configured to spend/);
    expect(relayCalls).toBe(0);
  });

  it("asset omitted and no CC offered: refused in the agent's terms, nothing reaches the relay", async () => {
    const required = { x402Version: 2, resource: { url: URL_ }, accepts: [entry("USDCx", U.admin, U.id)] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith(RELAY)) {
          relayCalls += 1;
          throw new Error("relay reached");
        }
        return new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64") },
        });
      })
    );
    const said = await pay({});
    expect(said).toBe('pay: this API does not take CC; it asks for USDCx. Pass asset "USDCx" to pay in USDCx. Nothing was paid.');
    expect(relayCalls).toBe(0);
  });

  it('asset "CC": the Canton Coin entry is paid', async () => {
    const said = await pay({ asset: "CC" });
    expect(said).not.toMatch(/not configured to spend/);
    expect(relayCalls).toBeGreaterThan(0);
  });

  it('asset "USDCx": consent and a USDCx cap come with it, so the USDCx entry is paid', async () => {
    const said = await pay({ asset: "USDCx" });
    expect(said).not.toMatch(/not configured to spend|denominated in Canton Coin|configured only for/);
    expect(relayCalls).toBeGreaterThan(0);
  });
});
