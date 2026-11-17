import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type * as Wallet from "@ftptech/canton-agent-wallet";

const withdrawMock = vi.fn();
vi.mock("@ftptech/canton-agent-wallet", async (importOriginal) => {
  const real = await importOriginal<typeof Wallet>();
  return { ...real, withdraw: (...args: unknown[]) => withdrawMock(...args) };
});

const { registerWalletTools } = await import("./tools.js");

async function harness() {
  const outbound: number[] = [];
  const server = new McpServer({ name: "t", version: "0" });
  registerWalletTools(server, {
    getWallet: async () =>
      ({ party: "agent::1220aaa", relayUrl: "https://relay.test", network: "canton:mainnet" }) as never,
    relayFor: () => ({ balance: async () => ({ cc: "10", amulet: 1 }) }) as never,
    payingFetchFor: async () => async () => new Response("ok", { status: 200 }),
    policy: { allowDomains: "*", fundedCeiling: false },
    ledger: {
      read: async () => ({ date: "d", spentTodayCC: 0, lifetimeOutCC: 0, lifetimeClaimedCC: 0 }),
      recordOutbound: async (cc: number) => {
        outbound.push(cc);
      },
      recordClaimedHighWater: async () => undefined,
    },
    serialize: async <T,>(fn: () => Promise<T>): Promise<T> => fn(),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, outbound };
}

const TO = "owner::1220bbb";

describe("withdraw whose outcome is unknown", () => {
  beforeEach(() => {
    withdrawMock.mockReset();
  });

  it("counts the amount against the caps, since it may have left the wallet", async () => {
    withdrawMock.mockImplementation(async () => {
      throw Object.assign(new Error("relay timed out after submitting"), { outcomeUnknown: true });
    });
    const h = await harness();
    const r = await h.client.callTool({ name: "withdraw", arguments: { to: TO, amount: "2.5" } });
    expect(r.isError).toBe(true);
    expect(h.outbound).toEqual([2.5]);
  });

  it("finds the flag on a wrapped cause too", async () => {
    withdrawMock.mockImplementation(async () => {
      throw new Error("withdraw failed", { cause: Object.assign(new Error("504"), { outcomeUnknown: true }) });
    });
    const h = await harness();
    await h.client.callTool({ name: "withdraw", arguments: { to: TO, amount: "1" } });
    expect(h.outbound).toEqual([1]);
  });

  it("does not count a send that was refused before anything went out", async () => {
    withdrawMock.mockImplementation(async () => {
      throw new Error("relay refused: 400");
    });
    const h = await harness();
    await h.client.callTool({ name: "withdraw", arguments: { to: TO, amount: "1" } });
    expect(h.outbound).toEqual([]);
  });

  it("counts a successful send once, as before", async () => {
    withdrawMock.mockResolvedValue({ amount: "1.5", updateId: "u1", landed: true });
    const h = await harness();
    await h.client.callTool({ name: "withdraw", arguments: { to: TO, amount: "1.5" } });
    expect(h.outbound).toEqual([1.5]);
  });

  it("a sweep sends the balance the caps were checked against", async () => {
    withdrawMock.mockResolvedValue({ amount: "10", updateId: "u2", landed: true });
    const h = await harness();
    await h.client.callTool({ name: "withdraw", arguments: { to: TO } });
    expect(withdrawMock.mock.calls[0]?.[0]).toMatchObject({ to: TO, amount: "10" });
    expect(h.outbound).toEqual([10]);
  });
});
