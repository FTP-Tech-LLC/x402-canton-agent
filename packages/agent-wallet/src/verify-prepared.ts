/**
 * verify-before-sign — defend the agent's self-custody key against a malicious
 * or compromised relay.
 *
 * THREAT MODEL
 * ------------
 * The agent builds a `TransferFactory_Transfer` (sender / receiver / amount /
 * instrumentId) and asks the relay to PREPARE it. The relay returns an opaque
 * `preparedTransaction` (a base64 Canton `PreparedTransaction` protobuf) plus
 * the `hash` the agent is expected to sign. The agent then signs that hash with
 * its own key. README/docs promise self-custody: "the relay never holds the key
 * and cannot move the agent's funds". But if the agent signs the relay-returned
 * hash BLINDLY, a compromised relay can prepare a DIFFERENT transfer (swap the
 * receiver, inflate the amount, change the instrument) and hand back its hash —
 * the agent's signature would then authorize the attacker's transfer. Blind
 * signing breaks the self-custody guarantee.
 *
 * APPROACH (STRUCTURAL decode, schema-pinned, zero-dependency)
 * ------------------------------------------------------------
 * We do NOT substring-scan the blob. We decode the Canton `PreparedTransaction`
 * protobuf STRUCTURALLY, descending by *field number* through exactly the path
 * Canton serializes (the field numbers are taken from the published Ledger API
 * `.proto`s — see FIELD MAP below). We reach the `Exercise` node that runs the
 * transfer choice, read its `chosen_value` (the choice-argument `Value` tree),
 * and pull the transfer's sender / receiver / amount / instrumentId.id from
 * their REAL typed positions:
 *
 *   - a recipient/sender is a Daml `Party`, serialized as `Value.party`
 *     (oneof tag 7) — never `Value.text`. An attacker cannot disguise a
 *     redirect as a text field.
 *   - the amount is a Daml `Numeric`, serialized as `Value.numeric` (oneof
 *     tag 6) — at the transfer record's amount position, not "somewhere".
 *
 * We then compare the EXTRACTED values to the caller's INTENT (sender ==
 * wallet.party, receiver == the intended payTo, amount == the EXACT requested
 * amount, instrumentId.id == the caller-known instrument). Crucially we NEVER
 * trust a value taken from the relay's prepared bytes (or its resolve response)
 * as a whitelist — the recipient is pinned to caller intent by exact equality
 * at its structural position, so a relay-supplied admin/party can never widen
 * what we will sign. Every legal Canton party-id form is accepted (dots,
 * non-hex namespaces, spaces) because we identify parties by their protobuf
 * type, not by a regex.
 *
 * As an independent backstop we also assert that NO party value anywhere in the
 * choice argument is a *recipient/sender* other than {wallet.party, intended
 * payTo} (the instrument admin is allowed ONLY at its `instrumentId.admin`
 * position). Any relay-injected extra leg paying a third party shows up as a
 * foreign party and is rejected.
 *
 * UNAMBIGUOUS DECODE (no first-vs-last-wins divergence). Every field we read is
 * NON-REPEATED in the schema, so we reject ANY duplicate occurrence of it
 * (`lenFieldUnique`) and reject any `Value` that sets a oneof member more than
 * once or sets two different members (`assertSingleValueMember`), plus duplicate
 * record-field labels. The protobuf wire format keeps the LAST occurrence of a
 * non-repeated field/oneof member, and Canton's ScalaPB parser follows that; a
 * hand-rolled FIRST-wins reader would otherwise let an attacker hide an inflated
 * amount (or swapped receiver/choice) as a second occurrence past a decoy first
 * one. We fail closed on the ambiguity instead of guessing.
 *
 * HASH BINDING (we must sign the hash OF the bytes we validated). Validating the
 * bytes is necessary but not sufficient: a compromised relay can return honest
 * bytes paired with the hash of a DIFFERENT transaction and swap the bytes it
 * forwards to the participant. So `assertHashBinding` (wired in tx.ts) REQUIRES
 * the relay-returned hash to equal a locally-recomputed hash of the validated
 * bytes (or an explicit, off-by-default opt-in to trust the relay) and refuses
 * otherwise — the Canton Ledger API itself mandates recomputing the hash when
 * the preparing participant is untrusted. Any swap of receiver/amount/instrument
 * changes the bytes, fails its exact-equality check here, AND changes the
 * recomputed hash. Fail-closed in every case.
 *
 * FIELD MAP (com.daml.ledger.api.v2 Ledger API protos)
 * ----------------------------------------------------
 *   PreparedTransaction          .transaction         = 1   (DamlTransaction)
 *                                .metadata            = 2   (Metadata)
 *   Metadata                     .submitter_info      = 2   (SubmitterInfo)
 *   Metadata.SubmitterInfo       .act_as (repeated)   = 1   (string party)
 *   DamlTransaction              .nodes  (repeated)   = 3   (Node)
 *   DamlTransaction.Node         .v1                  = 1000 (transaction.v1.Node)
 *   transaction.v1.Node          .exercise            = 3   (Exercise)
 *   transaction.v1.Exercise      .template_id         = 4   (Identifier)
 *                                .choice_id           = 9   (string)
 *                                .chosen_value        = 10  (Value)
 *   Value (oneof sum)            .numeric             = 6   (string)
 *                                .party               = 7   (string)
 *                                .text                = 8   (string)
 *                                .optional            = 10  (Optional)
 *                                .list                = 11  (List)
 *                                .text_map            = 12  (TextMap)
 *                                .gen_map             = 13  (GenMap)
 *                                .record              = 14  (Record)
 *                                .variant             = 15  (Variant)
 *   Record                       .fields (repeated)   = 2   (RecordField)
 *   RecordField                  .label               = 1   (string)
 *                                .value               = 2   (Value)
 *   List                         .elements (repeated) = 1   (Value)
 *   Optional                     .value               = 1   (Value)
 *   Variant                      .value               = 3   (Value)
 *   TextMap                      .entries (repeated)  = 1   (TextMap.Entry)
 *   TextMap.Entry                .key                 = 1   (string)
 *                                .value               = 2   (Value)
 *   GenMap                       .entries (repeated)  = 1   (GenMap.Entry)
 *   GenMap.Entry                 .key                 = 1   (Value)
 *                                .value               = 2   (Value)
 */
