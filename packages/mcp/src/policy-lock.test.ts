import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readLedger } from "./policy.js";
import type * as AgentWallet from "@ftptech/canton-agent-wallet";

/** One wallet, shared by every server in this file: its balance and how many
 *  payments actually went out. */
const state = { cc: 20, fetches: 0 };

// The real module underneath (withHomeLock included), with the ledger-touching
// pieces replaced.
vi.mock("@ftptech/canton-agent-wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof AgentWallet>()),
  loadWallet: () => ({ party: "agent::1220aaa", relayUrl: "https://relay.test", network: "canton:mainnet" }),
  RelayClient: class {
    async balance() {
      return { cc: String(state.cc), amulet: 1 };
    }
  },
  makePayingFetchForWallet: async () => async () => {
    state.fetches += 1;
    await new Promise((r) => setTimeout(r, 150)); // a payment takes a while
    state.cc -= 1;
    return new Response("ok", { status: 200 });
  },
}));

const { createServer } = await import("./server.js");

/**
 * Claude Desktop and Claude Code each start their own server on the same home.
 * The gate reads the ledger before the money moves and the spend is written
 * after, so two payments in flight together both pass at 19 of 20 CC. Two
 * server instances here share nothing in memory; only the lock directory in
 * the home can stop the second payment, exactly as between two processes.
 */
describe("money moves are queued across servers on one home", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "x402mcp-policylock-"));
    state.cc = 20;
    state.fetches = 0;
  });

  const connect = async () => {
    const server = createServer({
      relayUrl: "https://relay.test",
      home,
      network: "canton:mainnet",
      policy: { allowDomains: ["api.example.com"], maxPerTx: 5, dailyCap: 20, fundedCeiling: false },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    return client;
  };
  const textOf = (r: unknown) =>
    (r as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");

  it("at 19 of 20 CC, two parallel payments from two servers: the second is refused", async () => {
    writeFileSync(
      join(home, "mcp-policy-ledger.json"),
      JSON.stringify({ date: new Date().toISOString().slice(0, 10), spentTodayCC: 19, lifetimeOutCC: 19, lifetimeClaimedCC: 0 })
    );
    const [a, b] = await Promise.all([connect(), connect()]);
    const results = await Promise.all([
      a.callTool({ name: "pay", arguments: { url: "https://api.example.com/x" } }),
      b.callTool({ name: "pay", arguments: { url: "https://api.example.com/x" } }),
    ]);
    expect(state.fetches).toBe(1);
    expect(results.map(textOf).filter((t) => /daily cap 20 CC already reached/.test(t))).toHaveLength(1);
    expect(readLedger(home, Date.now()).spentTodayCC).toBe(20);
    expect(existsSync(join(home, ".policy-lock"))).toBe(false);
  });

  it("a lock left by a crashed process is taken over within a minute", async () => {
    const lock = join(home, ".policy-lock");
    mkdirSync(lock);
    const old = new Date(Date.now() - 2 * 60_000);
    utimesSync(lock, old, old);
    const r = await (await connect()).callTool({ name: "pay", arguments: { url: "https://api.example.com/x" } });
    expect(r.isError).not.toBe(true);
    expect(state.fetches).toBe(1);
  });
});
