/**
 * ROUND-4 ADVERSARY — the `claim` path (tx.ts `claimAll`).
 *
 * THREAT MODEL: the relay is MALICIOUS; it returns the `preparedTransaction`
 * bytes + the `hash` the agent signs and re-submits. `claimAll` (the routine
 * `canton-agent-wallet claim` command, run right after funding) was the ONE
 * caller of `prepareSignExecute` that passed NEITHER `verify` NOR `hashBinding`,
 * so the entire verify-before-sign + hash-binding gate was skipped and the agent
 * blind-signed whatever the relay returned.
 *
 * A malicious relay can prepare an OUTGOING DRAIN instead of the
 * `TransferInstruction_Accept` the agent built — root exercise
 * `ExternalPartyAmuletRules_CreateTransferCommand` (or `TransferFactory_Transfer`)
 * with the agent as act_as/sender and ATTACKER as receiver, full balance — set
 * the relay-returned hash to the (honest, for ITS chosen tx) V2 hash of those
 * drain bytes, and the agent signs the drain. No byte-swap is even required: it
 * is a direct blind-sign of relay-chosen draining bytes.
 *
 * SECURE: `claimAll` must NOT blind-sign. It must structurally bind the prepared
 * transaction to a TransferInstruction_Accept (no outbound transfer leg) AND
 * bind the signed hash to those bytes, fail-closed — exactly like the
 * transfer/createTransferCommand paths. A test that FAILS (the drain is signed +
 * executed) is the REAL bypass; fix it in production. DO NOT loosen this test.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { claimAll } from "./tx.js";
import { RelayClient } from "./relay-client.js";
import { generateAgentKey } from "./keys.js";
import {
  PreparedTransferMismatchError,
  assertPreparedAcceptMatches,
  type HashBindingOptions,
} from "./verify-prepared.js";
import type { AgentWallet } from "./store.js";
import { buildPreparedV1, buildPrepared, buildPreparedAccept } from "./_prepared-fixture.js";

/** Deterministic stand-in for Canton's V2 hash (plain sha256 of the bytes). */
function RECOMPUTE(b64: string): string {
  return createHash("sha256").update(Buffer.from(b64, "base64")).digest("base64");
}
/** A configured hash binding, so these tests isolate the STRUCTURAL accept gate
 *  (the drain is rejected because it is NOT an accept, not merely because the
 *  default fail-closed hash binding refused). */
const BOUND: HashBindingOptions = { recomputeHash: RECOMPUTE };

function wallet(): AgentWallet {
  const k = generateAgentKey();
  return {
    network: "canton:testnet",
    relayUrl: "http://relay",
    party: "agent::1220abcd",
    publicKeySpkiB64: k.publicKeySpkiB64,
    privateKeyPkcs8Pem: k.privateKeyPkcs8Pem,
    publicKeyFingerprint: "agentfp",
    createdAt: "t",
  };
}

const ATTACKER = "att.acker::1220dead";
const DSO = "DSO::1220cafe";

/**
 * Stub a MALICIOUS relay whose `submit/prepare` returns whatever `prepared`
 * yields (a drain by default), paired with the matching honest V2 hash. Captures
 * whether `execute` was reached and the bytes that were submitted.
 */
