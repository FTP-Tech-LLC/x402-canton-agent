import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readLedger } from "./policy.js";
import type * as AgentWallet from "@ftptech/canton-agent-wallet";

/**
 * Everything that would touch a ledger or a venue is a spy; the routing itself
 * (resolveSwapIntent, parse*, swapFloorNotes, KNOWN_INSTRUMENTS) is the REAL
 * agent-wallet code, so these tests pin the tool's behaviour on top of the
 * shared router rather than a re-description of it.
 */
const calls = {
  balances: [] as string[], // consumed in order by RelayClient.balance
  balanceReads: 0,
  resolveTicket: [] as Array<Record<string, unknown>>,
  execute: [] as Array<Record<string, unknown>>,
  payingFetch: [] as Array<Record<string, unknown>>,
};
let ticket: Record<string, unknown> = {};
let executeResult: Record<string, unknown> = {};
let throwOnBalanceRead: number | undefined;

vi.mock("@ftptech/canton-agent-wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentWallet>();
  const wallet = { party: "agent::1220aaa", relayUrl: "https://relay.test", network: "canton:mainnet" };
  return {
    ...actual,
    ensureWallet: async () => wallet,
    loadWallet: () => wallet,
    saveWallet: () => undefined,
    RelayClient: class {
      async balance() {
        calls.balanceReads += 1;
        if (throwOnBalanceRead === calls.balanceReads) throw new Error("relay 502");
        const next = calls.balances.length > 1 ? calls.balances.shift()! : calls.balances[0]!;
        return { cc: next, amulet: 1 };
      }
    },
    resolveTrustedDsoParty: () => "DSO::1220dso",
    makePayingFetchForWallet: async (_w: unknown, opts: Record<string, unknown>) => {
      calls.payingFetch.push(opts);
      return async () => new Response("{}", { status: 200 });
    },
    resolveSwapTicket: async (opts: Record<string, unknown>) => {
      calls.resolveTicket.push(opts);
      // The real router only builds the paying fetch on the endpoint path.
      if (opts["direct"] !== true && typeof opts["payingFetch"] === "function") {
        await (opts["payingFetch"] as () => Promise<unknown>)();
      }
      return { ticket, notes: [{ level: "warn", text: "routed note" }] };
    },
    executeSwap: async (opts: Record<string, unknown>) => {
      calls.execute.push(opts);
      return executeResult;
    },
  };
});

const { createServer } = await import("./server.js");
const { KNOWN_INSTRUMENTS, CANTEX_CONNECT_PARTY, CANTEX_MEMO_KEY } = await import(
  "@ftptech/canton-agent-wallet"
);

const USDCX = KNOWN_INSTRUMENTS["USDCx"]!;

