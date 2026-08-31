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
import type { TopologyTransaction } from "@canton-network/core-ledger-proto";

/* Locally-used core symbols. The re-export block below is a re-export, not an
 * import, so a name needed by code IN this file has to be bound here too. */
import { extractSelfPreapproval } from "@ftptech/x402-canton-core";

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
  assertPreparedRegistrySelfPreapproval,
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
  RegistrySelfPreapprovalExpectation,
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
 *       any PartyToParticipant is single-custody. This replaces the old
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
 *     - participants is non-empty (hosting is sane).
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
    let tx: TopologyTransaction;
    try {
      tx = decodeTopologyTransaction(txB64);
    } catch (e) {
      throw new OnboardingTopologyMismatchError(
        `could not decode a relay-returned onboarding transaction as a Canton ` +
          `TopologyTransaction (${(e as Error).message}) — refusing to sign ` +
          `(cannot structurally verify the topology binds the agent's own key)`
      );
    }

    const mapping = tx.mapping?.mapping;
    if (!mapping || mapping.oneofKind === undefined) {
      throw new OnboardingTopologyMismatchError(
        "a relay-returned onboarding transaction has no topology mapping — refusing " +
          "to sign (cannot account for an empty/unknown mapping in the bundle)"
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


/** The Amulet choice that creates a merchant TransferPreapproval (self-provider). */
const SELF_PREAPPROVAL_CHOICE = "AmuletRules_CreateTransferPreapproval";

/**
 * VERIFY-BEFORE-SIGN for the merchant-self-provisioned TransferPreapproval.
 *
 * The merchant signs a RELAY-PREPARED `AmuletRules_CreateTransferPreapproval`
 * with its OWN key. A compromised/hostile relay could instead prepare a
 * fund-MOVING transaction (a transfer/withdraw of the merchant's holdings) and
 * try to get THAT signed under the merchant's key. Decode the prepared bytes and
 * fail closed unless the transaction is exactly a single-root self-preapproval:
 *
 *   1. EXACTLY ONE root node, and it is an Exercise of
 *      `AmuletRules_CreateTransferPreapproval` — so no second root "leg" (e.g. an
 *      outbound transfer) rides along, and the root is not some other choice.
 *   2. `act_as` is EXACTLY [party] — the single external signer is the merchant.
 *
 * CONSEQUENCE exercises (the choice's own fee-burn on the merchant's Amulet) are
 * intentionally NOT constrained: they are children of the single authorized root
 * and are fixed by the public, audited Splice choice body — the signature
 * authorizes the ROOT choice, whose effects are not relay-controlled.
 *
 *   3. `receiver` and `provider` in the choice argument are BOTH `party`. Without
 *      this a hostile relay made the merchant pay to create a preapproval naming
 *      somebody else — the merchant burns the fee, ends up without the
 *      preapproval it believes it has, and every payment to it keeps failing
 *      while each retry burns another fee. Read positionally against a REAL
 *      MainNet capture (see `extractSelfPreapproval`), not an invented fixture.
 *   4. `expiresAt` equals `expectedExpiresAt` when the caller supplies one. The
 *      relay chooses this value (defaulting to 90 days) and echoes it in the
 *      prepare response; passing that echo back here is what binds the bytes to
 *      the terms the relay stated. Omitted → unchecked, exactly as before.
 */
export function assertPreparedSelfPreapproval(
  preparedTransactionB64: string,
  party: string,
  expectedExpiresAt?: string
): void {
  const decoded = decodePrepared(preparedTransactionB64);

  const rootNodes = decoded.nodes.filter((n) => decoded.roots.includes(n.nodeId));
  if (rootNodes.length !== 1) {
    throw new PreparedTransferMismatchError(
      `self-preapproval verify: prepared transaction has ${rootNodes.length} root ` +
        `nodes (want exactly 1) — refusing to sign (possible tampered/compromised relay ` +
        `adding a second leg)`
    );
  }
  const rootChoice = rootNodes[0]?.exercise?.choiceId;
  if (rootChoice !== SELF_PREAPPROVAL_CHOICE) {
    throw new PreparedTransferMismatchError(
      `self-preapproval verify: the root node is not an ${SELF_PREAPPROVAL_CHOICE} ` +
        `exercise (got ${JSON.stringify(rootChoice ?? null)}) — refusing to sign`
    );
  }
  if (decoded.actAs.length !== 1 || decoded.actAs[0] !== party) {
    throw new PreparedTransferMismatchError(
      `self-preapproval verify: prepared act_as ${JSON.stringify(decoded.actAs)} is not ` +
        `exactly [${party}] — refusing to sign`
    );
  }

  const chosen = rootNodes[0]?.exercise?.chosenValue;
  if (chosen === undefined) {
    throw new PreparedTransferMismatchError(
      "self-preapproval verify: the root exercise carries no choice argument — refusing to sign"
    );
  }
  const arg = extractSelfPreapproval(chosen);
  for (const [field, value] of [
    ["receiver", arg.receiver],
    ["provider", arg.provider],
  ] as const) {
    if (value !== party) {
      throw new PreparedTransferMismatchError(
        `self-preapproval verify: choice argument ${field} is ${JSON.stringify(value)}, ` +
          `not ${JSON.stringify(party)} — refusing to sign (this would pay to create a ` +
          `preapproval for somebody else)`
      );
    }
  }
  if (expectedExpiresAt !== undefined) {
    const wantMs = Date.parse(expectedExpiresAt);
    if (!Number.isFinite(wantMs)) {
      throw new PreparedTransferMismatchError(
        `self-preapproval verify: expected expiresAt ${JSON.stringify(expectedExpiresAt)} is ` +
          `not a parseable timestamp — refusing to sign`
      );
    }
    // Daml `Time` is µs since epoch; the expectation is milliseconds.
    const wantMicros = (BigInt(wantMs) * 1000n).toString();
    if (arg.expiresAtMicros !== wantMicros) {
      throw new PreparedTransferMismatchError(
        `self-preapproval verify: choice argument expiresAt is ${arg.expiresAtMicros}µs but ` +
          `${wantMicros}µs was stated (${expectedExpiresAt}) — refusing to sign`
      );
    }
  }
}
