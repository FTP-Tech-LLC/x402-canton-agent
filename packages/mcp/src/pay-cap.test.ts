import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type * as AgentWallet from "@ftptech/canton-agent-wallet";

/** Records the options the tool hands to the paying fetch. */
const seen: Array<Record<string, unknown>> = [];

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
    return async () => new Response("ok", { status: 200 });
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
