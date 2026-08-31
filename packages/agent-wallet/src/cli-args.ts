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
  "--asset",
  "--in",
  "--out",
  "--slippage",
  "--max-fee",
  "--swap-merchant",
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
  // BOTH spellings. `--amount 5` and `--amount=5` are the same instruction to
  // anyone who has used a CLI, and only the first was read. The equals form fell
  // through to "flag absent", which on `withdraw` means "send the FULL balance"
  // — a user who typed an amount got their whole wallet swept. Published
  // command, real money, one keystroke apart.
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq !== undefined) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** True when `--<name>` appears in either spelling: bare, or `--<name>=value`.
 *  The presence check has to agree with `flag()`, or a value the parser CAN read
 *  is treated as absent by the caller that asked whether it was given. */
export function flagPresent(args: readonly string[], name: string): boolean {
  return args.includes(name) || args.some((a) => a.startsWith(`${name}=`));
}

/**
 * True when the boolean switch `--<name>` is present anywhere in `args` (it
 * takes no value). Used by `merge --dry-run`/`--yes`, `preapproval --status`
 * and `--force`.
 *
 * THE EQUALS SPELLING IS REFUSED, NOT INTERPRETED. `flag()` and `flagPresent()`
 * above were both taught `--name=value` after the equals form on
 * `withdraw --amount=5` read as "amount absent" and swept the whole wallet.
 * This third reader stayed on a bare `includes()`, so the same keystroke has
 * the same shape of consequence: `merge --dry-run=true` reads as dry-run
 * ABSENT and submits real batch transfers instead of printing a plan;
 * `preapproval --status=true` runs the real preapproval.
 *
 * Guessing is not an option in either direction — reading mere presence turns
 * `--dry-run=false` into a dry run, and reading the value turns a typo'd
 * `--dry-run=yes` into real transfers. Both pick an outcome nobody asked for.
 * The bare spelling is the only unambiguous one, so name it and stop.
 */
export function boolFlag(args: readonly string[], name: string): boolean {
  const withValue = args.find((a) => a.startsWith(`${name}=`));
  if (withValue !== undefined) {
    throw new Error(
      `${name} is a switch and takes no value — write ${name} on its own, or ` +
        `omit it. Got ${JSON.stringify(withValue)}; refusing to guess whether ` +
        `that meant on or off.`
    );
  }
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

/**
 * The `--amount` decision for `withdraw`, as a value rather than a branch.
 *
 * Omitting `--amount` means "send the FULL balance". The CLI used to funnel the
 * flag through a truthiness filter, so `--amount ""` and a trailing `--amount`
 * with no value read exactly like omission — and `--amount "$AMT"` with AMT
 * unset swept the whole wallet, with no confirmation and only an after-the-fact
 * log line. withdraw() would itself have refused the empty string; the filter is
 * what turned a clean refusal into a sweep.
 *
 * Same rule `intFlag` already states for value flags: present-but-invalid fails
 * fast instead of falling back to a default. Pure, so it is testable.
 */
export function withdrawAmount(
  args: readonly string[]
): { kind: "full" } | { kind: "amount"; amount: string } | { kind: "error"; message: string } {
  if (!flagPresent(args, "--amount")) return { kind: "full" };
  const raw = flag(args, "--amount");
  if (raw === undefined || raw.trim() === "") {
    return {
      kind: "error",
      message:
        "withdraw --amount was given with no value — refusing. Omit --amount " +
        "entirely to send the FULL balance, or pass an explicit amount.",
    };
  }
  return { kind: "amount", amount: raw };
}

/**
 * Which preapproval mode `preapproval` runs in.
 *
 * ONLY the flag decides. This used to OR in `process.env.CANTON_X402_OPERATOR_TOKEN`,
 * and that name belongs to another component: everywhere else in this repo it is
 * the FACILITATOR SERVER's own secret, gating operator mutations. Sourcing the
 * facilitator's .env — ordinary on the facilitator host — silently changed which
 * party becomes the preapproval provider and who prepays the holding fee, with
 * no flag and nothing in the output before submission.
 *
 * An ambient value is not an instruction; it is reported as ignored so the
 * operator can opt in on purpose.
 */
export function preapprovalMode(
  args: readonly string[],
  env: Record<string, string | undefined>
): { mode: "self"; ambientIgnored: boolean } | { mode: "legacy"; operatorToken: string } {
  const token = flag(args, "--operator-token");
  if (token !== undefined && token.trim() !== "") {
    return { mode: "legacy", operatorToken: token };
  }
  return {
    mode: "self",
    ambientIgnored: Boolean(env["CANTON_X402_OPERATOR_TOKEN"]),
  };
}
