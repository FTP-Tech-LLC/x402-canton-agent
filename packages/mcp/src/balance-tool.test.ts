import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { KNOWN_INSTRUMENTS } from "@ftptech/canton-agent-wallet";
import { registerWalletTools } from "./tools.js";

const WALLET = { party: "agent::1220aaa", relayUrl: "https://relay.test", network: "canton:mainnet" };
const DSO_MAINNET = "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";
const later = () => new Date(Date.now() + 3_600_000).toISOString();

async function balanceText(pending: unknown[] | Error, policyExtra: Record<string, unknown> = {}): Promise<string> {
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
    policy: { allowDomains: ["*"], fundedCeiling: false, ...policyExtra } as never,
    ledger: {
      read: async () => ({ spentTodayCC: 12.5, lifetimeOutCC: 0, lifetimeClaimedCC: 0 }),
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

const ERR_413 = 'relay GET /v1/wallet/agent%3A%3A1220aaa/balance -> 413 {"code":"holdings_exceed_node_limit"}';

async function balanceWith(o: {
  newTools?: boolean;
  limitsUrl?: string;
  balance?: () => Promise<unknown>;
  holdings?: () => Promise<unknown>;
}): Promise<{ text: string; isError: boolean }> {
  const server = new McpServer({ name: "t", version: "0" });
  registerWalletTools(server, {
    getWallet: async () => WALLET as never,
    relayFor: () =>
      ({
        balance: o.balance ?? (async () => ({ cc: "0.2", amulet: 1 })),
        pending: async () => ({ party: WALLET.party, pending: [] }),
        holdings:
          o.holdings ??
          (async () => ({
            party: WALLET.party,
            complete: true,
            instruments: [
              { ...KNOWN_INSTRUMENTS["USDCx"]!, total: "1.5000000000", holdings: [{ cid: "a", amount: "1.5", locked: false }] },
            ],
          })),
      }) as never,
    payingFetchFor: async () => fetch,
    policy: { allowDomains: "*", maxPerTx: 5, dailyCap: 20, fundedCeiling: false, ...(o.limitsUrl ? { limitsUrl: o.limitsUrl } : {}) },
    ledger: {
      read: async () => ({ date: "d", spentTodayCC: 4.5, lifetimeOutCC: 4.5, lifetimeClaimedCC: 0 }),
      recordOutbound: async () => undefined,
      recordClaimedHighWater: async () => undefined,
    },
    ...(o.newTools ? { newTools: { maxResponseChars: 4000 } } : {}),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  const r = (await client.callTool({ name: "get_balance", arguments: {} })) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
}

describe("get_balance with and without newTools", () => {
  it("without newTools: one line, as in 2.3.0", async () => {
    expect((await balanceWith({})).text).toBe(`0.2 CC (1 amulet) for ${WALLET.party}`);
  });

  it("with newTools: the first line unchanged, then tokens and limits", async () => {
    const { text } = await balanceWith({ newTools: true });
    expect(text.split("\n")).toEqual([
      `0.2 CC (1 amulet) for ${WALLET.party}`,
      "1.5000000000 USDCx (1 holding)",
      "limits: today 15.5 of 20 CC left, up to 5 CC per payment; max_cc caps a whole pay call",
    ]);
    expect(text).toMatch(/^0\.2\d* CC/); // what hosted-e2e.mjs reads
  });

  it("a 413 on the balance keeps today's error first and still shows tokens and limits", async () => {
    const r = await balanceWith({ newTools: true, balance: async () => { throw new Error(ERR_413); } });
    expect(r.isError).toBe(true);
    const lines = r.text.split("\n");
    expect(lines[0]).toBe(`get_balance failed: ${ERR_413}`);
    expect(lines.slice(1)).toEqual([
      "1.5000000000 USDCx (1 holding)",
      "limits: today 15.5 of 20 CC left, up to 5 CC per payment; max_cc caps a whole pay call",
    ]);
  });

  it("without newTools a 413 is today's error alone", async () => {
    const r = await balanceWith({ balance: async () => { throw new Error(ERR_413); } });
    expect(r).toEqual({ text: `get_balance failed: ${ERR_413}`, isError: true });
  });

  it("a token read that fails leaves the balance and the limits", async () => {
    const { text } = await balanceWith({ newTools: true, holdings: async () => { throw new Error("relay 502"); } });
    expect(text.split("\n")).toEqual([
      `0.2 CC (1 amulet) for ${WALLET.party}`,
      "tokens: could not be read right now",
      "limits: today 15.5 of 20 CC left, up to 5 CC per payment; max_cc caps a whole pay call",
    ]);
  });
});

describe("get_balance on the hosted server says what the owner's limits are", () => {
  it("names both limits, today's spend and the page", async () => {
    const t = await balanceText([], { maxPerTx: 5000, dailyCap: 5000, limitsUrl: "https://pay.example/account#limits" });
    expect(t).toContain(
      "Limits: 5000 CC per payment, 5000 CC per day (12.5 CC spent today). The owner changes them on https://pay.example/account#limits."
    );
  });

  it("with newTools, the limits line names the page and no second limits line follows", async () => {
    const { text } = await balanceWith({ newTools: true, limitsUrl: "https://pay.example/account#limits" });
    expect(text.split("\n")).toEqual([
      `0.2 CC (1 amulet) for ${WALLET.party}`,
      "1.5000000000 USDCx (1 holding)",
      "limits: today 15.5 of 20 CC left, up to 5 CC per payment; max_cc caps a whole pay call. " +
        "The owner changes them on https://pay.example/account#limits.",
    ]);
  });

  it("says no limit for a limit the owner turned off, and nothing on the local server", async () => {
    const hosted = await balanceText([], { dailyCap: 300, limitsUrl: "https://pay.example/account#limits" });
    expect(hosted).toContain("Limits: no limit per payment, 300 CC per day");
    const local = await balanceText([], { maxPerTx: 5 });
    expect(local).not.toContain("Limits:");
  });
});
