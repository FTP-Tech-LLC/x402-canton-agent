import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/** Records the options the tool hands to the paying fetch. */
const seen: Array<Record<string, unknown>> = [];

vi.mock("@ftptech/canton-agent-wallet", () => ({
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
  questFund: async () => ({ ok: true }),
  makePayingFetch: async (opts: Record<string, unknown>) => {
    seen.push(opts);
    return async () => new Response("ok", { status: 200 });
  },
  makePayingFetchForWallet: async () => async () => new Response("ok", { status: 200 }),
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
});
