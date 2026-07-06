import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWallet } from "./onboard.js";
import { loadWallet } from "./store.js";
import { verifyHashB64, generateAgentKey } from "./keys.js";
import { OnboardingTopologyMismatchError } from "./verify-prepared.js";
import {
  faithfulOnboarding,
  partyToKeyTx,
  signingKey,
  rawPoint,
  keyFingerprint,
  topologyMultiHash,
} from "./_topology-fixture.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "caw-"));
  process.env.CANTON_AGENT_HOME = tmp;
});
afterEach(() => {
  delete process.env.CANTON_AGENT_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Faithful mock relay: an HONEST relay's `onboard/prepare` returns REAL Canton
 * topology transactions that bind the agent's own key (PartyToKeyMapping +
 * NamespaceDelegation + PartyToParticipant), the matching multiHash as
 * `hashToSign`, and the key's fingerprint as `publicKeyFingerprint` / party
 * namespace. The mock reads the SPKI key the agent sent and builds that
 * self-consistent shape with `_topology-fixture`, so `ensureWallet`'s full
 * verify-before-sign (structural decode + multiHash recompute + local
 * fingerprint) is exercised end-to-end on the honest path.
 */
function mockRelay() {
  let built: Awaited<ReturnType<typeof faithfulOnboarding>> | undefined;
  return {
    onboardPrepare: vi.fn().mockImplementation(async (b: { publicKey: { keyData: string } }) => {
      built = await faithfulOnboarding(b.publicKey.keyData);
      return {
        party: built.party,
        publicKeyFingerprint: built.publicKeyFingerprint,
        onboardingTransactions: built.onboardingTransactions,
        hashToSign: built.hashToSign,
      };
    }),
    onboardFinalize: vi.fn().mockImplementation(async () => ({ party: built!.party })),
    built: () => built!,
  };
}

describe("ensureWallet", () => {
  it("creates + persists a self-custody wallet and signs the RECOMPUTED multiHash", async () => {
    const relay = mockRelay();
    const w = await ensureWallet({
      relayUrl: "http://relay",
      network: "canton:testnet",
      relay: relay as never,
    });
    const built = relay.built();
    expect(w.party).toBe(built.party);
    expect(w.publicKeyFingerprint).toBe(built.publicKeyFingerprint);
    expect(w.privateKeyPkcs8Pem).toContain("BEGIN PRIVATE KEY");
    expect(loadWallet()?.party).toBe(built.party);
    expect(relay.onboardPrepare).toHaveBeenCalledOnce();
    expect(relay.onboardFinalize).toHaveBeenCalledOnce();
    // The finalize signature is a valid Ed25519 sig over the (recomputed, ==
    // relay) multiHash by the agent key.
    const sig = relay.onboardFinalize.mock.calls[0][0].multiHashSignatures[0];
    expect(sig.signedBy).toBe(built.publicKeyFingerprint);
    expect(verifyHashB64(built.hashToSign, sig.signature, w.publicKeySpkiB64)).toBe(true);
  });

  it("ephemeral: mints a FRESH wallet each call and NEVER touches the on-disk store", async () => {
    // Seed a normal (persisted) wallet first — ephemeral must IGNORE it.
    await ensureWallet({
      relayUrl: "http://relay",
      network: "canton:testnet",
      relay: mockRelay() as never,
    });
    const persisted = loadWallet();
    expect(persisted).not.toBeNull();

    // Ephemeral onboards a fresh key rather than reusing the persisted wallet.
    const relay = mockRelay();
    const w1 = await ensureWallet({
      relayUrl: "http://relay",
      network: "canton:testnet",
      relay: relay as never,
      ephemeral: true,
    });
    expect(relay.onboardPrepare).toHaveBeenCalledOnce(); // did NOT short-circuit
    expect(w1.party).not.toBe(persisted!.party); // a different, fresh party
    expect(w1.privateKeyPkcs8Pem).toContain("BEGIN PRIVATE KEY"); // key to hand off

    // It did NOT persist: the on-disk wallet is still the seeded one, untouched.
    expect(loadWallet()?.party).toBe(persisted!.party);
    expect(loadWallet()?.party).not.toBe(w1.party);

    // A second ephemeral call mints a DIFFERENT fresh party (new key each time).
    const w2 = await ensureWallet({
      relayUrl: "http://relay",
      network: "canton:testnet",
      relay: mockRelay() as never,
      ephemeral: true,
    });
    expect(w2.party).not.toBe(w1.party);
  });

  it("import (restore): onboards a PROVIDED key, runs prepare+verify, SKIPS finalize", async () => {
    // The `import` path passes a key + restore:true. The persisted wallet must
    // carry THAT key (so the restored party namespace == the backed-up key's
    // fingerprint), prepare+verify MUST still run (security), but finalize is
    // SKIPPED — the party is already allocated on-ledger, so a second allocate
    // would 400.
    const restoreKey = generateAgentKey();
    const relay = mockRelay();
    const w = await ensureWallet({
      relayUrl: "http://relay",
      network: "canton:testnet",
      relay: relay as never,
      key: restoreKey,
      restore: true,
    });
    expect(w.publicKeySpkiB64).toBe(restoreKey.publicKeySpkiB64);
    expect(w.privateKeyPkcs8Pem).toBe(restoreKey.privateKeyPkcs8Pem);
    // prepare ran (with the imported key) — the verify-before-sign legs depend on it.
    expect(relay.onboardPrepare).toHaveBeenCalledOnce();
    expect(relay.onboardPrepare.mock.calls[0][0].publicKey.keyData).toBe(
      restoreKey.publicKeySpkiB64
    );
    // finalize was NOT called (party already allocated; re-allocate would 400).
    expect(relay.onboardFinalize).not.toHaveBeenCalled();
    // Restored party is the verified prep.party, in the imported key's namespace.
    expect(w.party).toBe(relay.built().party);
    expect(loadWallet()?.publicKeySpkiB64).toBe(restoreKey.publicKeySpkiB64);
  });

  it("resolves wallet.network from the relay's /supported (authoritative, overrides the default)", async () => {
    const relay = mockRelay() as ReturnType<typeof mockRelay> & {
      supported?: unknown;
    };
    relay.supported = vi
      .fn()
      .mockResolvedValue({ kinds: [{ network: "canton:mainnet" }] });
    const w = await ensureWallet({
      relayUrl: "http://relay",
      network: "canton:testnet", // wrong client default; relay says mainnet
      relay: relay as never,
    });
    expect(w.network).toBe("canton:mainnet");
  });

  it("falls back to the caller network when the relay /supported is unavailable", async () => {
    // mockRelay has no `supported` -> the call throws -> keep opts.network.
    const relay = mockRelay();
    const w = await ensureWallet({
      relayUrl: "http://relay",
      network: "canton:testnet",
      relay: relay as never,
    });
    expect(w.network).toBe("canton:testnet");
  });

  it("is idempotent — reuses the persisted wallet, no relay calls", async () => {
    const relay1 = mockRelay();
    await ensureWallet({ relayUrl: "http://relay", network: "canton:testnet", relay: relay1 as never });
    const relay2 = mockRelay();
    const w = await ensureWallet({ relayUrl: "http://relay", network: "canton:testnet", relay: relay2 as never });
    expect(w.party).toBe(relay1.built().party);
    expect(relay2.onboardPrepare).not.toHaveBeenCalled();
    expect(relay2.onboardFinalize).not.toHaveBeenCalled();
  });

  it("REFUSES to onboard when the relay topology onboards a DIFFERENT key (C4)", async () => {
    // A malicious relay returns a well-formed party in a self-consistent
    // namespace but topology (PartyToKeyMapping) that onboards a FOREIGN key.
    const foreignPoint = rawPoint(generateAgentKey().publicKeySpkiB64);
    const evil = {
      onboardPrepare: vi.fn().mockImplementation(async (b: { publicKey: { keyData: string } }) => {
        const point = rawPoint(b.publicKey.keyData);
        const fingerprint = await keyFingerprint(point);
        const party = `agent::${fingerprint}`;
        // Bind the party to a FOREIGN signing key (custody hijack).
        const txs = [partyToKeyTx(party, [signingKey(foreignPoint)], 1)];
        return {
          party,
          publicKeyFingerprint: fingerprint,
          onboardingTransactions: txs,
          hashToSign: await topologyMultiHash(txs),
        };
      }),
      onboardFinalize: vi.fn().mockResolvedValue({ party: "x" }),
    };
    await expect(
      ensureWallet({ relayUrl: "http://relay", network: "canton:testnet", relay: evil as never })
    ).rejects.toThrow(OnboardingTopologyMismatchError);
    expect(evil.onboardFinalize).not.toHaveBeenCalled();
    expect(loadWallet()).toBeNull();
  });

  it("REFUSES when the relay hashToSign does NOT match the recomputed multiHash", async () => {
    // The topology is honest (binds the agent's own key) but the relay returns a
    // multiHash of a DIFFERENT bundle — the agent must not blind-sign it.
    const evil = {
      onboardPrepare: vi.fn().mockImplementation(async (b: { publicKey: { keyData: string } }) => {
        const built = await faithfulOnboarding(b.publicKey.keyData);
        return {
          party: built.party,
          publicKeyFingerprint: built.publicKeyFingerprint,
          onboardingTransactions: built.onboardingTransactions,
          // Tampered: a hash that is not the multiHash of these transactions.
          hashToSign: Buffer.from("not-the-real-multihash-of-this-bundle").toString("base64"),
        };
      }),
      onboardFinalize: vi.fn().mockResolvedValue({ party: "x" }),
    };
    await expect(
      ensureWallet({ relayUrl: "http://relay", network: "canton:testnet", relay: evil as never })
    ).rejects.toThrow(OnboardingTopologyMismatchError);
    expect(evil.onboardFinalize).not.toHaveBeenCalled();
    expect(loadWallet()).toBeNull();
  });

  it("REFUSES when the relay publicKeyFingerprint is a FOREIGN key's fingerprint", async () => {
    // Structural topology binds the agent's key and the multiHash is honest, but
    // the relay claims a foreign fingerprint as the namespace. The local
    // fingerprint derivation must catch the mismatch.
    const foreignFp = await keyFingerprint(rawPoint(generateAgentKey().publicKeySpkiB64));
    const evil = {
      onboardPrepare: vi.fn().mockImplementation(async (b: { publicKey: { keyData: string } }) => {
        const point = rawPoint(b.publicKey.keyData);
        // Party namespace must equal the claimed fingerprint for the (B) check to
        // pass, so the only failing check is the LOCAL fingerprint derivation.
        const party = `agent::${foreignFp}`;
        const txs = [partyToKeyTx(party, [signingKey(point)], 1)];
        return {
          party,
          publicKeyFingerprint: foreignFp,
          onboardingTransactions: txs,
          hashToSign: await topologyMultiHash(txs),
        };
      }),
      onboardFinalize: vi.fn().mockResolvedValue({ party: "x" }),
    };
    await expect(
      ensureWallet({ relayUrl: "http://relay", network: "canton:testnet", relay: evil as never })
    ).rejects.toThrow(OnboardingTopologyMismatchError);
    expect(evil.onboardFinalize).not.toHaveBeenCalled();
    expect(loadWallet()).toBeNull();
  });
});
