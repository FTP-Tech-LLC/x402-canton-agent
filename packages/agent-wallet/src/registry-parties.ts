/**
 * Resolve the agent's INDEPENDENTLY-TRUSTED registry infrastructure parties for a
 * non-Amulet CIP-56 token whose registrar runs a DA Registry Utility (USDCx, and
 * the rest of the registry family). This is the registry-token analogue of
 * `trusted-dso.ts`.
 *
 * WHY THIS EXISTS (self-custody). verify-before-sign
 * (`assertPreparedTransferMatches`) pins the money-critical fields and runs an
 * all-nodes foreign-party backstop. A real registry `TransferFactory_Transfer`
 * legitimately names the registry OPERATOR and, for a bridged token, the mint
 * BRIDGE-OPERATOR as signatories/observers of the holding + rule + preapproval
 * contracts — OUTSIDE the transfer's sender/receiver. To keep the backstop sound
 * those parties are admitted ONLY when the caller pins them to an INDEPENDENTLY-
 * TRUSTED value (`trustedRegistryParties`), never a relay-supplied one — exactly
 * as the DSO is for Amulet. The instrument ADMIN (registrar) is pinned separately
 * via `instrumentAdmin`; this set is the EXTRA infra parties beyond it.
 *
 * These parties are NETWORK-WIDE CONSTANTS per registrar (the same operator/bridge
 * for every transfer of that token on a given network), so they are configured
 * out-of-band ONCE and are NOT learned from the relay/402 (which would be
 * circular). Set `CANTON_AGENT_REGISTRY_TRUSTED_PARTIES` to a JSON object mapping
 * instrument-admin party id → array of trusted infra party ids. A baked-in table
 * of confirmed mainnet registries makes the common case work out of the box,
 * exactly like `KNOWN_DSO_BY_NETWORK`; the env merges on top / overrides.
 *
 * GENERIC: nothing here is keyed on a token symbol. A new registry token is added
 * by an env entry (or a confirmed constant), never by code.
 */

/** JSON env: `{ "<instrument-admin>": ["<operator>", "<bridge>", …] }`. */
export const REGISTRY_TRUSTED_PARTIES_ENV = "CANTON_AGENT_REGISTRY_TRUSTED_PARTIES";

/**
 * Confirmed mainnet registry infra parties, keyed by instrument-admin (registrar)
 * party id. Baked in as an out-of-band convenience anchor (network constants, not
 * relay-learned), overridable/extendable via the env. USDCx's registrar
 * `decentralized-usdc-interchain-rep::1220…` → the DA Registry Utility operator +
 * the xReserve Bridge-Operator, both confirmed on a live MainNet USDCx
 * `TransferFactory_Transfer`.
 */
/** DA Registry Utility operator, shared by EVERY instrument the utility hosts
 *  (verified live at /api/utilities/v0/operator — identical for USDCx, CBTC,
 *  USDXLR, cETH). It appears on every DA-Utility `TransferFactory_Transfer`. */
const DA_UTILITY_OPERATOR =
  "auth0_007c6643538f2eadd3e573dd05b9::12205bcc106efa0eaa7f18dc491e5c6f5fb9b0cc68dc110ae66f4ed6467475d7c78e";

export const KNOWN_REGISTRY_TRUSTED_PARTIES: Readonly<
  Record<string, readonly string[]>