describe("swap tool", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "x402mcp-swap-"));
    calls.balances = ["20"];
    calls.balanceReads = 0;
    calls.resolveTicket.length = 0;
    calls.execute.length = 0;
    calls.payingFetch.length = 0;
    throwOnBalanceRead = undefined;
    ticket = {
      venue: "cantex",
      poolParty: CANTEX_CONNECT_PARTY,
      minOutput: "0.53",
      memoKey: CANTEX_MEMO_KEY,
      memoValue: "USDCx",
      quote: "0.5412",
      inInstrument: null,
      outInstrument: USDCX,
    };
    executeResult = {
      sentUpdateId: "1220sent",
      claimed: 0,
      claimedUpdateIds: [],
      delivered: "0.54",
      timedOut: false,
      pollErrors: 0,
    };
  });

  const swap = async (
    policy: Record<string, unknown>,
    args: Record<string, unknown>
  ): Promise<{ text: string; isError: boolean }> => {
    const server = createServer({
      relayUrl: "https://relay.test",
      home,
      network: "canton:mainnet",
      policy,
    } as never);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    const r = (await client.callTool({ name: "swap", arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
  };

  const open = { allowDomains: "*", fundedCeiling: false };

  it("is listed with a destructive, funds-OUT annotation", async () => {
    const server = createServer({ relayUrl: "https://relay.test", home, network: "canton:mainnet", policy: open } as never);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "swap");
    expect(t).toBeDefined();
    expect(t!.annotations?.destructiveHint).toBe(true);
    expect(t!.annotations?.readOnlyHint).toBe(false);
    expect(t!.description).toMatch(/MOVES FUNDS OUT/);
    expect(t!.description).toContain("no on-ledger floor");
  });

  it("CC input: runs the shared router with the caller's venue/direct/slippage, executes, and reports what landed", async () => {
    calls.balances = ["20", "19.99", "19.99"]; // before, after ticket (fee 0.01), final
    const r = await swap(open, { in: "cc", out: "usdcx", amount: "60", venue: "tradecraft", slippage: 2, direct: true });
    expect(r.isError).toBe(false);
    expect(calls.resolveTicket).toHaveLength(1);
    expect(calls.resolveTicket[0]).toMatchObject({
      amount: "60",
      slippagePct: 2,
      venue: "tradecraft",
      venueExplicit: true,
      direct: true,
      dsoParty: "DSO::1220dso",
    });
    expect((calls.resolveTicket[0]!["intent"] as { inCanon: string; outCanon: string })).toMatchObject({
      inCanon: "CC",
      outCanon: "USDCx",
    });
    expect(calls.execute).toHaveLength(1);
    expect(calls.execute[0]).toMatchObject({ amount: "60", ticket, waitForOutput: true });
    expect(r.text).toContain("input sent, updateId 1220sent");
    expect(r.text).toContain("received 0.54 USDCx");
    expect(r.text).toContain("! routed note");
    expect(r.text).toContain("! no on-ledger floor on Cantex");
    expect(r.text).toContain("slippage 2%");
    expect(r.text).toContain("ticket fee 0.0100000000 CC");
    expect(r.text).toContain("balance now 19.9900000000 CC");
  });

  it("venue omitted = cantex, NOT explicit (the router may fall back); wait:false is passed through", async () => {
    const r = await swap(open, { in: "CC", out: "USDCx", amount: "60", wait: false });
    expect(calls.resolveTicket[0]).toMatchObject({ venue: "cantex", venueExplicit: false, direct: false });
    expect(calls.execute[0]).toMatchObject({ waitForOutput: false });
    expect(r.text).toContain("not waiting for the return");
  });

  it("books the fee and the CC input in the ledger, separately", async () => {
    calls.balances = ["20", "19.99", "19.99"];
    await swap(open, { in: "CC", out: "USDCx", amount: "60" });
    const led = readLedger(home, Date.now());
    expect(led.spentTodayCC).toBeCloseTo(60.01, 8);
    expect(led.lifetimeOutCC).toBeCloseTo(60.01, 8);
  });

  it("CC input over the per-tx cap is blocked BEFORE any quote or fee", async () => {
    const r = await swap({ ...open, maxPerTx: 1 }, { in: "CC", out: "USDCx", amount: "60" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/blocked by spend policy: swap blocked: 60 CC exceeds the per-tx cap of 1 CC/);
    expect(calls.resolveTicket).toHaveLength(0);
    expect(calls.payingFetch).toHaveLength(0);
    expect(calls.execute).toHaveLength(0);
    expect(calls.balanceReads).toBe(0);
  });

  it("CC input: daily cap and funded ceiling apply, as for withdraw", async () => {
    const daily = await swap({ ...open, dailyCap: 10 }, { in: "CC", out: "USDCx", amount: "60" });
    expect(daily.text).toMatch(/would exceed the daily cap of 10 CC/);
    // funded ceiling ON with nothing ever claimed: 60 out > 0 claimed.
    const funded = await swap({ allowDomains: "*", fundedCeiling: true }, { in: "CC", out: "USDCx", amount: "60" });
    expect(funded.text).toMatch(/would exceed the funded ceiling/);
    expect(calls.execute).toHaveLength(0);
  });

  it("the fee ceiling handed to the signer is min(SWAP_MAX_FEE_CC, per-tx cap)", async () => {
    await swap({ ...open, maxPerTx: 0.2 }, { in: "CC", out: "USDCx", amount: "0.1" });
    expect(calls.payingFetch).toHaveLength(1);
    expect(calls.payingFetch[0]!["maxPaymentValue"]).toBe("0.2");
    calls.payingFetch.length = 0;
    await swap({ ...open, maxPerTx: 3 }, { in: "CC", out: "USDCx", amount: "1" });
    expect(calls.payingFetch[0]!["maxPaymentValue"]).toBe("0.5");
    calls.payingFetch.length = 0;
    await swap(open, { in: "CC", out: "USDCx", amount: "1", direct: true });
    expect(calls.payingFetch).toHaveLength(0); // direct never builds one
  });

  it("token input: the per-tx cap is applied to the venue's quoted CC value, after the quote", async () => {
    ticket = { ...ticket, quote: "5", minOutput: "4.9", memoValue: "Amulet", inInstrument: USDCX, outInstrument: null };
    calls.balances = ["20", "19.99"];
    const r = await swap({ ...open, maxPerTx: 1 }, { in: "USDCx", out: "CC", amount: "5" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/5 CC \(the venue's quoted value\) exceeds the per-tx cap of 1 CC/);
    expect(calls.resolveTicket).toHaveLength(1);
    expect(calls.execute).toHaveLength(0);
    // The fee was paid for the quote and is booked even though the swap was refused.
    expect(readLedger(home, Date.now()).spentTodayCC).toBeCloseTo(0.01, 8);
  });

  it("token -> CC that lands raises the funded high-water like `claim` does, and books no CC out beyond the fee", async () => {
    ticket = { ...ticket, quote: "5", minOutput: "4.9", memoValue: "Amulet", inInstrument: USDCX, outInstrument: null };
    executeResult = { ...executeResult, delivered: "4.95" };
    calls.balances = ["20", "19.99", "24.94"];
    const r = await swap({ allowDomains: "*", fundedCeiling: true, dailyCap: 1 }, { in: "USDCx", out: "CC", amount: "5" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("received 4.95 CC");
    const led = readLedger(home, Date.now());
    expect(led.spentTodayCC).toBeCloseTo(0.01, 8);
    expect(led.lifetimeClaimedCC).toBeCloseTo(24.94 + 0.01, 8);
  });

  it("neither leg CC: refused under any per-tx/daily cap, allowed when none is set", async () => {
    ticket = { ...ticket, quote: "0.0001", inInstrument: USDCX, outInstrument: KNOWN_INSTRUMENTS["CBTC"]! };
    const blocked = await swap({ ...open, dailyCap: 100 }, { in: "USDCx", out: "CBTC", amount: "5" });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/no CC value could be put on this swap/);
    expect(calls.execute).toHaveLength(0);
    const ok = await swap(open, { in: "USDCx", out: "CBTC", amount: "5" });
    expect(ok.isError).toBe(false);
    expect(calls.execute).toHaveLength(1);
  });

  it("an unknown symbol fails closed with nothing quoted, executed, or paid", async () => {
    const r = await swap(open, { in: "USDC", out: "CC", amount: "5" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/in "USDC" is not a known instrument/);
    expect(calls.resolveTicket).toHaveLength(0);
    expect(calls.execute).toHaveLength(0);
  });

  it("output not received in the window is said plainly, with the no-retry instruction", async () => {
    executeResult = { sentUpdateId: "1220sent", claimed: 1, claimedUpdateIds: ["1220ret"], timedOut: true, pollErrors: 2, partialRise: "0.1" };
    calls.balances = ["100", "99.99", "39.99"]; // the input is still out
    const r = await swap(open, { in: "CC", out: "USDCx", amount: "60" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("USDCx NOT received yet");
    expect(r.text).toContain("Do NOT swap again before checking");
    expect(r.text).toContain("balance rose 0.1, below the ticket minimum 0.53");
    expect(r.text).toContain("Claimed 1 incoming transfer(s): 1220ret");
    expect(r.text).toContain("2 poll error(s)");
  });

  it("a CC input that comes BACK (unfilled trade) is reported as returned and re-raises the funded high-water", async () => {
    executeResult = { sentUpdateId: "1220sent", claimed: 0, claimedUpdateIds: [], timedOut: true, pollErrors: 0 };
    calls.balances = ["20", "19.99", "19.99"]; // before, after ticket, after swap: the 60 CC is back
    const r = await swap({ allowDomains: "*", fundedCeiling: true }, { in: "CC", out: "USDCx", amount: "60" });
    expect(r.isError).toBe(true); // funded ceiling: nothing claimed yet
    expect(r.text).toMatch(/would exceed the funded ceiling/);
    calls.balances = ["100", "99.99", "99.99"];
    calls.resolveTicket.length = 0;
    const r2 = await swap({ ...open, dailyCap: 100 }, { in: "CC", out: "USDCx", amount: "60" });
    expect(r2.isError).toBe(false);
    expect(r2.text).toContain("the input was RETURNED — nothing was swapped: the CC balance is back at 99.9900000000 CC");
    expect(r2.text).not.toContain("NOT received yet");
    const led = readLedger(home, Date.now());
    expect(led.spentTodayCC).toBeCloseTo(60.01, 8); // it did leave; the daily counter keeps it
    expect(led.lifetimeClaimedCC).toBeCloseTo(99.99 + 60.01, 8); // and the return is funding for the ceiling
  });

  it("a CC input that did NOT come back is not called returned", async () => {
    executeResult = { sentUpdateId: "1220sent", claimed: 0, claimedUpdateIds: [], timedOut: true, pollErrors: 0 };
    calls.balances = ["100", "99.99", "39.99"];
    const r = await swap(open, { in: "CC", out: "USDCx", amount: "60" });
    expect(r.text).toContain("USDCx NOT received yet");
    expect(r.text).not.toContain("RETURNED");
    expect(readLedger(home, Date.now()).lifetimeClaimedCC).toBe(0);
  });

  it("an error AFTER the input was sent carries the updateId and a do-not-retry warning", async () => {
    throwOnBalanceRead = 3; // before, after-ticket, then the post-send read fails
    const r = await swap(open, { in: "CC", out: "USDCx", amount: "60" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^WARNING: the swap input WAS sent \(updateId 1220sent\)/);
    expect(r.text).toContain("swap failed: relay 502");
    // The input still counts as spent: it left.
    expect(readLedger(home, Date.now()).spentTodayCC).toBeCloseTo(60, 8);
  });

  it("an error BEFORE the send that still moved CC (the fee) warns with the delta", async () => {
    calls.balances = ["20", "19.99", "19.99"];
    ticket = { ...ticket, quote: "not-a-number", inInstrument: USDCX, outInstrument: null };
    const r = await swap({ ...open, maxPerTx: 1 }, { in: "USDCx", out: "CC", amount: "5" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^WARNING: the wallet's CC balance fell by 0\.0100000000 CC/);
  });
});
