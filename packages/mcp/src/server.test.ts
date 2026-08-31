import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveConfig } from "./config.js";
import {
  PolicyError,
  readLedger,
  assertPayAllowed,
  assertWithdrawAllowed,
  recordOutbound,
  recordClaimedHighWater,
  type PolicyLedger,
} from "./policy.js";
import { createServer, buildFundingText, runAutoFund } from "./server.js";

const T0 = Date.parse("2026-06-15T12:00:00Z");
const tmpHome = () => mkdtempSync(join(tmpdir(), "x402mcp-"));

describe("resolveConfig", () => {
  it("requires a relay URL (no default)", () => {
    expect(() => resolveConfig([], {})).toThrow(/relay URL is required/);
  });

  it("reads relay/home/policy from flags; funded-ceiling defaults ON", () => {
    const c = resolveConfig(
      ["--relay-url", "https://r.test", "--home", "/h", "--max-per-tx", "1.5", "--daily-cap", "10", "--allow-domains", "Api.Example.com, b.test"],
      {}
    );
    expect(c.relayUrl).toBe("https://r.test");
    expect(c.home).toBe("/h");
    expect(c.policy.maxPerTx).toBe(1.5);
    expect(c.policy.dailyCap).toBe(10);
    expect(c.policy.allowDomains).toEqual(["api.example.com", "b.test"]);
    expect(c.policy.fundedCeiling).toBe(true);
  });

  it("env fills in when flags absent; '*' domains; --no-funded-ceiling disables", () => {
    const c = resolveConfig(["--relay-url", "https://r.test", "--no-funded-ceiling"], {
      CANTON_MCP_ALLOW_DOMAINS: "*",
      CANTON_MCP_DAILY_CAP: "5",
    });
    expect(c.policy.allowDomains).toBe("*");
    expect(c.policy.dailyCap).toBe(5);
    expect(c.policy.fundedCeiling).toBe(false);
  });
});

describe("policy — pay gate", () => {
  const led = (o: Partial<PolicyLedger> = {}): PolicyLedger => ({
    date: "2026-06-15", spentTodayCC: 0, lifetimeOutCC: 0, lifetimeClaimedCC: 100, ...o,
  });

  it("deny-all when no domains configured (fail-closed)", () => {
    expect(() => assertPayAllowed({ allowDomains: [], fundedCeiling: false }, led(), "https://x.test/a")).toThrow(PolicyError);
  });
  it("allows an exact domain and its subdomains, rejects others", () => {
    const p = { allowDomains: ["example.com"], fundedCeiling: false } as const;
    expect(() => assertPayAllowed(p, led(), "https://example.com/x")).not.toThrow();
    expect(() => assertPayAllowed(p, led(), "https://api.example.com/x")).not.toThrow();
    expect(() => assertPayAllowed(p, led(), "https://evil.test/x")).toThrow(/not in the allowed/);
  });
  it("'*' allows any host", () => {
    expect(() => assertPayAllowed({ allowDomains: "*", fundedCeiling: false }, led(), "https://anything.test/x")).not.toThrow();
  });
  it("blocks when daily cap already reached or funded ceiling exhausted", () => {
    expect(() => assertPayAllowed({ allowDomains: "*", dailyCap: 2, fundedCeiling: false }, led({ spentTodayCC: 2 }), "https://a.test")).toThrow(/daily cap/);
    expect(() => assertPayAllowed({ allowDomains: "*", fundedCeiling: true }, led({ lifetimeOutCC: 100, lifetimeClaimedCC: 100 }), "https://a.test")).toThrow(/funded ceiling/);
  });
});

describe("policy — withdraw gate (amount known up front)", () => {
  const led = (o: Partial<PolicyLedger> = {}): PolicyLedger => ({
    date: "2026-06-15", spentTodayCC: 0, lifetimeOutCC: 0, lifetimeClaimedCC: 100, ...o,
  });
  it("rejects over per-tx, over daily, and over funded ceiling; never clamps", () => {
    expect(() => assertWithdrawAllowed({ allowDomains: "*", maxPerTx: 1, fundedCeiling: false }, led(), 2)).toThrow(/per-tx cap/);
    expect(() => assertWithdrawAllowed({ allowDomains: "*", dailyCap: 5, fundedCeiling: false }, led({ spentTodayCC: 4 }), 2)).toThrow(/daily cap/);
    expect(() => assertWithdrawAllowed({ allowDomains: "*", fundedCeiling: true }, led({ lifetimeOutCC: 99, lifetimeClaimedCC: 100 }), 2)).toThrow(/funded ceiling/);
  });
  it("allows an in-bounds amount", () => {
    expect(() => assertWithdrawAllowed({ allowDomains: "*", maxPerTx: 5, dailyCap: 10, fundedCeiling: true }, led(), 3)).not.toThrow();
  });
});