import { createHash, createPublicKey, timingSafeEqual } from "node:crypto";
import { decodeTopologyTransaction } from "@canton-network/core-tx-visualizer";
import { TopologyTransaction } from "@canton-network/core-ledger-proto";

/* Locally-used core symbols. The re-export block below is a re-export, not an
 * import, so a name needed by code IN this file has to be bound here too. */
import { assertPreparedAmuletSelfPreapproval } from "@ftptech/x402-canton-core";

/* The validator moved to @ftptech/x402-canton-core (prepared-transfer.ts) so the
 * facilitator can reuse it for inline payloads. Re-exported here so every
 * existing import of ./verify-prepared.js keeps working unchanged. */
export {
  decodePrepared,
  extractTransfer,
  extractSelfPreapproval,
  canonicalAmount,
  assertPreparedTransferMatches,
  assertPreparedAcceptMatches,
  assertPreparedWithdrawMatches,
  assertPreparedRegistrySelfPreapproval,
  assertPreparedTcCreateBatcher,
  assertPreparedTcCreateAllocation,
  assertPreparedTcFundAllocation,
  assertPreparedTcCreateOrders,
  assertPreparedTcCancelOrder,
  assertPreparedTcWithdrawalRequest,
  KNOWN_TRADECRAFT_PACKAGE_IDS,
  PreparedDecodeError,
  PreparedTransferMismatchError,
} from "@ftptech/x402-canton-core";
export type {
  DecodedPrepared,
  DecodedNode,
  DecodedExercise,
  DecodedInputContract,
  PreparedTransferExpectation,
  PreparedAcceptExpectation,
  PreparedWithdrawExpectation,
  RegistrySelfPreapprovalExpectation,
  TradecraftParties,
  TcCreateBatcherExpectation,
  TcCreateAllocationExpectation,
  TcFundAllocationExpectation,
  TcCreateOrdersExpectation,
  TcCancelOrderExpectation,
  TcWithdrawalRequestExpectation,
} from "@ftptech/x402-canton-core";
import {
  decodePrepared,
  // PreparedDecodeError is NOT imported here: it is already re-exported to
  // callers by the `export { ... } from` block above, and importing it again
  // as a value this file never uses is exactly the unused binding eslint
  // refuses at --max-warnings 0.
  PreparedTransferMismatchError,
} from "@ftptech/x402-canton-core";
export interface HashBindingOptions {
  /**
   * A function that recomputes the signing hash from the prepared-transaction
   * bytes EXACTLY as Canton's participant does on `execute`
   * (HASHING_SCHEME_VERSION_V2), returning it base64-encoded. When supplied,
   * `assertHashBinding` requires `recomputeHash(prepared) === hash`
   * (constant-time) and throws otherwise — this is the real cryptographic
   * binding and the only thing that defeats a relay returning honest bytes with
   * the hash of a DIFFERENT (tampered) transaction.
   *
   * It MUST be a deterministic function of the bytes alone and MUST match the
   * participant's algorithm; if it does not, honest transfers fail closed
   * (refused), never silently mis-bound.
   *
   * May be async: the conformant implementation (`recomputeHash` in
   * `canton-hash.ts`, backed by `@canton-network/core-tx-visualizer`) uses
   * WebCrypto and returns a Promise. `assertHashBinding` awaits the result, so a
   * sync `=> string` recompute is also accepted.
   */
  recomputeHash?: (preparedTransactionB64: string) => Promise<string> | string;
  /**
   * DANGEROUS, OFF BY DEFAULT. Sign the relay-returned hash WITHOUT recomputing
   * it. The Canton Ledger API proto is explicit: "clients MUST recompute the
   * hash from the raw transaction if the preparing participant is not trusted"
   * and the hash field is "provided for convenience [and] may be removed". A
   * compromised relay can return structurally-honest bytes paired with the hash
   * of a tampered transaction; if it then swaps the bytes it forwards to the
   * participant, the agent's signature authorizes the attacker's transfer.
   *
   * Only set this true if you independently display the decoded transfer to a
   * human for approval before signing, OR you fully trust the relay. Never the
   * default for autonomous agents.
   */
  trustRelayHash?: boolean;
}

/** Thrown when a supplied `recomputeHash` cannot faithfully encode the bytes. */
export class PreparedHashUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreparedHashUnavailableError";
  }
}

