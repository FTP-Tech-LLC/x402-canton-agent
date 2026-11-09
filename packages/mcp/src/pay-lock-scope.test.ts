import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readLedger } from "./policy.js";
import { registerWalletTools, type WalletToolDeps } from "./tools.js";
import type * as AgentWallet from "@ftptech/canton-agent-wallet";

const enc = new TextEncoder();
const WALLET = { party: "agent::1220aaa", relayUrl: "https://relay.test", network: "canton:mainnet" };

/** One wallet on one home: its balance, and the merchant's body as it trickles. */
const state = {
  cc: 20,
  paid: false,
  cancelled: false,
  /** Characters of the body sent so far. */
  sent: 0,
  /** Ends the trickle: the merchant finally closes its body. */
  close: undefined as (() => void) | undefined,
};

// The real module underneath (withHomeLock included), with the ledger-touching
// pieces replaced. The merchant takes its payment, sends the headers, and then
// sends its body one character every 20 ms until it is told to stop.
vi.mock("@ftptech/canton-agent-wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof AgentWallet>()),
  loadWallet: () => WALLET,
  RelayClient: class {
    async balance() {
      return { cc: String(state.cc), amulet: 1 };
    }
  },
  makePayingFetchForWallet: async () => async () => {
    state.cc -= 0.5;
    let timer: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        timer = setInterval(() => {
          c.enqueue(enc.encode("a"));
          state.sent += 1;
        }, 20);
        state.close = () => {
          clearInterval(timer);
          try {
            c.close();
          } catch {
            // Already cancelled by the reader.
          }
        };
      },
      cancel() {
        clearInterval(timer);
        state.cancelled = true;
      },
    });
    state.paid = true;
    return new Response(body, { status: 200 });
  },
  withdraw: async (o: { amount?: string }) => {
    state.cc -= Number(o.amount);
    return { amount: o.amount, updateId: "1220w" };
  },
}));

const { createServer } = await import("./server.js");

const textOf = (r: unknown) =>
  (r as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");

afterEach(() => {
  state.close?.();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * The local `.policy-lock` holds every pay, withdraw and swap on the home, in
 * every process. It used to span the whole pay call, the merchant's body
 * included; a merchant that sends its headers and then trickles its body kept
 * every other money move on the wallet waiting until it gave up. The payment
 * has settled once the headers arrive, so the lock covers only the gate, the
 * payment and its ledger record.
 */
describe("a trickling merchant body holds no lock", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "x402mcp-lockscope-"));
    state.cc = 20;
    state.paid = false;
    state.cancelled = false;
    state.sent = 0;
    state.close = undefined;
    // Lighthouse, asked after the withdraw: not found, so nothing to confirm.
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
  });

  const connect = async () => {
    const server = createServer({
      relayUrl: "https://relay.test",
      home,
      network: "canton:mainnet",
      policy: { allowDomains: ["api.example.com"], maxPerTx: 5, dailyCap: 20, fundedCeiling: false },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    return client;
  };

  it("a withdraw on the same home goes through while pay is still reading the body", async () => {
    const [desktop, code] = await Promise.all([connect(), connect()]);
    const paying = desktop.callTool({ name: "pay", arguments: { url: "https://api.example.com/x" } });
    await vi.waitFor(() => expect(state.paid).toBe(true));

    const withdrawing = code.callTool({ name: "withdraw", arguments: { to: "owner::1220bbb", amount: "1" } });
    const first = await Promise.race([
      withdrawing.then((r) => textOf(r)),
      new Promise<string>((r) => setTimeout(() => r("still waiting"), 2500)),
    ]);
    expect(first).toBe("withdrew 1 CC to owner::1220bbb; updateId 1220w");

    // The withdraw can finish before the merchant's first 20 ms tick; close
    // the body only once it has begun, or it is rightly empty.
    await vi.waitFor(() => expect(state.sent).toBeGreaterThan(0));
    state.close?.();
    const paid = textOf(await paying);
    expect(paid).toMatch(/^HTTP 200; spent 0\.5000000000 CC; balance 19\.5000000000 CC\n--- response body ---\na+$/);
    expect(readLedger(home, Date.now()).spentTodayCC).toBe(1.5);
  });

  it("a body that never ends is read for 30 s at most, then cut and the download stopped", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => realTimeout(ms === 30_000 ? 300 : ms));
    const r = textOf(await (await connect()).callTool({ name: "pay", arguments: { url: "https://api.example.com/x" } }));
    const [head, body] = r.split("--- response body ---\n");
    expect(head).toBe("HTTP 200; spent 0.5000000000 CC; balance 19.5000000000 CC\n");
    expect(body).toMatch(/^a+\n\[truncated: \d+ shown; the rest of the body could not be read within 30 s\]$/);
    expect(state.cancelled).toBe(true);
  });
});

