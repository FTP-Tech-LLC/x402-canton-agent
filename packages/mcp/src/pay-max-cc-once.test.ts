import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readLedger } from "./policy.js";
import type * as AgentWallet from "@ftptech/canton-agent-wallet";

/** One wallet: its balance, the payments signed from it, and the options the
 *  local server handed to the paying fetch. */
const state = { cc: 20, signed: 0, seen: [] as Array<Record<string, unknown>> };

// The real module underneath, with the ledger-touching pieces replaced. The
// paying fetch stands for a merchant that settles every payment and still
// answers 402, behind the client's re-pay loop: one first payment plus
// `maxPaymentRetries` re-pays, 4 when unset (wrapFetchWithCantonPayment's
// default, which makePayingFetchForWallet keeps unless it is passed one).
vi.mock("@ftptech/canton-agent-wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof AgentWallet>()),
  loadWallet: () => ({ party: "agent::1220aaa", relayUrl: "https://relay.test", network: "canton:mainnet" }),
  RelayClient: class {
    async balance() {
      return { cc: String(state.cc), amulet: 1 };
    }
  },
  makePayingFetchForWallet: async (_w: unknown, opts: { maxPaymentRetries?: number }) => {
    state.seen.push({ ...opts });
    const attempts = 1 + (opts.maxPaymentRetries ?? 4);
    return async () => {
      for (let i = 0; i < attempts; i++) {
        state.signed += 1;
        state.cc -= 1;
      }
      throw new Error(`payment retry still returned 402 after ${attempts} attempt(s)`);
    };
  },
}));

const { createServer } = await import("./server.js");

/**
 * max_cc is what an agent sets to cap a pay call. The ceiling it lowers is
 * checked on each signed payment, and the local server re-pays a merchant that
 * keeps answering 402 (--single-payment is off by default), so a call capped
 * at 1 CC could still send 5. With max_cc the call pays at most once.
 */
describe("max_cc bounds the whole pay call on the local server", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "x402mcp-maxcc-"));
    state.cc = 20;
    state.signed = 0;
    state.seen.length = 0;
  });

  const pay = async (args: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const server = createServer({
      relayUrl: "https://relay.test",
      home,
      network: "canton:mainnet",
      policy: { allowDomains: ["api.example.com"], maxPerTx: 5, dailyCap: 20, fundedCeiling: false },
      ...extra,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    const r = (await client.callTool({ name: "pay", arguments: { url: "https://api.example.com/x", ...args } })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
  };

  it("with max_cc, a merchant that keeps answering 402 after payment is paid exactly once", async () => {
    const r = await pay({ max_cc: 1 });
    expect(state.signed).toBe(1);
    expect(state.seen).toHaveLength(1);
    expect(state.seen[0]!["maxPaymentRetries"]).toBe(0);
    expect(state.seen[0]!["maxPaymentValue"]).toBe("1");
    // The one payment is still reported and booked.
    expect(r.isError).toBe(true);
    expect(r.text).toContain("fell by 1.0000000000 CC");
    expect(readLedger(home, Date.now()).spentTodayCC).toBe(1);
  });

  it("without max_cc and without --single-payment, the re-pays stay as today", async () => {
    await pay({});
    expect(state.seen[0]).not.toHaveProperty("maxPaymentRetries");
    expect(state.signed).toBe(5);
  });

  it("with --single-payment and no max_cc, one payment as before", async () => {
    await pay({}, { singlePayment: true });
    expect(state.seen[0]!["maxPaymentRetries"]).toBe(0);
    expect(state.signed).toBe(1);
  });
});
