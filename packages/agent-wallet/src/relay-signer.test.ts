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

    it("the ceiling is in CC, and a whole-CC ceiling bites a sub-CC over-quote", async () => {
      // The unit is the thing. The 402 carries `amount` as an ATOMIC integer
      // ("500000000" for 0.05 CC); the client converts it once and hands the
      // signer the ledger Decimal, so this compares CC against CC. The doc used
      // to say "the same unit the 402 quotes", and a caller who followed it and
      // wrote "500000000" meaning 0.05 CC configured a ceiling of five hundred
      // million CC — present, configured, and unable to ever fire.
      const f = stubFetchThrows();
      const signer = makeRelaySigner(wallet(), {
        maxPaymentValue: "0.05", // CC, written the way a human writes it
        hashBinding: { recomputeHash: RECOMPUTE },
      });
      await expect(
        signer.signTransferFactory!(transferFactoryInput({ amount: "0.0500000001" }))
      ).rejects.toThrow(/exceeds|max/i);
      expect(f).not.toHaveBeenCalled();
    });

    it("...and the same ceiling still admits the amount it authorized", async () => {
      // The discriminator. A ceiling read in the wrong unit the OTHER way —
      // treating the cap as atomic and the amount as CC — would refuse every
      // honest payment and take the agent offline. Exactly at the cap must pass.
      stubFetchThrows();
      const signer = makeRelaySigner(wallet(), {
        maxPaymentValue: "0.05",
        hashBinding: { recomputeHash: RECOMPUTE },
      });
      await expect(
        signer.signTransferFactory!(transferFactoryInput({ amount: "0.0500000000" }))
      ).rejects.not.toThrow(/exceeds|max payment/i);
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

describe("spending a registry token is a separate opt-in from trusting it", () => {
  // The 402 author must not get to pick the denomination of the operator's cap.
  // Before this, a merchant serving instrumentId {admin: <baked-in USDCx
  // registrar>, id: "USDCx"} had the wallet pay in USDCx purely because the
  // registrar ships in KNOWN_REGISTRY_TRUSTED_PARTIES, and maxPaymentValue —
  // written and documented as Canton Coin — was compared against the USDCx
  // amount as a bare number.
  const USDCX_ADMIN =
    "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef";
  const KEY = `${USDCX_ADMIN}|USDCx`;
  const usdcxInput = {
    receiver: "merchant::1",
    amount: "0.0500000000",
    instrumentId: { admin: USDCX_ADMIN, id: "USDCx" },
    executeBeforeSeconds: 120,
    transferMeta: {},
  };

  it("refuses a registry payment the wallet never opted into spending", async () => {
    const f = vi.fn(async () => {
      throw new Error("network must NOT be reached");
    });
    vi.stubGlobal("fetch", f);
    const signer = makeRelaySigner(wallet(), {
      trustedDso: "DSO::1",
      hashBinding: { recomputeHash: RECOMPUTE },
    });
    await expect(signer.signTransferFactory!(usdcxInput as never)).rejects.toThrow(
      /not configured to spend/i
    );
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses to let a Canton Coin ceiling stand in for a token ceiling", async () => {
    // The value-amplification case: "0.05" meant 0.05 CC; silently reading it
    // as 0.05 USDCx is a different amount of money entirely.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network"); }));
    const signer = makeRelaySigner(wallet(), {
      trustedDso: "DSO::1",
      payableInstruments: [KEY],
      maxPaymentValue: "0.05",
      hashBinding: { recomputeHash: RECOMPUTE },
    });
    await expect(signer.signTransferFactory!(usdcxInput as never)).rejects.toThrow(
      /denominated in Canton Coin/i
    );
  });

  it("enforces the per-instrument ceiling once one is given", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network"); }));
    const signer = makeRelaySigner(wallet(), {
      trustedDso: "DSO::1",
      payableInstruments: [KEY],
      maxPaymentValue: "0.05",
      maxPaymentValueByInstrument: { [KEY]: "0.0100000000" },
      hashBinding: { recomputeHash: RECOMPUTE },
    });
    await expect(signer.signTransferFactory!(usdcxInput as never)).rejects.toThrow(
      /exceeds the max/i
    );
  });

  it("leaves Canton Coin exactly as it was — no consent needed, same ceiling", async () => {
    // The discriminator against over-correcting: CC is not a registry
    // instrument, so none of the new checks may touch the path that pays today.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network"); }));
    const signer = makeRelaySigner(wallet(), {
      trustedDso: "DSO::1",
      maxPaymentValue: "1.0000000000",
      hashBinding: { recomputeHash: RECOMPUTE },
    });
    await expect(
      signer.signTransferFactory!({
        ...usdcxInput,
        instrumentId: { admin: "DSO::1", id: "Amulet" },
        amount: "1.0000000001",
      } as never)
    ).rejects.toThrow(/exceeds the max/i);
  });
});