/** The same at the level of the tools: a counter stands for the queue. */
describe("what pay does outside the queue", () => {
  const harness = (o: {
    res: () => Response;
    newTools?: { maxResponseChars: number };
    lighthouse?: () => void;
  }) => {
    let held = 0;
    const deps: WalletToolDeps = {
      getWallet: async () => WALLET as never,
      relayFor: () => ({ balance: async () => ({ cc: "10", amulet: 1 }) }) as never,
      payingFetchFor: async () => async () => o.res(),
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
      ...(o.newTools ? { newTools: o.newTools } : {}),
    };
    return { deps, held: () => held };
  };
  const pay = async (deps: WalletToolDeps) => {
    const server = new McpServer({ name: "t", version: "0" });
    registerWalletTools(server, deps);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    return textOf(await client.callTool({ name: "pay", arguments: { url: "https://api.example.com/x" } }));
  };

  it("the Lighthouse check and the body read run after the queue is released", async () => {
    const heldAt: Record<string, number> = {};
    const h = harness({
      res: () =>
        new Response(
          // highWaterMark 0: pulled only when pay actually reads it.
          new ReadableStream<Uint8Array>(
            {
              pull(c) {
                heldAt["body"] = h.held();
                c.enqueue(enc.encode("ok"));
                c.close();
              },
            },
            { highWaterMark: 0 }
          ),
          {
            status: 200,
            headers: { "payment-response": Buffer.from(JSON.stringify({ transaction: "1220upd" })).toString("base64") },
          }
        ),
    });
    vi.stubGlobal("fetch", async () => {
      heldAt["lighthouse"] = h.held();
      return new Response("not found", { status: 404 });
    });
    expect(await pay(h.deps)).toBe(
      "HTTP 200; spent 0.0000000000 CC; balance 10.0000000000 CC; updateId 1220upd\n--- response body ---\nok"
    );
    expect(heldAt).toEqual({ lighthouse: 0, body: 0 });
  });

  it("reads at most maxResponseChars + 1 characters of a long body, says it was cut, and stops the download", async () => {
    let served = 0;
    let cancelled = false;
    const h = harness({
      newTools: { maxResponseChars: 20000 },
      res: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            // 100000 characters in all: far more than anything pay should read.
            pull(c) {
              served += 1000;
              c.enqueue(enc.encode("z".repeat(1000)));
              if (served >= 100_000) c.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 }
        ),
    });
    const r = await pay(h.deps);
    expect(r.endsWith(`--- response body ---\n${"z".repeat(4000)}\n[truncated: 4000 of more than 20000]`)).toBe(true);
    expect(cancelled).toBe(true);
    expect(served).toBeLessThanOrEqual(23000);
  });

  it("without newTools a body that never ends is cut at 30 s with no marker, as the 4000 cut has none", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => realTimeout(ms === 30_000 ? 100 : ms));
    const h = harness({
      res: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode("abc"));
            },
          }),
          { status: 200 }
        ),
    });
    expect(await pay(h.deps)).toBe("HTTP 200; spent 0.0000000000 CC; balance 10.0000000000 CC\n--- response body ---\nabc");
  });
});
