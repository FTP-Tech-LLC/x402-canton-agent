import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type * as AgentWallet from "@ftptech/canton-agent-wallet";

const W = { party: "agent::1220aaa", relayUrl: "https://relay.test", network: "canton:mainnet" };
const bal = { cc: 100, usdcx: 10 };
/** The options each pay handed the paying fetch, and what the next one charges. */
const seen: Array<Record<string, unknown>> = [];
const charge = { cc: 0, usdcx: 0 };

// The real module underneath, with only the wallet, the relay and the paying
// fetch replaced (a full-replacement mock breaks every time server.ts gains an
// import).
vi.mock("@ftptech/canton-agent-wallet", async (importOriginal) => {
  const real = await importOriginal<typeof AgentWallet>();
  const U = real.KNOWN_INSTRUMENTS.USDCx!;
  return {
    ...real,
    loadWallet: () => W,
    RelayClient: class {
      async balance() {
        return { cc: String(bal.cc), amulet: 1 };
      }
      async holdings() {
        return {
          party: W.party,
          complete: true,
          instruments: [{ admin: U.admin, id: U.id, total: bal.usdcx.toFixed(10), holdings: [] }],
        };
      }
    },
    makePayingFetchForWallet: async (_w: unknown, opts: Record<string, unknown>) => {
      seen.push(opts);
      return async () => {
        if (opts.preferAsset === "USDCx") {
          (opts.onSigned as (s: { instrument: string; amount: string }) => void)({
            instrument: real.instrumentKey(U.admin, U.id),
            amount: charge.usdcx.toFixed(10),
          });
          bal.usdcx -= charge.usdcx;
        } else {
          bal.cc -= charge.cc;
        }
        return new Response("ok", { status: 200 });
      };
    },
  };
});

const { createServer } = await import("./server.js");
const { readLedger } = await import("./policy.js");

const D1 = Date.parse("2026-10-06T23:00:00Z");
const D2 = Date.parse("2026-10-07T01:00:00Z");

async function connect(home: string, policy: Record<string, unknown>) {
  const server = createServer({ home, relayUrl: W.relayUrl, network: W.network, policy } as never);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

/**
 * The CC day and the USDCx day are separate counters with separate dates. If
 * a USDCx payment moved the CC date forward without resetting the CC total
 * (one shared day), yesterday's CC spend would block today's CC; and the
 * reverse.
 */
describe("local server: the CC day and the USDCx day roll over on their own", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "x402mcp-roll-"));
    seen.length = 0;
    bal.cc = 100;
    bal.usdcx = 10;
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => vi.useRealTimers());

  const payer = async (policy: Record<string, unknown>) => {
    const client = await connect(home, policy);
    return (args: Record<string, unknown>) =>
      client.callTool({ name: "pay", arguments: { url: "https://api.example.com/x", ...args } });
  };

  it("19 CC on day 1, USDCx on day 2, then a 5 CC payment on day 2 gets the whole CC day", async () => {
    const pay = await payer({ allowDomains: ["api.example.com"], maxPerTx: 19, dailyCap: 20, fundedCeiling: false, usdcxMaxPerTx: 1, usdcxDailyCap: 5 });
    vi.setSystemTime(D1);
    charge.cc = 19;
    await pay({});
    vi.setSystemTime(D2);
    charge.usdcx = 0.5;
    await pay({ asset: "USDCx" });
    charge.cc = 5;
    await pay({});
    expect(seen.at(-1)!.maxPaymentValue).toBe("19"); // the per-tx cap, not 20 - 19 = 1
    expect(readLedger(home, D2)).toMatchObject({ spentTodayCC: 5, spentTodayUSDCx: 0.5 });
  });

  it("4.5 USDCx on day 1, CC on day 2, then a 1 USDCx payment on day 2 gets the whole USDCx day", async () => {
    const pay = await payer({ allowDomains: ["api.example.com"], maxPerTx: 5, dailyCap: 20, fundedCeiling: false, usdcxMaxPerTx: 5, usdcxDailyCap: 5 });
    vi.setSystemTime(D1);
    charge.usdcx = 4.5;
    await pay({ asset: "USDCx" });
    vi.setSystemTime(D2);
    charge.cc = 1;
    await pay({});
    charge.usdcx = 1;
    await pay({ asset: "USDCx" });
    const last = seen.at(-1)!.maxPaymentValueByInstrument as Record<string, string>;
    expect(Object.values(last)).toEqual(["5"]); // not 5 - 4.5 = 0.5
    expect(readLedger(home, D2)).toMatchObject({ spentTodayCC: 1, spentTodayUSDCx: 1 });
  });
});

/** The USDCx line comes from plan C's limit lines under the first line. */
describe("local server: get_balance states the USDCx budget", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "x402mcp-bal-"));
    bal.cc = 100;
    bal.usdcx = 10;
  });

  const balanceLines = async (policy: Record<string, unknown>): Promise<string[]> => {
    const client = await connect(home, policy);
    const r = (await client.callTool({ name: "get_balance", arguments: {} })) as { content: Array<{ text: string }> };
    return r.content.map((c) => c.text).join("\n").split("\n");
  };

  it("under the CC limits, with the first line unchanged", async () => {
    const lines = await balanceLines({ allowDomains: ["api.example.com"], fundedCeiling: false, usdcxMaxPerTx: 1, usdcxDailyCap: 5 });
    expect(lines[0]).toMatch(/^100 CC \(1 amulet\) for agent::1220aaa/);
    expect(lines).toContain("limits in USDCx: today 5 of 5 USDCx left, up to 1 USDCx per payment");
  });

  it("says USDCx payments are off when the owner set no USDCx caps", async () => {
    const lines = await balanceLines({ allowDomains: ["api.example.com"], fundedCeiling: false });
    expect(lines).toContain("limits in USDCx: none set, so USDCx payments are off");
  });
});