/** Constant-time base64 comparison (length-independent leak is acceptable). */
function constantTimeEqualB64(a: string, b: string): boolean {
  let ba: Buffer;
  let bb: Buffer;
  try {
    ba = Buffer.from(a, "base64");
    bb = Buffer.from(b, "base64");
  } catch {
    return false;
  }
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Bind the `hash` the relay told us to sign to the `preparedTransaction` bytes
 * we just structurally validated. Call this BEFORE signing `hash`.
 *
 * THE BINDING (why blind-signing breaks self-custody)
 * ---------------------------------------------------
 * The signed artifact is `hash`. The participant, on `execute`, recomputes the
 * V2 hash from whatever bytes reach it and accepts the signature only if it
 * matches. A compromised relay (the participant proxy) can therefore return
 * structurally-HONEST `preparedTransaction` bytes (which sail through
 * `assertPreparedTransferMatches`) paired with `hash = V2(PT_evil)` for a
 * DIFFERENT transfer, then forward `PT_evil` instead of the honest bytes to the
 * participant: V2(PT_evil) == hash, signature valid, attacker paid. Validating
 * the bytes is therefore necessary but NOT sufficient — the agent must also
 * prove the hash it signs is the hash OF THOSE validated bytes. That requires
 * recomputing the hash locally; the relay-supplied hash is untrusted input.
 *
 * This function enforces, fail-closed:
 *   1. shape: `hash` is a present, well-formed, non-empty base64 digest, and the
 *      `preparedTransaction` is a decodable PreparedTransaction with exactly the
 *      one transfer exercise (so we are signing a transfer we understood);
 *   2. binding: EITHER `opts.recomputeHash` is supplied and
 *      `recomputeHash(prepared) === hash` (constant-time) — the real binding —
 *      OR `opts.trustRelayHash === true` is explicitly set (the documented,
 *      off-by-default escape hatch for human-in-the-loop / trusted-relay use).
 *      If neither holds, we REFUSE to sign rather than blind-sign an unbound,
 *      relay-chosen hash.
 */
export async function assertHashBinding(
  preparedTransactionB64: string,
  hashB64: string,
  opts: HashBindingOptions = {}
): Promise<void> {
  if (typeof hashB64 !== "string" || hashB64.length === 0) {
    throw new PreparedTransferMismatchError(
      "relay returned an empty hash — refusing to sign (possible tampered/compromised relay)"
    );
  }
  let hashBytes: Buffer;
  try {
    hashBytes = Buffer.from(hashB64, "base64");
  } catch {
    throw new PreparedTransferMismatchError("relay hash is not valid base64 — refusing to sign");
  }
  if (hashBytes.length === 0) {
    throw new PreparedTransferMismatchError("relay hash decoded to empty bytes — refusing to sign");
  }
  // Decoding here ensures the bytes we are about to sign-and-submit are a real,
  // structurally-valid PreparedTransaction (throws otherwise).
  decodePrepared(preparedTransactionB64);

  // The actual hash<->bytes binding.
  if (opts.recomputeHash) {
    let local: string;
    try {
      // Await covers both a sync `=> string` and the async WebCrypto-backed
      // conformant recompute (`=> Promise<string>`); a rejected promise lands
      // in catch and fails CLOSED, never falling back to the relay hash.
      local = await opts.recomputeHash(preparedTransactionB64);
    } catch (e) {
      // The recompute could not faithfully encode the bytes — fail CLOSED. We
      // never fall back to trusting the relay hash on a recompute failure.
      throw new PreparedTransferMismatchError(
        `could not recompute the prepared-transaction hash to bind it to the ` +
          `validated bytes (${(e as Error).message}) — refusing to sign`
      );
    }
    if (!constantTimeEqualB64(local, hashB64)) {
      throw new PreparedTransferMismatchError(
        "relay-returned hash does NOT match the hash of the prepared-transaction " +
          "bytes we validated — refusing to sign (possible tampered/compromised " +
          "relay supplying the hash of a different transaction)"
      );
    }
    return; // bound: the hash we sign is the hash of the bytes we validated
  }

  if (opts.trustRelayHash === true) {
    return; // explicit, documented, off-by-default escape hatch
  }

  // No way to bind the hash to the validated bytes and no explicit opt-in to
  // trust the relay → refuse. Blind-signing a relay-chosen hash is exactly the
  // self-custody break this module exists to prevent.
  throw new PreparedTransferMismatchError(
    "cannot bind the relay-returned hash to the validated prepared-transaction " +
      "bytes: no hash recomputation is available and trustRelayHash is not set. " +
      "Refusing to blind-sign a relay-supplied hash (Canton requires recomputing " +
      "the hash when the preparing participant is not trusted). Supply " +
      "HashBindingOptions.recomputeHash with a participant-conformant V2 hash, or " +
      "explicitly set trustRelayHash:true only with human-in-the-loop approval."
  );
}

/**
 * Returns true iff `hash` is the plain SHA-256 of the `preparedTransaction`
 * bytes. NOTE: Canton V2 does NOT hash this way (see `assertHashBinding`), so
 * this is advisory only and is NEVER used to accept or reject a submission.
 * Retained for diagnostics / future schemes.
 */
export function hashMatchesPreparedPlain(
  preparedTransactionB64: string,
  hashB64: string
): boolean {
  const bytes = Buffer.from(preparedTransactionB64, "base64");
  const digest = createHash("sha256").update(bytes).digest("base64");
  return digest === hashB64;
}

/* ════════════════════════════════════════════════════════════════════════
 * ONBOARDING — verify-before-sign for the external-party topology multiHash.
 *
 * THREAT MODEL (identical to the transfer paths). During onboarding the agent
 * generates its OWN Ed25519 key, asks the relay to `generateExternalParty-
 * Topology`, and signs the relay-returned `multiHash` (a combined hash over the
 * onboarding/topology transactions) with that key, then submits it to
 * `allocateExternalParty`. If it signs the multiHash BLINDLY, a malicious relay
 * can return topology transactions that onboard a DIFFERENT key/party: the agent
 * would sign and submit a topology it never authored, and persist a party it does
 * not control (key-custody compromise).
 *
 * `assertOnboardingTopologyBindsKey` proves, fail-closed, that the topology
 * TRANSACTION BYTES the agent is about to submit (the same bytes the participant
 * re-derives the multiHash from on `allocate`) bind ONLY the agent's own key:
 *
 *   (A) the agent's OWN raw Ed25519 public key appears as a byte-substring in the
 *       topology transactions (belt-and-suspenders; (D) is authoritative). The
 *       raw 32 bytes are also a contiguous suffix of the SPKI/DER encoding, so the
 *       check is robust to RAW or DER framing.
 *
 *   (B) the returned `party` is `name::fingerprint` whose namespace fingerprint
 *       equals the returned `publicKeyFingerprint`. An external party lives in the
 *       namespace of its OWN signing key (the namespace IS the key fingerprint),
 *       so the party the agent persists must be in the onboarded key's namespace.
 *
 *   (C) `publicKeyFingerprint` is present and non-empty (the namespace anchor).
 *
 *   (D) AUTHORITATIVE structural decode: each onboarding transaction is decoded
 *       as a real Canton `TopologyTransaction` (official
 *       `decodeTopologyTransaction`) and the custody-granting mappings are
 *       asserted to bind EXACTLY the agent's key — PartyToKeyMapping threshold 1
 *       with the agent's key as the SOLE signer (no co-holder), any
 *       NamespaceDelegation targets only the agent's key over its own namespace,
 *       any PartyToParticipant is single-custody with no signing key but the
 *       agent's in its party_signing_keys. This replaces the old
 *       substring-only check (which a relay could satisfy while ALSO binding an
 *       extra foreign co-signer) and closes the round-5 / convergence custody-
 *       hijack vectors. See `assertOnboardingTopologyDecodeBindsKey`.
 *
 * COMPLEMENTARY hash binding (in onboard.ts, NOT here): the multiHash IS now
 * recomputed locally (`recomputeTopologyMultiHash`, official
 * @canton-network/core-tx-visualizer) and compared to the relay's `hashToSign`,
 * and the fingerprint is derived locally and compared to `publicKeyFingerprint`,
 * before signing the RECOMPUTED multiHash. Structural decode proves "the bytes
 * bind only my key"; the recompute proves "I signed the hash OF those bytes" —
 * both required, exactly as on the transfer path. The recompute is conformance-
 * tested (`canton-hash.conformance.test.ts`); a wrong recompute fails honest
 * onboarding CLOSED rather than mis-binding.
 * ──────────────────────────────────────────────────────────────────────── */

/** Thrown when relay-returned onboarding topology cannot be proven to bind the
 *  agent's own key + namespace. Onboarding refuses to sign the multiHash. */
export class OnboardingTopologyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardingTopologyMismatchError";
  }
}

