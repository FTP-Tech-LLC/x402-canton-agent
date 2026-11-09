import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type * as AgentWallet from "@ftptech/canton-agent-wallet";

/** What the stubbed withdraw answers, and what it was asked. */
const state = { landed: true as boolean | null, calls: 0 };

vi.mock("@ftptech/canton-agent-wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof AgentWallet>()),
  withdraw: async (o: { amount?: string }) => {
    state.calls += 1;
    return { updateId: "1220upd", amount: o.amount ?? "1", landed: state.landed };
  },
}));

const { registerWalletTools } = await import("./tools.js");
const { CANTEX_CONNECT_PARTY } = await import("@ftptech/canton-agent-wallet");

async function withdraw(args: Record<string, unknown>) {
  const server = new McpServer({ name: "t", version: "0" });
  registerWalletTools(server, {
    getWallet: async () => ({ party: "agent::1220aaa", relayUrl: "https://relay.test", network: "canton:mainnet" }) as never,
    relayFor: () => ({ balance: async () => ({ cc: "10", amulet: 1 }) }) as never,
    payingFetchFor: async () => fetch,
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
  const r = (await client.callTool({ name: "withdraw", arguments: args })) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
}

beforeEach(() => {
  state.landed = true;
  state.calls = 0;
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
});

describe("withdraw", () => {
  it("refuses a swap venue's party before anything is sent", async () => {
    for (const to of ["tc-swp_CC-USDCx::122096fe", CANTEX_CONNECT_PARTY]) {
      const r = await withdraw({ to, amount: "1" });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^withdraw refused: that is a swap venue\. Use swap/);
    }
    expect(state.calls).toBe(0);
  });

  it("says when the CC went as an offer the receiver must accept", async () => {
    state.landed = false;
    const r = await withdraw({ to: "agent::1220bbb", amount: "1" });
    expect(r.text).toContain("It went as an offer: agent::1220bbb has no CC preapproval");
    expect(r.text).toContain("Until then the CC is locked and not in this wallet's balance, and this wallet cannot take it back.");
    expect(r.text).not.toContain("claim");
  });

  it("says nothing more when it landed, and that it could not tell when unknown", async () => {
    expect((await withdraw({ to: "agent::1220bbb", amount: "1" })).text).toBe("withdrew 1 CC to agent::1220bbb; updateId 1220upd");
    state.landed = null;
    expect((await withdraw({ to: "agent::1220bbb", amount: "1" })).text).toContain("could not be checked");
  });
});
