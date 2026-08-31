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
  withdrawAmount,
  preapprovalMode,
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

  it("REFUSES the equals spelling instead of reading it as absent", () => {
    // `flag()` and `flagPresent()` were both taught `--name=value` after the
    // equals form on `withdraw --amount=5` meant "amount absent", i.e. sweep the
    // whole wallet. boolFlag stayed on a bare `includes()`, so the same keystroke
    // has the same shape of consequence here: `merge --dry-run=true` reads as
    // dry-run ABSENT and submits real batch transfers instead of printing a plan.
    // `preapproval --status=true` likewise runs the real preapproval.
    //
    // Refusing, rather than parsing "true"/"false", is the deliberate choice:
    // reading presence would turn `--dry-run=false` into a dry run, and reading
    // the value would turn a typo'd `--dry-run=yes` into real transfers. Both
    // guesses pick an outcome the operator did not ask for. The bare spelling is
    // the only unambiguous one, so say that.
    for (const v of ["true", "false", "yes", "1", ""]) {
      expect(() => boolFlag(["merge", `--dry-run=${v}`], "--dry-run")).toThrow(
        /--dry-run/
      );
    }
    expect(() => boolFlag(["preapproval", "--status=true"], "--status")).toThrow(
      /--status/
    );
  });

  it("does not confuse a different flag that shares a prefix", () => {
    // `--dry-run-x=1` is not `--dry-run`. A startsWith check without the `=`
    // would have thrown on it.
    expect(boolFlag(["merge", "--dry-run-x=1"], "--dry-run")).toBe(false);
    expect(boolFlag(["merge", "--dry-runner"], "--dry-run")).toBe(false);
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

/**
 * `withdraw` sends the FULL balance when --amount is omitted. The CLI used to
 * funnel the flag through a truthiness filter, so a present-but-empty value read
 * exactly like omission — and `--amount "$AMT"` with AMT unset swept the wallet.
 */
describe("withdrawAmount — present-but-empty is not absent", () => {
  it("omitted means full balance", () => {
    expect(withdrawAmount(["--to", "p"])).toEqual({ kind: "full" });
  });

  it("an explicit amount is used verbatim", () => {
    expect(withdrawAmount(["--to", "p", "--amount", "0.25"])).toEqual({
      kind: "amount",
      amount: "0.25",
    });
  });

  it("an EMPTY value is refused, never treated as a sweep", () => {
    const r = withdrawAmount(["--to", "p", "--amount", ""]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/no value/i);
  });

  it("whitespace is refused too", () => {
    expect(withdrawAmount(["--to", "p", "--amount", "   "]).kind).toBe("error");
  });

  it("a TRAILING --amount with nothing after it is refused", () => {
    // The unquoted-unset-variable shape: argv ends with the flag itself.
    expect(withdrawAmount(["--to", "p", "--amount"]).kind).toBe("error");
  });
});

/**
 * The documented default of `preapproval` is SELF-provision. The mode used to be
 * switched by `CANTON_X402_OPERATOR_TOKEN` in the ambient environment — a name
 * that everywhere else in this repo is the FACILITATOR SERVER's own secret. On
 * the facilitator host, sourcing its .env silently changed which party becomes
 * the provider and who prepays the holding fee.
 */
describe("preapprovalMode — only the flag picks the mode", () => {
  it("no flag, clean env → self-provision", () => {
    expect(preapprovalMode([], {})).toEqual({ mode: "self", ambientIgnored: false });
  });

  it("an ambient operator token does NOT switch the mode, and is reported", () => {
    expect(
      preapprovalMode([], { CANTON_X402_OPERATOR_TOKEN: "server-secret" })
    ).toEqual({ mode: "self", ambientIgnored: true });
  });

  it("the flag DOES switch it — the legacy mode stays reachable on purpose", () => {
    // DISCRIMINATOR: this is an opt-in mode, not a removed one.
    expect(
      preapprovalMode(["--operator-token", "t"], {})
    ).toEqual({ mode: "legacy", operatorToken: "t" });
  });

  it("an empty --operator-token is not an opt-in", () => {
    expect(
      preapprovalMode(["--operator-token", ""], { CANTON_X402_OPERATOR_TOKEN: "s" })
    ).toEqual({ mode: "self", ambientIgnored: true });
  });
});

describe("--flag=value is the same instruction as --flag value", () => {
  it("withdraw --amount=5 sends 5, not the whole wallet", () => {
    // The presence check was an exact `includes("--amount")`, so the equals form
    // read as "no --amount" — which on withdraw means FULL BALANCE. A user who
    // typed an amount got their wallet swept. Published command, real money.
    const r = withdrawAmount(["withdraw", "--amount=5", "--to", "x::1220a"]);
    expect(r.kind).toBe("amount");
    if (r.kind === "amount") expect(r.amount).toBe("5");
  });

  it("the spaced form still works", () => {
    const r = withdrawAmount(["withdraw", "--amount", "5"]);
    expect(r.kind).toBe("amount");
    if (r.kind === "amount") expect(r.amount).toBe("5");
  });

  it("omitting --amount entirely still means the FULL balance", () => {
    // The discriminator: the fix must not turn an intentional full sweep into
    // an error, or every honest `withdraw --to x` breaks.
    expect(withdrawAmount(["withdraw", "--to", "x::1220a"]).kind).toBe("full");
  });

  it("--amount= with nothing after it is still refused, not treated as absent", () => {
    const r = withdrawAmount(["withdraw", "--amount="]);
    expect(r.kind).toBe("error");
  });

  it("flag() reads a value flag in either spelling", () => {
    expect(flag(["--relay-url=https://f.example"], "--relay-url")).toBe("https://f.example");
    expect(flag(["--relay-url", "https://f.example"], "--relay-url")).toBe("https://f.example");
  });

  it("--asset takes a value, so the URL after it stays the first positional (the documented `pay --asset USDCx <url>` form)", () => {
    expect(positionals(["--asset", "USDCx", "https://api.example.com/data"])).toEqual([
      "https://api.example.com/data",
    ]);
    expect(flag(["--asset", "USDCx", "https://api.example.com/data"], "--asset")).toBe("USDCx");
  });
});
