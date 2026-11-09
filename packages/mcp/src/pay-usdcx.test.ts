import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { KNOWN_INSTRUMENTS } from "@ftptech/canton-agent-wallet";
import { registerWalletTools, type PayingFetchOpts, type WalletToolDeps } from "./tools.js";
import type { OperationRecord, PolicyLedger } from "./policy.js";
import type { SpendPolicy } from "./config.js";

const U = KNOWN_INSTRUMENTS.USDCx!;
const KEY = `${U.admin}|USDCx`;
const URL_ = "https://api.example.com/x";

/** One wallet, one fake relay, one in-memory ledger, and a paying fetch the
 *  test scripts: what it signs, what it moves, and how it ends. */
function harness(opts: {
  policy?: Partial<SpendPolicy>;
  usdcx?: boolean;
  spentTodayUSDCx?: number;
  /** What the "merchant" does once the paying fetch runs. */
  pay?: (o: PayingFetchOpts, wallet: { cc: number; usdcx: number }) => Promise<Response>;
  /** Make the USDCx balance unreadable: on the first read, the second, or as a bounded (incomplete) answer. */
  usdcxRead?: "ok" | "fail-after" | "fail-before" | "incomplete";
  ledgerWithoutUsdcx?: boolean;
  /** Plan C's dep: with it, pay also takes max_cc and max_response_chars. */
  newTools?: boolean;
}) {
  const wallet = { cc: 10, usdcx: 3 };
  let usdcxReads = 0;
  const seen: PayingFetchOpts[] = [];
  const ops: OperationRecord[] = [];
  const led: PolicyLedger = {
    date: "2026-10-06",
    spentTodayCC: 0,
    lifetimeOutCC: 0,
    lifetimeClaimedCC: 0,
    spentTodayUSDCx: opts.spentTodayUSDCx ?? 0,
  };
  const deps: WalletToolDeps = {
    getWallet: async () => ({ party: "agent::1220aaa", relayUrl: "https://relay.test", network: "canton:mainnet" }) as never,
    relayFor: () =>
      ({
        balance: async () => ({ cc: String(wallet.cc), amulet: 1 }),
        pending: async () => ({ party: "agent::1220aaa", pending: [] }),
        holdings: async () => {
          usdcxReads += 1;
          const mode = opts.usdcxRead ?? "ok";
          if (mode === "fail-before" && usdcxReads === 1) throw new Error("relay down");
          if (mode === "fail-after" && usdcxReads === 2) throw new Error("relay down");
          return {
            party: "agent::1220aaa",
            complete: mode !== "incomplete",
            instruments: [{ admin: U.admin, id: "USDCx", total: wallet.usdcx.toFixed(10), holdings: [] }],
          };
        },
      }) as never,
    payingFetchFor: async (_w, o) => {
      seen.push(o);
      return async () => (opts.pay ? opts.pay(o, wallet) : new Response("ok", { status: 200 }));
    },
    policy: { allowDomains: "*", fundedCeiling: false, maxPerTx: 5, dailyCap: 20, usdcxMaxPerTx: 1, usdcxDailyCap: 5, ...opts.policy },
    ledger: {
      read: async () => ({ ...led }),
      recordOutbound: async (cc) => {
        led.spentTodayCC += cc;
      },
      recordClaimedHighWater: async () => undefined,
      recordOperation: async (op) => {
        ops.push(op);
      },
      ...(opts.ledgerWithoutUsdcx
        ? {}
        : {
            recordOutboundUSDCx: async (n: number) => {
              led.spentTodayUSDCx = (led.spentTodayUSDCx ?? 0) + n;
            },
          }),
    },
    usdcx: opts.usdcx ?? true,
    ...(opts.newTools ? { newTools: { maxResponseChars: 4000 } } : {}),
  };
  const connect = async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerWalletTools(server, deps);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    return client;
  };
  const call = async (args: Record<string, unknown>) => {
    const r = (await (await connect()).callTool({ name: "pay", arguments: { url: URL_, ...args } })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    return { ...r, said: r.content.map((c) => c.text).join("\n") };
  };
  const listPayParams = async () => {
    const { tools } = await (await connect()).listTools();
    return Object.keys((tools.find((t) => t.name === "pay")!.inputSchema.properties ?? {}) as object);
  };
  return { call, listPayParams, seen, ops, led, wallet };
}

