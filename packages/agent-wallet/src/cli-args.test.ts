import { describe, it, expect } from "vitest";
import {
  flag,
  boolFlag,
  intFlag,
  positionals,
  resolveNetwork,
  resolveRelayUrl,
  DEFAULT_NETWORK,
  MISSING_RELAY_HELP,
} from "./cli-args.js";

describe("cli-args.flag", () => {
  it("returns the value after the flag", () => {
    expect(flag(["--relay-url", "http://x:1"], "--relay-url")).toBe(
      "http://x:1"
    );
  });
  it("returns undefined when the flag is absent", () => {
    expect(flag(["pay", "http://x"], "--relay-url")).toBeUndefined();
  });
  it("returns undefined when the flag is last with no value", () => {
    expect(flag(["pay", "--relay-url"], "--relay-url")).toBeUndefined();
  });
});

describe("cli-args.positionals", () => {
  it("strips known --flag value pairs, keeping the URL", () => {
    expect(
      positionals(["--relay-url", "http://r:1", "https://api/x"])
    ).toEqual(["https://api/x"]);
  });
  it("works when the flag comes AFTER the positional", () => {
    expect(
      positionals(["https://api/x", "--relay-url", "http://r:1"])
    ).toEqual(["https://api/x"]);
  });
  it("strips multiple flags (--relay-url and --network)", () => {
    expect(
      positionals([
        "--network",
        "canton:mainnet",
        "https://api/x",
        "--relay-url",
        "http://r:1",
      ])
    ).toEqual(["https://api/x"]);
  });
  it("leaves a plain positional list untouched", () => {
    expect(positionals(["https://api/x"])).toEqual(["https://api/x"]);
  });
  it("does not treat an unknown --foo as a value flag", () => {
    // --foo is not in VALUE_FLAGS, so it (and its 'bar') stay as positionals.
    expect(positionals(["--foo", "bar", "https://api/x"])).toEqual([
      "--foo",
      "bar",
      "https://api/x",
    ]);
  });
  it("strips the merge value flags but leaves the --dry-run / --yes boolean switches", () => {
    // --target/--batch/--max-rounds are value flags (their values must not leak as
    // positionals); --dry-run and --yes take NO value, so they are not value flags
    // and are not consumed as one (the merge command reads them via boolFlag). A
    // --yes must NOT swallow the token after it (regression: it is not a value flag).
    expect(
      positionals(["--target", "2", "--batch", "90", "--max-rounds", "5", "--dry-run", "--yes"])
    ).toEqual(["--dry-run", "--yes"]);
  });
});

describe("cli-args.boolFlag", () => {
  it("is true only when the switch is present", () => {
    expect(boolFlag(["merge", "--dry-run"], "--dry-run")).toBe(true);
    expect(boolFlag(["merge"], "--dry-run")).toBe(false);
  });
  it("reads the merge --yes cost-gate switch", () => {
    // `--yes` acknowledges the GS-traffic cost of a >20-batch whale pass. It is a
    // boolean switch (no value), read via boolFlag exactly like --dry-run.
    expect(boolFlag(["merge", "--yes"], "--yes")).toBe(true);
    expect(boolFlag(["merge"], "--yes")).toBe(false);
    expect(boolFlag(["merge", "--dry-run", "--yes"], "--yes")).toBe(true);
  });
});

describe("cli-args.intFlag", () => {
  it("parses a positive integer flag value", () => {
    expect(intFlag(["--batch", "90"], "--batch")).toBe(90);
  });
  it("returns undefined when the flag is absent", () => {
    expect(intFlag(["merge"], "--batch")).toBeUndefined();
  });
  it("throws on a non-integer value", () => {
    expect(() => intFlag(["--batch", "abc"], "--batch")).toThrow(
      /--batch must be a positive integer/
    );
  });
  it("throws on a zero / negative value", () => {
    expect(() => intFlag(["--target", "0"], "--target")).toThrow(/positive integer/);
    expect(() => intFlag(["--max-rounds", "-1"], "--max-rounds")).toThrow(
      /positive integer/
    );
  });
});

describe("cli-args.resolveRelayUrl — no dead default (fail-fast)", () => {
  it("returns undefined when neither flag nor env is set", () => {
    // The whole point: there is NO built-in relay default. The caller must
    // fail fast rather than silently hitting a dead host.
    expect(resolveRelayUrl([], {})).toBeUndefined();
  });
  it("uses the --relay-url flag when present", () => {
    expect(resolveRelayUrl(["--relay-url", "http://flag:1"], {})).toBe(
      "http://flag:1"
    );
  });
  it("falls back to CANTON_AGENT_RELAY_URL env", () => {
    expect(
      resolveRelayUrl([], { CANTON_AGENT_RELAY_URL: "http://env:1" })
    ).toBe("http://env:1");
  });
  it("flag wins over env", () => {
    expect(
      resolveRelayUrl(["--relay-url", "http://flag:1"], {
        CANTON_AGENT_RELAY_URL: "http://env:1",
      })
    ).toBe("http://flag:1");
  });
  it("does NOT fall back to the old dead sslip.io testnet relay", () => {
    const r = resolveRelayUrl([], {});
    expect(r).toBeUndefined();
    expect(r ?? "").not.toContain("sslip.io");
    expect(r ?? "").not.toContain("178-105-206-80");
  });
});

describe("cli-args.resolveNetwork", () => {
  it("defaults to canton:testnet", () => {
    expect(resolveNetwork([], {})).toBe(DEFAULT_NETWORK);
    expect(DEFAULT_NETWORK).toBe("canton:testnet");
  });
  it("uses the --network flag", () => {
    expect(resolveNetwork(["--network", "canton:mainnet"], {})).toBe(
      "canton:mainnet"
    );
  });
  it("falls back to CANTON_AGENT_NETWORK env", () => {
    expect(
      resolveNetwork([], { CANTON_AGENT_NETWORK: "canton:devnet" })
    ).toBe("canton:devnet");
  });
});

describe("cli-args.MISSING_RELAY_HELP", () => {
  it("names both the flag and the env var, with the live relay endpoint", () => {
    expect(MISSING_RELAY_HELP).toContain("--relay-url");
    expect(MISSING_RELAY_HELP).toContain("CANTON_AGENT_RELAY_URL");
    expect(MISSING_RELAY_HELP).toContain("facilitator.ftptech.xyz");
  });
  it("does not point at the dead sslip relay", () => {
    expect(MISSING_RELAY_HELP).not.toContain("sslip.io");
  });
});

describe("preapproval value flags", () => {
  it("--admin / --expires-at / --operator-token take a value; --status is boolean", () => {
    const args = [
      "preapproval",
      "--admin",
      "DSO::1220",
      "--expires-at",
      "2026-10-01T00:00:00Z",
      "--operator-token",
      "op-secret",
      "--status",
    ];
    expect(flag(args, "--admin")).toBe("DSO::1220");
    expect(flag(args, "--expires-at")).toBe("2026-10-01T00:00:00Z");
    expect(flag(args, "--operator-token")).toBe("op-secret");
    expect(boolFlag(args, "--status")).toBe(true);
  });
});