describe("policy — ledger persistence + daily roll", () => {
  it("defaults, records outbound, raises claimed high-water, rolls the day", () => {
    const home = tmpHome();
    expect(readLedger(home, T0)).toMatchObject({ spentTodayCC: 0, lifetimeOutCC: 0, lifetimeClaimedCC: 0 });
    recordClaimedHighWater(home, 50, T0);
    recordOutbound(home, 3, T0);
    const l = readLedger(home, T0);
    expect(l).toMatchObject({ spentTodayCC: 3, lifetimeOutCC: 3, lifetimeClaimedCC: 50 });
    expect(JSON.parse(readFileSync(join(home, "mcp-policy-ledger.json"), "utf8")).lifetimeOutCC).toBe(3);
    // high-water is monotonic (a lower claim does not lower it)
    recordClaimedHighWater(home, 10, T0);
    expect(readLedger(home, T0).lifetimeClaimedCC).toBe(50);
    // next UTC day resets the rolling daily counter, keeps lifetime totals
    const next = readLedger(home, T0 + 24 * 3600_000);
    expect(next.spentTodayCC).toBe(0);
    expect(next.lifetimeOutCC).toBe(3);
  });
});

describe("funding text + server construction", () => {
  it("funding text includes the party and never leaks key material", () => {
    const t = buildFundingText("agent::1220abc", "0.5");
    expect(t).toContain("agent::1220abc");
    expect(t).toContain("0.5");
    expect(t).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(t.toLowerCase()).not.toContain("privatekey");
  });

  it("createServer builds an McpServer without touching the wallet/relay", () => {
    const home = tmpHome();
    const server = createServer({
      relayUrl: "https://facilitator.test",
      home,
      network: "canton:mainnet",
      policy: { allowDomains: "*", fundedCeiling: true },
    });
    expect(server).toBeInstanceOf(McpServer);
    expect(process.env.CANTON_AGENT_HOME).toBe(home);
  });
});

