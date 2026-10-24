import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerWalletTools } from "./tools.js";

const WALLET = { party: "agent::1220aaa", relayUrl: "https://relay.test", network: "canton:mainnet" };
const DSO_MAINNET = "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";
const later = () => new Date(Date.now() + 3_600_000).toISOString();

async function balanceText(pending: unknown[] | Error): Promise<string> {
  const server = new McpServer({ name: "t", version: "0" });
  registerWalletTools(server, {
    getWallet: async () => WALLET as never,
    relayFor: () =>
      ({
        balance: async () => ({ cc: "0.2", amulet: 1 }),
        pending: async () => {
          if (pending instanceof Error) throw pending;
          return { party: WALLET.party, pending };
        },
      }) as never,
    payingFetchFor: async () => fetch,
    policy: { allowDomains: ["*"], fundedCeiling: false },
    ledger: {
      read: async () => ({ spentTodayCC: 0, lifetimeOutCC: 0, lifetimeClaimedCC: 0 }),
      recordOutbound: async () => undefined,
      recordClaimedHighWater: async () => undefined,
    } as never,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  const r = (await client.callTool({ name: "get_balance", arguments: {} })) as {
    content: Array<{ text: string }>;
  };
  return r.content[0]!.text;
}

describe("get_balance says when a claim would bring something in", () => {
  it("names a Canton Coin offer waiting for claim", async () => {
    const t = await balanceText([
      { cid: "00a", instrumentId: { admin: DSO_MAINNET, id: "Amulet" }, executeBefore: later() },
    ]);
    expect(t).toContain("0.2 CC");
    expect(t).toContain("1 incoming transfer waiting");
  });

  it("stays quiet about offers claim would skip (expired, or an unanchored registrar)", async () => {
    const t = await balanceText([
      { cid: "00b", instrumentId: { admin: DSO_MAINNET, id: "Amulet" }, executeBefore: "2020-01-01T00:00:00Z" },
      { cid: "00c", instrumentId: { admin: "reg::1220unknown", id: "TOK" }, executeBefore: later() },
    ]);
    expect(t).not.toContain("incoming");
  });

  it("a relay that cannot list pending still answers the balance", async () => {
    const t = await balanceText(new Error("404"));
    expect(t).toMatch(/^0\.2 CC/);
    expect(t).not.toContain("incoming");
  });
});
