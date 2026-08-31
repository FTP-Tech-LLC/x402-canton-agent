/**
 * Venue attribution — stamps a caller-configured `<name>/venue` metadata key onto
 * outbound transfers of a CIP-56 registry token, so a token issuer's off-chain
 * metrics can credit this wallet's activity to a named venue.
 *
 * The motivating case is BitSafe's CBTC Incentive Program: a CBTC transfer WE
 * author carries `ftp/venue = ftp/agentic-wallet`, which BitSafe's metrics API
 * filters on to attribute — and pay an app-reward share for — FTP's CBTC activity.
 * Post-CIP-104 there is no on-ledger per-transaction beneficiary split, so this tag
 * is the SOLE basis of attribution. It is written generically: it stamps EVERY
 * outbound registry token (not just CBTC), so other issuers' programs
 * (USDXLR/cETH/…) work with no code change, and any operator of this (public)
 * wallet can set their OWN key + value.
 *
 * OFF BY DEFAULT: both the key (`CANTON_AGENT_VENUE_KEY`) and the value
 * (`CANTON_AGENT_VENUE_TAG`) come from env; with either unset nothing is stamped,
 * so a public wallet user never emits someone else's venue tag. The tag rides in
 * `transfer.meta.values` (a standard CIP-56 field) — advisory, not money-critical,
 * and not pinned by verify-before-sign; a stray value can only misattribute a
 * reward, never move funds. Canton Coin (Amulet) is never stamped: it is not a
 * CIP-56 registry token and its rewards accrue through the ordinary Amulet path.
 */

/** Env holding the metadata KEY. MUST end in `/venue` and be at most 64 chars
 *  (e.g. `ftp/venue`) — the facilitator's pay/prepare enforces exactly this, so a
 *  key that doesn't conform is refused here too rather than stamped on one path
 *  (withdraw) and 400-rejected on another (pay). Unset/empty → attribution off. */
export const VENUE_KEY_ENV = "CANTON_AGENT_VENUE_KEY";

/** Env holding the venue VALUE string, at most 128 chars (e.g.
 *  `ftp/agentic-wallet`). Unset/empty → attribution off. */
export const VENUE_TAG_ENV = "CANTON_AGENT_VENUE_TAG";

/** The key suffix + size bounds the facilitator's pay/prepare enforces. ONE rule,
 *  enforced at the source: a non-conforming env config stamps NOTHING anywhere,
 *  instead of working on withdraw/swap-sell and then 400-failing every
 *  registry-token x402 payment (which reads as a pay-path outage, with the env
 *  var nowhere near the error). */
const VENUE_KEY_SUFFIX = "/venue";
const VENUE_KEY_MAX = 64;
const VENUE_TAG_MAX = 128;

let warnedInvalid = false;

/**
 * The venue meta to merge onto an outbound transfer of `(admin, id)`. Returns
 * `{ [key]: tag }` only when BOTH env vars are set, the key ends in `/venue`
 * within the size bounds above, AND the instrument is a CIP-56 registry token —
 * i.e. `admin` and `id` are defined and `id` is not `"Amulet"`. Otherwise `{}`:
 * Canton Coin (no registry admin, or the Amulet id), either env unconfigured, or
 * a non-conforming key/tag (warned once on stderr) all yield no stamp. Any
 * registry token is attributed — there is no per-token allowlist.
 */
export function venueMetaForInstrument(
  admin: string | undefined,
  id: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const key = env[VENUE_KEY_ENV]?.trim();
  const tag = env[VENUE_TAG_ENV]?.trim();
  if (!key || !tag) return {};
  if (
    !key.endsWith(VENUE_KEY_SUFFIX) ||
    key.length > VENUE_KEY_MAX ||
    tag.length > VENUE_TAG_MAX
  ) {
    if (!warnedInvalid) {
      warnedInvalid = true;
      console.error(
        `! venue attribution disabled: ${VENUE_KEY_ENV} must end in "${VENUE_KEY_SUFFIX}" ` +
          `(<=${VENUE_KEY_MAX} chars) and ${VENUE_TAG_ENV} must be <=${VENUE_TAG_MAX} chars`
      );
    }
    return {};
  }
  if (admin === undefined || id === undefined) return {}; // Canton Coin: no registry instrument
  if (id === "Amulet") return {}; // Amulet is Canton Coin, not a registry token
  return { [key]: tag };
}
