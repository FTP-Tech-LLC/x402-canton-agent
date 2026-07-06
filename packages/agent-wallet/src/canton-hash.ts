/**
 * canton-hash — the OFFICIAL Canton hash recompute, wired so the agent's
 * Ed25519 signature is cryptographically bound to the bytes it verified.
 *
 * WHY THIS EXISTS
 * ---------------
 * The agent's self-custody guarantee has two independent legs (see
 * verify-prepared.ts):
 *
 *   1. STRUCTURAL verify ("the bytes match my intent") — decode the relay's
 *      `PreparedTransaction` / topology bytes and pin receiver/amount/instrument
 *      (transfer) or own-key/own-namespace (onboarding) to caller intent.
 *   2. HASH recompute ("I signed the bytes I saw") — recompute the signing hash
 *      from those exact bytes EXACTLY as the Canton participant does on
 *      `execute`/`allocate`, compare it to the relay-returned hash, and sign the
 *      RECOMPUTED value. This defeats a relay that returns structurally-honest
 *      bytes paired with the hash of a DIFFERENT transaction (then forwards the
 *      different bytes to the participant).
 *
 * Leg 2 was missing — `hash-binding.ts` was fail-closed with no conformant
 * recompute. This module supplies it by delegating to the official, published,
 * Apache-2.0 `@canton-network/core-tx-visualizer` (the same code the rest of the
 * Canton wallet ecosystem signs with), so the bytes-exact V2 algorithm is the
 * library's problem, not a hand-reimplementation's. The conformance test
 * (`canton-hash.conformance.test.ts`) gates trusting it against live vectors.
 *
 * We deliberately do NOT use the SDK's `sign()` — it signs the relay-returned
 * hash directly with no recompute/compare, which would reproduce the blind-sign
 * bug. We use the library only for HASHING and keep our own compare-then-sign.
 */
import {
  hashPreparedTransaction,
  computeSha256CantonHash,
  computeMultiHashForTopology,
} from "@canton-network/core-tx-visualizer";

/**
 * Canton HashPurpose integers (4-byte big-endian domain-separation prefixes),
 * confirmed against canonical Canton
 * `community/base/.../crypto/HashPurpose.scala`. These are stable API: ids are
 * eagerly-initialized and never reused.
 */
export const HASH_PURPOSE = {
  /** Per onboarding/topology transaction hash. */
  TopologyTransactionSignature: 11,
  /** Derive a public-key fingerprint (party namespace) from raw key bytes. */
  PublicKeyFingerprint: 12,
  /** The combined multiHash over all topology transaction hashes. */
  MultiTopologyTransaction: 55,
} as const;

/**
 * Recompute the prepared-transaction signing hash (Canton
 * HASHING_SCHEME_VERSION_V2) from the EXACT base64 `preparedTransaction` the
 * relay returns from `POST /v1/wallet/submit/prepare`, returning it base64.
 *
 * This is hash (1): a Merkle hash over the Daml transaction node tree, returned
 * as the raw 32 bytes (NOT multihash-framed) base64-encoded — exactly what the
 * relay returns as `hash`. Compare base64-to-base64; sign the RECOMPUTED value.
 *
 * Async: `hashPreparedTransaction` uses WebCrypto (`crypto.subtle.digest`).
 */
export function recomputeHash(preparedTransactionB64: string): Promise<string> {
  return hashPreparedTransaction(preparedTransactionB64, "base64");
}

/**
 * Recompute the onboarding topology multiHash (hash (2)) from the array of
 * base64 `onboardingTransactions` the relay returns from
 * `POST /v1/wallet/onboard/prepare`, returning it base64 to compare against the
 * relay's `hashToSign`.
 *
 * Algorithm (spec A.3 / B.4), 4-line wrapper over the library primitives:
 *   h_i      = computeSha256CantonHash(11, raw_i)        // per-tx, 34B framed
 *   combined = computeMultiHashForTopology([h_0, h_1..])  // sorted-by-hex, framed
 *   multiHash= computeSha256CantonHash(55, combined)      // combined, 34B framed
 *
 * The per-tx hash is over the RAW topology-transaction bytes as delivered (the
 * hasher never decodes the proto), and `computeMultiHashForTopology` sorts the
 * per-tx hashes by lowercase-hex ascending before combining — so the ORDER of
 * `onboardingTransactions` does not matter. Both the per-tx hashes and the final
 * multiHash are multihash-framed (0x12 0x20 prefix, 34 bytes); we compare the
 * base64 verbatim and never strip the prefix.
 */
export async function recomputeTopologyMultiHash(
  onboardingTxB64: string[]
): Promise<string> {
  const raw = await Promise.all(
    onboardingTxB64.map((b64) =>
      computeSha256CantonHash(
        HASH_PURPOSE.TopologyTransactionSignature,
        bytesFromB64(b64)
      )
    )
  );
  const combined = await computeMultiHashForTopology(raw);
  const hash = await computeSha256CantonHash(
    HASH_PURPOSE.MultiTopologyTransaction,
    combined
  );
  return Buffer.from(hash).toString("base64");
}

/**
 * Derive a Canton public-key fingerprint from raw public-key bytes:
 * `hex( computeSha256CantonHash(12, publicKeyBytes) )` (spec B.5). The result is
 * the multihash-framed (0x12 0x20 + 32 = 34 bytes) hash rendered as lowercase
 * hex (68 chars) — the form Canton uses for the `publicKeyFingerprint` / party
 * namespace.
 *
 * NOTE on which key-byte form to pass: Canton's fingerprint preimage is a
 * specific serialization of the signing public key. Callers that need to match a
 * relay-returned `publicKeyFingerprint` should try both the SPKI/DER bytes and
 * the bare 32-byte Ed25519 point and keep the one that matches (see
 * `onboard.ts`); this function is a pure transform over whatever bytes it is
 * given, and the surrounding assert is fail-closed so a wrong guess refuses.
 */
export async function fingerprintHex(
  publicKeyBytes: Uint8Array
): Promise<string> {
  const framed = await computeSha256CantonHash(
    HASH_PURPOSE.PublicKeyFingerprint,
    publicKeyBytes
  );
  return Buffer.from(framed).toString("hex");
}

/** Decode a base64 string to bytes; throws on invalid base64-derived empties is
 *  left to the library's own digest (empty input still hashes). Kept tiny and
 *  dependency-free so the hash adapters stay pure. */
function bytesFromB64(b64: string): Uint8Array {
  return Buffer.from(b64, "base64");
}
