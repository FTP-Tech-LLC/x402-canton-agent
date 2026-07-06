/**
 * Pure (side-effect-free) argument helpers for the canton-agent-wallet CLI.
 *
 * Kept in their own module so they can be unit-tested without importing
 * `cli.ts` (which auto-runs `main()` on import and would call
 * `process.exit`). `cli.ts` composes these with its env + `fail()`.
 */

export const DEFAULT_NETWORK = "canton:testnet";

/** Known `--flag <value>` options; used to strip flags out of positionals. */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--relay-url",
  "--network",
  "--to",
  "--amount",
  "--key-file",
  // merge: consolidate dust amulets. `--dry-run` and `--yes` are BOOLEAN flags (no
  // value), so they are intentionally NOT listed here — only the value-taking merge
  // flags are. (`--yes` acknowledges the GS-traffic cost of a >20-batch whale pass.)
  "--target",
  "--batch",
  "--max-rounds",
  // preapproval: merchant TransferPreapproval setup for the transfer-factory
  // path. --admin (instrument DSO), --expires-at (ISO-8601), --operator-token
  // (facilitator-as-provider auth). --status is a BOOLEAN flag, not listed here.
  "--admin",
  "--expires-at",
  "--days",
  "--operator-token",
]);

/** First value following `--<name>` in `args`, or undefined. */
export function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** True when the boolean switch `--<name>` is present anywhere in `args` (it takes
 *  no value). Used by `merge --dry-run` and `merge --yes`. */
export function boolFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

/**
 * Parse a positive-integer `--<name> <n>` flag. Returns undefined when the flag
 * is absent; THROWS on a present-but-invalid value (non-integer, ≤ 0) so a
 * fat-fingered `--batch abc` fails fast with a clear message instead of silently
 * falling back to a default. Pure (no process.exit) so it is unit-testable.
 */
export function intFlag(
  args: readonly string[],
  name: string
): number | undefined {
  const raw = flag(args, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return n;
}

/**
 * Positional args with any known `--flag <value>` pairs removed, so a command
 * can read its positional (e.g. `pay <url>`) regardless of where the flags
 * were placed on the line. A trailing `--flag` with no value still consumes
 * the (missing) value slot, matching `flag()`'s lookahead.
 */
export function positionals(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (VALUE_FLAGS.has(a)) {
      i += 1; // skip this flag's value
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Resolve the relay (facilitator) URL: `--relay-url` flag wins, else the
 * CANTON_AGENT_RELAY_URL env var. There is intentionally NO default — a
 * stale built-in default silently sends an agent's payments to a dead host,
 * so the caller must fail fast when this returns undefined.
 */
export function resolveRelayUrl(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return flag(args, "--relay-url") || env.CANTON_AGENT_RELAY_URL || undefined;
}

/** Network: `--network` flag wins, else CANTON_AGENT_NETWORK, else testnet. */
export function resolveNetwork(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): string {
  return flag(args, "--network") || env.CANTON_AGENT_NETWORK || DEFAULT_NETWORK;
}

/** Message shown when no relay URL is supplied (flag or env). */
export const MISSING_RELAY_HELP =
  "no relay URL — pass --relay-url <url> or set CANTON_AGENT_RELAY_URL.\n" +
  "  e.g. canton-agent-wallet create --relay-url https://facilitator.ftptech.xyz";
