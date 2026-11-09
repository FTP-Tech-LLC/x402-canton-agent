import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerWalletTools } from "./tools.js";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** One wallet behind a queue that another money move holds until `release()`. */
async function queued(policy: Parameters<typeof registerWalletTools>[1]["policy"] = { allowDomains: "*", fundedCeiling: false }) {
  let release!: () => void;
  const turn = new Promise<void>((r) => (release = r));
  const answers: unknown[] = [];
  const seen = { walletReads: 0, fetches: 0 };
  const server = new McpServer({ name: "t", version: "0" });
  registerWalletTools(server, {
    getWallet: async () => {
      seen.walletReads += 1;
      return { party: "agent::1220aaa", relayUrl: "https://relay.test", network: "canton:mainnet" } as never;
    },
    relayFor: () => ({ balance: async () => ({ cc: "10", amulet: 1 }) }) as never,
    payingFetchFor: async () => async () => {
      seen.fetches += 1;
      return new Response("ok", { status: 200 });
    },
    policy,
    ledger: {
      read: async () => ({ date: "d", spentTodayCC: 0, lifetimeOutCC: 0, lifetimeClaimedCC: 0 }),
      recordOutbound: async () => undefined,
      recordClaimedHighWater: async () => undefined,
    },
    serialize: async <T,>(fn: () => Promise<T>): Promise<T> => {
      await turn;
      const r = await fn();
      answers.push(r);
      return r;
    },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, release, answers, seen };
}

/**
 * A queued pay can wait minutes for the money moves before it. An MCP client
 * stops waiting after about 60 s, and the agent may then call pay again. The
 * abandoned call must not pay as well when its turn comes.
 */
describe("a queued pay whose client stopped waiting", () => {
  it("pays nothing when its turn comes, and says so", async () => {
    const q = await queued();
    const stop = new AbortController();
    const call = q.client.callTool(
      { name: "pay", arguments: { url: "https://api.example.com/x" } },
      undefined,
      { signal: stop.signal }
    );
    await tick(); // the call is in the queue
    stop.abort(new Error("the client gave up"));
    await expect(call).rejects.toThrow("the client gave up");
    await tick(); // the cancellation reaches the server
    q.release();
    await tick();
    expect(q.answers).toEqual([
      expect.objectContaining({
        isError: true,
        content: [
          {
            type: "text",
            text: "pay cancelled before paying: the client stopped waiting; nothing was paid. Call get_balance.",
          },
        ],
      }),
    ]);
    expect(q.seen).toEqual({ walletReads: 0, fetches: 0 });
  });

  it("a call nobody cancelled pays as before", async () => {
    const q = await queued();
    const call = q.client.callTool({ name: "pay", arguments: { url: "https://api.example.com/x" } });
    await tick();
    q.release();
    const r = (await call) as { content: Array<{ text: string }>; isError?: boolean };
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text).toMatch(/^HTTP 200; /);
    expect(q.seen.fetches).toBe(1);
  });
});

/** The same for the other two money moves: a cancelled call that waited its
 *  turn sends nothing, and a call nobody cancelled runs as before. */
describe.each([
  {
    tool: "withdraw",
    args: { to: "bob::1220bbb", amount: "1" },
    said: "withdraw cancelled before sending: the client stopped waiting; nothing was sent. Call get_balance.",
    // No amount under a per-tx cap: refused after the wallet is read, before anything moves.
    uncancelled: { to: "bob::1220bbb" },
    ranAsBefore: /^withdraw blocked: a per-tx cap is set/,
  },
  {
    tool: "swap",
    args: { in: "CC", out: "USDCx", amount: "60" },
    said: "swap cancelled before swapping: the client stopped waiting; nothing was sent. Call get_balance.",
    // A zero amount: refused after the wallet is read, before anything moves.
    uncancelled: { in: "CC", out: "USDCx", amount: "0" },
    ranAsBefore: /^swap: amount must be a positive number/,
  },
])("a queued $tool whose client stopped waiting", ({ tool, args, said, uncancelled, ranAsBefore }) => {
  it("sends nothing when its turn comes, and says so", async () => {
    const q = await queued();
    const stop = new AbortController();
    const call = q.client.callTool({ name: tool, arguments: args }, undefined, { signal: stop.signal });
    await tick(); // the call is in the queue
    stop.abort(new Error("the client gave up"));
    await expect(call).rejects.toThrow("the client gave up");
    await tick(); // the cancellation reaches the server
    q.release();
    await tick();
    expect(q.answers).toEqual([
      expect.objectContaining({ isError: true, content: [{ type: "text", text: said }] }),
    ]);
    expect(q.seen).toEqual({ walletReads: 0, fetches: 0 });
  });

  it("a call nobody cancelled runs as before", async () => {
    const q = await queued({ allowDomains: "*", maxPerTx: 5, fundedCeiling: false });
    const call = q.client.callTool({ name: tool, arguments: uncancelled });
    await tick();
    q.release();
    const r = (await call) as { content: Array<{ text: string }> };
    expect(r.content[0]!.text).toMatch(ranAsBefore);
    expect(q.seen.walletReads).toBe(1);
  });
});
