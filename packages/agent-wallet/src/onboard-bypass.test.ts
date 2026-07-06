/**
 * ROUND-5 / convergence C4 ADVERSARY suite — onboarding topology custody.
 *
 * THREAT MODEL (same as the transfer paths): the relay is MALICIOUS. During
 * `ensureWallet` the agent generates its OWN Ed25519 key, asks the relay to
 * `generateExternalPartyTopology`, and signs the relay-returned `multiHash`
 * (the combined hash over the onboarding/topology transactions) with that key,
 * then submits it to `allocateExternalParty`. Two complementary defenses bind
 * the agent's signature to a topology that ONLY onboards its own key:
 *
 *   (1) STRUCTURAL decode (`assertOnboardingTopologyBindsKey`): decode each
 *       onboarding transaction as a real Canton `TopologyTransaction` proto and
 *       assert the AUTHORITATIVE mappings bind EXACTLY the agent's own key —
 *       PartyToKeyMapping threshold 1 with the agent's key as the SOLE signer (no
 *       co-holder), any NamespaceDelegation targets only the agent's key over the
 *       agent's own namespace, any PartyToParticipant is single-custody
 *       (threshold 1). Any extra key-holder, threshold>1, or foreign
 *       key/namespace is rejected. (Belt-and-suspenders byte/namespace checks are
 *       kept too.)
 *   (2) HASH recompute (`recomputeTopologyMultiHash`, wired in onboard.ts): the
 *       signed multiHash must equal the multiHash recomputed from those exact
 *       bytes, and the fingerprint is derived locally — see onboard.test.ts.
 *
 * The honest case (a faithful, self-consistent topology) MUST pass; every
 * single-facet mutation (foreign key, extra co-holder, threshold>1, foreign
 * namespace, missing key mapping, undecodable bytes) MUST throw.
 *
 * DO NOT loosen these tests to make them pass. Fix the production code.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { generateAgentKey } from "./keys.js";
import {
  assertOnboardingTopologyBindsKey,
  OnboardingTopologyMismatchError,
  type OnboardingTopologyExpectation,
} from "./verify-prepared.js";
import {
  rawPoint,
  signingKey,
  partyToKeyTx,
  namespaceDelegationTx,
  partyToParticipantTx,
  keyFingerprint,
  faithfulOnboarding,
} from "./_topology-fixture.js";

const KEY = generateAgentKey();
const POINT = rawPoint(KEY.publicKeySpkiB64);

let FINGERPRINT: string;
let PARTY: string;
let EXPECT: OnboardingTopologyExpectation;

beforeAll(async () => {
  FINGERPRINT = await keyFingerprint(POINT);
  PARTY = `agent::${FINGERPRINT}`;
  EXPECT = {
    publicKeySpkiB64: KEY.publicKeySpkiB64,
    party: PARTY,
    publicKeyFingerprint: FINGERPRINT,
  };
});

describe("C4: onboarding topology must structurally bind the agent's own key", () => {
  it("ACCEPTS a faithful, self-consistent onboarding bundle", async () => {
    const ob = await faithfulOnboarding(KEY.publicKeySpkiB64);
    expect(() =>
      assertOnboardingTopologyBindsKey(ob.onboardingTransactions, {
        publicKeySpkiB64: KEY.publicKeySpkiB64,
        party: ob.party,
        publicKeyFingerprint: ob.publicKeyFingerprint,
      })
    ).not.toThrow();
  });

  it("ACCEPTS a minimal bundle of just a PartyToKeyMapping for the agent's key", () => {
    const txs = [partyToKeyTx(PARTY, [signingKey(POINT)], 1)];
    expect(() => assertOnboardingTopologyBindsKey(txs, EXPECT)).not.toThrow();
  });

  it("REJECTS a PartyToKeyMapping that onboards a DIFFERENT (foreign) key", () => {
    const foreign = signingKey(rawPoint(generateAgentKey().publicKeySpkiB64));
    const txs = [partyToKeyTx(PARTY, [foreign], 1)];
    expect(() => assertOnboardingTopologyBindsKey(txs, EXPECT)).toThrow(
      OnboardingTopologyMismatchError
    );
  });

  it("REJECTS a PartyToKeyMapping with an EXTRA co-holder key (custody sharing)", () => {
    // The agent's key IS present, but so is an attacker key — a substring scan
    // would pass; the structural decode must reject the extra signer.
    const foreign = signingKey(rawPoint(generateAgentKey().publicKeySpkiB64));
    const txs = [partyToKeyTx(PARTY, [signingKey(POINT), foreign], 1)];
    expect(() => assertOnboardingTopologyBindsKey(txs, EXPECT)).toThrow(
      OnboardingTopologyMismatchError
    );
  });

  it("REJECTS a PartyToKeyMapping with threshold > 1", () => {
    const txs = [partyToKeyTx(PARTY, [signingKey(POINT)], 2)];
    expect(() => assertOnboardingTopologyBindsKey(txs, EXPECT)).toThrow(
      OnboardingTopologyMismatchError
    );
  });

  it("REJECTS a PartyToKeyMapping that binds a party id != the agent's expected party", () => {
    // The mapping keys a DIFFERENT party (same namespace, different name) than the
    // one the agent expects (prep.party). The namespace pre-check (B) passes
    // (namespace == fingerprint), but the structural decode must reject the
    // wrong-party mapping — otherwise the agent would key/persist an identity it
    // did not ask for.
    const otherParty = `victim::${FINGERPRINT}`;
    const txs = [partyToKeyTx(otherParty, [signingKey(POINT)], 1)];
    expect(() =>
      assertOnboardingTopologyBindsKey(txs, EXPECT) // expect.party === agent's PARTY
    ).toThrow(OnboardingTopologyMismatchError);
  });

  it("REJECTS a NamespaceDelegation whose target is a FOREIGN key", () => {
    const foreign = signingKey(rawPoint(generateAgentKey().publicKeySpkiB64));
    const txs = [
      partyToKeyTx(PARTY, [signingKey(POINT)], 1),
      namespaceDelegationTx(FINGERPRINT, foreign), // foreign delegate over our ns
    ];
    expect(() => assertOnboardingTopologyBindsKey(txs, EXPECT)).toThrow(
      OnboardingTopologyMismatchError
    );
  });

  it("REJECTS a NamespaceDelegation for a FOREIGN namespace", () => {
    const otherNs = "1220deadbeef00000000000000000000000000000000000000000000000000ff";
    const txs = [
      partyToKeyTx(PARTY, [signingKey(POINT)], 1),
      namespaceDelegationTx(otherNs, signingKey(POINT)),
    ];
    expect(() => assertOnboardingTopologyBindsKey(txs, EXPECT)).toThrow(
      OnboardingTopologyMismatchError
    );
  });

  it("REJECTS a PartyToParticipant consortium definition (threshold > 1)", () => {
    const txs = [
      partyToKeyTx(PARTY, [signingKey(POINT)], 1),
      partyToParticipantTx(PARTY, "PAR::p::1220feed", 2),
    ];
    expect(() => assertOnboardingTopologyBindsKey(txs, EXPECT)).toThrow(
      OnboardingTopologyMismatchError
    );
  });

  it("REJECTS a bundle with NO PartyToKeyMapping (no custody binding)", () => {
    const txs = [partyToParticipantTx(PARTY)]; // hosting only, no key binding
    expect(() => assertOnboardingTopologyBindsKey(txs, EXPECT)).toThrow(
      OnboardingTopologyMismatchError
    );
  });

  it("ACCEPTS NamespaceDelegation + PartyToParticipant with NO PartyToKeyMapping (real Canton generate-topology shape)", () => {
    // Canton's generate-topology returns the key->namespace binding as a
    // NamespaceDelegation plus a PartyToParticipant hosting the agent's party —
    // there is NO standalone PartyToKeyMapping. Custody is anchored by the
    // namespace (party = name::fingerprint(agentKey)). This honest bundle MUST be
    // accepted (the bug that blocked every real onboarding).
    const txs = [
      namespaceDelegationTx(FINGERPRINT, signingKey(POINT)),
      partyToParticipantTx(PARTY),
    ];
    expect(() => assertOnboardingTopologyBindsKey(txs, EXPECT)).not.toThrow();
  });

  it("REJECTS undecodable onboarding bytes (not a TopologyTransaction proto)", () => {
    // Bytes that contain the agent's raw key (so the substring pre-check passes)
    // but are NOT a valid TopologyTransaction → structural decode must reject,
    // closing the old substring-only bypass.
    const garbage = Buffer.concat([
      Buffer.from("KeyToParty/junk"),
      Buffer.from(POINT),
      Buffer.from("\xff\xff\xff trailing"),
    ]).toString("base64");
    expect(() => assertOnboardingTopologyBindsKey([garbage], EXPECT)).toThrow(
      OnboardingTopologyMismatchError
    );
  });

  it("REJECTS a party in a FOREIGN namespace (namespace != publicKeyFingerprint)", () => {
    const foreignParty =
      "agent::1220deadbeef00000000000000000000000000000000000000000000000000";
    const txs = [partyToKeyTx(foreignParty, [signingKey(POINT)], 1)];
    expect(() =>
      assertOnboardingTopologyBindsKey(txs, {
        ...EXPECT,
        party: foreignParty, // namespace != FINGERPRINT
      })
    ).toThrow(OnboardingTopologyMismatchError);
  });

  it("REJECTS an empty publicKeyFingerprint", () => {
    const txs = [partyToKeyTx(PARTY, [signingKey(POINT)], 1)];
    expect(() =>
      assertOnboardingTopologyBindsKey(txs, { ...EXPECT, publicKeyFingerprint: "" })
    ).toThrow(OnboardingTopologyMismatchError);
  });

  it("REJECTS when the relay returns no topology transactions at all", () => {
    expect(() => assertOnboardingTopologyBindsKey([], EXPECT)).toThrow(
      OnboardingTopologyMismatchError
    );
  });

  it("ACCEPTS the key whether the topology carries it RAW (32B) or DER-wrapped", () => {
    // Canton normalizes Ed25519 to the raw point, but the raw 32 bytes are a
    // contiguous suffix of the SPKI/DER encoding, so a DER-carrying key still
    // normalizes to the agent's point. Prove both pass (no false negative).
    const derKey = signingKey(Buffer.from(KEY.publicKeySpkiB64, "base64"));
    const txs = [partyToKeyTx(PARTY, [derKey], 1)];
    expect(() => assertOnboardingTopologyBindsKey(txs, EXPECT)).not.toThrow();
  });
});