describe("runAutoFund (auto_fund tool flow — quest-funded)", () => {
  const wallet = { party: "agent::1220a", relayUrl: "https://facilitator.example" } as never;
  const PAY_PROXY = "https://pay.example";

  it("bootstraps a funded self-custody wallet via the quest and imports the key", async () => {
    const home = tmpHome();
    const relay = {
      balance: vi.fn().mockResolvedValue({ cc: "0" }),
      pending: vi.fn().mockResolvedValue({ pending: [] }), // empty → proceed to fund
    };
    const questFundImpl = vi.fn().mockResolvedValue({
      secret: "-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----",
      party: "agent::1220minted",
      network: "canton:mainnet",
      balanceCc: "0.05",
      updateId: "u-transa",
      image: "https://img.example/a.png",
    });
    const importWallet = vi.fn().mockResolvedValue({ party: "agent::1220minted" });
    const out = await runAutoFund({
      wallet,
      relay: relay as never,
      home,
      payProxyUrl: PAY_PROXY,
      questFundImpl,
      importWallet,
    });
    expect(questFundImpl).toHaveBeenCalledWith({ payProxyUrl: PAY_PROXY });
    // The returned key was imported (self-custody).
    expect(importWallet).toHaveBeenCalledWith(
      expect.stringContaining("PRIVATE KEY"),
      "https://facilitator.example",
      "canton:mainnet"
    );
    expect(out).toContain("agent::1220minted");
    expect(out).toContain("0.05 CC");
    expect(out).toContain("img.example"); // the demo image was surfaced
    // Funded ceiling raised to the new balance.
    expect(readLedger(home, T0).lifetimeClaimedCC).toBeGreaterThanOrEqual(0.05);
  });

  it("FAIL-LOUD: an import that keeps a DIFFERENT party reports failure, never a lying success", async () => {
    // Regression for the live canary: the load-first default import returned the
    // empty BOOT wallet, the funded key was dropped, and the tool still claimed
    // success with the funded party.
    const home = tmpHome();
    const relay = { balance: vi.fn().mockResolvedValue({ cc: "0" }),
      pending: vi.fn().mockResolvedValue({ pending: [] }), };
    const questFundImpl = vi.fn().mockResolvedValue({
      secret: "-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----",
      party: "agent::1220minted",
      network: "canton:mainnet",
      balanceCc: "0.05",
      updateId: "u-transa",
      image: "https://img.example/a.png",
    });
    // The broken behavior: import "succeeds" but the surviving wallet is the boot one.
    const importWallet = vi.fn().mockResolvedValue({ party: "agent::1220BOOT" });
    const out = await runAutoFund({
      wallet,
      relay: relay as never,
      home,
      payProxyUrl: PAY_PROXY,
      questFundImpl,
      importWallet,
    });
    expect(out).toContain("could NOT be completed");
    expect(out).toContain("NOT persisted");
    expect(out).not.toContain("You now hold this wallet's private key");
    // No funded ceiling raised for a wallet we did not keep.
    expect(readLedger(home, T0).lifetimeClaimedCC).toBe(0);
  });

  it("NO-CLOBBER: an already-funded wallet is reported, never replaced", async () => {
    const home = tmpHome();
    const relay = { balance: vi.fn().mockResolvedValue({ cc: "1.5" }),
      pending: vi.fn().mockResolvedValue({ pending: [] }), };
    const questFundImpl = vi.fn();
    const importWallet = vi.fn();
    const out = await runAutoFund({
      wallet,
      relay: relay as never,
      home,
      payProxyUrl: PAY_PROXY,
      questFundImpl,
      importWallet,
    });
    expect(out).toContain("already funded: 1.5 CC");
    expect(questFundImpl).not.toHaveBeenCalled();
    expect(importWallet).not.toHaveBeenCalled();
  });

  it("no pay-proxy URL configured → manual-funding fallback (no quest)", async () => {
    const home = tmpHome();
    const relay = { balance: vi.fn().mockResolvedValue({ cc: "0" }),
      pending: vi.fn().mockResolvedValue({ pending: [] }), };
    const questFundImpl = vi.fn();
    const out = await runAutoFund({
      wallet,
      relay: relay as never,
      home,
      payProxyUrl: undefined,
      questFundImpl,
    });
    expect(out).toContain("pay-proxy URL");
    expect(out).toContain("agent::1220a"); // buildFundingText body
    expect(questFundImpl).not.toHaveBeenCalled();
  });

  it("quest unavailable → manual-funding fallback (no error, no import)", async () => {
    const home = tmpHome();
    const relay = { balance: vi.fn().mockResolvedValue({ cc: "0" }),
      pending: vi.fn().mockResolvedValue({ pending: [] }), };
    const questFundImpl = vi.fn().mockRejectedValue(new Error("quest disabled"));
    const importWallet = vi.fn();
    const out = await runAutoFund({
      wallet,
      relay: relay as never,
      home,
      payProxyUrl: PAY_PROXY,
      questFundImpl,
      importWallet,
    });
    expect(out).toContain("quest is unavailable (quest disabled)");
    expect(out).toContain("agent::1220a");
    expect(importWallet).not.toHaveBeenCalled();
  });

  it("a quest that failed PAST step 1 rescues the key instead of dropping it", async () => {
    // Step 1 hands back the minted wallet's PEM; step 2 is where the faucet
    // grant is dispensed AND where the pay-proxy drops its own copy. So a
    // step-2 failure leaves real CC on a MainNet party whose only surviving key
    // is the one attached to this error. Reading just `e.message` let it be
    // collected — funds nobody can move — while the agent was told the quest
    // was merely "unavailable". The agent-wallet twin has rescued this since
    // the morning; this copy called the lower-level questFund and never got it.
    const relay = {
      balance: vi.fn().mockResolvedValue({ cc: "0" }),
      pending: vi.fn().mockResolvedValue({ pending: [] }),
    };
    const home = tmpHome();
    const { QuestFundError } = await import("@ftptech/canton-agent-wallet");
    const questFundImpl = vi.fn().mockRejectedValue(
      new QuestFundError("quest STEP 2 timed out", {
        secret: "-----BEGIN PRIVATE KEY-----\nMC4\n-----END PRIVATE KEY-----\n",
        party: "agent::1220stranded",
        network: "canton:mainnet",
      })
    );
    const rescued: Array<[string, string]> = [];
    const out = await runAutoFund({
      wallet,
      relay: relay as never,
      home,
      payProxyUrl: PAY_PROXY,
      questFundImpl,
      importWallet: vi.fn(),
      rescueKeyImpl: ((secret: string, party: string) => {
        rescued.push([secret, party]);
        return "/tmp/rescued-key-agent__1220stranded.pem";
      }) as never,
    });
    expect(rescued).toHaveLength(1);
    expect(rescued[0]![1]).toBe("agent::1220stranded");
    // And the agent must be TOLD, or the file on disk helps nobody.
    expect(out).toContain("agent::1220stranded");
    expect(out).toContain("/tmp/rescued-key-agent__1220stranded.pem");
  });

  it("a funded wallet that fails to INSTALL is rescued, not declared lost", async () => {
    // The old text said "the server does not expose the key, so treat that
    // wallet as lost and retry auto_fund". That was false — `funded.secret` is
    // in hand at that point — and acting on it meant funding a SECOND wallet
    // while the first one kept its CC forever.
    const home = tmpHome();
    const relay = {
      balance: vi.fn().mockResolvedValue({ cc: "0" }),
      pending: vi.fn().mockResolvedValue({ pending: [] }),
    };
    const rescued: string[] = [];
    const out = await runAutoFund({
      wallet,
      relay: relay as never,
      home,
      payProxyUrl: PAY_PROXY,
      questFundImpl: vi.fn().mockResolvedValue({
        secret: "-----BEGIN PRIVATE KEY-----\nY\n-----END PRIVATE KEY-----",
        party: "agent::1220installfail",
        network: "canton:mainnet",
        balanceCc: "0.05",
      }) as never,
      importWallet: vi.fn().mockRejectedValue(new Error("disk full")) as never,
      rescueKeyImpl: ((_s: string, party: string) => {
        rescued.push(party);
        return "/tmp/rescued-key-installfail.pem";
      }) as never,
    });
    expect(rescued).toEqual(["agent::1220installfail"]);
    expect(out).toContain("/tmp/rescued-key-installfail.pem");
    expect(out).not.toContain("does not expose the key");
    expect(out).not.toContain("treat that wallet as lost");
  });

  it("says so plainly when the rescue itself cannot be written", async () => {
    // Swallowing this would leave the agent believing nothing was lost.
    const relay = {
      balance: vi.fn().mockResolvedValue({ cc: "0" }),
      pending: vi.fn().mockResolvedValue({ pending: [] }),
    };
    const home = tmpHome();
    const { QuestFundError } = await import("@ftptech/canton-agent-wallet");
    const out = await runAutoFund({
      wallet,
      relay: relay as never,
      home,
      payProxyUrl: PAY_PROXY,
      questFundImpl: vi.fn().mockRejectedValue(
        new QuestFundError("boom", {
          secret: "pem",
          party: "agent::1220lost",
          network: "canton:mainnet",
        })
      ) as never,
      importWallet: vi.fn(),
      rescueKeyImpl: (() => {
        throw new Error("EROFS: read-only file system");
      }) as never,
    });
    expect(out).toContain("agent::1220lost");
    expect(out).toContain("unrecoverable");
  });
});

