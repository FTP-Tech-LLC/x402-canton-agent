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

describe("runAutoFund (auto_fund tool flow)", () => {
  const wallet = { party: "agent::1220a" } as never;

  it("seeds via the faucet, accepts it, and reports the new balance", async () => {
    const home = tmpHome();
    const relay = {
      faucetClaim: vi
        .fn()
        .mockResolvedValue({ updateId: "u-fc", amount: "0.02", party: "agent::1220a" }),
      balance: vi
        .fn()
        .mockResolvedValue({ party: "agent::1220a", amulet: 1, cc: "0.02", holdings: [] }),
    };
    const claimAll = vi.fn().mockResolvedValue({ claimed: 1, updateIds: ["u-acc"] });
    const out = await runAutoFund({ wallet, relay: relay as never, home, claimAll });
    expect(relay.faucetClaim).toHaveBeenCalledWith("agent::1220a");
    expect(claimAll).toHaveBeenCalledTimes(1);
    expect(out).toContain("faucet sent 0.02 CC");
    expect(out).toContain("balance now 0.02 CC");
    // Funded ceiling was raised so the agent may spend the seed.
    expect(readLedger(home, T0).lifetimeClaimedCC).toBeGreaterThanOrEqual(0.02);
  });

  it("falls back to the manual-funding ask when the faucet is unavailable (no error, no claim)", async () => {
    const home = tmpHome();
    const relay = {
      faucetClaim: vi.fn().mockRejectedValue(new Error("faucet disabled")),
      balance: vi.fn(),
    };
    const claimAll = vi.fn();
    const out = await runAutoFund({ wallet, relay: relay as never, home, claimAll });
    expect(out).toContain("Faucet unavailable (faucet disabled)");
    expect(out).toContain("agent::1220a"); // buildFundingText body
    expect(claimAll).not.toHaveBeenCalled();
    expect(relay.balance).not.toHaveBeenCalled();
  });
});
