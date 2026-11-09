import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GUIDE } from "./guide.js";
import { registerWalletTools, type WalletToolDeps } from "./tools.js";

describe("the guide", () => {
  it("guide.ts is guide.md", () => {
    expect(GUIDE).toBe(readFileSync(new URL("./guide.md", import.meta.url), "utf8"));
  });

  it("names every tool and the rules agents get wrong, and stays short", () => {
    for (const t of ["get_balance", "find_paid_apis", "pay", "get_address", "request_funding", "claim", "withdraw", "swap", "get_history", "send_feedback"]) {
      expect(GUIDE, t).toContain(`\`${t}\``);
    }
    expect(GUIDE).toMatch(/never call it again in a loop/i);
    expect(GUIDE).toContain("https://www.ftptech.xyz/skill.md");
    expect(GUIDE).toContain("https://ftp-tech.mintlify.site/terms");
    expect(GUIDE.length).toBeLessThan(6000);
  });

  it("says a call pays at most once and that max_cc caps it", () => {
    expect(GUIDE).toMatch(/never call `pay` again for the same purchase/i);
    expect(GUIDE).toMatch(/A `pay` call pays at most once: a seller that answers 402 after being paid is not paid again/);
    expect(GUIDE).toMatch(/Set `max_cc` to cap what the call may spend/);
  });
});

describe("get_guide", () => {
  const connect = async (newTools: boolean) => {
    const deps: WalletToolDeps = {
      getWallet: async () => {
        throw new Error("get_guide must not touch the wallet");
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
      ...(newTools ? { newTools: { maxResponseChars: 4000 } } : {}),
    };
    const server = new McpServer({ name: "t", version: "0" });
    registerWalletTools(server, deps);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    return client;
  };

  it("returns the guide without a wallet", async () => {
    const r = (await (await connect(true)).callTool({ name: "get_guide", arguments: {} })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text).toBe(GUIDE);
  });

  it("is not listed without newTools", async () => {
    const { tools } = await (await connect(false)).listTools();
    expect(tools.map((t) => t.name)).not.toContain("get_guide");
  });
});