describe("an unreadable balance is not an empty wallet", () => {
  // The write further down destroys the private key, and it is the only copy.
  // Catching the balance read into "0" made a relay failure look exactly like
  // an empty wallet. It is not hypothetical: /v1/wallet/:party/balance answers
  // 413 holdings_exceed_node_limit for a party holding more amulet contracts
  // than the participant's element cap — so the wallets whose balance cannot be
  // read are precisely the ones that accumulated the most CC, onboarding still
  // works, and every auto_fund call reproduces it.
  const wallet = { party: "agent::1220whale", relayUrl: "https://facilitator.example" } as never;

  it("refuses to mint, so the quest is never even started", async () => {
    const home = tmpHome();
    const questFundImpl = vi.fn();
    const importWallet = vi.fn();
    const out = await runAutoFund({
      wallet,
      relay: {
        balance: vi.fn().mockRejectedValue(
          new Error("relay GET /v1/wallet/agent::1220whale/balance -> 413 holdings_exceed_node_limit")
        ),
      } as never,
      home,
      payProxyUrl: "https://pay.example",
      questFundImpl: questFundImpl as never,
      importWallet: importWallet as never,
    });
    expect(questFundImpl).not.toHaveBeenCalled(); // nothing minted
    expect(importWallet).not.toHaveBeenCalled(); // nothing written
    expect(out).toMatch(/could not be read/i);
    expect(out).toMatch(/private key/i); // says WHY, so the LLM does not just retry
  });

  it("a balance that reads ZERO still funds — refusing everything would be the other bug", async () => {
    // The discriminator. "Never mint when unsure" must not become "never mint":
    // the empty bootstrap wallet is exactly the case auto_fund exists for.
    const home = tmpHome();
    const questFundImpl = vi.fn().mockResolvedValue({
      secret: "-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----",
      party: "agent::1220minted",
      network: "canton:mainnet",
      balanceCc: "0.05",
      updateId: "u-1",
    });
    await runAutoFund({
      wallet,
      relay: { balance: vi.fn().mockResolvedValue({ cc: "0" }),
      pending: vi.fn().mockResolvedValue({ pending: [] }), } as never,
      home,
      payProxyUrl: "https://pay.example",
      questFundImpl: questFundImpl as never,
      importWallet: vi.fn().mockResolvedValue({ party: "agent::1220minted" }) as never,
    });
    expect(questFundImpl).toHaveBeenCalledTimes(1);
  });

  it("the CLI path enforces the SAME rule — the two must not drift again", async () => {
    // This defect existed because the rule lives in two places and only one was
    // fixed. Driving both from one test is what keeps them honest.
    const { fundViaQuest, QuestFundError } = await import(
      "@ftptech/canton-agent-wallet"
    );
    const minted = vi.fn();
    await expect(
      fundViaQuest({
        relayUrl: "https://facilitator.example",
        payProxyUrl: "https://pay.example",
        loadWalletImpl: () => ({ party: "agent::1220whale" }) as never,
        balanceOf: async () => {
          throw new Error("413 holdings_exceed_node_limit");
        },
        questFundImpl: minted as never,
      } as never)
    ).rejects.toBeInstanceOf(QuestFundError);
    expect(minted).not.toHaveBeenCalled();
  });
});