/** What the agent independently knows/expects about its onboarding. */
export interface OnboardingTopologyExpectation {
  /** The agent's OWN freshly-generated public key, base64 SPKI/DER (keys.ts). */
  publicKeySpkiB64: string;
  /** The relay-returned party id, expected `name::fingerprint`. */
  party: string;
  /** The relay-returned canonical key fingerprint (the party's namespace). */
  publicKeyFingerprint: string;
}

/** The raw 32-byte Ed25519 public key from an SPKI/DER base64, via JWK `x`
 *  (robust to DER prefix length); falls back to the trailing-32-bytes slice if
 *  the key cannot be parsed as Ed25519. */
function rawEd25519PublicKey(spkiB64: string): Buffer {
  const der = Buffer.from(spkiB64, "base64");
  try {
    const jwk = createPublicKey({ key: der, format: "der", type: "spki" }).export({
      format: "jwk",
    }) as { x?: string };
    if (jwk.x) {
      const raw = Buffer.from(jwk.x, "base64url");
      if (raw.length === 32) return raw;
    }
  } catch {
    /* fall through to the slice form */
  }
  return der.subarray(Math.max(0, der.length - 32));
}

/** The namespace (fingerprint) part of a `name::fingerprint` party id, or
 *  undefined if the id is not in that form. Canton forbids consecutive colons
 *  inside the name, so the LAST `::` separates name from namespace. */
function partyNamespace(party: string): string | undefined {
  const idx = party.lastIndexOf("::");
  if (idx <= 0) return undefined; // no separator, or empty name
  const ns = party.slice(idx + 2);
  return ns.length > 0 ? ns : undefined;
}

/**
 * Assert the relay-returned onboarding topology binds the agent's OWN key and
 * namespace. Call this BEFORE signing the onboarding `multiHash`. Fail-closed:
 * anything not positively proven throws `OnboardingTopologyMismatchError`.
 */
