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
  /** Cap on total outbound (pay + withdraw) in CC per UTC day: the count
   *  starts again at 0 when the UTC date changes (not a rolling 24 hours). */
  dailyCap?: number | undefined;
  /** Hostnames `pay({url})` may target. `"*"` = any; `[]` = deny-all
   *  (fail-closed — the human must opt in to domains); `"catalog"` = only the
   *  services in the facilitator's catalogue (see `isCatalogOnly`). */
  allowDomains: string[] | "*" | "catalog";
  /** When true (default), cumulative outbound may never exceed cumulative
   *  claimed inbound: a compromised agent can at most re-spend what the owner
   *  funded, never more. */
  fundedCeiling: boolean;
  /** When set, `withdraw` may send only to these parties. The hosted server
   *  fills it with the destinations the owner confirmed with a passkey on the
   *  account page, so an assistant steered by a prompt injection cannot send
   *  the wallet to a stranger. An empty list refuses every withdrawal; unset
   *  means any party (the local server). */
  withdrawAllowlist?: readonly string[] | undefined;
  /** Where the owner manages that list; named in the refusal. */
  withdrawAllowlistUrl?: string | undefined;
  /** Where the owner changes maxPerTx and dailyCap; named in a refusal that a
   *  higher limit would have let through. Unset (the local server, whose limits
   *  are startup flags) leaves the refusal as it is. */
  limitsUrl?: string | undefined;
  /** The owner's own choice on the hosted server. `"catalog"`: `pay` reaches
   *  only services in the catalogue, on top of `allowDomains` (it can only
   *  narrow). Unset or `"any"`: no extra limit (the local server, and every
   *  hosted user who never chose). */
  payScope?: "any" | "catalog" | undefined;
  /** Where the owner changes `payScope`; named in the refusal. */
  payScopeUrl?: string | undefined;
  /** USDCx per payment, in USDCx. `pay` with `asset: "USDCx"` runs only when
   *  this AND `usdcxDailyCap` are set: unset is "no USDCx payments", never
   *  "uncapped". The CC caps above never apply to USDCx. */
  usdcxMaxPerTx?: number | undefined;
  /** USDCx per UTC day, in USDCx, counted apart from the CC daily cap. */
  usdcxDailyCap?: number | undefined;
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
  /** --single-payment / CANTON_MCP_SINGLE_PAYMENT: one `pay` call settles at
   *  most one payment (the paying fetch does not re-pay a merchant that keeps
   *  answering 402), as on the hosted server. Off by default. */
  singlePayment?: boolean | undefined;
}

/**
 * Read `--name value` AND `--name=value`.
 *
 * This used to be `indexOf("--name")` only, so `--max-per-tx=1` did not match
 * and read as "flag absent". In this package absent means UNCAPPED — every
 * enforcement site is gated on `!== undefined` — so the equals spelling quietly
 * removed the per-tx cap, both daily-cap branches, the `maxPaymentValue` that
 * arms the relay-signer's over-quote breaker, and the refusal to sweep a full
 * balance on an amount-less `withdraw`. `--home=/path` was dropped the same way,
 * pointing the agent at the DEFAULT wallet, which is the very wallet the
 * `canton-agent-wallet` CLI uses.
 *
 * agent-wallet's `cli-args.ts` was taught both spellings after the identical
 * defect made `withdraw --amount=5` send the entire balance. This package
 * carries its own private copy and did not get that fix; now it has it. Only
 * the FIRST `=` splits, so a value may contain its own.
 */
function flag(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const eq = argv.find((a) => a.startsWith(prefix));
  if (eq !== undefined) return eq.slice(prefix.length);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/**
 * A spend cap that cannot be read is a REFUSAL TO START, not "no cap".
 *
 * The old version returned `undefined` for anything `Number()` could not parse
 * — `"5 CC"`, `"1,5"`, an un-substituted `${MAX_PER_TX}` — and `undefined` is
 * how this package spells uncapped. So "I could not read your limit" and "you
 * asked for no limit" produced the same money policy, on a server whose only
 * report of the resolved policy is a stderr line that MCP clients hide.
 *
 * Empty/whitespace reads as UNSET rather than as an error: a bare `KEY=` line in
 * a .env is how operators comment a knob out, and `Number("")` is 0 — which
 * would otherwise have made it a cap of ZERO that refuses every payment. An
 * explicit `0` still means 0, because "allow nothing" is a real policy.
 */
function nonNegNum(raw: string | undefined, where: string): number | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  if (t === "") return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `${where} must be a non-negative number, got ${JSON.stringify(raw)}. ` +
        `Refusing to start: an unreadable spend cap used to be treated as NO ` +
        `cap, which silently removed every limit on this wallet.`
    );
  }
  return n;
}