/**
 * The MCP twin of the agent-wallet guard. /balance counts Amulet contracts only,
 * so funds the owner has sent but the agent has not claimed read as zero — and
 * this tool's own instructions tell the owner to send first and the agent to
 * claim after, so that window is the normal path, not an edge case.
 */
describe("auto_fund — unclaimed incoming transfers are not an empty wallet", () => {
  const wallet = {
    party: "agent::1220holder",
    relayUrl: "http://relay.test",
    network: "canton:mainnet",
  } as never;

  it("refuses to mint over a wallet with pending transfers, and names the amount", async () => {
    const relay = {
      balance: vi.fn().mockResolvedValue({ cc: "0" }),
      pending: vi.fn().mockResolvedValue({
        pending: [
          { cid: "00p1", amount: "5.0000000000" },
          { cid: "00p2", amount: "0.5000000000" },
        ],
      }),
    };
    const questFundImpl = vi.fn();
    const importWallet = vi.fn();
    const out = await runAutoFund({
      wallet,
      relay: relay as never,
      home: tmpHome(),
      payProxyUrl: "http://proxy.test",
      questFundImpl: questFundImpl as never,
      importWallet: importWallet as never,
    });
    expect(out).toMatch(/2 unaccepted/i);
    expect(out).toMatch(/5\.5000000000 CC/);
    expect(out).toMatch(/claim/i);
    expect(questFundImpl).not.toHaveBeenCalled();
    expect(importWallet).not.toHaveBeenCalled();
  });

  it("unreadable pending refuses too — it is not proof of emptiness", async () => {
    const relay = {
      balance: vi.fn().mockResolvedValue({ cc: "0" }),
      pending: vi.fn().mockRejectedValue(new Error("relay 502")),
    };
    const importWallet = vi.fn();
    const out = await runAutoFund({
      wallet,
      relay: relay as never,
      home: tmpHome(),
      payProxyUrl: "http://proxy.test",
      questFundImpl: vi.fn() as never,
      importWallet: importWallet as never,
    });
    expect(out).toMatch(/could not be read/i);
    expect(importWallet).not.toHaveBeenCalled();
  });
});