> = {
  "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef":
    [
      // DA Registry Utility operator (from /api/utilities/v0/operator).
      DA_UTILITY_OPERATOR,
      // xReserve Bridge-Operator (mints/burns USDCx; signatory on the holding).
      "Bridge-Operator::1220c8448890a70e65f6906bd48d797ee6551f094e9e6a53e329fd5b2b549334f13f",
    ],
  // CBTC (BitSafe), USDXLR (Excellar), cETH (onRails) — all DA Registry Utility
  // instruments, so each carries the shared operator above. A token-specific infra
  // party is added when its transfers reference one: CBTC declares a fee/config
  // "cbtc-beneficiary" party in its registrar-authored InstrumentConfiguration
  // (verified: it appears only in the authenticated InstrumentConfiguration input
  // contract — never as a value owner or recipient — so a relay cannot forge it).
  // cETH instead uses per-user parties minted UNDER ITS OWN NAMESPACE, which are
  // trusted generically by the same-namespace rule in @ftptech/x402-canton-core's
  // foreign-party backstop, so none need listing here.
  "cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262":
    [
      DA_UTILITY_OPERATOR,
      // CBTC beneficiary declared in the registrar's InstrumentConfiguration.
      "cbtc-beneficiary::1220409a9fcc5ff6422e29ab978c22c004dde33202546b4bcbde24b25b85353366c2",
    ],
  "excellar-issuer::12203d1e36930ee0e3fbb898add7e222a47ae9d2a5f0f6187e3a446ea32f871ce2ca":
    [DA_UTILITY_OPERATOR],
  "rails-cethMain-1::12200350ba6e96e3b701c3048b5aa013a8c1c08833e8ebf54339cff581055c29003a":
    [DA_UTILITY_OPERATOR],
  "ember-silver::1220ad9c097ae75192b4716854fa413aa8582c86a62b16714663cdab55e025cc79c4":
    [DA_UTILITY_OPERATOR],
  "ember-gold::1220ad9c097ae75192b4716854fa413aa8582c86a62b16714663cdab55e025cc79c4":
    [DA_UTILITY_OPERATOR],
};

/** MainNet symbol → {admin, id} for the DA Registry Utility instruments this
 *  wallet knows out of the box (all `decimals: 10`). Canton Coin is NOT here —
 *  it is the native Amulet, named by omitting an instrument. Used by `swap` to
 *  resolve `--in USDCx` locally; the fee-ticket path (facilitator /swap) carries
 *  its own resolved instruments, which take precedence on DevNet/other networks. */
export const KNOWN_INSTRUMENTS: Readonly<
  Record<string, { admin: string; id: string }>
> = {
  USDCx: {
    admin:
      "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef",
    id: "USDCx",
  },
  CBTC: {
    admin:
      "cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262",
    id: "CBTC",
  },
  USDXLR: {
    admin:
      "excellar-issuer::12203d1e36930ee0e3fbb898add7e222a47ae9d2a5f0f6187e3a446ea32f871ce2ca",
    id: "USDXLR",
  },
  cETH: {
    admin:
      "rails-cethMain-1::12200350ba6e96e3b701c3048b5aa013a8c1c08833e8ebf54339cff581055c29003a",
    id: "cETH",
  },
  // Ember tokenized metals (eXAG = silver, eXAU = gold), both DA Registry Utility
  // instruments (live metadata resolves, decimals 10) — same shared packages, no new
  // DARs to receive; ids verified from Tradecraft's /v1/tokenB and the DA Utility.
  eXAG: {
    admin:
      "ember-silver::1220ad9c097ae75192b4716854fa413aa8582c86a62b16714663cdab55e025cc79c4",
    id: "eXAG",
  },
  eXAU: {
    admin:
      "ember-gold::1220ad9c097ae75192b4716854fa413aa8582c86a62b16714663cdab55e025cc79c4",
    id: "eXAU",
  },
};

/**
 * Resolve a swap leg symbol to a CANONICAL form, distinguishing the three cases a
 * swap must never confuse:
 *  - `{ kind: "cc" }`         — native Canton Coin (canonical symbol `"CC"`).
 *  - `{ kind: "registry" }`   — a known registry token, with its `instrument`
 *                               ({admin,id}) and canonical `symbol` (correct case).
 *  - `{ kind: "unknown" }`    — anything else. The caller MUST reject this rather
 *                               than fall back to CC, so a typo like `USDC` (for
 *                               `USDCx`) can never silently send real Canton Coin.
 *
 * The canonical symbol is what the pool-party name and the Tradecraft quote URL
 * must use, so an input like `usdcx` resolves to `USDCx` and targets the real pool
 * rather than a case-mismatched, non-existent one.
 */
export type SwapSymbol =
  | { kind: "cc"; symbol: "CC" }
  | { kind: "registry"; symbol: string; instrument: { admin: string; id: string } }
  | { kind: "unknown" };

