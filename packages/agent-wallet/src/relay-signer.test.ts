import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { makeRelaySigner } from "./relay-signer.js";
import { generateAgentKey } from "./keys.js";
import type { AgentWallet } from "./store.js";

/** Deterministic stand-in for Canton's V2 hash (see verify-prepared.ts). */
function RECOMPUTE(b64: string): string {
  return createHash("sha256").update(Buffer.from(b64, "base64")).digest("base64");
}

function wallet(): AgentWallet {
  const k = generateAgentKey();
  return {
    network: "canton:testnet",
    relayUrl: "http://relay",
    party: "agent::12201",
    publicKeySpkiB64: k.publicKeySpkiB64,
    privateKeyPkcs8Pem: k.privateKeyPkcs8Pem,
    publicKeyFingerprint: "12201fp",
    createdAt: "t",
  };
}

afterEach(() => vi.unstubAllGlobals());

// The signTransferFactory happy path (payPrepare → verify-before-sign → sign →
// payCommit) is covered end-to-end in tx.test.ts / merge.test.ts, which stub the
// relay endpoints and build a faithful prepared transfer for verify-before-sign.

/**
 * Amount ceiling + expected-payee pin. The spend breaker is load-bearing only if
 * the signer REFUSES to sign a merchant-quoted amount above a caller-set ceiling
 * or to a payee the caller did not authorize — defending against an over-quoting
 * or MITM'd merchant. Both opts are OPTIONAL (unset → the legacy behavior), so
 * the published MCP/pay path is unaffected when they are not configured.
 *
 * The guards fail CLOSED *before any network call*: a refused sign must never
 * prepare, commit, or touch the relay at all. We stub fetch to THROW so any
 * leak-through to the network would surface as the wrong error.
 */
describe("RelaySigner amount ceiling + expected-payee pin", () => {
  /** A signTransferFactory input at/below the ceiling, correct payee. The spend
   *  breaker (enforceSpendLimits) runs at the top of signTransferFactory before
   *  any relay call. */
  function transferFactoryInput(over: Partial<Parameters<NonNullable<ReturnType<typeof makeRelaySigner>["signTransferFactory"]>>[0]> = {}) {
    return {
      receiver: "merchant::1",
      amount: "1.0000000000",
      instrumentId: { admin: "DSO::1", id: "Amulet" },
      executeBeforeSeconds: 120,
      transferMeta: {},
      ...over,
    };
  }

  /** Stub fetch to throw — proves the guard fires WITHOUT any relay call. */
  function stubFetchThrows(): ReturnType<typeof vi.fn> {
    const f = vi.fn(async () => {
      throw new Error("network must NOT be reached when the guard fails closed");
    });
    vi.stubGlobal("fetch", f);
    return f;
  }

  describe("transfer-factory arm", () => {
    it("REFUSES to sign when the amount exceeds maxPaymentValue (fail closed, no network)", async () => {
      const f = stubFetchThrows();
      const signer = makeRelaySigner(wallet(), {
        maxPaymentValue: "1.0000000000",
        hashBinding: { recomputeHash: RECOMPUTE },
      });
      await expect(
        signer.signTransferFactory!(transferFactoryInput({ amount: "1.0000000001" }))
      ).rejects.toThrow(/exceeds|max|ceiling|maxPaymentValue/i);
      expect(f).not.toHaveBeenCalled();
    });

    it("REFUSES to sign when the recipient is not the expected payee (fail closed, no network)", async () => {
      const f = stubFetchThrows();
      const signer = makeRelaySigner(wallet(), {
        expectedPayTo: "merchant::expected",
        hashBinding: { recomputeHash: RECOMPUTE },
      });
      await expect(
        signer.signTransferFactory!(transferFactoryInput({ receiver: "attacker::evil" }))
      ).rejects.toThrow(/payee|recipient|expected|payTo/i);
      expect(f).not.toHaveBeenCalled();
    });

    it("REFUSES to sign when maxPaymentValue itself is non-numeric (broken ceiling fails closed)", async () => {
      const f = stubFetchThrows();
      const signer = makeRelaySigner(wallet(), {
        maxPaymentValue: "not-a-number", // misconfigured cap must not silently disable
        hashBinding: { recomputeHash: RECOMPUTE },
      });
      await expect(
        signer.signTransferFactory!(transferFactoryInput({ amount: "0.0000000001" }))
      ).rejects.toThrow(/max payment value|ceiling|finite/i);
      expect(f).not.toHaveBeenCalled();
    });

    // The at/below-ceiling happy path (a passing guard proceeds to a real
    // payPrepare + payCommit) is covered in tx.test.ts / merge.test.ts, so the
    // three fail-closed cases above carry this block's guarantee.
  });
});