export function assertOnboardingTopologyBindsKey(
  onboardingTransactionsB64: string[],
  expect: OnboardingTopologyExpectation
): void {
  // (C) namespace anchor must be present.
  if (
    typeof expect.publicKeyFingerprint !== "string" ||
    expect.publicKeyFingerprint.length === 0
  ) {
    throw new OnboardingTopologyMismatchError(
      "relay returned an empty publicKeyFingerprint — refusing to sign the onboarding " +
        "topology (cannot anchor the party namespace to the agent's key)"
    );
  }

  // (B) the party the agent will persist must live in the namespace of the key
  // being onboarded: party = name::fingerprint, namespace == publicKeyFingerprint.
  const ns = partyNamespace(expect.party);
  if (ns === undefined) {
    throw new OnboardingTopologyMismatchError(
      `relay returned a malformed party id ${JSON.stringify(expect.party)} (expected ` +
        `"name::fingerprint") — refusing to sign the onboarding topology`
    );
  }
  if (ns !== expect.publicKeyFingerprint) {
    throw new OnboardingTopologyMismatchError(
      `relay-returned party namespace ${JSON.stringify(ns)} does not equal the key fingerprint ` +
        `${JSON.stringify(expect.publicKeyFingerprint)} — refusing to sign the onboarding topology ` +
        `(party would not live in the agent key's own namespace — possible foreign-party custody hijack)`
    );
  }

  // (A) the agent's OWN raw public key must appear in the topology bytes
  // (belt-and-suspenders byte check; (D) below is the authoritative decode).
  if (!onboardingTransactionsB64 || onboardingTransactionsB64.length === 0) {
    throw new OnboardingTopologyMismatchError(
      "relay returned no onboarding topology transactions — refusing to sign " +
        "(cannot prove the topology onboards the agent's own key)"
    );
  }
  const rawKey = rawEd25519PublicKey(expect.publicKeySpkiB64);
  if (rawKey.length !== 32) {
    throw new OnboardingTopologyMismatchError(
      "could not derive the agent's raw Ed25519 public key — refusing to sign the onboarding topology"
    );
  }
  let keyFound = false;
  for (const txB64 of onboardingTransactionsB64) {
    let txBytes: Buffer;
    try {
      txBytes = Buffer.from(txB64, "base64");
    } catch {
      continue;
    }
    if (txBytes.length > 0 && txBytes.includes(rawKey)) {
      keyFound = true;
      break;
    }
  }
  if (!keyFound) {
    throw new OnboardingTopologyMismatchError(
      "the agent's own public key does not appear in the relay-returned onboarding topology " +
        "transactions — refusing to sign (the topology would onboard a DIFFERENT key; possible " +
        "tampered/compromised relay performing a key-custody hijack)"
    );
  }

  // (D) AUTHORITATIVE structural decode. The byte-substring check (A) proves the
  // key is PRESENT somewhere; it does NOT prove the AUTHORITATIVE mappings bind
  // EXACTLY the agent's own key with no foreign co-holders. Decode each topology
  // transaction as a real Canton `TopologyTransaction` proto and assert,
  // fail-closed, that the custody-granting mappings bind only the agent's key.
  // This closes the round-5 / convergence custody-hijack vectors that a substring
  // scan misses (an extra signing key in the PartyToKeyMapping, threshold>1, a
  // foreign NamespaceDelegation target, a co-hosting foreign participant set with
  // a consortium threshold, etc.).
  assertOnboardingTopologyDecodeBindsKey(onboardingTransactionsB64, expect, rawKey);
}

/* ──────────────────────────────────────────────────────────────────────────
 * (D) Structural topology decode — the authoritative custody binding.
 *
 * We decode each relay-returned onboarding transaction with the OFFICIAL
 * `decodeTopologyTransaction` (@canton-network/core-tx-visualizer) and inspect
 * the typed `TopologyMapping` oneof. The onboarding bundle for an external party
 * carries (at least) a PartyToKeyMapping (the party's signing key(s)); it may
 * also carry a NamespaceDelegation (authorizing a key over the party's
 * namespace) and a PartyToParticipant (hosting). We require, fail-closed:
 *
 *   PartyToKeyMapping (REQUIRED, ≥1 across the bundle, all for the agent's party):
 *     - threshold === 1
 *     - signingKeys is EXACTLY [the agent's own key] — one key, equal to the
 *       agent's, and NO additional key-holders (an extra co-signer would let the
 *       relay co-authorize spends).
 *
 *   NamespaceDelegation (OPTIONAL; if present, every one must):
 *     - namespace === the agent's key fingerprint (the party's own namespace)
 *     - targetKey === the agent's own key (no foreign delegate gets namespace
 *       authority).
 *
 *   PartyToParticipant (OPTIONAL; if present, every one must):
 *     - party === the agent's party
 *     - threshold === 1 (NOT a consortium party — threshold>1 means multiple
 *       participants must co-act, a custody-sharing definition)
 *     - participants is non-empty (hosting is sane)
 *     - party_signing_keys (field 6) is absent, or threshold 1 with the agent's
 *       own key as the only key. Read from the raw bytes: the typed decoder
 *       (core-ledger-proto 1.4.0) has no field 6 and drops it silently. Any
 *       other field we do not read is refused.
 *
 * Any mapping that references a key/namespace/party that is NOT the agent's, or
 * any threshold>1, or any extra key-holder, is rejected. Mapping types we do not
 * expect in an external-party onboarding bundle (owner-to-key, decentralized
 * namespace, synchronizer state, …) are also rejected fail-closed — an honest
 * relay does not include them, and we refuse to sign a bundle we cannot fully
 * account for.
 * ──────────────────────────────────────────────────────────────────────── */

/** Extract the raw key bytes carried by a decoded `SigningPublicKey`, normalized
 *  to the bare 32-byte Ed25519 point. Canton may carry the key RAW (32 bytes) or
 *  DER-wrapped (SPKI); the raw 32-byte point is a contiguous suffix of the SPKI
 *  encoding, so taking the trailing 32 bytes normalizes both. Returns undefined
 *  if there are fewer than 32 bytes (malformed). */
