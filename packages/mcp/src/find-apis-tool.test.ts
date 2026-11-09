import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerWalletTools, type WalletToolDeps } from "./tools.js";
import type { CatalogCache } from "./catalog.js";

const CATALOG: CatalogCache = {
  get: async () => [
    {
      resource: "https://cc-api.itrocket.space/x402/api/v1/stats",
      type: "http",
      accepts: [{ amount: "254000000", asset: "CC" }],
      metadata: { title: "IT Rocket Canton indexer" },
    },
    {
      resource: "https://api.cantrustai.xyz/v1/agent/completions",
      type: "http",
      method: "POST",
      accepts: [{ amount: "2500000000", asset: "CC" }],
      metadata: { name: "CanTrustAI Agent Completions" },
    },
  ],
};

async function connect(o: { newTools: boolean; catalog?: CatalogCache }) {
  const deps: WalletToolDeps = {
    getWallet: async () => {
      throw new Error("find_paid_apis must not touch the wallet");
    },
    relayFor: () => {
      throw new Error("no relay");
    },
    payingFetchFor: async () => fetch,
    policy: { allowDomains: "*", fundedCeiling: false },
    ledger: {
      read: async () => ({ date: "d", spentTodayCC: 0, lifetimeOutCC: 0, lifetimeClaimedCC: 0 }),
      recordOutbound: async () => undefined,
      recordClaimedHighWater: async () => undefined,
    },
    ...(o.newTools ? { newTools: { maxResponseChars: 4000 } } : {}),
    ...(o.catalog ? { catalog: o.catalog } : {}),
  };
  const server = new McpServer({ name: "t", version: "0" });
  registerWalletTools(server, deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}
const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");

describe("find_paid_apis", () => {
  it("is not listed without newTools, even with a catalogue", async () => {
    const { tools } = await (await connect({ newTools: false, catalog: CATALOG })).listTools();
    expect(tools.map((t) => t.name)).not.toContain("find_paid_apis");
  });

  it("is read-only and lists the matching entries with prices, without a wallet", async () => {
    const c = await connect({ newTools: true, catalog: CATALOG });
    const t = (await c.listTools()).tools.find((x) => x.name === "find_paid_apis");
    expect(t?.annotations?.readOnlyHint).toBe(true);
    const r = await c.callTool({ name: "find_paid_apis", arguments: { query: "indexer" } });
    expect(r.isError).not.toBe(true);
    expect(textOf(r)).toContain("IT Rocket Canton indexer");
    expect(textOf(r)).toContain("0.0254 CC");
    expect(textOf(r)).not.toContain("CanTrustAI");
  });

  it("says when the catalogue never loaded", async () => {
    const c = await connect({ newTools: true, catalog: { get: async () => undefined } });
    const r = await c.callTool({ name: "find_paid_apis", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/could not be loaded/);
  });
});
