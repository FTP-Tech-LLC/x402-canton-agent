/**
 * ensureWallet — lazy, idempotent self-custody onboarding.
 *
 * If a wallet already exists, return it (the agent reuses the same one forever).
 * Otherwise generate a key, onboard the external party through the relay
 * (generate-topology → sign the multiHash locally → allocate), persist, return.
 * This is the flow proven by the Phase 0 live spike.
 */
import { ED25519_WIRE_CONSTANTS } from "@ftptech/x402-canton-ledger";
import { generateAgentKey, signHashB64, type AgentKeyMaterial } from "./keys.js";
import { loadWallet, saveWallet, type AgentWallet } from "./store.js";
import { RelayClient } from "./relay-client.js";
import {
  assertOnboardingTopologyBindsKey,
  OnboardingTopologyMismatchError,
} from "./verify-prepared.js";
import { recomputeTopologyMultiHash, fingerprintHex } from "./canton-hash.js";

export interface EnsureWalletOpts {
  relayUrl: string;
  network: string;
  apiKey?: string | undefined;
  partyHint?: string;
  /** Injectable for tests; defaults to a real RelayClient. */
  relay?: RelayClient;
  /** Restore from an existing key (the `import` command) instead of generating a
   *  fresh one. The party namespace is this key's fingerprint, so the party is
   *  already on-ledger from the original `create`. */
  key?: AgentKeyMaterial;
  /** Restore mode (`import`): SKIP onboard/finalize because the external party is
   *  already allocated (a second allocate returns HTTP 400). prepare + the
   *  verify-before-sign legs still run; we persist the verified prep.party. */
  restore?: boolean;
  /** Ephemeral mode: mint a FRESH wallet on every call and NEVER touch the
   *  on-disk store — skip `loadWallet` (always onboard a new key) and skip
   *  `saveWallet` (the full key material is returned in the wallet object for the
   *  caller to hand off; nothing is persisted by us). Used by the hosted quest
   *  one-shot, which mints a throwaway wallet per request and returns its key to
   *  the user. Every verify-before-sign leg still runs — only the file I/O is
   *  skipped. Independent of `restore`. */
  ephemeral?: boolean;
}

