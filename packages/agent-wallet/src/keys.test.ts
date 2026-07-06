import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  generateAgentKey,
  agentKeyFromPrivatePem,
  signHashB64,
  verifyHashB64,
} from "./keys.js";

describe("agent keys", () => {
  it("generates Ed25519 material (SPKI b64 public + PKCS8 PEM private)", () => {
    const k = generateAgentKey();
    expect(k.publicKeySpkiB64).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(k.privateKeyPkcs8Pem).toContain("BEGIN PRIVATE KEY");
  });

  it("sign/verify round-trips over a base64 hash; tampered hash fails", () => {
    const k = generateAgentKey();
    const hash = Buffer.from("a-prepared-transaction-hash").toString("base64");
    const sig = signHashB64(hash, k.privateKeyPkcs8Pem);
    expect(verifyHashB64(hash, sig, k.publicKeySpkiB64)).toBe(true);
    const tampered = Buffer.from("a-different-hash").toString("base64");
    expect(verifyHashB64(tampered, sig, k.publicKeySpkiB64)).toBe(false);
  });

  it("distinct keys produce distinct signatures", () => {
    const hash = Buffer.from("h").toString("base64");
    const a = generateAgentKey();
    const b = generateAgentKey();
    expect(signHashB64(hash, a.privateKeyPkcs8Pem)).not.toBe(
      signHashB64(hash, b.privateKeyPkcs8Pem)
    );
  });

  describe("agentKeyFromPrivatePem (import / restore)", () => {
    it("reconstructs the SAME public key + signing identity from the exported PEM", () => {
      const orig = generateAgentKey();
      // `export` prints exactly privateKeyPkcs8Pem — feed that back in.
      const restored = agentKeyFromPrivatePem(orig.privateKeyPkcs8Pem);
      // Same public key => same fingerprint => same party namespace on re-onboard.
      expect(restored.publicKeySpkiB64).toBe(orig.publicKeySpkiB64);
      // The restored key signs verifiably under the original public key.
      const hash = Buffer.from("restore-roundtrip").toString("base64");
      const sig = signHashB64(hash, restored.privateKeyPkcs8Pem);
      expect(verifyHashB64(hash, sig, orig.publicKeySpkiB64)).toBe(true);
    });

    it("tolerates surrounding whitespace around the PEM", () => {
      const orig = generateAgentKey();
      const padded = `\n  ${orig.privateKeyPkcs8Pem.trim()}\n\n`;
      expect(agentKeyFromPrivatePem(padded).publicKeySpkiB64).toBe(
        orig.publicKeySpkiB64
      );
    });

    it("rejects a non-Ed25519 key (wallet is Ed25519 only)", () => {
      const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pem = rsa.privateKey.export({
        type: "pkcs8",
        format: "pem",
      }) as string;
      expect(() => agentKeyFromPrivatePem(pem)).toThrow(/Ed25519 only/);
    });

    it("rejects a malformed PEM with a clear error", () => {
      expect(() => agentKeyFromPrivatePem("not a pem")).toThrow(
        /could not parse the private key/
      );
    });
  });
});
