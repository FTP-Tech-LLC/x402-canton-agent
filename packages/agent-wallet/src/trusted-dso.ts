/**
 * Resolve the agent's INDEPENDENTLY-TRUSTED Amulet DSO party (the instrument
 * admin) from the environment, for the CLI / autopay / withdraw paths.
 *
 * WHY THIS EXISTS (self-custody, post round-3 fix). verify-before-sign pins the
 * money-critical fields to caller intent and runs an all-nodes foreign-party
 * backstop. The one party it reads-but-does-not-pin is the relay-supplied
 * instrument admin / expectedDso (the DSO). The honest transfer choice's
 * consequence (the created TransferCommand) legitimately carries that DSO as a
 * payload party + signatory, OUTSIDE the root choice argument. To keep the
 * backstop sound, an admin/dso value is excluded outside its root position ONLY
 * when the caller pins it to an INDEPENDENTLY-TRUSTED value; otherwise a malicious
 * relay could alias the unpinned admin/dso to an attacker and inject that same
 * value as a consequence / node-metadata / input-contract party (the
 * neutralization the round-3 fix closes by REMOVING the no-pin value-global
 * fallback). Consequently a value-moving transfer whose prepared bytes carry the
 * DSO outside the root now FAILS CLOSED unless this trusted pin is supplied.
 *
 * The Amulet DSO party is a NETWORK-WIDE CONSTANT (the same for every wallet on a
 * given Canton network), so the operator can configure it out-of-band ONCE — it
 * is NOT learned from the relay (anchoring on the relay's own resolve response
 * would be circular and provide no security). Set CANTON_AGENT_DSO_PARTY to the
 * network's Amulet DSO party id. When unset, value-moving transfers that carry
 * the DSO outside the root refuse to sign (fail-closed, the secure default).
 */

/** The env var an operator sets to the network's Amulet DSO (instrument admin). */
export const TRUSTED_DSO_PARTY_ENV = "CANTON_AGENT_DSO_PARTY";

/**
 * Known Amulet DSO party ids per Canton network. The DSO is a NETWORK-WIDE
 * CONSTANT — the Super-Validator collective party that signs AmuletRules — so it
 * is safe to bake in as an independently-trusted anchor (it is NOT learned from
 * the relay). This lets the CLI auto-pin the DSO for the common networks so a v1
 * `pay` works out of the box; the env var still overrides if a network's DSO is
 * ever rotated or for a network not listed here.
 *
 * mainnet DSO confirmed live from Scan `/api/scan/v0/dso-party-id` (2026-06).
 * Other networks are intentionally absent until confirmed — they fall back to
 * the env var (fail-closed if also unset).
 */
export const KNOWN_DSO_BY_NETWORK: Readonly<Record<string, string>> = {
  "canton:mainnet":
    "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc",
};

/**
 * The independently-trusted DSO/instrument-admin party id, or undefined when
 * neither the env var nor a baked-in network constant supplies one.
 *
 * Precedence: explicit `CANTON_AGENT_DSO_PARTY` env (trimmed) wins, else the
 * baked-in {@link KNOWN_DSO_BY_NETWORK} value for `network`, else undefined
 * (value-moving transfers then fail closed — the secure default).
 */
export function resolveTrustedDsoParty(
  env: NodeJS.ProcessEnv = process.env,
  network?: string
): string | undefined {
  const v = (env[TRUSTED_DSO_PARTY_ENV] ?? "").trim();
  if (v.length > 0) return v;
  if (network && KNOWN_DSO_BY_NETWORK[network]) {
    return KNOWN_DSO_BY_NETWORK[network];
  }
  return undefined;
}