export async function ensureWallet(opts: EnsureWalletOpts): Promise<AgentWallet> {
  // Ephemeral mode skips the on-disk store entirely: never reuse an existing
  // wallet (always mint fresh) and never persist (below). Every verify-before-
  // sign leg still runs — only the file I/O changes.
  if (!opts.ephemeral) {
    const existing = loadWallet();
    if (existing) return existing;
  }

  const key = opts.key ?? generateAgentKey();
  const relay =
    opts.relay ?? new RelayClient({ relayUrl: opts.relayUrl, apiKey: opts.apiKey });

  const prep = await relay.onboardPrepare({
    publicKey: {
      format: ED25519_WIRE_CONSTANTS.publicKeyFormat,
      keyData: key.publicKeySpkiB64,
      keySpec: ED25519_WIRE_CONSTANTS.keySpec,
    },
    partyHint: opts.partyHint ?? "agent",
  });

  // VERIFY-BEFORE-SIGN (onboarding) — TWO complementary, fail-closed legs:
  //  (1) STRUCTURAL: decode the topology transactions and prove they onboard the
  //      agent's OWN key into the agent's OWN namespace (authoritative mappings
  //      bind exactly the agent's key, threshold 1, no foreign co-holders).
  //  (2) HASH RECOMPUTE: recompute the multiHash + fingerprint locally (below)
  //      and sign the RECOMPUTED value, so the signature is bound to the exact
  //      bytes we structurally verified.
  // Either a relay that binds a different key/party (custody hijack, caught by 1)
  // or one that pairs honest-looking topology with the hash of a different bundle
  // (caught by 2) is refused. See verify-prepared.ts / canton-hash.ts.
  assertOnboardingTopologyBindsKey(prep.onboardingTransactions, {
    publicKeySpkiB64: key.publicKeySpkiB64,
    party: prep.party,
    publicKeyFingerprint: prep.publicKeyFingerprint,
  });

  // HASH RECOMPUTE (onboarding): bind the signed multiHash to the EXACT topology
  // bytes we just structurally verified. The relay's `hashToSign` is the combined
  // multiHash over the onboarding transactions; recompute it locally EXACTLY as
  // the participant does on `allocate` (HashPurpose 11 per-tx, 55 combined; the
  // official @canton-network/core-tx-visualizer primitives), compare, and sign the
  // RECOMPUTED value — never the relay's. A relay that returns honest-looking
  // topology paired with the multiHash of a DIFFERENT bundle is refused here.
  const recomputedMultiHash = await recomputeTopologyMultiHash(
    prep.onboardingTransactions
  );
  if (recomputedMultiHash !== prep.hashToSign) {
    throw new OnboardingTopologyMismatchError(
      `relay-returned onboarding hashToSign does NOT match the multiHash recomputed ` +
        `from the onboarding transactions — refusing to sign (possible tampered/` +
        `compromised relay supplying the hash of a different topology bundle)`
    );
  }

  // LOCAL FINGERPRINT assert: the prior namespace check compared two
  // relay-supplied strings (party namespace vs publicKeyFingerprint). Derive the
  // fingerprint locally from the agent's OWN public-key bytes and assert it equals
  // the relay's publicKeyFingerprint — closing the relay-vs-relay namespace trust
  // gap (the namespace is the fingerprint; if the relay lies about the fingerprint
  // it lies about the namespace). Fail-closed.
  await assertLocalFingerprintMatches(
    key.publicKeySpkiB64,
    prep.publicKeyFingerprint
  );

  // FINALIZE (create) vs SKIP (restore/import). A first-time onboard signs the
  // recomputed multiHash and submits it so the participant ALLOCATES the external
  // party. On `import` (restore of an already-onboarded key) the party is ALREADY
  // allocated — a second allocate returns HTTP 400 — so we skip finalize and
  // persist the party that prepare+verify just proved binds our key. The
  // verify-before-sign legs above run on BOTH paths (the security invariant).
  let party = prep.party;
  if (!opts.restore) {
    const signature = {
      format: ED25519_WIRE_CONSTANTS.signatureFormat,
      // Sign the RECOMPUTED multiHash, not the relay's hashToSign (they are proven
      // equal above; signing the recomputed value makes the binding explicit).
      signature: signHashB64(recomputedMultiHash, key.privateKeyPkcs8Pem),
      signingAlgorithmSpec: ED25519_WIRE_CONSTANTS.signingAlgorithmSpec,
      signedBy: prep.publicKeyFingerprint,
    };

    const fin = await relay.onboardFinalize({
      onboardingTransactions: prep.onboardingTransactions,
      multiHashSignatures: [signature],
    });

    // The party we PERSIST (and will later act_as) must be the one we just proved
    // lives in the agent key's namespace. The verified anchor is prep.party (it was
    // checked against publicKeyFingerprint above); if the finalize step returns a
    // different party, it must STILL be in that same verified namespace, else a
    // relay could swap the persisted identity after the topology check. Fail-closed.
    party = fin.party || prep.party;
    if (party !== prep.party) {
      const sep = party.lastIndexOf("::");
      const ns = sep > 0 ? party.slice(sep + 2) : "";
      if (ns !== prep.publicKeyFingerprint) {
        throw new OnboardingTopologyMismatchError(
          `onboard/finalize returned party ${JSON.stringify(party)} whose namespace does not match ` +
            `the verified key fingerprint ${JSON.stringify(prep.publicKeyFingerprint)} — refusing to ` +
            `persist a wallet for a party outside the agent key's own namespace`
        );
      }
    }
  }

  // Resolve wallet.network from the relay's /supported (AUTHORITATIVE — the relay
  // knows which Canton network it settles on) so a wrong client-side default
  // (e.g. the testnet default when paying a mainnet facilitator) can't be
  // persisted. wallet.network keys the out-of-band DSO pin used by withdraw /
  // cip56 transfers; a mismatched network leaves the DSO unpinned and the
  // foreign-party backstop refuses to sign. Fall back to opts.network if
  // /supported is unavailable or shapeless.
  let resolvedNetwork = opts.network;
  try {
    const sup = await relay.supported();
    const net = sup?.kinds?.find(
      (k) => typeof k?.network === "string" && k.network.length > 0
    )?.network;
    if (net) resolvedNetwork = net;
  } catch {
    /* relay /supported unavailable — keep the caller-provided network */
  }

  const wallet: AgentWallet = {
    network: resolvedNetwork,
    relayUrl: opts.relayUrl,
    party,
    publicKeySpkiB64: key.publicKeySpkiB64,
    privateKeyPkcs8Pem: key.privateKeyPkcs8Pem,
    publicKeyFingerprint: prep.publicKeyFingerprint,
    createdAt: new Date().toISOString(),
  };
  // Ephemeral wallets are returned to the caller (with full key material) but
  // NEVER written to disk — the quest one-shot hands the key to the user and
  // keeps no copy.
  if (!opts.ephemeral) saveWallet(wallet);
  return wallet;
}

