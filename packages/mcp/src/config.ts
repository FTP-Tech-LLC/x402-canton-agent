/**
 * Server config — resolved ONCE at startup from argv/env by the HUMAN who runs
 * `claude mcp add ... -- canton-x402-mcp --relay-url ... --max-per-tx ...`.
 *
 * The agent never sets any of this; the spend policy here is the out-of-band
 * trust boundary that makes auto-approving small payments defensible. Precedence
 * for every value: CLI flag > env var > default.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Spend policy — enforced in-process BEFORE any signature is emitted. */
export interface SpendPolicy {
  /** Per-transaction cap in CC. Enforced on `withdraw` (amount known pre-call).
   *  On `pay` the price is only known mid-x402-dance, so v1 enforces it via the
   *  daily/funded ceilings + the balance-delta ledger, not a pre-sign per-tx
   *  block (that needs an agent-wallet onBeforeSign hook — see README). */
  maxPerTx?: number | undefined;
  /** Rolling 24h cap on total outbound (pay + withdraw) in CC. */
  dailyCap?: number | undefined;
  /** Hostnames `pay({url})` may target. `"*"` = any; `[]` = deny-all
   *  (fail-closed — the human must opt in to domains). */
  allowDomains: string[] | "*";
  /** When true (default), cumulative outbound may never exceed cumulative
   *  claimed inbound: a compromised agent can at most re-spend what the owner
   *  funded, never more. */
  fundedCeiling: boolean;
}

export interface McpConfig {
  /** Facilitator relay base URL. REQUIRED — no default (a stale default would
   *  silently misroute real payments). */
  relayUrl: string;
  /** The server's OWN wallet home (holds wallet.json + the policy ledger). The
   *  agent never sees this path's contents — only tool results. */
  home: string;
  /** ensureWallet fallback network; the relay's /supported is authoritative and
   *  overrides this at create time. */
  network: string;
  apiKey?: string | undefined;
  policy: SpendPolicy;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function nonNegNum(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function resolveConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv
): McpConfig {
  const relayUrl = flag(argv, "relay-url") ?? env.CANTON_AGENT_RELAY_URL;
  if (!relayUrl) {
    throw new Error(
      "relay URL is required: pass --relay-url <https://facilitator...> or set " +
        "CANTON_AGENT_RELAY_URL. There is no default (a stale default would " +
        "silently misroute real payments)."
    );
  }

  const home =
    flag(argv, "home") ??
    env.CANTON_AGENT_HOME ??
    join(homedir(), ".canton-agent");

  const network =
    flag(argv, "network") ?? env.CANTON_X402_MCP_NETWORK ?? "canton:mainnet";

  const apiKey = flag(argv, "api-key") ?? env.CANTON_AGENT_API_KEY;

  const allowRaw = flag(argv, "allow-domains") ?? env.CANTON_MCP_ALLOW_DOMAINS ?? "";
  const allowDomains: string[] | "*" =
    allowRaw.trim() === "*"
      ? "*"
      : allowRaw
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);

  // funded-ceiling defaults ON; disable with --no-funded-ceiling or
  // CANTON_MCP_FUNDED_CEILING=false.
  const fundedCeiling = !(
    argv.includes("--no-funded-ceiling") ||
    env.CANTON_MCP_FUNDED_CEILING === "false"
  );

  return {
    relayUrl,
    home,
    network,
    apiKey,
    policy: {
      maxPerTx: nonNegNum(flag(argv, "max-per-tx") ?? env.CANTON_MCP_MAX_PER_TX),
      dailyCap: nonNegNum(flag(argv, "daily-cap") ?? env.CANTON_MCP_DAILY_CAP),
      allowDomains,
      fundedCeiling,
    },
  };
}
