import { describe, it, expect, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerWalletTools } from "./tools.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * After a payment, pay asks Lighthouse whether the transfer was accepted. That
 * question used to run inside the money-move queue, which the local server
 * holds as `.policy-lock` across processes, and a Lighthouse that never
 * answered held every other money move on the home. It now runs after the
 * queue is released, and is still given 10 seconds, after which the payment is
 * simply not confirmed.
 */
describe("the Lighthouse cross-check after a payment", () => {
  it("gives up on a Lighthouse that never answers after 10 s; pay answers and the queue moves on", async () => {
    // AbortSignal.timeout(10_000) is the deadline asked for; it is cut to
    // 50 ms here so the test does not wait 10 seconds.
    const deadlines: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      deadlines.push(ms);
      return realTimeout(ms === 10_000 ? 50 : ms);
    });
    // A Lighthouse that never answers: like a real fetch, it gives up only
    // when its signal aborts.
    const asked: string[] = [];
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      asked.push(String(input));
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))
      );
    });

    let held = 0;
    const server = new McpServer({ name: "t", version: "0" });
    registerWalletTools(server, {
      getWallet: async () =>
        ({ party: "agent::1220aaa", relayUrl: "https://relay.test", network: "canton:mainnet" }) as never,
      relayFor: () => ({ balance: async () => ({ cc: "10", amulet: 1 }) }) as never,
      payingFetchFor: async () => async () =>
        new Response("ok", {
          status: 200,
          headers: { "payment-response": Buffer.from(JSON.stringify({ transaction: "1220upd" })).toString("base64") },
        }),
      policy: { allowDomains: "*", fundedCeiling: false },
      ledger: {
        read: async () => ({ date: "d", spentTodayCC: 0, lifetimeOutCC: 0, lifetimeClaimedCC: 0 }),
        recordOutbound: async () => undefined,
        recordClaimedHighWater: async () => undefined,
      },
      serialize: async <T,>(fn: () => Promise<T>): Promise<T> => {
        held += 1;
        try {
          return await fn();
        } finally {
          held -= 1;
        }
      },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);

    const r = (await client.callTool({ name: "pay", arguments: { url: "https://api.example.com/x" } })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(asked).toEqual(["https://lighthouse.cantonloop.com/api/transactions/1220upd"]);
    expect(deadlines).toContain(10_000);
    expect(r.isError).not.toBe(true);
    // Not confirmed: no "verified", no throw; the payment itself is reported.
    expect(r.content[0]!.text).toBe(
      "HTTP 200; spent 0.0000000000 CC; balance 10.0000000000 CC; updateId 1220upd\n--- response body ---\nok"
    );
    expect(held).toBe(0);
  });
});
