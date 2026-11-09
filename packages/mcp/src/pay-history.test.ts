import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerWalletTools } from "./tools.js";
import type { OperationRecord } from "./policy.js";

describe("the history line of a pay that failed after paying", () => {
  it("names the host, never the full URL with its query", async () => {
    let cc = 10;
    const ops: OperationRecord[] = [];
    const server = new McpServer({ name: "t", version: "0" });
    registerWalletTools(server, {
      getWallet: async () => ({ party: "agent::1220aaa", relayUrl: "https://relay.test", network: "canton:mainnet" }) as never,
      relayFor: () => ({ balance: async () => ({ cc: String(cc), amulet: 1 }) }) as never,
      payingFetchFor: async () => async () => {
        cc -= 1; // settled a payment, then the merchant answered 402 again
        throw new Error("payment required after 1 attempt");
      },
      policy: { allowDomains: "*", fundedCeiling: false },
      ledger: {
        read: async () => ({ date: "d", spentTodayCC: 0, lifetimeOutCC: 0, lifetimeClaimedCC: 0 }),
        recordOutbound: async () => undefined,
        recordClaimedHighWater: async () => undefined,
        recordOperation: async (op) => {
          ops.push(op);
        },
      },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    await client.callTool({ name: "pay", arguments: { url: "https://api.example.com:8443/v1/x?api_key=SECRET&q=1" } });
    expect(ops).toEqual([
      expect.objectContaining({ kind: "pay", detail: "api.example.com:8443 (failed after paying)", ok: false }),
    ]);
    expect(JSON.stringify(ops)).not.toContain("SECRET");
  });
});
