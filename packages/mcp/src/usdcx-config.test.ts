import { describe, it, expect } from "vitest";
import { resolveConfig } from "./config.js";

const env = { CANTON_AGENT_RELAY_URL: "https://facilitator.example" } as NodeJS.ProcessEnv;

/**
 * USDCx is a second budget with its own caps. Like the CC caps, an unreadable
 * value refuses to start, and an unset one means "no USDCx payments" (the pay
 * tool checks that), never "uncapped".
 */
describe("local USDCx caps", () => {
  it("are unset by default", () => {
    const c = resolveConfig([], env);
    expect(c.policy.usdcxMaxPerTx).toBeUndefined();
    expect(c.policy.usdcxDailyCap).toBeUndefined();
  });

  it("read both flag spellings", () => {
    const c = resolveConfig(["--usdcx-max-per-tx=0.5", "--usdcx-daily-cap", "2"], env);
    expect(c.policy.usdcxMaxPerTx).toBe(0.5);
    expect(c.policy.usdcxDailyCap).toBe(2);
  });

  it("read the env, and a flag wins over it", () => {
    const c = resolveConfig(["--usdcx-daily-cap=3"], {
      ...env,
      CANTON_MCP_USDCX_MAX_PER_TX: "1",
      CANTON_MCP_USDCX_DAILY_CAP: "9",
    });
    expect(c.policy.usdcxMaxPerTx).toBe(1);
    expect(c.policy.usdcxDailyCap).toBe(3);
  });

  it("refuse to start on an unreadable value", () => {
    expect(() => resolveConfig(["--usdcx-max-per-tx", "1 USDCx"], env)).toThrow(/--usdcx-max-per-tx/);
    expect(() => resolveConfig([], { ...env, CANTON_MCP_USDCX_DAILY_CAP: "-1" })).toThrow(/CANTON_MCP_USDCX_DAILY_CAP/);
  });

  it("leave the CC caps alone", () => {
    const c = resolveConfig(["--max-per-tx", "1", "--usdcx-max-per-tx", "0.25", "--usdcx-daily-cap", "1"], env);
    expect(c.policy.maxPerTx).toBe(1);
    expect(c.policy.dailyCap).toBeUndefined();
  });
});
