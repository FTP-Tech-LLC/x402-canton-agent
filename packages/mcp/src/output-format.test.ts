/**
 * PINS TODAY'S TEXT. What get_balance and pay print is read by people, by
 * agents and by e2e/hosted-e2e.mjs, which matches /^0\.2\d* CC/ and /HTTP 200/
 * and splits on "--- response body ---\n". A change that alters a line here on
 * purpose updates the expectation in the same commit, and keeps the old text on
 * every path its flag leaves off.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerWalletTools, type WalletToolDeps } from "./tools.js";

const PARTY = "agent::1220aaa";
const WALLET = { party: PARTY, relayUrl: "https://relay.test", network: "canton:mainnet" };
const DSO_MAINNET = "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";
const later = () => new Date(Date.now() + 3_600_000).toISOString();
const ccOffer = (cid: string) => ({ cid, instrumentId: { admin: DSO_MAINNET, id: "Amulet" }, executeBefore: later() });

interface Harness {
  /** What successive relay balance() calls return; the last one repeats. */
  balances: Array<{ cc: string; amulet: number } | Error>;
  pending?: unknown[] | Error;
  /** The paying fetch handed to pay. */
  fetch?: typeof globalThis.fetch;
}

async function callTool(name: string, args: Record<string, unknown>, h: Harness) {
  let i = 0;
  const deps: WalletToolDeps = {
    getWallet: async () => WALLET as never,
    relayFor: () =>
      ({
        balance: async () => {
          const b = h.balances[Math.min(i++, h.balances.length - 1)]!;
          if (b instanceof Error) throw b;
          return b;
        },
        pending: async () => {
          if (h.pending instanceof Error) throw h.pending;
          return { party: PARTY, pending: h.pending ?? [] };
        },
      }) as never,
    payingFetchFor: async () => h.fetch ?? (async () => new Response("unused")),
    policy: { allowDomains: ["api.example.com"], fundedCeiling: false },
    ledger: {
      read: async () => ({ date: "2026-10-06", spentTodayCC: 0, lifetimeOutCC: 0, lifetimeClaimedCC: 0 }),
      recordOutbound: async () => undefined,
      recordClaimedHighWater: async () => undefined,
    },
  };
  const server = new McpServer({ name: "t", version: "0" });
  registerWalletTools(server, deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  await client.close();
  return { isError: r.isError === true, texts: r.content.map((c) => c.text) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("get_balance output, exactly as today", () => {
  it("one line: '<cc> CC (<n> amulet) for <party>'", async () => {
    const r = await callTool("get_balance", {}, { balances: [{ cc: "0.2", amulet: 1 }] });
    expect(r).toEqual({ isError: false, texts: [`0.2 CC (1 amulet) for ${PARTY}`] });
  });

  it("plural amulets, and the claim hint on the same line", async () => {
    const r = await callTool("get_balance", {}, {
      balances: [{ cc: "1.5", amulet: 3 }],
      pending: [ccOffer("00a"), ccOffer("00b")],
    });
    expect(r.texts).toEqual([
      `1.5 CC (3 amulets) for ${PARTY}; 2 incoming transfers waiting — call \`claim\` to accept`,
    ]);
  });

  it("a single waiting transfer is singular", async () => {
    const r = await callTool("get_balance", {}, { balances: [{ cc: "0", amulet: 0 }], pending: [ccOffer("00a")] });
    expect(r.texts).toEqual([`0 CC (0 amulets) for ${PARTY}; 1 incoming transfer waiting — call \`claim\` to accept`]);
  });

  it("a failed balance read (a 413 from /balance) is a tool error with the relay's message", async () => {
    const r = await callTool("get_balance", {}, {
      balances: [new Error("relay GET /v1/wallet/balance: HTTP 413 too many holdings")],
    });
    expect(r).toEqual({
      isError: true,
      texts: ["get_balance failed: relay GET /v1/wallet/balance: HTTP 413 too many holdings"],
    });
  });
});

describe("pay output, exactly as today", () => {
  it("result line, the body separator, then the body", async () => {
    const r = await callTool("pay", { url: "https://api.example.com/x" }, {
      balances: [{ cc: "20", amulet: 1 }, { cc: "19.5", amulet: 1 }],
      fetch: async () => new Response("pong", { status: 200 }),
    });
    expect(r).toEqual({
      isError: false,
      texts: ["HTTP 200; spent 0.5000000000 CC; balance 19.5000000000 CC\n--- response body ---\npong"],
    });
  });

  it("names the updateId from the payment response; no verdict when Lighthouse does not answer", async () => {
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    const receipt = Buffer.from(JSON.stringify({ transaction: "1220abcd" })).toString("base64");
    const r = await callTool("pay", { url: "https://api.example.com/x" }, {
      balances: [{ cc: "20", amulet: 1 }, { cc: "19.75", amulet: 1 }],
      fetch: async () => new Response("ok", { status: 200, headers: { "payment-response": receipt } }),
    });
    expect(r.texts).toEqual([
      "HTTP 200; spent 0.2500000000 CC; balance 19.7500000000 CC; updateId 1220abcd\n--- response body ---\nok",
    ]);
  });

  it("shows at most 4000 characters of the body, with no marker", async () => {
    const r = await callTool("pay", { url: "https://api.example.com/x" }, {
      balances: [{ cc: "20", amulet: 1 }, { cc: "20", amulet: 1 }],
      fetch: async () => new Response("a".repeat(5000), { status: 200 }),
    });
    const [head, body] = r.texts[0]!.split("--- response body ---\n");
    expect(head).toBe("HTTP 200; spent 0.0000000000 CC; balance 20.0000000000 CC\n");
    expect(body).toBe("a".repeat(4000));
  });

  it("a non-2xx answer is still a result, not a tool error", async () => {
    const r = await callTool("pay", { url: "https://api.example.com/x" }, {
      balances: [{ cc: "20", amulet: 1 }],
      fetch: async () => new Response('{"error":"nope"}', { status: 402 }),
    });
    expect(r).toEqual({
      isError: false,
      texts: ['HTTP 402; spent 0.0000000000 CC; balance 20.0000000000 CC\n--- response body ---\n{"error":"nope"}'],
    });
  });

  it("money moved and then the call failed: the warning first, then the error", async () => {
    const r = await callTool("pay", { url: "https://api.example.com/x" }, {
      balances: [{ cc: "20", amulet: 1 }, { cc: "19", amulet: 1 }],
      fetch: async () => {
        throw new Error("payment required after 1 attempts");
      },
    });
    expect(r).toEqual({
      isError: true,
      texts: [
        "WARNING: the wallet balance fell by 1.0000000000 CC during this call — funds MOVED. " +
          "Do NOT call pay again for this request; confirm with get_balance and check whether the merchant delivered.",
        "pay failed: payment required after 1 attempts",
      ],
    });
  });

  it("a policy refusal names the rule and nothing else", async () => {
    const r = await callTool("pay", { url: "https://other.example.com/x" }, { balances: [{ cc: "20", amulet: 1 }] });
    expect(r).toEqual({
      isError: true,
      texts: [
        "blocked by spend policy: pay blocked: other.example.com is not in the allowed payer domains (api.example.com).",
      ],
    });
  });
});
