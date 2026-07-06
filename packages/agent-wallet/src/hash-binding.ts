/**
 * Resolve how the agent binds the relay-returned prepared-transaction hash to
 * the bytes it validated, for the CLI / autopay paths (`makeRelaySigner`,
 * `withdraw`, `claimAll`).
 *
 * SECURITY DEFAULT: REAL cryptographic binding. With no configuration, the
 * default now recomputes the prepared-transaction hash from the bytes the agent
 * validated, EXACTLY as the Canton participant does on `execute`
 * (HASHING_SCHEME_VERSION_V2 via `@canton-network/core-tx-visualizer`), and
 * `assertHashBinding` signs the RECOMPUTED value only if it equals the relay
 * `hash` — refusing otherwise. This satisfies the Canton Ledger API requirement:
 * "clients MUST recompute the hash from the raw transaction if the preparing
 * participant is not trusted." The previous fail-closed `{}` default existed
 * only because no conformant recompute was wired; it now is.
 *
 * Escape hatch, off by default:
 *   CANTON_AGENT_TRUST_RELAY_HASH=1 accepts the relay's hash WITHOUT
 *   recomputation. This re-opens the blind-signing risk and is only acceptable
 *   when a human reviews each transfer or the relay is fully trusted. It is the
 *   documented last-resort fallback (e.g. if a future participant hashing-scheme
 *   change outpaces the pinned library and the operator must sign before the
 *   library catches up). Never assumed; must be explicitly set.
 *
 * The recompute is conformance-tested against captured live participant vectors
 * (`canton-hash.conformance.test.ts`); a wrong recompute fails honest transfers
 * CLOSED (refused) rather than mis-binding — it can never silently accept a
 * relay-chosen hash.
 */
import type { HashBindingOptions } from "./verify-prepared.js";
import { recomputeHash } from "./canton-hash.js";

/** The env var an operator sets to accept the relay hash without recomputing. */
export const TRUST_RELAY_HASH_ENV = "CANTON_AGENT_TRUST_RELAY_HASH";

function envSaysTrustRelayHash(env: NodeJS.ProcessEnv): boolean {
  const v = (env[TRUST_RELAY_HASH_ENV] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Build the default `HashBindingOptions` for the CLI/autopay paths from the
 * environment. Returns `{ trustRelayHash: true }` ONLY when the operator has
 * explicitly opted into the dangerous escape hatch; otherwise returns the REAL
 * binding `{ recomputeHash }` (the conformant V2 recompute), which makes
 * `assertHashBinding` sign the recomputed hash and refuse on any mismatch.
 */
export function resolveHashBinding(
  env: NodeJS.ProcessEnv = process.env
): HashBindingOptions {
  if (envSaysTrustRelayHash(env)) return { trustRelayHash: true };
  return { recomputeHash };
}
