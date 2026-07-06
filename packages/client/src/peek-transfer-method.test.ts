import { describe, it, expect, vi } from "vitest";
import {
  HEADER_PAYMENT_REQUIRED_V2,
  HEADER_PAYMENT_SIGNATURE_V2,
  encodeBase64Json,
} from "@ftptech/x402-canton-core";
import { peekChosenTransferMethod, wrapFetchWithCantonPayment } from "./fetch.js";
import type { CantonSigner } from "./signer.js";

const MERCHANT = "merchant::1220m";
const FAC = "ftp::1220fff";
const SYNC = "global-domain::1220xyz";
const PAYER = "agent::1220abc";

/** A signer that can produce the transfer-factory method (like the agent-wallet
 *  relay signer). */
function allSigner(): CantonSigner {
  return {
    party: PAYER,
    signTransferFactory: vi.fn().mockResolvedValue({
      payerParty: PAYER,
      submissionRef: "ref",
      preparedTxHash: "hash",
    }),
  };
}

/** A signer that implements NO method — cannot produce anything the merchant
 *  could advertise. */
function noMethodSigner(): CantonSigner {
  return { party: PAYER };
}

function header(transferMethod: string, scheme = "exact", network = "canton:devnet"): string {
  return encodeBase64Json({
    x402Version: 2,
    resource: { url: "https://api.example.com/x" },
    accepts: [
      {
        scheme,
        network,
        amount: "1000000000",
        asset: "canton-coin",
        payTo: MERCHANT,
        maxTimeoutSeconds: 60,
        extra: {
          assetTransferMethod: transferMethod,
          feePayer: FAC,
          synchronizerId: SYNC,
          instrumentId: { admin: FAC, id: "Amulet" },
          executeBeforeSeconds: 60,
        },
      },
    ],
  });
}

function resp402(transferMethod: string, scheme?: string, network?: string): Response {
  return new Response("payment required", {
    status: 402,
    headers: { [HEADER_PAYMENT_REQUIRED_V2]: header(transferMethod, scheme, network) },
  });
}

describe("peekChosenTransferMethod", () => {
  it("returns transfer-factory for a transfer-factory 402", () => {
    expect(peekChosenTransferMethod(resp402("transfer-factory"), allSigner())).toBe(
      "transfer-factory"
    );
  });

  it("returns undefined for a non-402 response (caller serializes by default)", () => {
    const ok = new Response("ok", { status: 200 });
    expect(peekChosenTransferMethod(ok, allSigner())).toBeUndefined();
  });

  it("returns undefined when the PAYMENT-REQUIRED header is missing", () => {
    const r = new Response("payment required", { status: 402 });
    expect(peekChosenTransferMethod(r, allSigner())).toBeUndefined();
  });

  it("returns undefined when the header is not valid base64 JSON", () => {
    const r = new Response("payment required", {
      status: 402,
      headers: { [HEADER_PAYMENT_REQUIRED_V2]: "!!!not-base64!!!" },
    });
    expect(peekChosenTransferMethod(r, allSigner())).toBeUndefined();
  });

  it("returns undefined when there is no exact accepts entry", () => {
    expect(
      peekChosenTransferMethod(resp402("transfer-factory", "some-other-scheme"), allSigner())
    ).toBeUndefined();
  });

  it("returns undefined when the signer cannot produce the offered method", () => {
    // transfer-factory 402 but a signer that implements no method → no
    // compatible entry.
    expect(
      peekChosenTransferMethod(resp402("transfer-factory"), noMethodSigner())
    ).toBeUndefined();
  });

  it("honors networkFilter (excluded network → undefined)", () => {
    expect(
      peekChosenTransferMethod(resp402("transfer-factory"), allSigner(), {
        networkFilter: (n) => n === "canton:mainnet",
      })
    ).toBeUndefined();
  });

  // DRIFT GUARD: peek must agree with the method wrapFetchWithCantonPayment
  // actually pays — otherwise the pay-lock decision (which uses peek) could lock
  // the wrong path. Run the real pay flow and assert the same arm peek named.
  it("agrees with the arm wrapFetchWithCantonPayment actually calls (transfer-factory)", async () => {
    const signer = allSigner();
    const fetchImpl = vi.fn(async (_url: string, init?: { headers?: HeadersInit }) => {
      const h = new Headers(init?.headers);
      if (h.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return resp402("transfer-factory");
    }) as unknown as typeof globalThis.fetch;

    const peeked = peekChosenTransferMethod(resp402("transfer-factory"), signer);
    const wrapped = wrapFetchWithCantonPayment(fetchImpl, signer);
    const res = await wrapped("https://api.example.com/x");

    expect(res.status).toBe(200);
    expect(peeked).toBe("transfer-factory");
    expect(signer.signTransferFactory).toHaveBeenCalledTimes(1);
  });
});
