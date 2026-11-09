import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type * as AgentWallet from "@ftptech/canton-agent-wallet";

/** Records the options the tool hands to the paying fetch. */
const seen: Array<Record<string, unknown>> = [];
/** When set, the paying fetch fails with it, as the signer does at its ceiling. */
const signer: { refuse?: string | undefined } = {};

// The real module underneath, with only the ledger-touching pieces replaced:
// a full-replacement mock breaks every time server.ts gains an import.
vi.mock("@ftptech/canton-agent-wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof AgentWallet>()),
  ensureWallet: async () => ({
    party: "agent::1220aaa",
    relayUrl: "https://relay.test",
    network: "canton:mainnet",
  }),
  RelayClient: class {
    async balance() {
      return { cc: "20" };
    }
  },
  claimAll: async () => ({ accepted: 0 }),
  loadWallet: async () => ({
    party: "agent::1220aaa",
    relayUrl: "https://relay.test",
    network: "canton:mainnet",
  }),
  saveWallet: async () => undefined,
  agentKeyFromPrivatePem: () => "k",
  withdraw: async () => ({ updateId: "u" }),
  makePayingFetchForWallet: async (_w: unknown, opts: Record<string, unknown>) => {
    seen.push(opts);
    return async () => {
      if (signer.refuse) throw new Error(signer.refuse);
      return new Response("ok", { status: 200 });
    };
  },
}));

const { createServer } = await import("./server.js");

/**
 * `pay` cannot pre-check the charge the way `withdraw` does — the amount only
 * exists once the merchant answers 402. So --max-per-tx was enforced on
 * withdraw and silently ignored here, and the daily cap only blocked STARTING a
 * payment once already exhausted: one over-quoting merchant could take the
 * whole wallet in a single call and still be inside policy. The signer already
 * implements the ceiling; it was never handed the number.
 */
describe("the per-tx cap reaches the signer on the pay path", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "x402mcp-cap-"));
    seen.length = 0;
  });

  const pay = async (policy: Record<string, unknown>) => {
    const server = createServer({ home, policy } as never);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    await client
      .callTool({ name: "pay", arguments: { url: "https://api.example.com/x" } })
      .catch(() => undefined);
  };

  it("passes maxPerTx through as the signer's maxPaymentValue", async () => {
    await pay({ allowDomains: ["api.example.com"], maxPerTx: 1.5 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["maxPaymentValue"]).toBe("1.5");
  });

  it("omits the ceiling entirely when no per-tx cap is configured", async () => {
    // The discriminator against over-correcting: an unset cap must stay unset,
    // not become "0" or "Infinity" — the signer fails closed on a non-finite
    // ceiling, so a fabricated one would refuse every honest payment.
    await pay({ allowDomains: ["api.example.com"] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["maxPaymentValue"]).toBeUndefined();
  });
  /** Today's spend, written where the local server's file ledger keeps it. */
  const spentToday = (cc: number) =>
    writeFileSync(
      join(home, "mcp-policy-ledger.json"),
      JSON.stringify({
        date: new Date().toISOString().slice(0, 10),
        spentTodayCC: cc,
        lifetimeOutCC: cc,
        lifetimeClaimedCC: 0,
      })
    );

  it("hands the signer the rest of today's budget when it is below the per-tx cap", async () => {
    // 19.5 of 20 CC spent: the gate lets the call start (the cap is not yet
    // reached), so the only thing that can stop a 5 CC charge from leaving the
    // day at 24.5 is the ceiling the signer sees.
    spentToday(19.5);
    await pay({ allowDomains: ["api.example.com"], maxPerTx: 5, dailyCap: 20 });
    expect(seen[0]!["maxPaymentValue"]).toBe("0.5");
  });

  it("keeps the per-tx cap, verbatim, while it is the smaller number", async () => {
    spentToday(1);
    await pay({ allowDomains: ["api.example.com"], maxPerTx: 5, dailyCap: 20 });
    expect(seen[0]!["maxPaymentValue"]).toBe("5");
  });

  it("makes a daily cap alone a ceiling too", async () => {
    spentToday(1.25);
    await pay({ allowDomains: ["api.example.com"], dailyCap: 3 });
    expect(seen[0]!["maxPaymentValue"]).toBe("1.75");
  });
});

