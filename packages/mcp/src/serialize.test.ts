import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerWalletTools, type WalletToolDeps } from "./tools.js";

/**
 * The hosted server queues one user's money moves (WalletToolDeps.serialize):
 * the policy gate reads the ledger before the money moves and the spend is
 * recorded after, so two moves in flight together would both pass on one
 * reading. The tools have to actually run pay, withdraw and swap inside it.
 */
describe("money moves run inside deps.serialize", () => {
  const connect = async (deps: WalletToolDeps) => {
    const server = new McpServer({ name: "t", version: "0" });
    registerWalletTools(server, deps);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    return client;
  };

  const baseDeps = (log: string[]): WalletToolDeps => {
    const wallet = { party: "agent::1220aaa", relayUrl: "https://relay.test", network: "canton:mainnet" };
    return {
      getWallet: async () => wallet as never,
      relayFor: () => ({ balance: async () => ({ cc: "10" }) }) as never,
      payingFetchFor: async () => async () => {
        log.push("fetch");
        return new Response("ok", { status: 200 });
      },
      policy: { allowDomains: "*", maxPerTx: 5, dailyCap: 20, fundedCeiling: false },
      ledger: {
        read: async () => ({ date: "d", spentTodayCC: 0, lifetimeOutCC: 0, lifetimeClaimedCC: 0 }),
        recordOutbound: async () => undefined,
        recordClaimedHighWater: async () => undefined,
      },
      serialize: async (fn) => {
        log.push("enter");
        try {
          return await fn();
        } finally {
          log.push("exit");
        }
      },
    };
  };

  it("wraps pay: the whole call, payment included, happens inside the queue", async () => {
    const log: string[] = [];
    const client = await connect(baseDeps(log));
    await client.callTool({ name: "pay", arguments: { url: "https://api.example.com/x" } });
    expect(log).toEqual(["enter", "fetch", "exit"]);
  });

  it("wraps withdraw and swap even when they are refused", async () => {
    const log: string[] = [];
    const client = await connect(baseDeps(log));
    await client.callTool({ name: "withdraw", arguments: { to: "someone::1220", amount: "1000" } });
    await client
      .callTool({ name: "swap", arguments: { in: "CC", out: "USDCx", amount: "1000" } })
      .catch(() => undefined);
    expect(log.filter((e) => e === "enter")).toHaveLength(2);
    expect(log.filter((e) => e === "exit")).toHaveLength(2);
  });

  it("leaves balance reads outside it", async () => {
    const log: string[] = [];
    const client = await connect(baseDeps(log));
    await client.callTool({ name: "get_balance", arguments: {} }).catch(() => undefined);
    expect(log).not.toContain("enter");
  });

  it("pay writes one history line; a refused withdraw writes none and names the account page", async () => {
    const log: string[] = [];
    const ops: Array<Record<string, unknown>> = [];
    const deps = baseDeps(log);
    deps.ledger.recordOperation = async (op) => {
      ops.push(op as unknown as Record<string, unknown>);
    };
    deps.policy = { ...deps.policy, withdrawAllowlist: [], withdrawAllowlistUrl: "https://pay.example/account" };
    const client = await connect(deps);
    await client.callTool({ name: "pay", arguments: { url: "https://api.example.com/x" } });
    expect(ops).toEqual([expect.objectContaining({ kind: "pay", detail: "api.example.com (HTTP 200)", ok: true })]);
    const w = await client.callTool({ name: "withdraw", arguments: { to: "mallory::1220ff", amount: "1" } });
    expect(JSON.stringify(w.content)).toMatch(/not a withdrawal address the owner confirmed.*pay\.example\/account/);
    expect(ops).toHaveLength(1);
  });
});