/** The bare 32-byte Ed25519 public-key point from an SPKI/DER base64 (the point
 *  is the trailing 32 bytes of the SPKI encoding). */
function rawEd25519Point(spkiB64: string): Buffer {
  const der = Buffer.from(spkiB64, "base64");
  return der.subarray(Math.max(0, der.length - 32));
}

/** Normalize a Canton fingerprint hex for comparison: lowercase; tolerate an
 *  optional `1220` (0x12 0x20 multihash sha2-256) prefix on either side so a
 *  framed-vs-unframed representation still compares equal. */
function normalizeFingerprint(fp: string): string {
  const lower = fp.trim().toLowerCase();
  return lower.startsWith("1220") ? lower.slice(4) : lower;
}

/**
 * Derive the public-key fingerprint LOCALLY from the agent's own key bytes and
 * assert it equals the relay-returned `publicKeyFingerprint`. Fail-closed.
 *
 * WHICH KEY-BYTE FORM: Canton's fingerprint preimage is `HashPurpose 12 ||
 * <key bytes>`, but whether `<key bytes>` is the SPKI/DER the agent sent or the
 * bare 32-byte Ed25519 point is not pinned offline (spec B.5 flags this as
 * needing a live `generate-topology` vector to confirm). We compute BOTH
 * candidate fingerprints and accept iff the relay's value equals EITHER. This is
 * still a real binding against the attack we care about — a relay returning the
 * fingerprint of a FOREIGN key matches NEITHER candidate and is refused — while
 * tolerating the spec ambiguity until a live vector pins the exact form. The
 * conformance test (`canton-hash.conformance.test.ts`) records, once a live
 * topology vector is dropped in, which form Canton actually uses.
 */
async function assertLocalFingerprintMatches(
  publicKeySpkiB64: string,
  relayFingerprint: string
): Promise<void> {
  if (typeof relayFingerprint !== "string" || relayFingerprint.length === 0) {
    throw new OnboardingTopologyMismatchError(
      "relay returned an empty publicKeyFingerprint — refusing to sign the onboarding " +
        "topology (cannot bind the party namespace to the agent's key)"
    );
  }
  const derBytes = Buffer.from(publicKeySpkiB64, "base64");
  const pointBytes = rawEd25519Point(publicKeySpkiB64);
  const [fpFromDer, fpFromPoint] = await Promise.all([
    fingerprintHex(derBytes),
    fingerprintHex(pointBytes),
  ]);
  const want = normalizeFingerprint(relayFingerprint);
  const candidates = [fpFromDer, fpFromPoint].map(normalizeFingerprint);
  if (!candidates.includes(want)) {
    throw new OnboardingTopologyMismatchError(
      `relay-returned publicKeyFingerprint ${JSON.stringify(relayFingerprint)} does not ` +
        `equal the fingerprint derived locally from the agent's own public key ` +
        `(neither the SPKI/DER nor the bare-point preimage matched) — refusing to sign ` +
        `the onboarding topology (possible tampered/compromised relay claiming a foreign ` +
        `key's fingerprint as the agent's namespace)`
    );
  }
}
