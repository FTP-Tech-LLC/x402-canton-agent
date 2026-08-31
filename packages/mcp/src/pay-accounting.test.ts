import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readLedger } from "./policy.js";

const balance = { cc: 20 };

vi.mock("@ftptech/canton-agent-wallet", () => ({
  ensureWallet: async () => ({
    party: "agent::1220aaa",
    relayUrl: "https://relay.test",
    network: "canton:mainnet",
  }),
  RelayClient: class {
    async balance() {
      return { cc: String(balance.cc) };
    }
  },
  claimAll: async () => ({ accepted: 0 }),
  loadWallet: async () => ({ party: "agent::1220aaa", relayUrl: "https://relay.test", network: "canton:mainnet" }),
  saveWallet: async () => undefined,
  agentKeyFromPrivatePem: () => "k",
  withdraw: async () => ({ updateId: "u" }),
  questFund: async () => ({ ok: true }),
  makePayingFetch: async () => async () => {
    // Settles a real payment, then the merchant answers 402 again and the
    // client gives up: money moved, the call throws.
    balance.cc -= 5;
    throw new Error("payment required after 4 attempts");
  },
  makePayingFetchForWallet: async () => async () => {
    balance.cc -= 5;
    throw new Error("payment required after 4 attempts");
  },
}));

const { createServer } = await import("./server.js");

describe("a pay that moves money and then throws must still be accounted for", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "x402mcp-pay-"));
    balance.cc = 20;
  });

  it("the daily cap fires on the NEXT call, because the first one was recorded", async () => {
    const server = createServer({
      home,
      policy: { allowDomains: ["api.example.com"], dailyCap: 2 },
    } as never);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    for (let i = 0; i < 4; i++) {
      await client
        .callTool({ name: "pay", arguments: { url: "https://api.example.com/x" } })
        .catch(() => undefined);
    }
    // The accounting used to sit after the paying fetch inside the same try,
    // so a throw skipped it — and a throw is exactly the case where money may
    // already have moved (the client re-signs per attempt and can settle
    // several before giving up). spentTodayCC stayed 0, so --daily-cap, whose
    // only input is that counter, could never fire: on the old code these four
    // calls drained the wallet 20 -> 0 CC with the counter still reading 0.
    const led = readLedger(home, Date.now());
    expect(led.spentTodayCC).toBe(5); // the first call's real movement
    expect(balance.cc).toBe(15); // calls 2-4 were refused by the cap
  });
});

/**
 * "PAID AND FAILED" AND "NOTHING MOVED" MUST NOT BE THE SAME SENTENCE.
 *
 * The handler already measures the movement — it must, or the daily cap can
 * never fire (the test above). It computes `spent` from the balance delta and
 * writes the ledger. Then the outer catch calls `toolError("pay", err)`, which
 * only ever renders the error message. The number is thrown away.
 *
 * So the agent reading the reply cannot distinguish "the merchant never got
 * paid, retry" from "you paid and got nothing, do NOT retry" — and an agent is
 * exactly the caller that will decide to retry. This is the same ambiguity the
 * facilitator's inconclusive /settle produces upstream, arriving at the one
 * component that acts on it automatically.
 */
describe("a pay that moved money says so, even when it failed", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "x402mcp-paywarn-"));
    balance.cc = 20;
  });

  async function callPay(policy: Record<string, unknown>) {
    const server = createServer({ home, policy } as never);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    return (await client.callTool({
      name: "pay",
      arguments: { url: "https://api.example.com/x" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
  }

  it("names the amount that left the wallet and says not to retry", async () => {
    const r = await callPay({ allowDomains: ["api.example.com"] });
    const said = r.content.map((c) => c.text).join("\n");
    // The mock settles 5 CC and then throws — money moved, the call failed.
    expect(said).toMatch(/5/);
    expect(said).toMatch(/moved|MOVED/);
    expect(said).toMatch(/do not|Do NOT|not call pay again/i);
    // Still an error: the call DID fail, and dressing it as success would be a
    // worse lie than the one being fixed.
    expect(r.isError).toBe(true);
  });

  it("a failure that moved NOTHING carries no such warning", async () => {
    // The discriminator. A policy refusal happens before any payment, so the
    // balance is untouched and the reply must stay clean — a warning on every
    // failure would train the agent to ignore it.
    const r = await callPay({ allowDomains: ["other.example.com"] });
    const said = r.content.map((c) => c.text).join("\n");
    expect(said).toMatch(/blocked by spend policy/);
    expect(said).not.toMatch(/moved|MOVED/);
    expect(r.isError).toBe(true);
  });
});
