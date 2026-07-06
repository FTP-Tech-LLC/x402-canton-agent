/**
 * Ed25519 key material for a self-custody agent wallet.
 *
 * The agent generates and holds this key. The participant only ever sees the
 * SPKI/DER public key (during onboarding); the private key never leaves the
 * agent. Serialized as strings so it can live in ~/.canton-agent/wallet.json.
 */
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

export interface AgentKeyMaterial {
  /** Base64 of the SPKI/DER public key — what onboarding sends as keyData. */
  publicKeySpkiB64: string;
  /** PKCS8 PEM private key — self-custody secret, persisted locally only. */
  privateKeyPkcs8Pem: string;
}

export function generateAgentKey(): AgentKeyMaterial {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeySpkiB64: Buffer.from(
      publicKey.export({ type: "spki", format: "der" })
    ).toString("base64"),
    privateKeyPkcs8Pem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

/**
 * Reconstruct the full key material from a PKCS8 PEM private key — the inverse of
 * `export` (which prints `privateKeyPkcs8Pem`). The Ed25519 public key is derived
 * deterministically from the private key, so a backed-up private key is all that
 * is needed to restore a wallet (the party namespace is this key's fingerprint,
 * re-affirmed idempotently by the relay on `import`).
 *
 * Throws on a malformed PEM or a non-Ed25519 key — the agent wallet is Ed25519
 * only, and importing a wrong-curve key would onboard an unusable party.
 */
export function agentKeyFromPrivatePem(pkcs8Pem: string): AgentKeyMaterial {
  // Trim: a PEM piped from `export` (stdin) or read from a file carries a
  // trailing newline, and copy/paste can add leading whitespace — neither is
  // significant, but createPrivateKey rejects some of it.
  const pem = pkcs8Pem.trim();
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch (e) {
    throw new Error(
      `could not parse the private key — expected a PKCS8 PEM ` +
        `(-----BEGIN PRIVATE KEY-----): ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `unsupported key type ${JSON.stringify(privateKey.asymmetricKeyType)} — ` +
        `the agent wallet is Ed25519 only`
    );
  }
  const publicKey = createPublicKey(privateKey);
  return {
    publicKeySpkiB64: Buffer.from(
      publicKey.export({ type: "spki", format: "der" })
    ).toString("base64"),
    privateKeyPkcs8Pem: privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string,
  };
}

export function loadPrivateKey(pkcs8Pem: string): KeyObject {
  return createPrivateKey(pkcs8Pem);
}

export function loadPublicKey(spkiB64: string): KeyObject {
  return createPublicKey({
    key: Buffer.from(spkiB64, "base64"),
    format: "der",
    type: "spki",
  });
}

/**
 * Sign a base64 hash (the `multiHash` from generate-topology, or a
 * `preparedTransactionHash` from interactive-submission) with the agent's key.
 * Returns a base64 64-byte R||S Ed25519 signature — `SIGNATURE_FORMAT_CONCAT`.
 */
export function signHashB64(hashB64: string, pkcs8Pem: string): string {
  return cryptoSign(
    null,
    Buffer.from(hashB64, "base64"),
    createPrivateKey(pkcs8Pem)
  ).toString("base64");
}

/** Verify a signHashB64 result — used in tests + the sign-before-trust check. */
export function verifyHashB64(
  hashB64: string,
  signatureB64: string,
  spkiB64: string
): boolean {
  return cryptoVerify(
    null,
    Buffer.from(hashB64, "base64"),
    loadPublicKey(spkiB64),
    Buffer.from(signatureB64, "base64")
  );
}
