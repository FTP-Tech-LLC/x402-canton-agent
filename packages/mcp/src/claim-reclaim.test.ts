import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type * as AgentWallet from "@ftptech/canton-agent-wallet";

const WALLET = { party: "agent::1220aaa", relayUrl: "https://relay.test", network: "canton:mainnet" };

/** What the stubbed wallet functions answer for the next claim. */
const state = {
  reclaim: undefined as unknown,
  reclaimError: undefined as Error | undefined,
};

// The real module underneath, with the two ledger-touching claim functions
// replaced: claim finds nothing incoming; reclaim answers `state`.
vi.mock("@ftptech/canton-agent-wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof AgentWallet>()),
  claimAll: async () => ({ claimed: 0, updateIds: [], skippedExpired: 0, failed: [], skippedUntrusted: [] }),
  reclaimExpiredOffers: async () => {
    if (state.reclaimError) throw state.reclaimError;
    return state.reclaim;
  },
}));

const { registerWalletTools } = await import("./tools.js");

async function claimText(): Promise<{ text: string; isError: boolean; ops: Array<{ kind: string; detail: string }> }> {
  const ops: Array<{ kind: string; detail: string }> = [];
  const server = new McpServer({ name: "t", version: "0" });
  registerWalletTools(server, {
    getWallet: async () => WALLET as never,
    relayFor: () => ({ balance: async () => ({ cc: "701.5", amulet: 1 }) }) as never,
    payingFetchFor: async () => fetch,
    policy: { allowDomains: ["*"], fundedCeiling: false } as never,
    ledger: {
      read: async () => ({ spentTodayCC: 0, lifetimeOutCC: 0, lifetimeClaimedCC: 0 }),
      recordOutbound: async () => undefined,
      recordClaimedHighWater: async () => undefined,
      recordOperation: async (op: { kind: string; detail: string }) => {
        ops.push(op);
      },
    } as never,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  const r = (await client.callTool({ name: "claim", arguments: {} })) as { content: Array<{ text: string }>; isError?: boolean };
  return { text: r.content[0]!.text, isError: r.isError === true, ops };
}

beforeEach(() => {
  state.reclaim = { supported: true, reclaimed: [], waiting: [], failed: [], skippedUntrusted: [] };
  state.reclaimError = undefined;
});

describe("claim takes back the wallet's own expired offers", () => {
  it("says what came back and records it in the history", async () => {
    state.reclaim = {
      supported: true,
      reclaimed: [
        { cid: "00d7", amount: "0.1808893116", instrument: "eXAG", updateId: "u1" },
        { cid: "001d", amount: "0.0041874702", instrument: "cETH", updateId: "u2" },
      ],
      waiting: [],
      failed: [],
      skippedUntrusted: [],
    };
    const { text, ops } = await claimText();
    expect(text).toBe(
      "nothing to claim; balance 701.5 CC — took back 2 expired offer(s) the receiver never took: 0.1808893116 eXAG, 0.0041874702 cETH"
    );
    expect(ops).toEqual([
      expect.objectContaining({ kind: "claim", detail: "returned 2 expired offer(s): 0.1808893116 eXAG, 0.0041874702 cETH" }),
    ]);
  });

  it("names an offer still in its window and when claim can take it back", async () => {
    state.reclaim = {
      supported: true,
      reclaimed: [],
      waiting: [{ cid: "00aa", amount: "1", instrument: "eXAG", executeBefore: "2026-10-24T16:40:00Z" }],
      failed: [],
      skippedUntrusted: [],
    };
    const { text } = await claimText();
    expect(text).toContain("1 offer(s) still waiting on the receiver: 1 eXAG (until 2026-10-24T16:40:00Z;");
  });

  it("with nothing sent and nothing incoming, the answer is as before", async () => {
    expect((await claimText()).text).toBe("nothing to claim; balance 701.5 CC");
  });

  it("a verify refusal on a withdraw is an ERROR result, never a footnote to a normal claim", async () => {
    const { PreparedTransferMismatchError } = await import("@ftptech/canton-agent-wallet");
    state.reclaimError = new PreparedTransferMismatchError("withdraw targets \"00ff\", not the offer \"00d7\" — refusing to sign");
    const r = await claimText();
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^claim: taking back an expired offer was REFUSED before signing: the relay returned a transaction/);
    expect(r.text).toContain("Nothing was signed for it. Incoming: nothing to claim; balance 701.5 CC");
  });

  it("a failed reclaim does not fail the claim: it is said and the rest stands", async () => {
    state.reclaimError = new Error("relay GET /outgoing -> 502");
    const { text } = await claimText();
    expect(text).toBe("nothing to claim; balance 701.5 CC — taking back expired offers failed: relay GET /outgoing -> 502");
  });
});