describe("pay asset: which options reach the paying fetch", () => {
  it("asset omitted, newTools: CC as the default entry, no consent, no token cap", async () => {
    const h = harness({ newTools: true });
    await h.call({});
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]).toEqual({ maxPaymentValue: "5", defaultAsset: "CC", onSigned: expect.any(Function) });
  });

  it("asset omitted, no newTools: exactly 2.3.0's options (no preferred or default entry)", async () => {
    const h = harness({});
    await h.call({});
    expect(h.seen[0]).toEqual({ maxPaymentValue: "5", onSigned: expect.any(Function) });
  });

  it('asset "CC": only the preferred entry is added', async () => {
    const h = harness({});
    await h.call({ asset: "CC" });
    expect(h.seen[0]).toEqual({ maxPaymentValue: "5", preferAsset: "CC", onSigned: expect.any(Function) });
  });

  it('asset "USDCx": consent to USDCx, its ceiling, one signature', async () => {
    const h = harness({ spentTodayUSDCx: 4.25 });
    await h.call({ asset: "USDCx" });
    const o = h.seen[0]!;
    expect(o.preferAsset).toBe("USDCx");
    expect(o.payableInstruments).toEqual([KEY]);
    expect(o.maxPaymentValueByInstrument).toEqual({ [KEY]: "0.75" });
    expect(o.maxPaymentRetries).toBe(0);
  });

  it("a two-decimal USDCx cap reaches the signer exactly, so a merchant charging it is paid", async () => {
    for (const cap of [0.57, 0.41, 1.13]) {
      const h = harness({ policy: { usdcxMaxPerTx: cap } });
      await h.call({ asset: "USDCx" });
      expect(h.seen[0]!.maxPaymentValueByInstrument).toEqual({ [KEY]: String(cap) });
    }
    const left = harness({ spentTodayUSDCx: 4.43 }); // 5 - 4.43 left today
    await left.call({ asset: "USDCx" });
    expect(left.seen[0]!.maxPaymentValueByInstrument).toEqual({ [KEY]: "0.57" });
  });

  it("the parameter exists only when the server offers it", async () => {
    expect(await harness({ usdcx: true }).listPayParams()).toContain("asset");
    expect(await harness({ usdcx: false }).listPayParams()).not.toContain("asset");
  });
});

describe("pay asset USDCx: refusals before anything is signed", () => {
  it("both USDCx caps must be set", async () => {
    const h = harness({ policy: { usdcxDailyCap: undefined } });
    const r = await h.call({ asset: "USDCx" });
    expect(r.isError).toBe(true);
    expect(r.said).toMatch(/not set both USDCx caps/);
    expect(h.seen).toHaveLength(0);
  });

  it("a used-up USDCx day refuses; the CC day does not matter", async () => {
    const h = harness({ spentTodayUSDCx: 5 });
    const r = await h.call({ asset: "USDCx" });
    expect(r.said).toMatch(/daily USDCx cap 5 already reached/);
    expect(h.seen).toHaveLength(0);
    const cc = harness({ policy: { dailyCap: 2 } });
    cc.led.spentTodayCC = 2;
    const ok = await cc.call({ asset: "USDCx" });
    expect(ok.said).not.toMatch(/blocked/);
    expect(cc.seen).toHaveLength(1);
  });

  it("a USDCx day counter that is not a number refuses: the day counts as used up", async () => {
    const h = harness({ spentTodayUSDCx: NaN });
    const r = await h.call({ asset: "USDCx" });
    expect(r.isError).toBe(true);
    expect(r.said).toMatch(/daily USDCx cap counts as reached/);
    expect(h.seen).toHaveLength(0);
  });

  it("the payee checks still apply", async () => {
    const h = harness({ policy: { allowDomains: ["other.example.com"] } });
    const r = await h.call({ asset: "USDCx" });
    expect(r.said).toMatch(/not in the allowed payer domains/);
    expect(h.seen).toHaveLength(0);
  });

  it("a ledger that cannot count USDCx refuses USDCx", async () => {
    const h = harness({ ledgerWithoutUsdcx: true });
    const r = await h.call({ asset: "USDCx" });
    expect(r.said).toMatch(/cannot count USDCx spending/);
    expect(h.seen).toHaveLength(0);
  });

  it("max_cc caps Canton Coin only: together with asset USDCx it is refused", async () => {
    const h = harness({ newTools: true });
    const r = await h.call({ asset: "USDCx", max_cc: 1 });
    expect(r.isError).toBe(true);
    expect(r.said).toMatch(/max_cc caps Canton Coin/);
    expect(h.seen).toHaveLength(0);
  });
});

/** A merchant paid in USDCx: the signer signs `amount`, the balance drops by
 *  `settled` (0 = not settled yet). */