function rawPointFromSigningKey(pk: { publicKey: Uint8Array } | undefined): Buffer | undefined {
  if (!pk || !pk.publicKey || pk.publicKey.length < 32) return undefined;
  const buf = Buffer.from(pk.publicKey);
  // If it already IS 32 bytes, this is the point; otherwise (DER) the point is
  // the trailing 32 bytes (the SPKI BIT STRING payload sits at the end).
  return buf.subarray(buf.length - 32);
}

/* PartyToParticipant.party_signing_keys (field 6) holds the party's protocol
 * signing keys: on MainNet that is where an external party's key lives (see
 * topology-reader). The typed decoder does not know the field, so a relay could
 * add its own key there unseen. The minimal reader below walks the same bytes
 * the multiHash covers, the way Canton parses them. */

interface RawField {
  no: number;
  wire: number;
  /** Varint value, or the length of a length-delimited field. */
  value: number;
  /** Payload of a length-delimited field. */
  bytes?: Buffer;
}

function rawDecodeError(what: string): OnboardingTopologyMismatchError {
  return new OnboardingTopologyMismatchError(
    `could not read a relay-returned onboarding transaction (${what}) - refusing to sign`
  );
}

/** Decode one protobuf message. Tags and length prefixes must fit in uint32,
 *  the same rule core's prepared-transaction reader enforces, so an over-long
 *  encoding cannot be read differently here and by the participant. */
function rawFields(buf: Buffer): RawField[] {
  const out: RawField[] = [];
  let pos = 0;
  const varint = (): number => {
    let value = 0;
    for (let shift = 0; shift < 64 && pos < buf.length; shift += 7) {
      const b = buf[pos++] as number;
      value += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return value;
    }
    throw rawDecodeError("malformed varint");
  };
  while (pos < buf.length) {
    const tag = varint();
    const no = Math.floor(tag / 8);
    const wire = tag % 8;
    if (tag > 0xffffffff || no === 0) throw rawDecodeError("invalid tag");
    if (wire === 0) {
      out.push({ no, wire, value: varint() });
    } else if (wire === 2) {
      const len = varint();
      if (len > buf.length - pos) throw rawDecodeError("field overruns buffer");
      out.push({ no, wire, value: len, bytes: buf.subarray(pos, pos + len) });
      pos += len;
    } else if (wire === 1 || wire === 5) {
      const len = wire === 1 ? 8 : 4;
      if (len > buf.length - pos) throw rawDecodeError("field overruns buffer");
      out.push({ no, wire, value: 0 });
      pos += len;
    } else {
      throw rawDecodeError(`unsupported wire type ${wire}`);
    }
  }
  return out;
}

/** The single occurrence of a non-repeated field, or undefined. A duplicate or
 *  a wrong wire type is refused: duplicates of a message field merge on the
 *  participant, so a second party_signing_keys could add keys we never saw. */
function rawOnly(
  fields: RawField[],
  no: number,
  wire: number,
  what: string
): RawField | undefined {
  const all = fields.filter((f) => f.no === no);
  if (all.length > 1) throw rawDecodeError(`${what} appears ${all.length} times`);
  if (all[0] !== undefined && all[0].wire !== wire) {
    throw rawDecodeError(`${what} has wire type ${all[0].wire}`);
  }
  return all[0];
}

/** One onboarding transaction's TopologyTransaction bytes, and the field number
 *  and raw bytes of its TopologyMapping oneof member. A live participant returns
 *  each transaction inside Canton's versioned envelope (data = 1, version = 2);
 *  unwrap it first. */
function rawTopologyMapping(txB64: string): { tx: Buffer; no: number; bytes: Buffer } {
  let tx: Buffer = Buffer.from(txB64, "base64");
  let fields = rawFields(tx);
  // TopologyTransaction.operation (field 1) is a varint, so a length-delimited
  // field 1 is the envelope's data.
  if (fields.some((f) => f.no === 1 && f.wire === 2)) {
    if (fields.some((f) => !(f.no === 1 && f.wire === 2) && !(f.no === 2 && f.wire === 0))) {
      throw rawDecodeError("unexpected field in the versioned envelope");
    }
    tx = rawOnly(fields, 1, 2, "envelope data")!.bytes!;
    fields = rawFields(tx);
  }
  const mapping = rawOnly(fields, 3, 2, "TopologyTransaction.mapping");
  if (mapping === undefined) throw rawDecodeError("no mapping");
  const members = rawFields(mapping.bytes!);
  if (members.length !== 1 || members[0]!.wire !== 2) {
    throw rawDecodeError("TopologyMapping must carry exactly one mapping");
  }
  return { tx, no: members[0]!.no, bytes: members[0]!.bytes! };
}

/** TopologyMapping.party_to_participant oneof field number. */
const TOPOLOGY_MAPPING_PARTY_TO_PARTICIPANT = 9;

/** Refuse a PartyToParticipant whose party_signing_keys is anything but absent
 *  or {keys: [agent key], threshold: 1}, or that carries a field we do not read
 *  (party = 1, threshold = 2, participants = 3, party_signing_keys = 6). */
