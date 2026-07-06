/**
 * TEST-ONLY fixture: build FAITHFUL Canton onboarding topology transactions.
 *
 * NOT shipped — excluded from the package build/typecheck via tsconfig `exclude`
 * (imported only by `*.test.ts`, which vitest resolves directly).
 *
 * An HONEST relay's `onboard/prepare` returns:
 *   - `onboardingTransactions`: real `TopologyTransaction` protobufs (a
 *     PartyToKeyMapping that binds the party to its signing key, optionally a
 *     NamespaceDelegation + PartyToParticipant),
 *   - `hashToSign`: the combined multiHash over those exact bytes
 *     (HashPurpose 11 per-tx, 55 combined — Canton's topology multiHash),
 *   - `publicKeyFingerprint`: the key's fingerprint (HashPurpose 12 hex), which
 *     is ALSO the party's namespace (`party = name::fingerprint`).
 *
 * This builder reproduces that self-consistent shape using the SAME official
 * library the production code verifies with, so the onboarding tests exercise the
 * real structural decode + multiHash recompute + local fingerprint assert
 * end-to-end on the honest path. The malicious-relay tests then mutate ONE facet
 * (foreign key, threshold>1, extra co-holder, wrong multiHash, foreign namespace)
 * and assert the production code refuses — without weakening that code.
 */
import {
  computeSha256CantonHash,
  computeMultiHashForTopology,
} from "@canton-network/core-tx-visualizer";
import {
  TopologyTransaction,
  PartyToKeyMapping,
  NamespaceDelegation,
  PartyToParticipant,
  CryptoKeyFormat,
  Enums_TopologyChangeOp,
  Enums_ParticipantPermission,
  type SigningPublicKey,
  type TopologyMapping,
} from "@canton-network/core-ledger-proto";

/** The bare 32-byte Ed25519 point from an SPKI/DER base64 (trailing 32 bytes). */
export function rawPoint(spkiB64: string): Uint8Array {
  const der = Buffer.from(spkiB64, "base64");
  return der.subarray(der.length - 32);
}

/** A Canton SigningPublicKey carrying RAW Ed25519 point bytes (how Canton
 *  normalizes external Ed25519 keys in topology). */
export function signingKey(point: Uint8Array): SigningPublicKey {
  return {
    format: CryptoKeyFormat.RAW,
    publicKey: point,
    scheme: 0,
    usage: [],
    keySpec: 0,
  };
}

/** Encode a single TopologyTransaction (ADD_REPLACE, serial 1) to base64. */
export function encodeTopologyTx(mapping: TopologyMapping["mapping"]): string {
  const tx = TopologyTransaction.create({
    operation: Enums_TopologyChangeOp.ADD_REPLACE,
    serial: 1,
    mapping: { mapping },
  });
  return Buffer.from(TopologyTransaction.toBinary(tx)).toString("base64");
}

/** PartyToKeyMapping topology tx: party ⇒ [keys] with the given threshold. */
export function partyToKeyTx(
  party: string,
  keys: SigningPublicKey[],
  threshold = 1
): string {
  return encodeTopologyTx({
    oneofKind: "partyToKeyMapping",
    partyToKeyMapping: PartyToKeyMapping.create({ party, threshold, signingKeys: keys }),
  });
}

/** NamespaceDelegation topology tx: namespace ⇒ targetKey (root delegation). */
export function namespaceDelegationTx(
  namespace: string,
  targetKey: SigningPublicKey
): string {
  return encodeTopologyTx({
    oneofKind: "namespaceDelegation",
    namespaceDelegation: NamespaceDelegation.create({
      namespace,
      targetKey,
      isRootDelegation: true,
      restriction: { oneofKind: "canSignAllMappings", canSignAllMappings: {} },
    }),
  });
}

/** PartyToParticipant topology tx: party hosted by one participant, threshold 1. */
export function partyToParticipantTx(
  party: string,
  participantUid = "PAR::participant::1220feed",
  threshold = 1
): string {
  return encodeTopologyTx({
    oneofKind: "partyToParticipant",
    partyToParticipant: PartyToParticipant.create({
      party,
      threshold,
      participants: [
        { participantUid, permission: Enums_ParticipantPermission.SUBMISSION },
      ],
    }),
  });
}

/** The Canton multiHash (base64) over a set of topology transaction base64s —
 *  the value an honest relay returns as `hashToSign`. */
export async function topologyMultiHash(onboardingTxB64: string[]): Promise<string> {
  const raw = await Promise.all(
    onboardingTxB64.map((b64) => computeSha256CantonHash(11, Buffer.from(b64, "base64")))
  );
  const combined = await computeMultiHashForTopology(raw);
  const hash = await computeSha256CantonHash(55, combined);
  return Buffer.from(hash).toString("base64");
}

/** The Canton key fingerprint (HashPurpose 12 hex) for raw point bytes — the
 *  value an honest relay returns as `publicKeyFingerprint` and the party's
 *  namespace. */
export async function keyFingerprint(point: Uint8Array): Promise<string> {
  const framed = await computeSha256CantonHash(12, point);
  return Buffer.from(framed).toString("hex");
}

export interface FaithfulOnboarding {
  party: string;
  publicKeyFingerprint: string;
  onboardingTransactions: string[];
  hashToSign: string;
}

/**
 * Build a complete, self-consistent honest onboarding response for an agent key
 * (given its SPKI/DER base64): a PartyToKeyMapping + NamespaceDelegation +
 * PartyToParticipant bundle, the matching multiHash, and the party/fingerprint
 * derived from the real key. This is what a real participant produces.
 */
export async function faithfulOnboarding(
  publicKeySpkiB64: string,
  name = "agent"
): Promise<FaithfulOnboarding> {
  const point = rawPoint(publicKeySpkiB64);
  const fingerprint = await keyFingerprint(point);
  const party = `${name}::${fingerprint}`;
  const key = signingKey(point);
  const onboardingTransactions = [
    partyToKeyTx(party, [key], 1),
    namespaceDelegationTx(fingerprint, key),
    partyToParticipantTx(party),
  ];
  const hashToSign = await topologyMultiHash(onboardingTransactions);
  return { party, publicKeyFingerprint: fingerprint, onboardingTransactions, hashToSign };
}
