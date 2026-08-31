/**
 * THE SPEND POLICY MUST NOT BECOME "NO LIMIT" BY ACCIDENT.
 *
 * `undefined` is how this package spells "uncapped", and every enforcement site
 * is gated on it: the per-tx cap (policy.ts `assertWithdrawAllowed`), both daily
 * cap branches, the `maxPaymentValue` handed to the relay-signer's fail-closed
 * over-quote breaker (server.ts), and the refusal to sweep a full balance when
 * `withdraw` is called with no amount (server.ts). So anything that turns an
 * operator's real cap into `undefined` removes ALL of them at once, silently,
 * on a published money server that a user connects with one `claude mcp add`.
 *
 * Two independent inputs did exactly that:
 *
 *   1. `--max-per-tx=1`. `flag()` looked the token up with `argv.indexOf("--max-per-tx")`,
 *      which does not match `"--max-per-tx=1"`. This is the SAME defect fixed in
 *      agent-wallet's `cli-args.ts` earlier — where the equals spelling on
 *      `withdraw --amount=5` meant "amount absent", i.e. send the whole balance.
 *      The MCP carries its own private copy of `flag()` and never got the fix.
 *      It also silently dropped `--home=/path`, pointing the agent at the
 *      DEFAULT wallet — the same one the `canton-agent-wallet` CLI uses — rather
 *      than the isolated home the operator named.
 *
 *   2. A present-but-unparseable value: `CANTON_MCP_DAILY_CAP="5 CC"`, `"1,5"`,
 *      or an un-substituted template placeholder. `Number(...)` is NaN, and the
 *      old `nonNegNum` mapped that to `undefined` — "I could not read your cap"
 *      became "you asked for no cap".
 *
 * Both now fail LOUD at boot rather than quietly wide open. The startup line
 * that would have shown `maxPerTx=∞` goes to the stderr of a client-spawned
 * stdio server, which nobody reads.
 */
import { describe, it, expect } from "vitest";
import { resolveConfig } from "./config.js";

const RELAY = "https://facilitator.example";
const baseEnv = { CANTON_AGENT_RELAY_URL: RELAY } as NodeJS.ProcessEnv;

describe("spend caps survive the equals spelling", () => {
  it("reads --max-per-tx=1 --daily-cap=2 as real caps, not as absent", () => {
    // Verbatim shape of a documented `claude mcp add ... -- npx -y ...` command.
    const c = resolveConfig(
      ["--max-per-tx=1", "--daily-cap=2", "--allow-domains=api.example.com"],
      baseEnv
    );
    expect(c.policy.maxPerTx).toBe(1);
    expect(c.policy.dailyCap).toBe(2);
    expect(c.policy.allowDomains).toEqual(["api.example.com"]);
  });

  it("still reads the space spelling", () => {
    const c = resolveConfig(
      ["--max-per-tx", "1", "--daily-cap", "2", "--allow-domains", "api.example.com"],
      baseEnv
    );
    expect(c.policy.maxPerTx).toBe(1);
    expect(c.policy.dailyCap).toBe(2);
    expect(c.policy.allowDomains).toEqual(["api.example.com"]);
  });

  it("--home=/path is honoured, so the agent does not open the operator's main wallet", () => {
    // The default home is the SAME path the canton-agent-wallet CLI uses. An
    // ignored --home means the agent drives the operator's primary wallet while
    // the operator believes it is sandboxed.
    const c = resolveConfig(["--home=/tmp/x402-isolated"], baseEnv);
    expect(c.home).toBe("/tmp/x402-isolated");
    expect(resolveConfig(["--home", "/tmp/x402-isolated"], baseEnv).home).toBe(
      "/tmp/x402-isolated"
    );
  });

  it("--relay-url=… satisfies the required-relay check", () => {
    const c = resolveConfig([`--relay-url=${RELAY}`], {} as NodeJS.ProcessEnv);
    expect(c.relayUrl).toBe(RELAY);
  });

  it("an equals-value with its own '=' inside survives (only the first splits)", () => {
    const c = resolveConfig(
      [`--relay-url=https://f.example/?k=v`],
      {} as NodeJS.ProcessEnv
    );
    expect(c.relayUrl).toBe("https://f.example/?k=v");
  });
});

describe("an unreadable cap is refused, never widened to no cap", () => {
  for (const bad of ["5 CC", "1,5", "${MAX_PER_TX}", "abc", "-1", "NaN"]) {
    it(`throws on CANTON_MCP_MAX_PER_TX=${JSON.stringify(bad)}`, () => {
      expect(() =>
        resolveConfig([], { ...baseEnv, CANTON_MCP_MAX_PER_TX: bad })
      ).toThrow(/CANTON_MCP_MAX_PER_TX|max-per-tx/);
    });
    it(`throws on --daily-cap=${JSON.stringify(bad)}`, () => {
      expect(() => resolveConfig([`--daily-cap=${bad}`], baseEnv)).toThrow(
        /CANTON_MCP_DAILY_CAP|daily-cap/
      );
    });
  }

  // ── discriminators: the guard must not refuse honest configuration ──────────
  it("ABSENT stays uncapped — that is the documented default, not an error", () => {
    const c = resolveConfig([], baseEnv);
    expect(c.policy.maxPerTx).toBeUndefined();
    expect(c.policy.dailyCap).toBeUndefined();
  });

  it("EMPTY reads as unset, matching how an unset .env line behaves", () => {
    // `CANTON_MCP_MAX_PER_TX=` in a .env file. Before, Number("") === 0 made
    // this a cap of ZERO, which refuses every payment — a different silent
    // wrong answer in the opposite direction.
    const c = resolveConfig([], {
      ...baseEnv,
      CANTON_MCP_MAX_PER_TX: "",
      CANTON_MCP_DAILY_CAP: "   ",
    });
    expect(c.policy.maxPerTx).toBeUndefined();
    expect(c.policy.dailyCap).toBeUndefined();
  });

  it("an explicit 0 is kept as 0 — 'allow nothing' is a real, deliberate policy", () => {
    const c = resolveConfig(["--max-per-tx=0", "--daily-cap", "0"], baseEnv);
    expect(c.policy.maxPerTx).toBe(0);
    expect(c.policy.dailyCap).toBe(0);
  });

  it("decimals and whitespace-padded numbers are accepted", () => {
    const c = resolveConfig([], {
      ...baseEnv,
      CANTON_MCP_MAX_PER_TX: " 0.25 ",
      CANTON_MCP_DAILY_CAP: "2.5",
    });
    expect(c.policy.maxPerTx).toBe(0.25);
    expect(c.policy.dailyCap).toBe(2.5);
  });
});

describe("the boolean flag does not silently invert", () => {
  it("the bare --no-funded-ceiling disables the ceiling", () => {
    expect(resolveConfig(["--no-funded-ceiling"], baseEnv).policy.fundedCeiling).toBe(
      false
    );
    expect(resolveConfig([], baseEnv).policy.fundedCeiling).toBe(true);
  });

  it("--no-funded-ceiling=false is REFUSED rather than guessed at", () => {
    // The trap this avoids: reading the presence of the token would disable the
    // ceiling for someone who wrote `=false` meaning to keep it. Guessing the
    // opposite is just as bad. Refuse and say which spelling to use.
    expect(() => resolveConfig(["--no-funded-ceiling=false"], baseEnv)).toThrow(
      /no-funded-ceiling/
    );
    expect(() => resolveConfig(["--no-funded-ceiling=true"], baseEnv)).toThrow(
      /no-funded-ceiling/
    );
  });
});