/**
 * Off by default, the client re-pays a merchant that still answers 402, up to
 * 4 more times in one call; the 402 text that would justify it is the
 * merchant's own. --single-payment makes one call one payment, as the hosted
 * server always does.
 */
describe("--single-payment reaches the paying fetch", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "x402mcp-single-"));
    seen.length = 0;
  });

  const payWith = async (extra: Record<string, unknown>) => {
    const server = createServer({ home, policy: { allowDomains: ["api.example.com"], maxPerTx: 1 }, ...extra } as never);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    await client.callTool({ name: "pay", arguments: { url: "https://api.example.com/x" } }).catch(() => undefined);
  };

  it("passes maxPaymentRetries 0 when set", async () => {
    await payWith({ singlePayment: true });
    expect(seen[0]!["maxPaymentRetries"]).toBe(0);
  });

  it("leaves the client's default retries when not set", async () => {
    await payWith({});
    expect(seen[0]).not.toHaveProperty("maxPaymentRetries");
  });
});

describe("a payment refused at the owner's limit says where to raise it", () => {
  let home: string;
  const LIMITS = "https://pay.example/account#limits";
  const REFUSAL = "refusing to sign: payment amount 10 exceeds the max payment value 5 (the merchant over-quoted)";
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "x402mcp-hint-"));
    seen.length = 0;
    signer.refuse = REFUSAL;
  });

  const pay = async (
    policy: Record<string, unknown>,
    args: Record<string, unknown> = {}
  ): Promise<{ text: string; isError: boolean }> => {
    const server = createServer({ home, policy } as never);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    const r = (await client.callTool({ name: "pay", arguments: { url: "https://api.example.com/x", ...args } })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    signer.refuse = undefined;
    return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
  };
  const ledgerWith = (l: { spentTodayCC: number; lifetimeOutCC: number; lifetimeClaimedCC: number }) =>
    writeFileSync(join(home, "mcp-policy-ledger.json"), JSON.stringify({ date: new Date().toISOString().slice(0, 10), ...l }));

  it("names the per-payment limit and the page", async () => {
    const r = await pay({ allowDomains: ["api.example.com"], maxPerTx: 5, dailyCap: 20, limitsUrl: LIMITS });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("exceeds the max payment value 5");
    expect(r.text).toContain(
      "The payment is capped at the per-payment limit of 5 CC; the owner can raise it on https://pay.example/account?maxPerTx=10#limits."
    );
  });

  it("names the daily limit when what is left of today set the ceiling", async () => {
    ledgerWith({ spentTodayCC: 19.5, lifetimeOutCC: 19.5, lifetimeClaimedCC: 0 });
    const r = await pay({ allowDomains: ["api.example.com"], maxPerTx: 5, dailyCap: 20, limitsUrl: LIMITS });
    // 19.5 spent + the refused 10 = 29.5, rounded up.
    expect(r.text).toContain(
      "capped at what is left today of the daily limit of 20 CC; the owner can raise it on https://pay.example/account?dailyCap=30#limits."
    );
  });

  it("says nothing of raising a limit when the funded ceiling set it, or no page is known", async () => {
    ledgerWith({ spentTodayCC: 0, lifetimeOutCC: 1, lifetimeClaimedCC: 3 });
    const funded = await pay({ allowDomains: ["api.example.com"], maxPerTx: 5, fundedCeiling: true, limitsUrl: LIMITS });
    expect(funded.text).toContain("exceeds the max payment value");
    expect(funded.text).not.toContain("raise it");
    signer.refuse = REFUSAL;
    const local = await pay({ allowDomains: ["api.example.com"], maxPerTx: 5 });
    expect(local.text).not.toContain("raise it");
  });
});
