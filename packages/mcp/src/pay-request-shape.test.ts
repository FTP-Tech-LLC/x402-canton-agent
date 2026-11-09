import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerWalletTools, withJsonContentType, type WalletToolDeps } from "./tools.js";

/**
 * What pay sends and what it says after an API refused a paid request: an API
 * takes the payment before it reads the request, so a JSON body labelled
 * text/plain, or a retry of a request the API already refused, is paid for
 * nothing.
 */

const WALLET = { party: "agent::1220aaa", relayUrl: "https://relay.test", network: "canton:mainnet" };

function harness(o: { status?: number; balances?: string[]; signs?: string; newTools?: boolean; settlement?: boolean } = {}) {
  const sent: RequestInit[] = [];
  const balances = [...(o.balances ?? ["10", "10"])];
  const deps: WalletToolDeps = {
    getWallet: async () => WALLET as never,
    relayFor: () => ({ balance: async () => ({ cc: balances.length > 1 ? balances.shift()! : balances[0]!, amulet: 1 }) }) as never,
    payingFetchFor: async (_w, opts) => async (_u: unknown, init?: RequestInit) => {
      sent.push(init ?? {});
      // A transfer signed for the merchant (what the real signer reports).
      if (o.signs) opts.onSigned?.({ instrument: "DSO::1220dso|Amulet", amount: o.signs });
      const headers: Record<string, string> = o.settlement
        ? { "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ success: true, transaction: "1220set" })).toString("base64") }
        : {};
      return new Response('{"error":"amountIn is required"}', { status: o.status ?? 200, headers });
    },
    policy: { allowDomains: "*", maxPerTx: 5, dailyCap: 20, fundedCeiling: false },
    ledger: {
      read: async () => ({ date: "d", spentTodayCC: 0, lifetimeOutCC: 0, lifetimeClaimedCC: 0 }),
      recordOutbound: async () => undefined,
      recordClaimedHighWater: async () => undefined,
    },
    ...(o.newTools === false ? {} : { newTools: { maxResponseChars: 4000 } }),
  };
  return { deps, sent };
}

async function pay(deps: WalletToolDeps, args: Record<string, unknown>) {
  const server = new McpServer({ name: "t", version: "0" });
  registerWalletTools(server, deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  const r = (await client.callTool({ name: "pay", arguments: { url: "https://api.example.com/q", ...args } })) as {
    content: Array<{ text: string }>;
  };
  return r.content.map((c) => c.text).join("\n");
}

describe("withJsonContentType", () => {
  it("labels a JSON object or array body as JSON, unless a content type is set", () => {
    expect(withJsonContentType(undefined, '{"a":1}')).toEqual({ "content-type": "application/json" });
    expect(withJsonContentType({ "x-k": "v" }, "[1]")).toEqual({ "x-k": "v", "content-type": "application/json" });
    expect(withJsonContentType({ "Content-Type": "text/plain" }, '{"a":1}')).toEqual({ "Content-Type": "text/plain" });
    expect(withJsonContentType(undefined, "hello")).toBeUndefined();
    expect(withJsonContentType(undefined, '"just a string"')).toBeUndefined();
    expect(withJsonContentType({ a: "b" }, undefined)).toEqual({ a: "b" });
  });
});

describe("pay", () => {
  it("sends a JSON body as application/json when the agent set no content type", async () => {
    const h = harness();
    await pay(h.deps, { method: "POST", body: '{"fromToken":"CC","amountIn":"1000"}' });
    expect(new Headers(h.sent[0]!.headers).get("content-type")).toBe("application/json");
  });

  it("after a paid 4xx, says the API kept the payment and the same request pays again", async () => {
    const h = harness({ status: 400, balances: ["10", "9.9"] });
    const said = await pay(h.deps, { method: "POST", body: "{}" });
    expect(said).toContain("--- response body ---\n" + '{"error":"amountIn is required"}');
    expect(said).toContain(
      "The API kept the payment and refused the request as sent (HTTP 400). Fix the request (the body above says what is wrong) before paying again"
    );
  });

  it("after a paid 5xx, says paying again pays again", async () => {
    const h = harness({ status: 502, balances: ["10", "9.9"] });
    expect(await pay(h.deps, {})).toContain("The API kept the payment and failed (HTTP 502). Paying again pays again");
  });

  it("an error with nothing paid gets no such line", async () => {
    const h = harness({ status: 404 });
    expect(await pay(h.deps, {})).not.toContain("kept the payment");
  });

  it("signed but not settled (the API answered 502 before settling): no 'kept', the signed warning instead", async () => {
    const h = harness({ status: 502, signs: "0.1" });
    const said = await pay(h.deps, {});
    expect(said).not.toContain("kept the payment");
    expect(said).toContain("the merchant can still collect it");
  });

  it("a settlement the API reports counts as kept, though the balance does not show it yet", async () => {
    const h = harness({ status: 400, signs: "0.1", settlement: true });
    expect(await pay(h.deps, {})).toContain("The API kept the payment and refused the request as sent (HTTP 400)");
  });

  it("without newTools the request and the answer are 2.3.0's: no JSON label, no next step", async () => {
    const h = harness({ status: 400, balances: ["10", "9.9"], newTools: false });
    const said = await pay(h.deps, { method: "POST", body: '{"a":1}' });
    expect(h.sent[0]!.headers).toBeUndefined();
    expect(said).not.toContain("kept the payment");
  });
});