function assertPartySigningKeys(
  p2p: Buffer,
  isAgentKey: (pk: { publicKey: Uint8Array } | undefined) => boolean
): void {
  const fields = rawFields(p2p);
  const unknown = fields.find((f) => ![1, 2, 3, 6].includes(f.no));
  if (unknown !== undefined) {
    throw new OnboardingTopologyMismatchError(
      `onboarding PartyToParticipant carries unknown field ${unknown.no} - refusing to sign ` +
        `(cannot account for what it grants)`
    );
  }
  const signingKeys = rawOnly(fields, 6, 2, "party_signing_keys");
  if (signingKeys === undefined) return;

  const inner = rawFields(signingKeys.bytes!);
  if (inner.some((f) => f.no !== 1 && f.no !== 2)) {
    throw rawDecodeError("unknown field in party_signing_keys");
  }
  const keys = inner.filter((f) => f.no === 1);
  if (keys.some((f) => f.wire !== 2)) {
    throw rawDecodeError("party_signing_keys key has wrong wire type");
  }
  const threshold = rawOnly(inner, 2, 0, "party_signing_keys threshold")?.value ?? 0;
  if (threshold !== 1) {
    throw new OnboardingTopologyMismatchError(
      `onboarding PartyToParticipant party_signing_keys has threshold ${threshold} (expected 1) - ` +
        `refusing to sign (the agent's key must be able to sign alone and be the only signer)`
    );
  }
  if (keys.length !== 1) {
    throw new OnboardingTopologyMismatchError(
      `onboarding PartyToParticipant party_signing_keys carries ${keys.length} keys (expected ` +
        `exactly 1, the agent's own) - refusing to sign (an extra key would let its holder ` +
        `authorize the agent's spends)`
    );
  }
  const publicKey = rawOnly(rawFields(keys[0]!.bytes!), 3, 2, "SigningPublicKey.public_key");
  if (publicKey === undefined || !isAgentKey({ publicKey: publicKey.bytes! })) {
    throw new OnboardingTopologyMismatchError(
      "onboarding PartyToParticipant party_signing_keys key is NOT the agent's own key - " +
        "refusing to sign (the topology would onboard a foreign signing key)"
    );
  }
}