/**
 * The pay allow-list, as both servers read it (`--allow-domains` here,
 * `MCP_REMOTE_ALLOW_DOMAINS` on the hosted one): `"*"` = any host, a
 * comma-separated host list (lowercased; empty = deny all), or `"catalog"` =
 * only the services in the facilitator's catalogue.
 *
 * `catalog` is a keyword only as the whole value. Mixed with hosts it is a
 * refusal to start: "catalogue and also these hosts" is not a policy this
 * package has, and guessing which half was meant picks a spend policy the owner
 * did not ask for.
 */
export function parseAllowDomains(raw: string, where: string): string[] | "*" | "catalog" {
  if (raw.trim() === "*") return "*";
  const hosts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!hosts.includes("catalog")) return hosts;
  if (hosts.length === 1) return "catalog";
  throw new Error(
    `${where}: "catalog" must be the whole value (pay only services in the catalogue), ` +
      `got ${JSON.stringify(raw)}. Use "catalog" alone, or a list of hosts.`
  );
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

  const allowDomains = parseAllowDomains(
    flag(argv, "allow-domains") ?? env.CANTON_MCP_ALLOW_DOMAINS ?? "",
    "--allow-domains / CANTON_MCP_ALLOW_DOMAINS"
  );

  // funded-ceiling defaults ON; disable with --no-funded-ceiling or
  // CANTON_MCP_FUNDED_CEILING=false.
  //
  // A bare switch, and `--no-funded-ceiling=false` is REFUSED rather than
  // guessed at. Reading it as "present, so disable" turns off the ceiling for
  // someone who wrote `=false` meaning to keep it; reading it as "false, so
  // keep" ignores an operator who wrote `=true` meaning to remove it. Both
  // guesses silently pick a spend policy the operator did not ask for, so say
  // which spelling to use instead.
  const NO_CEIL = "--no-funded-ceiling";
  const ceilEquals = argv.find((a) => a.startsWith(`${NO_CEIL}=`));
  if (ceilEquals !== undefined) {
    throw new Error(
      `${NO_CEIL} is a bare switch: pass ${NO_CEIL} to disable the funded ` +
        `ceiling, or omit it to keep the ceiling on. Got ` +
        `${JSON.stringify(ceilEquals)} — refusing to guess which was meant.`
    );
  }
  const fundedCeiling = !(
    argv.includes(NO_CEIL) || env.CANTON_MCP_FUNDED_CEILING === "false"
  );

  // --single-payment is a bare switch, refused with a value for the same
  // reason as --no-funded-ceiling: `=false` cannot be guessed at.
  const SINGLE = "--single-payment";
  const singleEquals = argv.find((a) => a.startsWith(`${SINGLE}=`));
  if (singleEquals !== undefined) {
    throw new Error(
      `${SINGLE} is a bare switch: pass ${SINGLE} to turn it on, or omit it. ` +
        `Got ${JSON.stringify(singleEquals)} — refusing to guess which was meant.`
    );
  }
  const singleEnv = env.CANTON_MCP_SINGLE_PAYMENT?.trim().toLowerCase() ?? "";
  if (!["", "0", "false", "1", "true"].includes(singleEnv)) {
    throw new Error(
      `CANTON_MCP_SINGLE_PAYMENT must be true or false, got ${JSON.stringify(env.CANTON_MCP_SINGLE_PAYMENT)}`
    );
  }
  const singlePayment = argv.includes(SINGLE) || singleEnv === "true" || singleEnv === "1";

  return {
    relayUrl,
    home,
    network,
    apiKey,
    singlePayment,
    policy: {
      maxPerTx: nonNegNum(
        flag(argv, "max-per-tx") ?? env.CANTON_MCP_MAX_PER_TX,
        "--max-per-tx / CANTON_MCP_MAX_PER_TX"
      ),
      dailyCap: nonNegNum(
        flag(argv, "daily-cap") ?? env.CANTON_MCP_DAILY_CAP,
        "--daily-cap / CANTON_MCP_DAILY_CAP"
      ),
      allowDomains,
      fundedCeiling,
      usdcxMaxPerTx: nonNegNum(
        flag(argv, "usdcx-max-per-tx") ?? env.CANTON_MCP_USDCX_MAX_PER_TX,
        "--usdcx-max-per-tx / CANTON_MCP_USDCX_MAX_PER_TX"
      ),
      usdcxDailyCap: nonNegNum(
        flag(argv, "usdcx-daily-cap") ?? env.CANTON_MCP_USDCX_DAILY_CAP,
        "--usdcx-daily-cap / CANTON_MCP_USDCX_DAILY_CAP"
      ),
    },
  };
}
