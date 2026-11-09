import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { assertNotRelay, PolicyError } from "./policy.js";
import { registerWalletTools } from "./tools.js";

const RELAY = "https://relay.test";
const LOCAL_RELAY = "http://127.0.0.1:4122";

describe("assertNotRelay", () => {
  it("refuses the relay's own host and port", () => {
    expect(() => assertNotRelay(`${RELAY}/v1/wallet/onboard/finalize`, RELAY)).toThrow(PolicyError);
    expect(() => assertNotRelay("https://relay.test:443/x", RELAY)).toThrow(PolicyError);
    expect(() => assertNotRelay(`${LOCAL_RELAY}/v1/wallet/onboard/prepare`, LOCAL_RELAY)).toThrow(PolicyError);
  });

  it("refuses http and https on the relay host alike", () => {
    for (const url of ["http://relay.test/x", "http://relay.test:443/x", "https://relay.test:80/x"]) {
      expect(() => assertNotRelay(url, RELAY), url).toThrow(PolicyError);
    }
    expect(() => assertNotRelay("https://relay.test/x", "http://relay.test")).toThrow(PolicyError);
  });

  it("ignores a trailing dot", () => {
    expect(() => assertNotRelay("https://relay.test./x", RELAY)).toThrow(PolicyError);
    expect(() => assertNotRelay("https://relay.test/x", "https://relay.test./")).toThrow(PolicyError);
  });

  it("ignores letter case", () => {
    expect(() => assertNotRelay("https://RELAY.Test/x", RELAY)).toThrow(PolicyError);
    expect(() => assertNotRelay("https://relay.test/x", "https://Relay.TEST")).toThrow(PolicyError);
  });

  it("lets another port on the relay host through", () => {
    expect(() => assertNotRelay("http://127.0.0.1:4180/paid", LOCAL_RELAY)).not.toThrow();
    expect(() => assertNotRelay("https://relay.test:8443/x", RELAY)).not.toThrow();
  });

  it("lets other hosts through", () => {
    expect(() => assertNotRelay("https://api.example.com/x", RELAY)).not.toThrow();
    expect(() => assertNotRelay("https://relay.test.example.com/x", RELAY)).not.toThrow();
  });
});

describe("pay to the wallet's relay", () => {
  it("is refused before anything is paid", async () => {
    let payingFetches = 0;
    const server = new McpServer({ name: "t", version: "0" });
    registerWalletTools(server, {
      getWallet: async () => ({ party: "agent::1220aaa", relayUrl: RELAY, network: "canton:mainnet" }) as never,
      relayFor: () => ({ balance: async () => ({ cc: "10", amulet: 1 }) }) as never,
      payingFetchFor: async () => {
        payingFetches += 1;
        return async () => new Response("ok", { status: 200 });
      },
      policy: { allowDomains: "*", fundedCeiling: false },
      ledger: {
        read: async () => ({ date: "d", spentTodayCC: 0, lifetimeOutCC: 0, lifetimeClaimedCC: 0 }),
        recordOutbound: async () => undefined,
        recordClaimedHighWater: async () => undefined,
      },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    const r = (await client.callTool({
      name: "pay",
      arguments: { url: `${RELAY}/v1/wallet/onboard/finalize`, method: "POST", body: "{}" },
    })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(r.content.map((c) => c.text).join("\n")).toBe(
      "blocked by spend policy: pay blocked: that address is the relay, not a paid service."
    );
    expect(payingFetches).toBe(0);
  });
});
