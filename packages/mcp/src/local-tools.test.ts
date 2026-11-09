import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";
import { GUIDE } from "./guide.js";

/** What clients that show only the start of the instructions must still see. */
const LEAD = ["get_guide", "find_paid_apis", "never retried", "www.ftptech.xyz/skill.md"];

async function local() {
  const home = mkdtempSync(join(tmpdir(), "x402mcp-local-"));
  const server = createServer({
    relayUrl: "https://relay.test",
    home,
    network: "canton:mainnet",
    policy: { allowDomains: [], fundedCeiling: true },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, home };
}

describe("the local server", () => {
  it("lists the 2.3.0 tools plus get_guide, find_paid_apis and swap_quote, not the hosted-only ones", async () => {
    const { client } = await local();
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(
      [
        "claim",
        "find_paid_apis",
        "get_address",
        "get_balance",
        "get_guide",
        "pay",
        "request_funding",
        "swap",
        "swap_quote",
        "tradecraft_queued_cancel",
        "tradecraft_queued_fills",
        "tradecraft_queued_orders",
        "tradecraft_queued_setup",
        "tradecraft_queued_status",
        "tradecraft_queued_withdraw",
        "withdraw",
      ].sort()
    );
  });

  it("starts its instructions with the lead lines, inside 512 characters, and keeps the terms", async () => {
    const { client } = await local();
    const ins = client.getInstructions() ?? "";
    for (const p of LEAD) {
      const i = ins.indexOf(p);
      expect(i, p).toBeGreaterThanOrEqual(0);
      expect(i + p.length, p).toBeLessThanOrEqual(512);
    }
    expect(ins).toContain("https://ftp-tech.mintlify.site/terms");
  });

  it("the lead lines say a call pays at most once, and point to max_cc", async () => {
    const { client } = await local();
    const lead = (client.getInstructions() ?? "").slice(0, 512);
    expect(lead).toMatch(/Never call pay again for the same purchase/);
    expect(lead).toMatch(/A pay call pays at most once; set max_cc to cap what it may spend/);
  });

  it("pay can return up to 20000 characters", async () => {
    const { client } = await local();
    const pay = (await client.listTools()).tools.find((t) => t.name === "pay");
    expect(JSON.stringify(pay?.inputSchema)).toContain("at most 20000");
  });

  it("get_guide answers from memory and creates no wallet", async () => {
    const { client, home } = await local();
    const r = (await client.callTool({ name: "get_guide", arguments: {} })) as { content: Array<{ text: string }> };
    expect(r.content[0]!.text).toBe(GUIDE);
    expect(existsSync(join(home, "wallet.json"))).toBe(false);
  });
});
