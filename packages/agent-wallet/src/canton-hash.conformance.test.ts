/**
 * CONFORMANCE — gates trusting the Canton V2 hash recompute against REAL
 * participant output.
 *
 * The production binding (transfer hash-binding + onboarding multiHash/fingerprint
 * asserts) is only as trustworthy as the claim that our recompute reproduces what
 * a live Canton participant signs. This test pins that claim to captured vectors:
 *
 *   preparedTx vector: assert recomputeHash(v.preparedTransaction) === v.hash
 *   topology   vector: assert recomputeTopologyMultiHash(v.onboardingTransactions)
 *                              === v.hashToSign
 *                      AND fingerprintHex(v.publicKeyKeyData) === v.publicKeyFingerprint
 *
 * GREEN-GATE behavior (intentional):
 *   - If `_conformance-vectors.json` is ABSENT or its arrays are EMPTY, the
 *     per-vector assertions are marked PENDING (`it.skip`, "awaiting live
 *     conformance vectors") so the suite stays green before vectors exist.
 *   - If the file exists WITH vectors, they MUST pass — a present-but-mismatching
 *     vector FAILS the build loudly. This is the gate that flips the binding from
 *     "library-says-so" to "verified against a live participant".
 *
 * Capturing vectors is PREPARE/GENERATE-only (side-effect-free; no execute /
 * finalize / money movement). See `_conformance-vectors.json` `_howToCapture`
 * and spec section C.
 */
import { describe, it, expect } from "vitest";
import {
  recomputeHash,
  recomputeTopologyMultiHash,
  fingerprintHex,
} from "./canton-hash.js";

// Vitest resolves JSON natively. The stub ships empty arrays; live vectors get
// dropped in here by the operator.
import vectors from "./_conformance-vectors.json";

interface PreparedVector {
  preparedTransaction: string;
  hash: string;
  note?: string;
}
interface TopologyVector {
  onboardingTransactions: string[];
  hashToSign: string;
  publicKeyKeyData: string;
  publicKeyFingerprint: string;
  note?: string;
}

const preparedTx: PreparedVector[] = Array.isArray(vectors?.preparedTx)
  ? (vectors.preparedTx as PreparedVector[])
  : [];
const topology: TopologyVector[] = Array.isArray(vectors?.topology)
  ? (vectors.topology as TopologyVector[])
  : [];

/** Normalize a Canton fingerprint hex (lowercase; tolerate an optional `1220`
 *  multihash prefix) so framed-vs-unframed representations compare equal. */
function normFp(fp: string): string {
  const lower = fp.trim().toLowerCase();
  return lower.startsWith("1220") ? lower.slice(4) : lower;
}

describe("Canton hash recompute — conformance against live participant vectors", () => {
  describe("prepared-transaction hash (transfer path)", () => {
    if (preparedTx.length === 0) {
      it.skip("awaiting live conformance vectors (preparedTx) — see _conformance-vectors.json", () => {
        /* pending: drop captured {preparedTransaction, hash} vectors into the JSON */
      });
    } else {
      preparedTx.forEach((v, i) => {
        it(`recomputeHash reproduces the participant hash [${i}]${v.note ? ` — ${v.note}` : ""}`, async () => {
          const got = await recomputeHash(v.preparedTransaction);
          expect(got).toBe(v.hash);
        });
      });
    }
  });

  describe("topology multiHash + fingerprint (onboarding path)", () => {
    if (topology.length === 0) {
      it.skip("awaiting live conformance vectors (topology) — see _conformance-vectors.json", () => {
        /* pending: drop captured {onboardingTransactions, hashToSign, publicKeyKeyData, publicKeyFingerprint} vectors */
      });
    } else {
      topology.forEach((v, i) => {
        it(`recomputeTopologyMultiHash reproduces hashToSign [${i}]${v.note ? ` — ${v.note}` : ""}`, async () => {
          const got = await recomputeTopologyMultiHash(v.onboardingTransactions);
          expect(got).toBe(v.hashToSign);
        });

        it(`fingerprintHex reproduces publicKeyFingerprint [${i}] (records which key-byte form Canton uses)`, async () => {
          // publicKeyKeyData is the EXACT base64 the agent sent (SPKI/DER). Try
          // both candidate preimages (SPKI DER bytes and the bare 32-byte point);
          // at least one MUST reproduce the relay fingerprint. Whichever matches
          // pins the form Canton fingerprints (spec B.5).
          const der = Buffer.from(v.publicKeyKeyData, "base64");
          const point = der.subarray(der.length - 32);
          const [fpDer, fpPoint] = await Promise.all([
            fingerprintHex(der),
            fingerprintHex(point),
          ]);
          const want = normFp(v.publicKeyFingerprint);
          const matchedDer = normFp(fpDer) === want;
          const matchedPoint = normFp(fpPoint) === want;
          expect(matchedDer || matchedPoint).toBe(true);
        });
      });
    }
  });

  // The published @canton-network/core-tx-visualizer@1.4.0 tarball ships only
  // `dist/**` + package.json — NO test fixtures or vectors — so there is no
  // in-tarball offline anchor to add here. (If a future minor ships fixtures,
  // add a test that runs them through recomputeHash / recomputeTopologyMultiHash
  // as an additional offline self-consistency anchor.) Documented as pending so
  // the intent is visible without failing the gate.
  it.skip("library-shipped offline test vectors — none present in 1.4.0 (dist-only tarball)", () => {
    /* intentionally pending: tarball ships no fixtures to anchor against */
  });
});
