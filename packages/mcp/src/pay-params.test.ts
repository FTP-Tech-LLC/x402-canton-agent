import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerWalletTools, type WalletToolDeps } from "./tools.js";
import type { SpendPolicy } from "./config.js";

const WALLET = { party: "agent::1220aaa", relayUrl: "https://relay.test", network: "canton:mainnet" };
const CAPPED: SpendPolicy = { allowDomains: "*", maxPerTx: 5, dailyCap: 20, fundedCeiling: false };

function harness(o: { newTools?: { maxResponseChars: number }; body?: string; policy?: SpendPolicy } = {}) {
  const seen: Array<{ maxPaymentValue?: string; maxPaymentRetries?: number }> = [];
  let walletReads = 0;
  const deps: WalletToolDeps = {
    getWallet: async () => {
      walletReads += 1;
      return WALLET as never;
    },
    relayFor: () => ({ balance: async () => ({ cc: "10", amulet: 1 }) }) as never,
    payingFetchFor: async (_w, opts) => {
      seen.push(opts);
      return async () => new Response(o.body ?? "ok", { status: 200 });
    },
    policy: o.policy ?? CAPPED,
    ledger: {
      read: async () => ({ date: "d", spentTodayCC: 0, lifetimeOutCC: 0, lifetimeClaimedCC: 0 }),
      recordOutbound: async () => undefined,
      recordClaimedHighWater: async () => undefined,
    },
    ...(o.newTools ? { newTools: o.newTools } : {}),
  };
  return { deps, seen, walletReads: () => walletReads };
}

async function connect(deps: WalletToolDeps) {
  const server = new McpServer({ name: "t", version: "0" });
  registerWalletTools(server, deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

async function pay(deps: WalletToolDeps, args: Record<string, unknown> = {}) {
  const r = (await (await connect(deps)).callTool({
    name: "pay",
    arguments: { url: "https://api.example.com/x", ...args },
  })) as { content: Array<{ text: string }>; isError?: boolean };
  return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
}

const ON = { maxResponseChars: 4000 };

describe("without newTools, pay is 2.3.0's", () => {
  it("lists only url, method, headers and body, and drops max_cc", async () => {
    const h = harness();
    const { tools } = await (await connect(h.deps)).listTools();
    const props = tools.find((t) => t.name === "pay")!.inputSchema.properties ?? {};
    expect(Object.keys(props).sort()).toEqual(["body", "headers", "method", "url"]);
    await pay(h.deps, { max_cc: 0.5 });
    expect(h.seen[0]!.maxPaymentValue).toBe("5");
  });

  it("cuts the body at 4000 with no marker", async () => {
    const h = harness({ body: "x".repeat(5000) });
    const r = await pay(h.deps);
    expect(r.text.endsWith(`--- response body ---\n${"x".repeat(4000)}`)).toBe(true);
    expect(r.text).not.toContain("[truncated");
  });
});

describe("max_cc", () => {
  it("lowers the ceiling handed to the signer", async () => {
    const h = harness({ newTools: ON });
    await pay(h.deps, { max_cc: 0.5 });
    expect(h.seen[0]!.maxPaymentValue).toBe("0.5");
  });

  it("above the owner's limits changes nothing", async () => {
    const h = harness({ newTools: ON });
    await pay(h.deps, { max_cc: 50 });
    expect(h.seen[0]!.maxPaymentValue).toBe("5");
  });

  it("with no owner caps becomes the ceiling", async () => {
    const h = harness({ newTools: ON, policy: { allowDomains: "*", fundedCeiling: false } });
    await pay(h.deps, { max_cc: 0.25 });
    expect(h.seen[0]!.maxPaymentValue).toBe("0.25");
  });

  it("is described as a cap on the whole call, which then pays at most once", async () => {
    const { tools } = await (await connect(harness({ newTools: ON }).deps)).listTools();
    const props = tools.find((t) => t.name === "pay")!.inputSchema.properties as Record<string, { description?: string }>;
    const d = props["max_cc"]!.description ?? "";
    expect(d).not.toMatch(/this one payment/);
    expect(d).toMatch(/^The most this pay call may spend, in CC\./);
    expect(d).toMatch(/pays at most once/);
  });

  it("asks the paying fetch for no re-pays; without it the server's setting stands", async () => {
    const h = harness({ newTools: ON });
    await pay(h.deps, { max_cc: 0.5 });
    await pay(h.deps);
    expect(h.seen[0]).toMatchObject({ maxPaymentRetries: 0 });
    expect(h.seen[1]).not.toHaveProperty("maxPaymentRetries");
  });

  it("of zero or below is refused before the wallet is read", async () => {
    for (const bad of [0, -1]) {
      const h = harness({ newTools: ON });
      const r = await pay(h.deps, { max_cc: bad });
      expect(r.isError, String(bad)).toBe(true);
      expect(h.seen).toHaveLength(0);
      expect(h.walletReads()).toBe(0);
    }
  });
});

describe("max_response_chars", () => {
  it("defaults to 4000 and marks a cut body", async () => {
    const h = harness({ newTools: { maxResponseChars: 20000 }, body: "x".repeat(5000) });
    const r = await pay(h.deps);
    expect(r.text).toContain(`--- response body ---\n${"x".repeat(4000)}\n[truncated: 4000 of 5000]`);
  });

  it("asks for more, up to the server's ceiling", async () => {
    // Nothing past the ceiling is read, so a longer body's length is not known.
    const h = harness({ newTools: { maxResponseChars: 20000 }, body: "y".repeat(30000) });
    expect((await pay(h.deps, { max_response_chars: 25000 })).text).toContain(
      "[truncated: 20000 of more than 20000, the most this server returns; paying again returns the same part]"
    );
    expect((await pay(h.deps, { max_response_chars: 100 })).text).toContain("[truncated: 100 of more than 20000]");
    const shorter = harness({ newTools: { maxResponseChars: 20000 }, body: "y".repeat(15000) });
    expect((await pay(shorter.deps, { max_response_chars: 100 })).text).toContain("[truncated: 100 of 15000]");
  });

  it("a body that fits has no marker", async () => {
    const h = harness({ newTools: ON });
    expect((await pay(h.deps)).text.endsWith("--- response body ---\nok")).toBe(true);
  });

  it("of zero is refused", async () => {
    const h = harness({ newTools: ON });
    expect((await pay(h.deps, { max_response_chars: 0 })).isError).toBe(true);
    expect(h.seen).toHaveLength(0);
  });
});