const usdcxMerchant =
  (amount: number, settled = amount) =>
  async (o: PayingFetchOpts, wallet: { usdcx: number }) => {
    o.onSigned?.({ instrument: KEY, amount: amount.toFixed(10) });
    wallet.usdcx -= settled;
    return new Response("paid content", { status: 200 });
  };

describe("pay asset USDCx: what is counted", () => {
  it("hands the signer a hook that reports what it signs", async () => {
    const h = harness({});
    await h.call({ asset: "USDCx" });
    expect(typeof h.seen[0]!.onSigned).toBe("function");
  });

  it("settled: the holdings delta, which equals what was signed", async () => {
    const h = harness({ pay: usdcxMerchant(0.05) });
    const r = await h.call({ asset: "USDCx" });
    expect(r.isError).toBeFalsy();
    expect(r.said).toMatch(/^HTTP 200; spent 0\.0500000000 USDCx; balance 2\.9500000000 USDCx/);
    expect(r.said).toContain("\n--- response body ---\npaid content");
    expect(h.led.spentTodayUSDCx).toBeCloseTo(0.05, 10);
    expect(h.led.spentTodayCC).toBe(0);
    expect(h.ops).toEqual([
      expect.objectContaining({ kind: "pay", asset: "USDCx", amount: 0.05, detail: "api.example.com (HTTP 200)", ok: true }),
    ]);
    expect(h.ops[0]!.amountCC).toBeUndefined();
  });

  it("CC that also fell during a USDCx call is said in the head", async () => {
    const h = harness({
      pay: async (o, wallet) => {
        wallet.cc -= 0.001;
        return usdcxMerchant(0.05)(o, wallet);
      },
    });
    const r = await h.call({ asset: "USDCx" });
    expect(r.said).toMatch(/^HTTP 200; spent 0\.0500000000 USDCx; balance 2\.9500000000 USDCx; also 0\.0010000000 CC\n/);
    const unread = harness({
      usdcxRead: "fail-after",
      pay: async (o, wallet) => {
        wallet.cc -= 0.001;
        return usdcxMerchant(0.05)(o, wallet);
      },
    });
    expect((await unread.call({ asset: "USDCx" })).said).toMatch(/; balance unknown; also 0\.0010000000 CC\n/);
    const none = harness({ pay: usdcxMerchant(0.05) });
    expect((await none.call({ asset: "USDCx" })).said).not.toMatch(/also/);
  });

  it("signed but not settled yet: the signed amount", async () => {
    const h = harness({ pay: usdcxMerchant(0.05, 0) });
    await h.call({ asset: "USDCx" });
    expect(h.led.spentTodayUSDCx).toBeCloseTo(0.05, 10);
  });

  it("balance unreadable after paying: the full ceiling, said to be counted, not spent", async () => {
    const h = harness({ spentTodayUSDCx: 1, pay: usdcxMerchant(0.05), usdcxRead: "fail-after" });
    const r = await h.call({ asset: "USDCx" });
    expect(h.led.spentTodayUSDCx).toBeCloseTo(2, 10); // 1 before + the 1 USDCx ceiling
    expect(r.said).toMatch(/^HTTP 200; counted 1\.0000000000 USDCx, not necessarily spent \(/);
    expect(r.said).toMatch(/; signed 0\.0500000000 USDCx; balance unknown/);
  });

  it("balance unreadable before paying: the full ceiling", async () => {
    const h = harness({ pay: usdcxMerchant(0.05), usdcxRead: "fail-before" });
    await h.call({ asset: "USDCx" });
    expect(h.led.spentTodayUSDCx).toBeCloseTo(1, 10);
  });

  it("balance unreadable before paying, then a 0.05 payment: the text says what was signed, not that 1 was spent", async () => {
    const h = harness({ pay: usdcxMerchant(0.05), usdcxRead: "fail-before" });
    const r = await h.call({ asset: "USDCx" });
    expect(r.isError).toBeFalsy();
    expect(r.said).not.toMatch(/spent 1\.0000000000 USDCx/);
    expect(r.said).toMatch(
      /^HTTP 200; counted 1\.0000000000 USDCx, not necessarily spent \(the USDCx balance could not be read, so the full ceiling was counted against today's USDCx cap\); signed 0\.0500000000 USDCx; balance 2\.9500000000 USDCx/
    );
  });

  it("an unreadable balance and a call that signed nothing: nothing counted, no history row", async () => {
    for (const usdcxRead of ["fail-before", "fail-after", "incomplete"] as const) {
      const h = harness({
        usdcxRead,
        pay: async () => {
          throw new Error("refusing to sign: payment amount 2 exceeds the max payment value 1");
        },
      });
      const r = await h.call({ asset: "USDCx" });
      expect(r.isError).toBe(true);
      expect(r.said).not.toMatch(/MOVED|counted/);
      expect(h.led.spentTodayUSDCx).toBe(0);
      expect(h.ops).toEqual([]);
    }
  });

  it("five unsigned calls with an unreadable balance leave the USDCx day open for the sixth", async () => {
    const h = harness({
      usdcxRead: "incomplete",
      pay: async () => {
        throw new Error("402 does not offer USDCx");
      },
    });
    for (let i = 0; i < 5; i++) await h.call({ asset: "USDCx" });
    expect(h.led.spentTodayUSDCx).toBe(0);
    const sixth = await h.call({ asset: "USDCx" });
    expect(sixth.said).not.toMatch(/already reached/);
    expect(h.seen).toHaveLength(6);
    expect(h.ops).toEqual([]);
  });

  it("an incomplete (bounded) read: the full ceiling", async () => {
    const h = harness({ pay: usdcxMerchant(0.05), usdcxRead: "incomplete" });
    await h.call({ asset: "USDCx" });
    expect(h.led.spentTodayUSDCx).toBeCloseTo(1, 10);
  });

  it("money moved and then the call failed: counted, recorded, and the agent is told not to retry", async () => {
    const h = harness({
      pay: async (o, wallet) => {
        o.onSigned?.({ instrument: KEY, amount: "0.0500000000" });
        wallet.usdcx -= 0.05;
        throw new Error("payment required after settling");
      },
    });
    const r = await h.call({ asset: "USDCx" });
    expect(r.isError).toBe(true);
    expect(r.said).toMatch(/USDCx balance fell by 0\.0500000000 USDCx/);
    expect(r.said).toMatch(/Do NOT call pay again/);
    expect(h.led.spentTodayUSDCx).toBeCloseTo(0.05, 10);
    expect(h.ops).toEqual([
      expect.objectContaining({ kind: "pay", asset: "USDCx", amount: 0.05, detail: "api.example.com (failed after paying)", ok: false }),
    ]);
  });

  it("signed, not in the balance yet, and then the call failed: the agent is told not to retry", async () => {
    const h = harness({
      pay: async (o) => {
        o.onSigned?.({ instrument: KEY, amount: "0.0500000000" });
        throw new Error("facilitator timed out");
      },
    });
    const r = await h.call({ asset: "USDCx" });
    expect(r.isError).toBe(true);
    expect(r.said).toMatch(/0\.0500000000 USDCx was signed during this call/);
    expect(r.said).toMatch(/funds MOVED\. Do NOT call pay again/);
    expect(h.led.spentTodayUSDCx).toBeCloseTo(0.05, 10);
  });

  it("signed, and the USDCx balance could not be read afterwards: the agent is told not to retry", async () => {
    const h = harness({
      usdcxRead: "fail-after",
      pay: async (o, wallet) => {
        o.onSigned?.({ instrument: KEY, amount: "0.0500000000" });
        wallet.usdcx -= 0.05;
        throw new Error("payment required after settling");
      },
    });
    const r = await h.call({ asset: "USDCx" });
    expect(r.isError).toBe(true);
    expect(r.said).toMatch(/0\.0500000000 USDCx was signed during this call and the USDCx balance could not be read/);
    expect(r.said).toMatch(/funds MOVED\. Do NOT call pay again/);
    expect(r.said).toMatch(/1\.0000000000 USDCx \(the full ceiling\) was counted against today's USDCx cap, not necessarily spent/);
    expect(h.led.spentTodayUSDCx).toBeCloseTo(1, 10); // unknown balance: the whole ceiling
    expect(h.ops).toEqual([
      expect.objectContaining({ kind: "pay", asset: "USDCx", amount: 1, detail: "api.example.com (failed after paying)", ok: false }),
    ]);
  });

  it("a failure that moved nothing carries no warning", async () => {
    const h = harness({
      pay: async () => {
        throw new Error("refusing to sign: payment amount 2 exceeds the max payment value 1");
      },
    });
    const r = await h.call({ asset: "USDCx" });
    expect(r.isError).toBe(true);
    expect(r.said).not.toMatch(/MOVED/);
    expect(h.led.spentTodayUSDCx).toBe(0);
    expect(h.ops).toEqual([]);
  });

  it("a CC payment never touches the USDCx counter", async () => {
    const h = harness({
      pay: async (_o, wallet) => {
        wallet.cc -= 0.5;
        return new Response("ok", { status: 200 });
      },
    });
    const r = await h.call({});
    expect(r.said).toMatch(/^HTTP 200; spent 0\.5000000000 CC; balance 9\.5000000000 CC/);
    expect(h.led.spentTodayCC).toBeCloseTo(0.5, 10);
    expect(h.led.spentTodayUSDCx).toBe(0);
  });
});

/** A CC merchant: the signer signs `amount` (refusing above its ceiling, as
 *  the real one does), the balance drops by `settled` (0 = settles later). */
const ccMerchant =
  (amount: number, settled = amount, status = 200) =>
  async (o: PayingFetchOpts, wallet: { cc: number }) => {
    if (o.maxPaymentValue !== undefined && amount > Number(o.maxPaymentValue)) {
      throw new Error(`refusing to sign: payment amount ${amount} exceeds the max payment value ${o.maxPaymentValue}`);
    }
    o.onSigned?.({ instrument: `${CC_ADMIN}|Amulet`, amount: amount.toFixed(10) });
    wallet.cc -= settled;
    if (status === 402) throw new Error("payment retry still returned 402 after 1 attempt(s): facilitator rejected the payment");
    return new Response("paid content", { status });
  };
const CC_ADMIN = "DSO::1220dso";

describe("pay in CC: what is counted", () => {
  it("settled during the call: counted once, as the balance shows it", async () => {
    const h = harness({ pay: ccMerchant(5) });
    const r = await h.call({});
    expect(r.said).toMatch(/^HTTP 200; spent 5\.0000000000 CC; balance 5\.0000000000 CC\n/);
    expect(h.led.spentTodayCC).toBeCloseTo(5, 10);
    expect(h.ops).toEqual([expect.objectContaining({ kind: "pay", amountCC: 5, ok: true })]);
  });

  it("a merchant that settles after answering: the signed amount, and funds may still move", async () => {
    const h = harness({ pay: ccMerchant(5, 0) });
    const r = await h.call({});
    expect(r.isError).toBeFalsy();
    expect(r.said).not.toMatch(/spent 0\.0000000000 CC/);
    expect(r.said).toMatch(
      /^HTTP 200; counted 5\.0000000000 CC; signed 5\.0000000000 CC that the balance does not show yet: .*funds may still move\. Do NOT call pay again/
    );
    expect(h.led.spentTodayCC).toBeCloseTo(5, 10);
    expect(h.ops).toEqual([expect.objectContaining({ kind: "pay", amountCC: 5, ok: true })]);
  });

  it("late settles count toward the daily cap, and the pay that would pass it is refused", async () => {
    const h = harness({ policy: { dailyCap: 12 }, pay: ccMerchant(5, 0) });
    expect((await h.call({})).isError).toBeFalsy();
    expect((await h.call({})).isError).toBeFalsy();
    expect(h.led.spentTodayCC).toBeCloseTo(10, 10);
    // 2 CC of the day left: the signer gets that ceiling and refuses 5.
    const third = await h.call({});
    expect(third.isError).toBe(true);
    expect(h.seen[2]!.maxPaymentValue).toBe("2");
    expect(third.said).toMatch(/refusing to sign/);
    expect(third.said).not.toMatch(/MOVED|may still move/);
    expect(h.led.spentTodayCC).toBeCloseTo(10, 10);
    h.led.spentTodayCC = 12;
    const fourth = await h.call({});
    expect(fourth.said).toMatch(/blocked by spend policy/);
    expect(h.seen).toHaveLength(3);
  });

  it("signed, then a 402 'rejected': counted, and the agent is told funds may still move", async () => {
    const h = harness({ pay: ccMerchant(5, 0, 402) });
    const r = await h.call({});
    expect(r.isError).toBe(true);
    expect(r.said).toMatch(/5\.0000000000 CC was signed during this call and the balance does not show it yet/);
    expect(r.said).toMatch(/funds may still move\. Do NOT call pay again/);
    expect(r.said).not.toMatch(/balance fell/);
    expect(h.led.spentTodayCC).toBeCloseTo(5, 10);
    expect(h.ops).toEqual([expect.objectContaining({ kind: "pay", amountCC: 5, ok: false })]);
  });

  it("a USDCx signature in a CC call is not counted as CC", async () => {
    const h = harness({
      pay: async (o) => {
        o.onSigned?.({ instrument: KEY, amount: "0.0500000000" });
        return new Response("ok", { status: 200 });
      },
    });
    const r = await h.call({});
    expect(r.said).toMatch(/^HTTP 200; spent 0\.0000000000 CC/);
    expect(h.led.spentTodayCC).toBe(0);
  });
});