function assertOnboardingTopologyDecodeBindsKey(
  onboardingTransactionsB64: string[],
  expect: OnboardingTopologyExpectation,
  agentRawKey: Buffer
): void {
  /** True iff a decoded signing key is EXACTLY the agent's own Ed25519 point. */
  const isAgentKey = (pk: { publicKey: Uint8Array } | undefined): boolean => {
    const point = rawPointFromSigningKey(pk);
    return point !== undefined && point.length === 32 && timingSafeEqual(point, agentRawKey);
  };

  let sawPartyToKey = false;
  let sawNsDelegForAgent = false;
  let sawP2PForAgent = false;

  for (const txB64 of onboardingTransactionsB64) {
    const raw = rawTopologyMapping(txB64);
    let tx: TopologyTransaction;
    try {
      tx = decodeTopologyTransaction(raw.tx.toString("base64"));
    } catch (e) {
      throw new OnboardingTopologyMismatchError(
        `could not decode a relay-returned onboarding transaction as a Canton ` +
          `TopologyTransaction (${(e as Error).message}) — refusing to sign ` +
          `(cannot structurally verify the topology binds the agent's own key)`
      );
    }

    // The typed decoder does not check wire types: a field sent with the wrong
    // one is read as something Canton never sees (Canton skips it as unknown).
    // Require the bytes to be exactly what the typed decode encodes back to.
    if (!Buffer.from(TopologyTransaction.toBinary(tx)).equals(raw.tx)) {
      throw new OnboardingTopologyMismatchError(
        "a relay-returned onboarding transaction is not canonically encoded - refusing to " +
          "sign (the typed decode may differ from what Canton applies)"
      );
    }

    const mapping = tx.mapping?.mapping;
    if (!mapping || mapping.oneofKind === undefined) {
      throw new OnboardingTopologyMismatchError(
        "a relay-returned onboarding transaction has no topology mapping — refusing " +
          "to sign (cannot account for an empty/unknown mapping in the bundle)"
      );
    }

    // The raw read must see the same mapping kind as the typed decode, so the
    // signing-key check below runs on the PartyToParticipant Canton will apply.
    if (
      (raw.no === TOPOLOGY_MAPPING_PARTY_TO_PARTICIPANT) !==
      (mapping.oneofKind === "partyToParticipant")
    ) {
      throw new OnboardingTopologyMismatchError(
        `onboarding transaction decodes as ${mapping.oneofKind} but its raw mapping is ` +
          `field ${raw.no} - refusing to sign (ambiguous encoding)`
      );
    }

    switch (mapping.oneofKind) {
      case "partyToKeyMapping": {
        const m = mapping.partyToKeyMapping;
        sawPartyToKey = true;
        // The mapping must be for the agent's OWN party.
        if (m.party !== expect.party) {
          throw new OnboardingTopologyMismatchError(
            `onboarding PartyToKeyMapping binds party ${JSON.stringify(m.party)} but the ` +
              `agent's party is ${JSON.stringify(expect.party)} — refusing to sign ` +
              `(topology would key a DIFFERENT party — possible custody hijack)`
          );
        }
        // EXACTLY threshold 1.
        if (m.threshold !== 1) {
          throw new OnboardingTopologyMismatchError(
            `onboarding PartyToKeyMapping has threshold ${m.threshold} (expected 1) — ` +
              `refusing to sign (a threshold≠1 key mapping is a custody-sharing definition)`
          );
        }
        // EXACTLY one signing key, and it is the agent's own — NO co-holders.
        if (m.signingKeys.length !== 1) {
          throw new OnboardingTopologyMismatchError(
            `onboarding PartyToKeyMapping carries ${m.signingKeys.length} signing keys ` +
              `(expected exactly 1 — the agent's own) — refusing to sign (an extra ` +
              `key-holder would let the relay co-authorize the agent's spends)`
          );
        }
        if (!isAgentKey(m.signingKeys[0])) {
          throw new OnboardingTopologyMismatchError(
            "onboarding PartyToKeyMapping's signing key is NOT the agent's own key — " +
              "refusing to sign (the topology would onboard a foreign key; possible " +
              "tampered/compromised relay performing a key-custody hijack)"
          );
        }
        break;
      }

      case "namespaceDelegation": {
        const m = mapping.namespaceDelegation;
        // If present, it must authorize ONLY the agent's own key over the agent's
        // own namespace (the key fingerprint). A foreign target/namespace would
        // grant namespace authority outside the agent's control.
        if (m.namespace !== expect.publicKeyFingerprint) {
          throw new OnboardingTopologyMismatchError(
            `onboarding NamespaceDelegation is for namespace ${JSON.stringify(m.namespace)} ` +
              `but the agent's namespace is ${JSON.stringify(expect.publicKeyFingerprint)} — ` +
              `refusing to sign (foreign-namespace delegation — possible custody hijack)`
          );
        }
        if (!isAgentKey(m.targetKey)) {
          throw new OnboardingTopologyMismatchError(
            "onboarding NamespaceDelegation's target key is NOT the agent's own key — " +
              "refusing to sign (a foreign key would gain authority over the agent's " +
              "namespace — possible custody hijack)"
          );
        }
        sawNsDelegForAgent = true;
        break;
      }

      case "partyToParticipant": {
        const m = mapping.partyToParticipant;
        if (m.party !== expect.party) {
          throw new OnboardingTopologyMismatchError(
            `onboarding PartyToParticipant hosts party ${JSON.stringify(m.party)} but the ` +
              `agent's party is ${JSON.stringify(expect.party)} — refusing to sign`
          );
        }
        // threshold>1 ⇒ consortium party (multiple participants must co-act) — a
        // custody-sharing definition the agent must never sign for its own party.
        if (m.threshold > 1) {
          throw new OnboardingTopologyMismatchError(
            `onboarding PartyToParticipant has threshold ${m.threshold} (>1 = consortium ` +
              `party) — refusing to sign (the agent's party must be single-custody)`
          );
        }
        if (!m.participants || m.participants.length === 0) {
          throw new OnboardingTopologyMismatchError(
            "onboarding PartyToParticipant lists no hosting participants — refusing to " +
              "sign (the party would be unhosted/sane-check failed)"
          );
        }
        assertPartySigningKeys(raw.bytes, isAgentKey);
        sawP2PForAgent = true;
        break;
      }

      default: {
        // Any other mapping type is unexpected in an external-party onboarding
        // bundle. Fail closed rather than sign a bundle we cannot account for.
        throw new OnboardingTopologyMismatchError(
          `relay-returned onboarding bundle contains an unexpected topology mapping ` +
            `(${mapping.oneofKind}) — refusing to sign (an honest external-party ` +
            `onboarding carries only PartyToKeyMapping / NamespaceDelegation / ` +
            `PartyToParticipant; an extra mapping could grant foreign authority)`
        );
      }
    }
  }

  // CUSTODY ANCHOR. For Canton external parties the binding is the NAMESPACE: the
  // party id is name::fingerprint(agentKey) — enforced by checks (B)/(C) here plus
  // the local fingerprint recompute in onboard.ts — and namespace authority is
  // granted by a PartyToKeyMapping (party->key) OR a NamespaceDelegation
  // (key->namespace) for the agent, with the party hosted via PartyToParticipant.
  // Real Canton generate-topology returns NamespaceDelegation + PartyToParticipant
  // and NO standalone PartyToKeyMapping, so requiring a PartyToKeyMapping rejected
  // every honest onboarding. Accept any of the three agent-bound custody mappings:
  // each was already proven above to bind ONLY the agent's own key/namespace/party
  // (foreign keys, extra co-holders, threshold>1, foreign namespaces/parties, and
  // unknown mappings are all refused per-mapping), and check (A) guarantees the
  // agent's own key actually appears in the signed bytes.
  if (!sawPartyToKey && !sawNsDelegForAgent && !sawP2PForAgent) {
    throw new OnboardingTopologyMismatchError(
      "relay-returned onboarding bundle binds no agent-custody mapping (no " +
        "PartyToKeyMapping, no NamespaceDelegation for the agent's namespace, and no " +
        "PartyToParticipant for the agent's party) — refusing to sign (cannot establish " +
        "that the bundle onboards the agent's own party)"
    );
  }
}


/**
 * VERIFY-BEFORE-SIGN for the merchant-self-provisioned Amulet TransferPreapproval.
 *
 * The merchant signs a RELAY-PREPARED `AmuletRules_CreateTransferPreapproval`
 * with its OWN key, and the choice spends the merchant's Amulet for the fee. A
 * hostile relay could hand over a look-alike choice whose body moves that
 * Amulet elsewhere, so the full check lives in core
 * (`assertPreparedAmuletSelfPreapproval`): root template pinned, consequences
 * and creates whitelisted from real MainNet captures, receiver/provider/expiry
 * bound, and an all-nodes party backstop of {merchant, DSO}.
 *
 * `dso` must come from an out-of-band source (`resolveTrustedDsoParty`, or the
 * operator's `--admin`) — never from the relay.
 */
export function assertPreparedSelfPreapproval(
  preparedTransactionB64: string,
  expect: { party: string; dso: string; expectedExpiresAt?: string }
): void {
  assertPreparedAmuletSelfPreapproval(preparedTransactionB64, expect);
}
