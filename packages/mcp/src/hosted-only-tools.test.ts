import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerWalletTools, type WalletToolDeps } from "./tools.js";
import type { HistoryRow } from "./history.js";

const T = Date.parse("2026-10-06T12:00:00Z");

function baseDeps(): WalletToolDeps {
  return {
    getWallet: async () => {
      throw new Error("these tools must not touch the wallet");
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
    newTools: { maxResponseChars: 4000 },
  };
}

async function connect(deps: WalletToolDeps) {
  const server = new McpServer({ name: "t", version: "0" });
  registerWalletTools(server, deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}
const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");

describe("get_history", () => {
  it("is listed only when the server can read a history (the local server cannot)", async () => {
    const { tools } = await (await connect(baseDeps())).listTools();
    expect(tools.map((t) => t.name)).not.toContain("get_history");
  });

  it("reads at most 50 rows and formats them, without a wallet", async () => {
    const asked: number[] = [];
    const rows: HistoryRow[] = [{ at: T, kind: "pay", amountCC: 0.25, detail: "api.example.com (HTTP 200)", ok: true }];
    const c = await connect({
      ...baseDeps(),
      history: async (limit) => {
        asked.push(limit);
        return rows;
      },
    });
    const t = (await c.listTools()).tools.find((x) => x.name === "get_history");
    expect(t?.annotations?.readOnlyHint).toBe(true);
    expect(textOf(await c.callTool({ name: "get_history", arguments: {} }))).toContain("host api.example.com");
    await c.callTool({ name: "get_history", arguments: { limit: 500 } });
    await c.callTool({ name: "get_history", arguments: { limit: 3 } });
    expect(asked).toEqual([50, 50, 3]);
  });
});

describe("send_feedback", () => {
  const sink = () => {
    const stored: Array<{ kind: string; text: string }> = [];
    return {
      stored,
      feedback: {
        add: async (kind: "bug" | "confusing" | "idea", text: string) => {
          stored.push({ kind, text });
        },
        countToday: async () => stored.length,
      },
    };
  };

  it("is listed only when the server has somewhere to put it", async () => {
    const { tools } = await (await connect(baseDeps())).listTools();
    expect(tools.map((t) => t.name)).not.toContain("send_feedback");
  });

  it("stores six a day and refuses the seventh, without a wallet", async () => {
    const s = sink();
    const c = await connect({ ...baseDeps(), feedback: s.feedback });
    const t = (await c.listTools()).tools.find((x) => x.name === "send_feedback");
    expect(t?.description).toMatch(/Never include private keys, recovery codes/);
    for (let i = 0; i < 6; i++) {
      const r = await c.callTool({ name: "send_feedback", arguments: { kind: "bug", text: `  report ${i}  ` } });
      expect(r.isError, `call ${i}`).not.toBe(true);
    }
    const seventh = await c.callTool({ name: "send_feedback", arguments: { kind: "idea", text: "one more" } });
    expect(seventh.isError).toBe(true);
    expect(textOf(seventh)).toMatch(/6 a day/);
    expect(s.stored).toHaveLength(6);
    expect(s.stored[0]).toEqual({ kind: "bug", text: "report 0" });
  });

  it("refuses an unknown kind, an empty text and more than 2,000 characters", async () => {
    const s = sink();
    const c = await connect({ ...baseDeps(), feedback: s.feedback });
    expect((await c.listTools()).tools.map((t) => t.name)).toContain("send_feedback");
    for (const args of [{ kind: "rant", text: "x" }, { kind: "bug", text: "   " }, { kind: "bug", text: "x".repeat(2001) }]) {
      expect((await c.callTool({ name: "send_feedback", arguments: args })).isError, JSON.stringify(args).slice(0, 40)).toBe(true);
    }
    expect(s.stored).toHaveLength(0);
  });
});