function stubMaliciousClaimRelay(prepared: string): {
  executed: () => boolean;
  submittedBytes: () => string | undefined;
} {
  const w = wallet();
  let executed = false;
  let submittedBytes: string | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body?: string } = {}) => {
      if (url.endsWith("/pending")) {
        return new Response(
          JSON.stringify({ party: w.party, pending: [{ cid: "ti1", amount: "5.0" }] }),
          { status: 200 }
        );
      }
      if (url.endsWith("/v1/wallet/resolve/accept")) {
        return new Response(
          JSON.stringify({ choiceContextData: { values: {} }, disclosedContracts: [] }),
          { status: 200 }
        );
      }
      if (url.endsWith("/v1/wallet/submit/prepare")) {
        // The relay IGNORES the TransferInstruction_Accept the agent built and
        // returns a DRAIN, with the honest V2 hash OF THE DRAIN (it is preparing
        // honestly for its own chosen tx, so this hash matches on execute).
        return new Response(
          JSON.stringify({ preparedTransaction: prepared, hash: RECOMPUTE(prepared) }),
          { status: 200 }
        );
      }
      if (url.endsWith("/v1/wallet/submit/execute")) {
        executed = true;
        submittedBytes = JSON.parse(init.body ?? "{}").preparedTransaction;
        return new Response(JSON.stringify({ updateId: "u1" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    })
  );
  return { executed: () => executed, submittedBytes: () => submittedBytes };
}

afterEach(() => vi.unstubAllGlobals());

describe("claimAll — blind-sign bypass on the claim path", () => {
  it("REJECTS a relay that returns an OUTBOUND v1 DRAIN instead of TransferInstruction_Accept (no execute)", async () => {
    // Malicious drain: a v1 CreateTransferCommand sending the agent's funds to
    // ATTACKER. act_as/sender = the agent (so it IS authorized by the agent's key
    // if blindly signed), receiver = ATTACKER, full balance.
    const drain = buildPreparedV1({
      sender: "agent::1220abcd",
      receiver: ATTACKER,
      delegate: ATTACKER,
      amount: "9999.0000000000",
      nonce: 1,
      expectedDso: DSO,
    });
    const r = stubMaliciousClaimRelay(drain);
    await expect(
      claimAll(new RelayClient({ relayUrl: "http://relay" }), wallet(), { hashBinding: BOUND })
    ).rejects.toBeInstanceOf(PreparedTransferMismatchError);
    expect(r.executed()).toBe(false); // never blind-signed/executed the drain
  });

  it("REJECTS a relay that returns an OUTBOUND cip56 transfer DRAIN instead of Accept (no execute)", async () => {
    const drain = buildPrepared({
      sender: "agent::1220abcd",
      receiver: ATTACKER,
      amount: "9999.0000000000",
      admin: DSO,
      id: "Amulet",
    });
    const r = stubMaliciousClaimRelay(drain);
    await expect(
      claimAll(new RelayClient({ relayUrl: "http://relay" }), wallet(), { hashBinding: BOUND })
    ).rejects.toBeInstanceOf(PreparedTransferMismatchError);
    expect(r.executed()).toBe(false);
  });

  // POSITIVE — the HONEST claim shape (a real TransferInstruction_Accept by the
  // agent) still verifies + executes (over-strict regression guard).
  it("ACCEPTS the honest TransferInstruction_Accept claim shape (executes)", async () => {
    const accept = buildPreparedAccept({ selfParty: "agent::1220abcd" });
    const r = stubMaliciousClaimRelay(accept);
    const out = await claimAll(new RelayClient({ relayUrl: "http://relay" }), wallet(), {
      hashBinding: BOUND,
    });
    expect(out.claimed).toBe(1);
    expect(r.executed()).toBe(true);
  });
});

describe("claim accept consequence whitelist (0.1.2): Archive + LockedAmulet_UnlockV2 only", () => {
  const PARTY = "ctai-agent::1220aa";
  it("ACCEPTS the real claim shape: Accept root + LockedAmulet_UnlockV2 + Archive consequences", () => {
    const b64 = buildPreparedAccept({
      selfParty: PARTY,
      consequenceChoiceIds: ["LockedAmulet_UnlockV2", "Archive"],
    });
    expect(() => assertPreparedAcceptMatches(b64, { selfParty: PARTY, nowMs: Date.now() })).not.toThrow();
  });
  it("still ACCEPTS a bare Accept with no consequences", () => {
    const b64 = buildPreparedAccept({ selfParty: PARTY });
    expect(() => assertPreparedAcceptMatches(b64, { selfParty: PARTY, nowMs: Date.now() })).not.toThrow();
  });
  it("REJECTS a CreateTransferCommand drain smuggled as a consequence", () => {
    const b64 = buildPreparedAccept({
      selfParty: PARTY,
      consequenceChoiceIds: ["Archive", "ExternalPartyAmuletRules_CreateTransferCommand"],
    });
    expect(() => assertPreparedAcceptMatches(b64, { selfParty: PARTY, nowMs: Date.now() })).toThrow(
      PreparedTransferMismatchError
    );
  });
  it("REJECTS a TransferFactory_Transfer drain consequence", () => {
    const b64 = buildPreparedAccept({ selfParty: PARTY, consequenceChoiceIds: ["TransferFactory_Transfer"] });
    expect(() => assertPreparedAcceptMatches(b64, { selfParty: PARTY, nowMs: Date.now() })).toThrow(
      PreparedTransferMismatchError
    );
  });
});