export function resolveSwapSymbol(symbol: string): SwapSymbol {
  const s = symbol.trim().toLowerCase();
  if (s === "cc" || s === "canton-coin" || s === "amulet") {
    return { kind: "cc", symbol: "CC" };
  }
  for (const [sym, instrument] of Object.entries(KNOWN_INSTRUMENTS)) {
    if (sym.toLowerCase() === s) {
      return { kind: "registry", symbol: sym, instrument };
    }
  }
  return { kind: "unknown" };
}

/** Parse the env JSON (admin → party[]) fail-closed to `{}` on any malformation. */
function parseEnvTrustedParties(
  raw: string | undefined
): Record<string, readonly string[]> {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string[]> = {};
    for (const [admin, parties] of Object.entries(parsed)) {
      if (!Array.isArray(parties)) continue;
      const ps = parties.filter(
        (p): p is string => typeof p === "string" && p.length > 0
      );
      if (ps.length > 0) out[admin] = ps;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The independently-trusted registry infra party set for `instrumentAdmin`, or an
 * empty set when the admin is not a known/configured registry (Amulet, or an
 * unconfigured token). Env entries MERGE with (and can extend) the baked-in
 * constants for the same admin.
 */
export function resolveTrustedRegistryParties(
  instrumentAdmin: string,
  env: NodeJS.ProcessEnv = process.env
): ReadonlySet<string> {
  const fromEnv = parseEnvTrustedParties(env[REGISTRY_TRUSTED_PARTIES_ENV]);
  const set = new Set<string>();
  for (const p of KNOWN_REGISTRY_TRUSTED_PARTIES[instrumentAdmin] ?? []) set.add(p);
  for (const p of fromEnv[instrumentAdmin] ?? []) set.add(p);
  return set;
}

/**
 * Whether `instrumentAdmin` is an independently-trusted registry admin — i.e. the
 * agent has an out-of-band trust anchor for it (a baked-in or env-configured infra
 * set). Only then may the admin be pinned from the 402-supplied value; otherwise a
 * value-moving transfer keeps the Amulet DSO anchor / fails closed.
 */
export function isTrustedRegistryAdmin(
  instrumentAdmin: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return resolveTrustedRegistryParties(instrumentAdmin, env).size > 0;
}

/** Env naming the registry instruments this wallet MAY SPEND, e.g.
 *  `CANTON_AGENT_PAYABLE_INSTRUMENTS="<admin>|USDCx,<admin2>|EURx"`. */
export const PAYABLE_INSTRUMENTS_ENV = "CANTON_AGENT_PAYABLE_INSTRUMENTS";

/** Canonical key for an instrument, used by both the consent list and the
 *  per-instrument ceilings so the two can never drift apart. */
export function instrumentKey(admin: string, id: string): string {
  return `${admin}|${id}`;
}

/**
 * MAY THIS WALLET SPEND THIS INSTRUMENT?
 *
 * Deliberately a DIFFERENT question from {@link isTrustedRegistryAdmin}, and
 * keeping them separate is the whole point. Trusting a registry says "I can
 * verify what its transfers look like, so its operator appearing in a transfer
 * is not a foreign party". It does not say "spend my balance of that token".
 *
 * Conflating the two hands the choice of denomination to whoever wrote the 402:
 * a merchant serving `instrumentId: {admin: <known registrar>, id: "USDCx"}`
 * would have the wallet pay in USDCx purely because the registrar is baked in,
 * with no operator ever having said so. Spending is opt-in, per instrument, and
 * defaults to none — Canton Coin is unaffected because it is not a registry
 * instrument and never reaches this check.
 */
export function isPayableInstrument(
  admin: string,
  id: string,
  allowFromCaller: readonly string[] | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const key = instrumentKey(admin, id);
  if (allowFromCaller?.some((k) => k.trim() === key)) return true;
  const raw = (env[PAYABLE_INSTRUMENTS_ENV] ?? "").trim();
  if (raw.length === 0) return false;
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .includes(key);
}
