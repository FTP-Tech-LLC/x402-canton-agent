import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as Tx from "./tx.js";

/** Every prepare+sign the signer ran. The real one needs a relay and a
 *  faithful prepared transaction (tx.test.ts covers that path). */
const signedCalls: Array<{ receiver: string; amount: string }> = [];

vi.mock("./tx.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Tx>()),
  payViaTransferFactory: vi.fn(
    async (_relay: unknown, wallet: { party: string }, o: { receiver: string; amount: string }) => {
      signedCalls.push({ receiver: o.receiver, amount: o.amount });
      return {
        payerParty: wallet.party,
        txHash: "AAAA",
        preparedTxHashHex: "00",
        preparedTransactionBytes: new Uint8Array([1]),
        signatureB64: "c2ln",
        hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2" as const,
      };
    }
  ),
}));

const { makeRelaySigner } = await import("./relay-signer.js");
const { generateAgentKey } = await import("./keys.js");

const USDCX_ADMIN =
  "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef";
const USDCX_KEY = `${USDCX_ADMIN}|USDCx`;

function wallet() {
  const k = generateAgentKey();
  return {
    network: "canton:mainnet",
    relayUrl: "http://relay",
    party: "agent::12201",
    publicKeySpkiB64: k.publicKeySpkiB64,
    privateKeyPkcs8Pem: k.privateKeyPkcs8Pem,
    publicKeyFingerprint: "12201fp",
    createdAt: "t",
  };
}

const usdcxInput = {
  receiver: "merchant::1",
  amount: "0.0500000000",
  instrumentId: { admin: USDCX_ADMIN, id: "USDCx" },
  executeBeforeSeconds: 120,
  transferMeta: {},
};

/**
 * A spend counter that only trusts the balance a moment later misses a
 * payment the facilitator has not settled yet. The signer is the one place
 * that knows exactly what it put its signature on, so it reports it.
 */
describe("makeRelaySigner onSigned", () => {
  beforeEach(() => {
    signedCalls.length = 0;
  });

  it("reports the instrument and amount of a signed token payment, once", async () => {
    const seen: Array<{ instrument: string; amount: string }> = [];
    const signer = makeRelaySigner(wallet(), {
      trustedDso: "DSO::1",
      payableInstruments: [USDCX_KEY],
      maxPaymentValueByInstrument: { [USDCX_KEY]: "1" },
      onSigned: (s) => seen.push(s),
    });
    await signer.signTransferFactory!(usdcxInput as never);
    expect(signedCalls).toHaveLength(1);
    expect(seen).toEqual([{ instrument: USDCX_KEY, amount: "0.0500000000" }]);
  });

  it("reports a Canton Coin payment under its own key", async () => {
    const seen: Array<{ instrument: string; amount: string }> = [];
    const signer = makeRelaySigner(wallet(), { trustedDso: "DSO::1", onSigned: (s) => seen.push(s) });
    await signer.signTransferFactory!({
      ...usdcxInput,
      instrumentId: { admin: "DSO::1", id: "Amulet" },
      amount: "0.2000000000",
    } as never);
    expect(seen).toEqual([{ instrument: "DSO::1|Amulet", amount: "0.2000000000" }]);
  });

  it("says nothing when the signer refuses: nothing was signed", async () => {
    const seen: unknown[] = [];
    const signer = makeRelaySigner(wallet(), {
      trustedDso: "DSO::1",
      payableInstruments: [USDCX_KEY],
      maxPaymentValueByInstrument: { [USDCX_KEY]: "0.01" },
      onSigned: (s) => seen.push(s),
    });
    await expect(signer.signTransferFactory!(usdcxInput as never)).rejects.toThrow(/exceeds the max/);
    expect(signedCalls).toHaveLength(0);
    expect(seen).toEqual([]);
  });

  it("a hook that throws does not cancel the signed payment", async () => {
    const signer = makeRelaySigner(wallet(), {
      trustedDso: "DSO::1",
      payableInstruments: [USDCX_KEY],
      maxPaymentValueByInstrument: { [USDCX_KEY]: "1" },
      onSigned: () => {
        throw new Error("observer broke");
      },
    });
    const r = await signer.signTransferFactory!(usdcxInput as never);
    expect(r.signatureB64).toBe("c2ln");
  });

  it("a hook that returns a thenable gets a rejection handler attached", async () => {
    const onRejected: unknown[] = [];
    const thenable = {
      then(_ok?: unknown, bad?: unknown) {
        onRejected.push(bad);
        return thenable;
      },
    };
    const signer = makeRelaySigner(wallet(), {
      trustedDso: "DSO::1",
      payableInstruments: [USDCX_KEY],
      maxPaymentValueByInstrument: { [USDCX_KEY]: "1" },
      onSigned: () => thenable as unknown as void,
    });
    await signer.signTransferFactory!(usdcxInput as never);
    expect(onRejected).toHaveLength(1);
    expect(typeof onRejected[0]).toBe("function");
  });

  it("an async hook that rejects cannot crash the process, and the payment goes on", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const signer = makeRelaySigner(wallet(), {
        trustedDso: "DSO::1",
        payableInstruments: [USDCX_KEY],
        maxPaymentValueByInstrument: { [USDCX_KEY]: "1" },
        onSigned: async () => {
          throw new Error("observer broke later");
        },
      });
      const r = await signer.signTransferFactory!(usdcxInput as never);
      expect(r.signatureB64).toBe("c2ln");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
