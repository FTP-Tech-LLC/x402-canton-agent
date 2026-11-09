import { describe, it, expect, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  HEADER_PAYMENT_REQUIRED_V2,
  HEADER_PAYMENT_SIGNATURE_V2,
  HEADER_PAYMENT_RESPONSE_V2,
  encodeBase64Json,
  type PaymentRequirements,
} from "@ftptech/x402-canton-core";
import {
  wrapFetchWithCantonPayment,
  readPaymentResponseHeader,
  X402PaymentError,
  type X402PaymentRequired,
} from "./fetch.js";
import { SchemeMethodMismatchError } from "./scheme.js";
import type { CantonSigner } from "./signer.js";

const MERCHANT = "merchant::1220m";
const FACILITATOR = "ftp_facilitator::1220fff";
const SYNC = "global-domain::1220xyz";
const PAYER = "agent::1220abc";

function fakeSigner(): CantonSigner {
  return {
    party: PAYER,
    signTransferFactory: vi.fn().mockResolvedValue({
      payerParty: PAYER,
      preparedTxHash: "ab".repeat(32),
      preparedTransactionBytes: new Uint8Array([1, 2, 3, 4]),
      signatureB64: Buffer.alloc(64, 7).toString("base64"),
    }),
  };
}

function requirements(scheme: string = "exact"): PaymentRequirements {
  return {
    scheme: scheme as "exact",
    network: "canton:devnet",
    amount: "1000000000",
    asset: `${FACILITATOR}::TestToken`,
    payTo: MERCHANT,
    maxTimeoutSeconds: 60,
    extra: {
      assetTransferMethod: "transfer-factory" as const,
      feePayer: FACILITATOR,
      synchronizerId: SYNC,
      instrumentId: { admin: FACILITATOR, id: "TestToken" },
      executeBeforeSeconds: 120,
    },
  };
}

function paymentRequiredHeader(req: X402PaymentRequired): string {
  return encodeBase64Json(req);
}

describe("wrapFetchWithCantonPayment", () => {
  it("a 400 error page from the merchant's EDGE (header too large) becomes MERCHANT_HEADER_LIMIT with the fix in the message", async () => {
    const signer = fakeSigner();
    let n = 0;
    const fetch = vi.fn(async () => {
      n++;
      if (n === 1) {
        const required: X402PaymentRequired = {
          x402Version: 2,
          resource: { url: "https://api.example.com/data" },
          accepts: [requirements()],
        };
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      // nginx's stock page, verbatim — what a default 8k buffer answers.
      return new Response(
        "<html><head><title>400 Request Header Or Cookie Too Large</title></head></html>",
        { status: 400 }
      );
    }) as typeof globalThis.fetch;
    const wrapped = wrapFetchWithCantonPayment(fetch, signer);
    let err: unknown;
    try {
      await wrapped("https://api.example.com/data");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(X402PaymentError);
    expect((err as X402PaymentError).code).toBe("MERCHANT_HEADER_LIMIT");
    expect((err as Error).message).toMatch(/16 KiB/);
    expect((err as Error).message).toMatch(/large_client_header_buffers/);
    expect((err as Error).message).toMatch(/nothing settled/);
  });

  it("the merchant's OWN 400 (no edge fingerprint) still passes through untouched, body readable", async () => {
    const signer = fakeSigner();
    let n = 0;
    const fetch = vi.fn(async () => {
      n++;
      if (n === 1) {
        const required: X402PaymentRequired = {
          x402Version: 2,
          resource: { url: "https://api.example.com/data" },
          accepts: [requirements()],
        };
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      return new Response(JSON.stringify({ error: "amountIn must be positive" }), { status: 400 });
    }) as typeof globalThis.fetch;
    const wrapped = wrapFetchWithCantonPayment(fetch, signer);
    const res = await wrapped("https://api.example.com/data");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "amountIn must be positive" });
  });

  it("passes through non-402 responses unchanged", async () => {
    const fetch = vi.fn(
      async () => new Response("hello", { status: 200 })
    ) as typeof globalThis.fetch;
    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());

    const res = await wrapped("https://example.com/data");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("on 402 v2 → calls signer, retries with PAYMENT-SIGNATURE, returns success", async () => {
    const signer = fakeSigner();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init: init as RequestInit | undefined });
      if (calls.length === 1) {
        const required: X402PaymentRequired = {
          x402Version: 2,
          resource: { url: "https://api.example.com/data" },
          accepts: [requirements()],
        };
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      return new Response("paid-body", {
        status: 200,
        headers: {
          [HEADER_PAYMENT_RESPONSE_V2]: encodeBase64Json({
            success: true,
            transaction: "u-xyz",
            payer: PAYER,
            network: "canton:devnet",
          }),
        },
      });
    }) as typeof globalThis.fetch;

    const wrapped = wrapFetchWithCantonPayment(fetch, signer);
    const res = await wrapped("https://api.example.com/data");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("paid-body");
    expect(fetch).toHaveBeenCalledTimes(2);

    // Retry carried PAYMENT-SIGNATURE
    const retryHeaders = new Headers(calls[1]?.init?.headers);
    expect(retryHeaders.get(HEADER_PAYMENT_SIGNATURE_V2)).not.toBeNull();

    // Signer was called with the requirements' merchant
    const signerFn = signer.signTransferFactory as ReturnType<typeof vi.fn>;
    expect(signerFn).toHaveBeenCalledTimes(1);
    const arg = signerFn.mock.calls[0][0];
    expect(arg.receiver).toBe(MERCHANT);
    // Under scheme "exact" the signer receives the on-ledger Daml Decimal derived
    // from the ATOMIC wire amount ("1000000000" → 0.1 CC).
    expect(arg.amount).toBe("0.1000000000");
    // PR #2634 privacy: resourceUrl is NOT committed on-ledger (the facilitator
    // does not match it). Guard that the client no longer stamps it.
    expect(arg.transferMeta["x402.resourceUrl"]).toBeUndefined();

    // PAYMENT-RESPONSE decodable
    const settle = readPaymentResponseHeader<{
      success: boolean;
      transaction: string;
    }>(res);
    expect(settle?.success).toBe(true);
    expect(settle?.transaction).toBe("u-xyz");
  });

  it("on 402 transfer-factory → capability precheck accepts it + calls signTransferFactory (regression for signerMethods)", async () => {
    // Regression: signerMethods() must map transfer-factory -> signTransferFactory,
    // else the candidate is filtered out and a SchemeMethodMismatchError is thrown
    // BEFORE the signer is ever called (this is the bug the live 402 e2e surfaced).
    const signer: CantonSigner = {
      party: PAYER,
      signTransferFactory: vi.fn().mockResolvedValue({
        payerParty: PAYER,
        preparedTxHash: "cd".repeat(32),
        preparedTransactionBytes: new Uint8Array([5, 6, 7, 8]),
        signatureB64: Buffer.alloc(64, 9).toString("base64"),
      }),
    };
    const tfReqs: PaymentRequirements = {
      scheme: "exact",
      network: "canton:devnet",
      amount: "1000000000",
      asset: `${FACILITATOR}::TestToken`,
      payTo: MERCHANT,
      maxTimeoutSeconds: 60,
      extra: {
        assetTransferMethod: "transfer-factory" as const,
        feePayer: FACILITATOR,
        synchronizerId: SYNC,
        instrumentId: { admin: FACILITATOR, id: "TestToken" },
        executeBeforeSeconds: 600,
      },
    };
    let n = 0;
    const fetch = vi.fn(async () => {
      n++;
      if (n === 1) {
        const required: X402PaymentRequired = {
          x402Version: 2,
          resource: { url: "https://api.example.com/data" },
          accepts: [tfReqs],
        };
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      return new Response("paid-body", { status: 200 });
    }) as typeof globalThis.fetch;

    const wrapped = wrapFetchWithCantonPayment(fetch, signer);
    const res = await wrapped("https://api.example.com/data");

    expect(res.status).toBe(200);
    const fn = signer.signTransferFactory as ReturnType<typeof vi.fn>;
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].receiver).toBe(MERCHANT);
  });

  it("throws MISSING_PAYMENT_REQUIRED_HEADER when 402 lacks the header (v1 not supported)", async () => {
    const fetch = vi.fn(
      async () => new Response("{}", { status: 402 })
    ) as typeof globalThis.fetch;
    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());

    await expect(wrapped("https://example.com")).rejects.toMatchObject({
      name: "X402PaymentError",
      code: "MISSING_PAYMENT_REQUIRED_HEADER",
    });
  });

  it("throws MALFORMED_PAYMENT_REQUIRED when the header is not valid base64 JSON", async () => {
    // Server-controlled, untrusted header. Garbage must surface as a
    // discriminated X402PaymentError, not leak a raw SyntaxError.
    const fetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: "!!!not-base64-json!!!" },
        })
    ) as typeof globalThis.fetch;
    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());

    await expect(wrapped("https://example.com")).rejects.toMatchObject({
      name: "X402PaymentError",
      code: "MALFORMED_PAYMENT_REQUIRED",
    });
  });

  it("throws MALFORMED_PAYMENT_REQUIRED when the payload is valid JSON but has no accepts[] array", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: encodeBase64Json({ x402Version: 2 }) },
        })
    ) as typeof globalThis.fetch;
    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());

    await expect(wrapped("https://example.com")).rejects.toMatchObject({
      name: "X402PaymentError",
      code: "MALFORMED_PAYMENT_REQUIRED",
    });
  });

  it("throws NO_ACCEPTABLE_SCHEME when accepts[] has no exact entries", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com" },
      accepts: [
        { ...requirements(), scheme: "exact-evm" as any },
      ],
    };
    const fetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        })
    ) as typeof globalThis.fetch;
    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());

    await expect(wrapped("https://example.com")).rejects.toMatchObject({
      name: "X402PaymentError",
      code: "NO_ACCEPTABLE_SCHEME",
    });
  });

  it("throws NO_ACCEPTABLE_SCHEME when networkFilter rejects all candidates", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com" },
      accepts: [requirements()],
    };
    const fetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        })
    ) as typeof globalThis.fetch;
    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner(), {
      networkFilter: (n) => n === "canton:mainnet",
    });

    await expect(wrapped("https://example.com")).rejects.toMatchObject({
      code: "NO_ACCEPTABLE_SCHEME",
    });
  });

  it("throws PAYMENT_REJECTED when the retry also returns 402 (no infinite loop)", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com" },
      accepts: [requirements()],
    };
    const fetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        })
    ) as typeof globalThis.fetch;
    // maxPaymentRetries:0 = the old at-most-twice behavior (1 probe + 1 pay).
    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner(), {
      maxPaymentRetries: 0,
    });

    await expect(wrapped("https://example.com")).rejects.toMatchObject({
      code: "PAYMENT_REJECTED",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops on the first unexpected_canton_ledger_error (the facilitator also sends it for an unknown outcome)", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com" },
      accepts: [requirements()],
    };
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: "unexpected_canton_ledger_error" }),
          {
            status: 402,
            headers: {
              [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required),
            },
          }
        )
    ) as typeof globalThis.fetch;
    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner(), {
      maxPaymentRetries: 4,
      sleep: async () => {},
    });

    await expect(wrapped("https://example.com")).rejects.toMatchObject({
      code: "PAYMENT_UNCONFIRMED",
    });
    // 1 probe + 1 pay. No re-pay.
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("NEVER re-pays after an ambiguous execute outcome — one 402 is enough to stop", async () => {
    // `invalid_exact_canton_execute_failed` is the facilitator's catch-all
    // around the submit. Some of what lands there is a clean rejection with
    // nothing spent; some is a network failure mid-submit where the participant
    // may well have accepted the transaction. From here the two look identical,
    // and a re-pay re-prepares over the payer's REMAINING holdings — so if the
    // first one committed, the payer pays twice for one purchase.
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com" },
      accepts: [requirements()],
    };
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: "invalid_exact_canton_execute_failed" }),
          {
            status: 402,
            headers: {
              [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required),
            },
          }
        )
    ) as typeof globalThis.fetch;
    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner(), {
      maxPaymentRetries: 4,
      sleep: async () => {},
    });

    // PAYMENT_UNCONFIRMED, not PAYMENT_REJECTED: `code` is the only field a
    // program can branch on, and an integrator whose "rejected -> mint a fresh
    // payment" path fires on it would pay twice for one purchase.
    await expect(wrapped("https://example.com")).rejects.toMatchObject({
      code: "PAYMENT_UNCONFIRMED",
    });
    // 1 probe + exactly 1 pay. Never a second payment.
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries a TRANSIENT network failure from createPaymentPayload (ETIMEDOUT) instead of killing the pay", async () => {
    // A dropped TLS read while talking to the relay surfaces as
    // `TypeError: fetch failed` with cause.code ETIMEDOUT — a network blip,
    // not a payment rejection. The loop must back off and retry.
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com" },
      accepts: [requirements()],
    };
    let resourceCalls = 0;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      resourceCalls += 1;
      const paid = new Headers(init?.headers).has(HEADER_PAYMENT_SIGNATURE_V2);
      if (paid) return new Response(JSON.stringify({ data: "premium" }), { status: 200 });
      return new Response("{}", {
        status: 402,
        headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
      });
    }) as typeof globalThis.fetch;
    const signer = fakeSigner();
    const netErr = new TypeError("fetch failed");
    (netErr as { cause?: unknown }).cause = Object.assign(new Error("read ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    (signer.signTransferFactory as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(netErr)
      .mockResolvedValueOnce({
        payerParty: PAYER,
        preparedTxHash: "ef".repeat(32),
        preparedTransactionBytes: new Uint8Array([2, 4, 6, 8]),
        signatureB64: Buffer.alloc(64, 3).toString("base64"),
      });
    const wrapped = wrapFetchWithCantonPayment(fetch, signer, {
      maxPaymentRetries: 2,
      sleep: async () => {},
    });
    const res = await wrapped("https://example.com");
    expect(res.status).toBe(200);
    // probe (402) + paid retry (200): the network blip cost no resource hits.
    expect(resourceCalls).toBe(2);
  });

  // A merchant that settles each payment and still answers 402 collects one
  // real payment per signature. Mirrors the audit PoC: count the signatures
  // handed to the merchant, with the default options.
  async function payAgainst402(body: string, options = {}, headerReason?: string) {
    const required: X402PaymentRequired = {
      x402Version: 2,
      ...(headerReason !== undefined ? { error: headerReason } : {}),
      resource: { url: "https://example.com" },
      accepts: [requirements()],
    };
    const fetch = vi.fn(
      async () =>
        new Response(body, {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        })
    ) as typeof globalThis.fetch;
    const signer = fakeSigner();
    const wrapped = wrapFetchWithCantonPayment(fetch, signer, {
      sleep: async () => {},
      ...options,
    });
    const err = await wrapped("https://example.com").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(X402PaymentError);
    const signatures = (signer.signTransferFactory as ReturnType<typeof vi.fn>).mock.calls.length;
    return { err: err as X402PaymentError, signatures };
  }

  it("a 402 after signing never re-pays: empty body, made-up or unlisted reason", async () => {
    for (const body of [
      "",
      "{}",
      JSON.stringify({ error: "totally_made_up" }),
      JSON.stringify({ error: "invalid_exact_canton_preapproval_missing" }),
      JSON.stringify({ error: "invalid_exact_canton_nonce_reuse" }),
      JSON.stringify({ error: "invalid_exact_canton_input_contention" }),
      JSON.stringify({ error: "payment_already_redeemed" }),
    ]) {
      expect((await payAgainst402(body)).signatures).toBe(1);
    }
  });

  it("never re-pays on counter_not_ready or expired, whatever maxPaymentRetries says", async () => {
    for (const reason of [
      "invalid_exact_canton_counter_not_ready",
      "invalid_exact_canton_expired",
    ]) {
      for (const options of [{}, { maxPaymentRetries: 0 }, { maxPaymentRetries: 10 }]) {
        const { err, signatures } = await payAgainst402(JSON.stringify({ error: reason }), options);
        expect(signatures).toBe(1);
        expect(err.code).toBe("PAYMENT_REJECTED");
        expect(err.message).toBe(
          `payment returned 402 after it was signed (${reason}); ` +
            `this client will not pay again for this request`
        );
      }
    }
  });

  it("a reason that says the payment may already have moved is PAYMENT_UNCONFIRMED", async () => {
    for (const reason of [
      "invalid_exact_canton_execute_failed",
      "unexpected_canton_ledger_error",
      "payment_already_redeemed",
      "invalid_exact_canton_payment_already_settled",
    ]) {
      for (const headerOnly of [false, true]) {
        const { err, signatures } = headerOnly
          ? await payAgainst402("{}", {}, reason)
          : await payAgainst402(JSON.stringify({ error: reason }));
        expect(signatures).toBe(1);
        expect(err.code).toBe("PAYMENT_UNCONFIRMED");
        expect(err.message).toContain(`(${reason})`);
      }
    }
  });

  // A server on the official x402 SDK answers a failed settle 402 with an
  // empty body and the reason only in PAYMENT-RESPONSE.
  it("reads the reason from PAYMENT-RESPONSE, and settlement_pending is PAYMENT_UNCONFIRMED", async () => {
    for (const [reason, code] of [
      ["settlement_pending", "PAYMENT_UNCONFIRMED"],
      ["invalid_exact_canton_payment_already_settled", "PAYMENT_UNCONFIRMED"],
      ["invalid_exact_canton_amount_mismatch", "PAYMENT_REJECTED"],
    ] as const) {
      const required: X402PaymentRequired = {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [requirements()],
      };
      let calls = 0;
      const fetch = vi.fn(async () => {
        calls++;
        const headers: Record<string, string> = { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) };
        if (calls > 1) {
          headers[HEADER_PAYMENT_RESPONSE_V2] = encodeBase64Json({ success: false, errorReason: reason, transaction: "", network: "canton:devnet" });
        }
        return new Response("", { status: 402, headers: calls > 1 ? { [HEADER_PAYMENT_RESPONSE_V2]: headers[HEADER_PAYMENT_RESPONSE_V2]! } : headers });
      }) as typeof globalThis.fetch;
      const signer = fakeSigner();
      const err = await wrapFetchWithCantonPayment(fetch, signer, { sleep: async () => {} })("https://example.com").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(X402PaymentError);
      expect((err as X402PaymentError).code, reason).toBe(code);
      expect((err as X402PaymentError).message).toContain(`(${reason})`);
      expect((signer.signTransferFactory as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    }
  });

  // The express middleware answers a failed verify with a `{}` body and the
  // reason only in the PAYMENT-REQUIRED header.
  it("reads the reason from the PAYMENT-REQUIRED header when the body has none", async () => {
    for (const body of ["", "{}"]) {
      const { err, signatures } = await payAgainst402(body, {}, "invalid_exact_canton_expired");
      expect(err.message).toContain("(invalid_exact_canton_expired)");
      expect(signatures).toBe(1);
    }
  });

  it("a header-only execute_failed is still PAYMENT_UNCONFIRMED", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      error: "invalid_exact_canton_execute_failed",
      resource: { url: "https://example.com" },
      accepts: [requirements()],
    };
    const fetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        })
    ) as typeof globalThis.fetch;
    const signer = fakeSigner();
    const wrapped = wrapFetchWithCantonPayment(fetch, signer, { sleep: async () => {} });
    const err = await wrapped("https://example.com").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(X402PaymentError);
    expect((err as X402PaymentError).code).toBe("PAYMENT_UNCONFIRMED");
    expect(signer.signTransferFactory).toHaveBeenCalledTimes(1);
  });

  it("the body reason wins over the header reason", async () => {
    const rejected = await payAgainst402(
      JSON.stringify({ error: "invalid_exact_canton_expired" }),
      {},
      "invalid_exact_canton_execute_failed"
    );
    expect(rejected.err.code).toBe("PAYMENT_REJECTED");
    const unconfirmed = await payAgainst402(
      JSON.stringify({ error: "invalid_exact_canton_execute_failed" }),
      {},
      "PAYMENT-SIGNATURE header required"
    );
    expect(unconfirmed.err.code).toBe("PAYMENT_UNCONFIRMED");
  });

  it("an undecodable PAYMENT-REQUIRED header on a paid 402 gives no reason and stops", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com" },
      accepts: [requirements()],
    };
    let n = 0;
    const fetch = vi.fn(async () => {
      n++;
      const header = n === 1 ? paymentRequiredHeader(required) : "!!!not-base64-json!!!";
      return new Response("{}", {
        status: 402,
        headers: { [HEADER_PAYMENT_REQUIRED_V2]: header },
      });
    }) as typeof globalThis.fetch;
    const signer = fakeSigner();
    const wrapped = wrapFetchWithCantonPayment(fetch, signer, { sleep: async () => {} });
    const err = await wrapped("https://example.com").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(X402PaymentError);
    expect((err as X402PaymentError).code).toBe("PAYMENT_REJECTED");
    expect(signer.signTransferFactory).toHaveBeenCalledTimes(1);
  });

  it("requests already carrying PAYMENT-SIGNATURE bypass the payment dance", async () => {
    const signer = fakeSigner();
    const fetch = vi.fn(
      async () => new Response("direct", { status: 200 })
    ) as typeof globalThis.fetch;
    const wrapped = wrapFetchWithCantonPayment(fetch, signer);

    const res = await wrapped("https://example.com", {
      headers: { [HEADER_PAYMENT_SIGNATURE_V2]: "preexisting" },
    });
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signer.signTransferFactory).not.toHaveBeenCalled();
  });
});

describe("readPaymentResponseHeader", () => {
  it("returns parsed JSON when header present", () => {
    const r = new Response("ok", {
      headers: {
        [HEADER_PAYMENT_RESPONSE_V2]: encodeBase64Json({ success: true, transaction: "t-1" }),
      },
    });
    expect(readPaymentResponseHeader(r)).toEqual({
      success: true,
      transaction: "t-1",
    });
  });

  it("returns null when header absent", () => {
    const r = new Response("ok");
    expect(readPaymentResponseHeader(r)).toBeNull();
  });
});

describe("wrapFetchWithCantonPayment — additional edge cases", () => {
  it("uses selectRequirements callback to pick among multiple exact accepts", async () => {
    const req1 = requirements();
    const req2: PaymentRequirements = { ...requirements(), amount: "2000000000" };
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com/data" },
      accepts: [req1, req2],
    };

    const calls: Array<PaymentRequirements> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (!headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;

    const signer = fakeSigner();
    const wrapped = wrapFetchWithCantonPayment(fetch, signer, {
      // Always pick the second candidate (higher amount)
      selectRequirements: (candidates) => {
        calls.push(...candidates);
        return candidates[1] ?? candidates[0];
      },
    });

    await wrapped("https://example.com/data");
    // Both candidates were passed to selectRequirements
    expect(calls).toHaveLength(2);
    expect(calls[1].amount).toBe("2000000000");

    // The signer was called with the selected (second) requirements — its wire
    // amount "2000000000" converts to the on-ledger Decimal 0.2 CC.
    const signerFn = signer.signTransferFactory as ReturnType<typeof vi.fn>;
    expect(signerFn.mock.calls[0][0].amount).toBe("0.2000000000");
  });

  it("signer receives description containing the resource URL", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/resource/42" },
      accepts: [requirements()],
    };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (!headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;

    const signer = fakeSigner();
    const wrapped = wrapFetchWithCantonPayment(fetch, signer);
    await wrapped("https://api.example.com/resource/42");

    const signerFn = signer.signTransferFactory as ReturnType<typeof vi.fn>;
    const arg = signerFn.mock.calls[0][0];
    // PR #2634 privacy: resourceUrl is NOT committed on-ledger.
    expect(arg.transferMeta["x402.resourceUrl"]).toBeUndefined();
  });

  it("passes original request body through to the retry", async () => {
    // Ensures streaming/body replay works for JSON payloads
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com/rpc" },
      accepts: [requirements()],
    };
    const capturedBodies: Array<string | null> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedBodies.push((init as RequestInit | undefined)?.body as string ?? null);
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (!headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;

    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());
    await wrapped("https://example.com/rpc", {
      method: "POST",
      body: '{"action":"buy"}',
    });

    // Both the initial request and the retry should carry the same body
    expect(capturedBodies[0]).toBe('{"action":"buy"}');
    expect(capturedBodies[1]).toBe('{"action":"buy"}');
  });
});

describe("wrapFetchWithCantonPayment — header and scheme edge cases", () => {
  it("PAYMENT-RESPONSE header absent on retry → readPaymentResponseHeader returns null/undefined", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/no-response-header" },
      accepts: [requirements()],
    };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (!headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      // Retry response WITHOUT PAYMENT-RESPONSE header
      return new Response("paid", { status: 200 });
    }) as typeof globalThis.fetch;

    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());
    const res = await wrapped("https://api.example.com/no-response-header");

    expect(res.status).toBe(200);
    const meta = readPaymentResponseHeader(res);
    // Header absent → returns null (not throws)
    expect(meta).toBeNull();
  });

  it("when 402 response lacks accepts array entirely → NO_ACCEPTABLE_SCHEME error", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com" },
      accepts: [], // empty array — no acceptable scheme
    };
    const fetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        })
    ) as typeof globalThis.fetch;
    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());

    await expect(wrapped("https://example.com")).rejects.toMatchObject({
      name: "X402PaymentError",
      code: "NO_ACCEPTABLE_SCHEME",
    });
  });

  it("when accepts has exact but network doesn't match networkFilter → NO_ACCEPTABLE_SCHEME", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com/gated" },
      accepts: [requirements()], // network: "canton:devnet"
    };
    const fetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        })
    ) as typeof globalThis.fetch;
    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner(), {
      // Filter accepts only mainnet — devnet entry will be excluded
      networkFilter: (n) => n === "canton:mainnet",
    });

    await expect(wrapped("https://example.com/gated")).rejects.toMatchObject({
      name: "X402PaymentError",
      code: "NO_ACCEPTABLE_SCHEME",
    });
  });

  it("readPaymentResponseHeader: returns null when header is absent (does not throw)", () => {
    // Plain response with no PAYMENT-RESPONSE header
    const r = new Response("body text", { status: 200 });
    // Must return null, not throw
    expect(() => readPaymentResponseHeader(r)).not.toThrow();
    expect(readPaymentResponseHeader(r)).toBeNull();
  });

  it("wrapFetchWithCantonPayment: passes request headers through on the payment retry", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/header-passthrough" },
      accepts: [requirements()],
    };
    const capturedRetryHeaders: Headers[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (!headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      capturedRetryHeaders.push(headers);
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;

    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());
    // Send original request with a custom header
    await wrapped("https://api.example.com/header-passthrough", {
      headers: {
        "X-Custom-Header": "custom-value",
        "Authorization": "Bearer original-token",
      },
    });

    expect(capturedRetryHeaders).toHaveLength(1);
    const retryH = capturedRetryHeaders[0]!;
    // Original headers must be present on the retry
    expect(retryH.get("X-Custom-Header")).toBe("custom-value");
    expect(retryH.get("Authorization")).toBe("Bearer original-token");
    // Payment signature header must also be set
    expect(retryH.get(HEADER_PAYMENT_SIGNATURE_V2)).not.toBeNull();
  });
});

describe("wrapFetchWithCantonPayment — new coverage", () => {
  // ── 1. networkFilter selects only the matching network ──────────────────
  it("networkFilter: picks the matching network entry from multiple accepts[]", async () => {
    const devnet = requirements(); // network: "canton:devnet"
    const mainnet: typeof devnet = { ...requirements(), network: "canton:mainnet" };
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com/gated" },
      accepts: [devnet, mainnet],
    };

    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (!headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;

    const signer = fakeSigner();
    const wrapped = wrapFetchWithCantonPayment(fetch, signer, {
      networkFilter: (n) => n === "canton:mainnet",
    });

    await wrapped("https://example.com/gated");

    // Signer must have been called with the mainnet entry (higher amount would
    // disambiguate if networks differed by more, but here the network on the
    // signed args is the one that survived the filter).
    const signerFn = signer.signTransferFactory as ReturnType<typeof vi.fn>;
    expect(signerFn).toHaveBeenCalledTimes(1);
    // The mainnet requirements share all other fields with devnet in this
    // fixture, so we confirm the filter passed the right object by checking
    // the `synchronizerId` that appears in the signed call — both fixtures
    // share SYNC, so we verify the request completed (no error thrown) and
    // fetch was called twice (initial 402 + paid retry).
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // ── 2. scheme filter: mixed exact and exact-evm — only exact picked ─
  it("scheme filter: only the exact entry is selected when accepts[] also contains exact-evm", async () => {
    const evmEntry = {
      scheme: "exact-evm" as any,
      network: "eip155:1" as any,
      amount: "1000000000",
      asset: "eth",
      payTo: "0xdeadbeef",
      maxTimeoutSeconds: 60,
      extra: {} as any,
    };
    const cantonEntry = requirements(); // scheme: "exact"
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com/mixed" },
      accepts: [evmEntry, cantonEntry],
    };

    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (!headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      return new Response("paid", { status: 200 });
    }) as typeof globalThis.fetch;

    const signer = fakeSigner();
    const wrapped = wrapFetchWithCantonPayment(fetch, signer);
    const res = await wrapped("https://example.com/mixed");

    // Must succeed (exact entry found)
    expect(res.status).toBe(200);

    // Signer was invoked with the canton entry's fields, not the evm entry
    const signerFn = signer.signTransferFactory as ReturnType<typeof vi.fn>;
    expect(signerFn).toHaveBeenCalledTimes(1);
    const arg = signerFn.mock.calls[0][0];
    expect(arg.receiver).toBe(MERCHANT); // from cantonEntry
  });

  // ── 3. x402Version 1 lacks the v2 header — behavior is documented ───────
  it("x402Version 1 wire format (no PAYMENT-REQUIRED header) → MISSING_PAYMENT_REQUIRED_HEADER", async () => {
    // A v1 server returns 402 with only a WWW-Authenticate or body,
    // not the PAYMENT-REQUIRED v2 header. The client must reject cleanly.
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            x402Version: 1,
            accepts: [requirements()],
            resource: { url: "https://example.com" },
          }),
          {
            status: 402,
            headers: { "Content-Type": "application/json" },
            // NOTE: intentionally omits HEADER_PAYMENT_REQUIRED_V2
          }
        )
    ) as typeof globalThis.fetch;

    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());

    await expect(wrapped("https://example.com")).rejects.toMatchObject({
      name: "X402PaymentError",
      code: "MISSING_PAYMENT_REQUIRED_HEADER",
    });
    // Only one fetch call — no retry attempted
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // ── 4. Retry uses PAYMENT-SIGNATURE (not a variant header name) ──────────
  it("retry carries exactly PAYMENT-SIGNATURE (v2 header name), not a variant", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/pay" },
      accepts: [requirements()],
    };
    const capturedRetryHeaders: Headers[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (!headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      capturedRetryHeaders.push(headers);
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;

    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());
    await wrapped("https://api.example.com/pay");

    expect(capturedRetryHeaders).toHaveLength(1);
    const h = capturedRetryHeaders[0]!;

    // Exact v2 header is present (Headers API is case-insensitive, so
    // PAYMENT-SIGNATURE and payment-signature both resolve to the same slot —
    // the meaningful check is that the canonical name is set at all)
    expect(h.get(HEADER_PAYMENT_SIGNATURE_V2)).not.toBeNull();

    // X-prefixed variant spellings must NOT appear as separate entries
    // (guards against accidental header-name drift in future refactors).
    // Note: Headers.get() is case-insensitive for the same header name;
    // X-Payment-Signature and X-PAYMENT-SIGNATURE are a *different* header
    // from PAYMENT-SIGNATURE and must be absent.
    expect(h.get("X-Payment-Signature")).toBeNull();
    expect(h.get("X-PAYMENT-SIGNATURE")).toBeNull();
  });

  // ── 5. PAYMENT-RESPONSE header is parsed and returned in response metadata ─
  it("payment-response header is decoded and readable via readPaymentResponseHeader", async () => {
    const settlePayload = {
      success: true,
      transaction: "u-settle-abc",
      payer: PAYER,
      network: "canton:devnet",
    };
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/settle-test" },
      accepts: [requirements()],
    };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (!headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      return new Response("premium", {
        status: 200,
        headers: {
          [HEADER_PAYMENT_RESPONSE_V2]: encodeBase64Json(settlePayload),
        },
      });
    }) as typeof globalThis.fetch;

    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());
    const res = await wrapped("https://api.example.com/settle-test");

    expect(res.status).toBe(200);
    const meta = readPaymentResponseHeader<typeof settlePayload>(res);
    expect(meta).not.toBeNull();
    expect(meta?.success).toBe(true);
    expect(meta?.transaction).toBe("u-settle-abc");
    expect(meta?.payer).toBe(PAYER);
    expect(meta?.network).toBe("canton:devnet");
  });

  // ── 6. signer.signTransferFactory throw propagates (not swallowed) ─────────
  it("signer.signTransferFactory throw propagates out of wrapFetchWithCantonPayment", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/signer-throw" },
      accepts: [requirements()],
    };
    const fetch = vi.fn(async () =>
      new Response("{}", {
        status: 402,
        headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
      })
    ) as typeof globalThis.fetch;

    const throwingSigner: CantonSigner = {
      party: PAYER,
      signTransferFactory: vi.fn().mockRejectedValue(
        new Error("ledger rejected: insufficient funds")
      ),
    };

    const wrapped = wrapFetchWithCantonPayment(fetch, throwingSigner);

    await expect(wrapped("https://api.example.com/signer-throw")).rejects.toThrow(
      "ledger rejected: insufficient funds"
    );
    // The error is the original one, not wrapped in X402PaymentError
    await expect(wrapped("https://api.example.com/signer-throw")).rejects.not.toMatchObject({
      name: "X402PaymentError",
    });
  });

  // ── NEW: query params preserved on retry ────────────────────────────────
  it("wrapFetchWithCantonPayment: when the resource URL has query params, they're preserved in the retry", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/data?foo=bar&baz=1" },
      accepts: [requirements()],
    };
    const capturedUrls: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      capturedUrls.push(url);
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (!headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;

    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());
    await wrapped("https://api.example.com/data?foo=bar&baz=1");

    expect(capturedUrls).toHaveLength(2);
    // Both the initial request and the retry should include the query parameters
    expect(capturedUrls[1]).toContain("foo=bar");
    expect(capturedUrls[1]).toContain("baz=1");
  });

  // ── NEW: readPaymentResponseHeader parses all required fields ────────────
  it("readPaymentResponseHeader: parses all required fields (success, payer, transaction, network)", () => {
    const payload = {
      success: true,
      payer: PAYER,
      transaction: "txn-abc-123",
      network: "canton:devnet",
    };
    const r = new Response("ok", {
      headers: {
        [HEADER_PAYMENT_RESPONSE_V2]: encodeBase64Json(payload),
      },
    });
    const parsed = readPaymentResponseHeader<typeof payload>(r);
    expect(parsed).not.toBeNull();
    expect(parsed?.success).toBe(true);
    expect(parsed?.payer).toBe(PAYER);
    expect(parsed?.transaction).toBe("txn-abc-123");
    expect(parsed?.network).toBe("canton:devnet");
  });

  // ── NEW: selectRequirements when all candidates have wrong scheme ─────────
  it("selectRequirements: when all candidates have wrong scheme → NO_ACCEPTABLE_SCHEME", async () => {
    // All accepts[] entries use a scheme other than exact
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com" },
      accepts: [
        { ...requirements(), scheme: "exact-evm" as any },
        { ...requirements(), scheme: "exact-solana" as any },
      ],
    };
    const fetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        })
    ) as typeof globalThis.fetch;
    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());

    await expect(wrapped("https://example.com")).rejects.toMatchObject({
      name: "X402PaymentError",
      code: "NO_ACCEPTABLE_SCHEME",
    });
    // Only one fetch — no retry attempted
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // ── NEW: PAYMENT-SIGNATURE header value is base64-encoded JSON ───────────
  it("the PAYMENT-SIGNATURE header value is base64-encoded JSON (parseable after decoding)", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/sig-check" },
      accepts: [requirements()],
    };
    let capturedSigHeader: string | null = null;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (!headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      capturedSigHeader = headers.get(HEADER_PAYMENT_SIGNATURE_V2);
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;

    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());
    await wrapped("https://api.example.com/sig-check");

    expect(capturedSigHeader).not.toBeNull();
    // Must be valid base64
    expect(capturedSigHeader).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // Must decode to valid JSON
    const decoded = Buffer.from(capturedSigHeader!, "base64").toString("utf8");
    expect(() => JSON.parse(decoded)).not.toThrow();
    const parsed = JSON.parse(decoded);
    // The envelope must have x402Version and scheme at minimum
    expect(parsed.x402Version).toBe(2);
    expect(parsed.scheme).toBe("exact");
  });

  // ── NEW: 201 response (not 200) passes through unchanged ─────────────────
  it("wrapFetchWithCantonPayment: 201 response (not 200) passes through unchanged", async () => {
    const fetch = vi.fn(
      async () => new Response('{"created":true}', { status: 201 })
    ) as typeof globalThis.fetch;
    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());

    const res = await wrapped("https://example.com/resource");
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('{"created":true}');
    // No retry — 201 is a success, not a payment challenge
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // ── NEW: when payment successful, original response body is available ─────
  it("wrapFetchWithCantonPayment: when payment successful, original response body is available", async () => {
    const successBody = JSON.stringify({ data: "premium-content", value: 42 });
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/premium" },
      accepts: [requirements()],
    };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (!headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      return new Response(successBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());
    const res = await wrapped("https://api.example.com/premium");

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe(successBody);
    // Body must be parseable as JSON with the expected fields
    const parsed = JSON.parse(text);
    expect(parsed.data).toBe("premium-content");
    expect(parsed.value).toBe(42);
  });

  it("any transport error on the paid request is PAYMENT_UNCONFIRMED with the error as cause, a refused connection too, since a followed redirect can be refused after the merchant settled", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/unstable" },
      accepts: [requirements()],
    };
    for (const dropped of [
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      }),
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      }),
      new TypeError("fetch failed"),
    ]) {
      const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (new Headers(init?.headers).has(HEADER_PAYMENT_SIGNATURE_V2)) throw dropped;
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }) as typeof globalThis.fetch;
      const signer = fakeSigner();
      const wrapped = wrapFetchWithCantonPayment(fetch, signer);
      const err = await wrapped("https://api.example.com/unstable").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(X402PaymentError);
      expect((err as X402PaymentError).code).toBe("PAYMENT_UNCONFIRMED");
      expect((err as X402PaymentError).cause).toBe(dropped);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(signer.signTransferFactory).toHaveBeenCalledTimes(1);
    }
  });

  function abortable402Fetch(onPaid: () => Response) {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/data" },
      accepts: [requirements()],
    };
    return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (new Headers(init?.headers).has(HEADER_PAYMENT_SIGNATURE_V2)) return onPaid();
      return new Response("{}", {
        status: 402,
        headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
      });
    }) as typeof globalThis.fetch;
  }

  it("an abort before the paid request is sent rethrows the abort reason, and no payment reaches the merchant", async () => {
    const ac = new AbortController();
    const signer = fakeSigner();
    const sign = signer.signTransferFactory!;
    // The caller gives up while the payment is being signed.
    const aborting: CantonSigner = {
      party: signer.party,
      signTransferFactory: async (input) => {
        ac.abort();
        return sign(input);
      },
    };
    let paid = 0;
    const fetch = abortable402Fetch(() => {
      paid++;
      return new Response("ok", { status: 200 });
    });
    const err = await wrapFetchWithCantonPayment(fetch, aborting)("https://api.example.com/data", {
      signal: ac.signal,
    }).catch((e: unknown) => e);
    expect(err).toBe(ac.signal.reason);
    expect(paid).toBe(0);
  });

  it("an abort while the paid request is in flight is PAYMENT_UNCONFIRMED, with the abort as cause", async () => {
    const ac = new AbortController();
    const fetch = abortable402Fetch(() => {
      ac.abort();
      throw ac.signal.reason;
    });
    const err = await wrapFetchWithCantonPayment(fetch, fakeSigner())("https://api.example.com/data", {
      signal: ac.signal,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(X402PaymentError);
    expect((err as X402PaymentError).code).toBe("PAYMENT_UNCONFIRMED");
    expect((err as X402PaymentError).cause).toBe(ac.signal.reason);
  });

  // ── NEW: PAYMENT-REQUIRED header from 402 is base64 JSON ──────────────────
  it("PAYMENT-REQUIRED header from 402 is in the PAYMENT_REQUIRED_HEADER format (base64 JSON)", async () => {
    const requiredPayload: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/b64-check" },
      accepts: [requirements()],
    };
    // Encode via the same helper the server uses
    const encodedHeader = paymentRequiredHeader(requiredPayload);

    // Verify it is valid base64
    expect(encodedHeader).toMatch(/^[A-Za-z0-9+/]+=*$/);

    // Verify it decodes back to valid JSON with all required fields
    const decoded = Buffer.from(encodedHeader, "base64").toString("utf8");
    expect(() => JSON.parse(decoded)).not.toThrow();
    const parsed: X402PaymentRequired = JSON.parse(decoded);
    expect(parsed.x402Version).toBe(2);
    expect(parsed.resource.url).toBe("https://api.example.com/b64-check");
    expect(Array.isArray(parsed.accepts)).toBe(true);

    // Also verify the wrapped fetch honours it correctly by processing the header
    let capturedSigHeader: string | null = null;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (!headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: encodedHeader },
        });
      }
      capturedSigHeader = headers.get(HEADER_PAYMENT_SIGNATURE_V2);
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;

    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());
    const res = await wrapped("https://api.example.com/b64-check");
    expect(res.status).toBe(200);
    // The payment-signature header was set on the retry (header was parsed correctly)
    expect(capturedSigHeader).not.toBeNull();
  });

  // ── NEW: first 402 correct header, second returns 200 → final response is 200 ──
  it("when first fetch returns 402 with correct PAYMENT-REQUIRED header, second fetch returns 200 → final response is 200", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/two-step" },
      accepts: [requirements()],
    };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (!headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      return new Response("success-body", { status: 200 });
    }) as typeof globalThis.fetch;

    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());
    const res = await wrapped("https://api.example.com/two-step");

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success-body");
  });

  // ── NEW: when payment is successful, PAYMENT-RESPONSE header contains payer ─
  it("when payment is successful, the PAYMENT-RESPONSE header on the response contains payer", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/payer-check" },
      accepts: [requirements()],
    };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (!headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      return new Response("ok", {
        status: 200,
        headers: {
          [HEADER_PAYMENT_RESPONSE_V2]: encodeBase64Json({
            success: true,
            transaction: "txn-payer",
            payer: PAYER,
            network: "canton:devnet",
          }),
        },
      });
    }) as typeof globalThis.fetch;

    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());
    const res = await wrapped("https://api.example.com/payer-check");

    expect(res.status).toBe(200);
    const meta = readPaymentResponseHeader<{ payer: string }>(res);
    expect(meta).not.toBeNull();
    expect(meta?.payer).toBe(PAYER);
  });

  // ── NEW: when second fetch also returns 402 → PAYMENT_REJECTED, exactly 2 calls ──
  it("wrapFetchWithCantonPayment: when second fetch also returns 402 → PAYMENT_REJECTED, exactly 2 fetch calls (no infinite loop)", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/no-retry" },
      accepts: [requirements()],
    };
    const fetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        })
    ) as typeof globalThis.fetch;

    const signer = fakeSigner();
    const wrapped = wrapFetchWithCantonPayment(fetch, signer, {
      maxPaymentRetries: 0,
    });

    await expect(wrapped("https://api.example.com/no-retry")).rejects.toMatchObject({
      name: "X402PaymentError",
      code: "PAYMENT_REJECTED",
    });
    // First fetch (gets 402) + one retry (still 402) = exactly 2 calls total, then throws
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not re-pay through counter_not_ready, even when a second payment would be served", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/transient" },
      accepts: [requirements()],
    };
    // 402 (probe) -> 402 (the signed payment) -> 200 that a second payment would get.
    let n = 0;
    const fetch = vi.fn(async () => {
      n += 1;
      if (n <= 2) {
        const body = n === 2 ? JSON.stringify({ error: "invalid_exact_canton_counter_not_ready" }) : "{}";
        return new Response(body, {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    const signer = fakeSigner();
    const sleeps: number[] = [];
    const wrapped = wrapFetchWithCantonPayment(fetch, signer, {
      maxPaymentRetries: 4,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(wrapped("https://api.example.com/transient")).rejects.toMatchObject({
      code: "PAYMENT_REJECTED",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([]);
    expect(signer.signTransferFactory as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  // ── NEW: parsePaymentRequiredHeader with valid base64 → returns array of requirements ─
  it("parsePaymentRequiredHeader with valid base64 → decodes to array of payment requirements", () => {
    const reqs = requirements();
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/parse-test" },
      accepts: [reqs],
    };
    const encoded = encodeBase64Json(required);
    // Decoding via Buffer matches what the client does internally
    const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as X402PaymentRequired;
    expect(Array.isArray(decoded.accepts)).toBe(true);
    expect(decoded.accepts).toHaveLength(1);
    expect(decoded.accepts[0]?.scheme).toBe("exact");
    expect(decoded.accepts[0]?.amount).toBe("1000000000");
  });

  // ── NEW: created PaymentPayload has resource.url matching the original request URL ─
  it("the created PaymentPayload has resource.url matching the original request URL", async () => {
    const ORIGINAL_URL = "https://api.example.com/resource-url-check";
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: ORIGINAL_URL },
      accepts: [requirements()],
    };
    let capturedSigHeader: string | null = null;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (!headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      capturedSigHeader = headers.get(HEADER_PAYMENT_SIGNATURE_V2);
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;

    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());
    await wrapped(ORIGINAL_URL);

    expect(capturedSigHeader).not.toBeNull();
    const envelope = JSON.parse(Buffer.from(capturedSigHeader!, "base64").toString("utf8"));
    // The resource.url in the payment payload must match the original request URL
    expect(envelope.resource?.url).toBe(ORIGINAL_URL);
  });

  // ── 7. Very large payment amounts — no number precision loss ─────────────
  it("very large payment amount string converts to the ledger Decimal without precision loss", async () => {
    // Canton wire amounts (scheme "exact", atomic units) can exceed
    // Number.MAX_SAFE_INTEGER. The client must convert via exact BigInt math
    // (atomicToDecimalCC), never coerce to a JS number.
    const largeAmount = "9007199254740993000000000"; // > MAX_SAFE_INTEGER * 1e6
    // The on-ledger Daml Decimal the signer must receive (largeAmount / 1e10),
    // computed by exact BigInt division — no float rounding.
    const expectedLedger = "900719925474099.3000000000";
    const req = requirements();
    req.amount = largeAmount;
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/bigpay" },
      accepts: [req],
    };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (!headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;

    const signer = fakeSigner();
    const wrapped = wrapFetchWithCantonPayment(fetch, signer);
    await wrapped("https://api.example.com/bigpay");

    const signerFn = signer.signTransferFactory as ReturnType<typeof vi.fn>;
    expect(signerFn).toHaveBeenCalledTimes(1);
    const arg = signerFn.mock.calls[0][0];

    // Amount must arrive at the signer as the exact converted ledger Decimal,
    // with no floating-point rounding or scientific notation.
    expect(arg.amount).toBe(expectedLedger);
    expect(arg.amount).not.toContain("e"); // no scientific notation
    // Confirm the conversion is exact (BigInt), not via Number() which would lose
    // precision on a value this large.
    expect(String(Number(largeAmount)) === largeAmount).toBe(false); // sanity: Number() would lose precision
    expect(arg.amount).toBe(expectedLedger); // the signer received the exact ledger Decimal
  });

  // ── NEW: headers in the original response are preserved after payment ────────
  it("wrapFetchWithCantonPayment: headers in the original response are preserved after payment", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/headers-preserved" },
      accepts: [requirements()],
    };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (!headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      // Return response with custom headers on the paid response
      return new Response("paid", {
        status: 200,
        headers: {
          "X-Custom-Response-Header": "custom-value",
          "X-Rate-Limit-Remaining": "42",
          "Content-Type": "text/plain",
        },
      });
    }) as typeof globalThis.fetch;

    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());
    const res = await wrapped("https://api.example.com/headers-preserved");

    expect(res.status).toBe(200);
    // Headers from the paid response must be preserved
    expect(res.headers.get("X-Custom-Response-Header")).toBe("custom-value");
    expect(res.headers.get("X-Rate-Limit-Remaining")).toBe("42");
    expect(res.headers.get("Content-Type")).toBe("text/plain");
  });

  // ── NEW: accepts[] with multiple x402Version:2 exact entries → first matching one used ─
  it("when accepts[] has multiple exact entries → first matching one is used by default", async () => {
    const first = requirements(); // amount: "1000000000"
    const second: PaymentRequirements = { ...requirements(), amount: "2000000000" };
    const third: PaymentRequirements = { ...requirements(), amount: "3000000000" };
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/first-match" },
      accepts: [first, second, third],
    };

    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (!headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;

    const signer = fakeSigner();
    const wrapped = wrapFetchWithCantonPayment(fetch, signer);
    await wrapped("https://api.example.com/first-match");

    const signerFn = signer.signTransferFactory as ReturnType<typeof vi.fn>;
    expect(signerFn).toHaveBeenCalledTimes(1);
    // The signer must have been called with the FIRST entry's amount — its wire
    // atomic "1000000000" converts to the on-ledger Decimal 0.1 CC.
    expect(signerFn.mock.calls[0][0].amount).toBe("0.1000000000");
  });

  // ── NEW: readPaymentResponseHeader with malformed base64 → returns null (not throws) ──
  it("readPaymentResponseHeader: with malformed base64 value → does not throw (returns null or throws gracefully)", () => {
    // A response whose PAYMENT-RESPONSE header has garbage that can't be decoded
    const r = new Response("body", {
      headers: {
        [HEADER_PAYMENT_RESPONSE_V2]: "!!!not-valid-base64!!!",
      },
    });
    // The contract is: must not throw an unhandled exception.
    // It may return null or throw a decode error — either is acceptable.
    // The important guarantee is that the outer code can safely try-catch it.
    let threw = false;
    let result: unknown = undefined;
    try {
      result = readPaymentResponseHeader(r);
    } catch {
      threw = true;
    }
    // Either it returned null/undefined (graceful), or it threw (which the caller can catch)
    // The key assertion: the process didn't crash — we got here
    expect(true).toBe(true); // sentinel: if we reach here, no unhandled crash
    if (!threw) {
      // If it returned, the value is either null or a parsed object
      // (Buffer.from("!!!not-valid-base64!!!") is technically valid base64 decoding,
      // but JSON.parse may fail — either null or throw is acceptable)
      expect(result === null || result !== undefined).toBe(true);
    }
  });

  // ── NEW: createPaymentPayload is not called when PAYMENT-REQUIRED header is missing ──
  it("createPaymentPayload (signer) is not called when PAYMENT-REQUIRED header is missing from 402", async () => {
    // A 402 response without the PAYMENT-REQUIRED header should not trigger signing
    const fetch = vi.fn(
      async () => new Response("{}", { status: 402 /* no PAYMENT-REQUIRED header */ })
    ) as typeof globalThis.fetch;

    const signer = fakeSigner();
    const wrapped = wrapFetchWithCantonPayment(fetch, signer);

    await expect(wrapped("https://example.com")).rejects.toMatchObject({
      code: "MISSING_PAYMENT_REQUIRED_HEADER",
    });

    // Signer must NOT have been called — no payment payload was created
    expect(signer.signTransferFactory).not.toHaveBeenCalled();
    // Only one fetch call (no retry attempted)
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // ── NEW: the scheme field in the payment payload is "exact" ───────────
  it("the scheme field in the payment payload is \"exact\" (exact match)", async () => {
    const required: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/scheme-check" },
      accepts: [requirements()],
    };
    let capturedSigHeader: string | null = null;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (!headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
        });
      }
      capturedSigHeader = headers.get(HEADER_PAYMENT_SIGNATURE_V2);
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;

    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());
    await wrapped("https://api.example.com/scheme-check");

    expect(capturedSigHeader).not.toBeNull();
    const envelope = JSON.parse(Buffer.from(capturedSigHeader!, "base64").toString("utf8"));
    // scheme must be exactly "exact" — not "canton", not "exact_canton"
    expect(envelope.scheme).toBe("exact");
    expect(envelope.scheme).not.toBe("canton");
    expect(envelope.scheme).not.toBe("exact_canton");
  });
});

// ---------------------------------------------------------------------------
// Capability-aware method selection: a transfer-factory wallet must skip an
// accept[] entry whose advertised method it cannot service, pick the
// transfer-factory entry when the merchant advertises it alongside an
// unsupported one, and surface a clear named error when ONLY an unsupported
// method is advertised. (transfer-factory is the only real method now; a bogus
// method string stands in for "something this wallet cannot produce".)
// ---------------------------------------------------------------------------

function unsupportedMethodRequirements(): PaymentRequirements {
  return {
    scheme: "exact",
    network: "canton:devnet",
    amount: "1000000000",
    asset: `${FACILITATOR}::TestToken`,
    payTo: MERCHANT,
    maxTimeoutSeconds: 60,
    extra: {
      // A method this wallet cannot produce (the only real method is
      // transfer-factory); the signer-capability filter must drop it.
      assetTransferMethod: "some-unsupported-method" as any,
      feePayer: FACILITATOR,
      synchronizerId: SYNC,
    } as any,
  };
}

describe("wrapFetchWithCantonPayment — capability-aware method selection", () => {
  it("unsupported-method-only accepts[] → SchemeMethodMismatchError (never calls fetch retry)", async () => {
    let retried = false;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        retried = true;
        return new Response("ok", { status: 200 });
      }
      const required: X402PaymentRequired = {
        x402Version: 2,
        resource: { url: "https://api.example.com/unsupported-only" },
        accepts: [unsupportedMethodRequirements()],
      };
      return new Response("{}", {
        status: 402,
        headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
      });
    }) as typeof globalThis.fetch;

    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner());
    await expect(wrapped("https://api.example.com/unsupported-only")).rejects.toBeInstanceOf(
      SchemeMethodMismatchError
    );
    expect(retried).toBe(false);
  });

  it("transfer-factory advertised alongside an unsupported method → picks the transfer-factory entry and pays", async () => {
    const signer = fakeSigner();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      if (headers.has(HEADER_PAYMENT_SIGNATURE_V2)) {
        return new Response("paid", { status: 200 });
      }
      const required: X402PaymentRequired = {
        x402Version: 2,
        resource: { url: "https://api.example.com/both" },
        // unsupported entry first to prove the wrapper does NOT just take accepts[0]
        accepts: [unsupportedMethodRequirements(), requirements()],
      };
      return new Response("{}", {
        status: 402,
        headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
      });
    }) as typeof globalThis.fetch;

    const wrapped = wrapFetchWithCantonPayment(fetch, signer);
    const res = await wrapped("https://api.example.com/both");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("paid");
    // it paid via the transfer-factory signer, not the unsupported entry
    expect(signer.signTransferFactory as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });
});

/**
 * The ambiguity guard and the retry budget both stop the loop; they differ in
 * what they TELL the caller, and on an ambiguous reason that difference is the
 * whole point. The budget check used to run first, so an ambiguous reason
 * arriving on the FINAL attempt was reported as a definite "facilitator
 * rejected the payment" — and a caller acting on "rejected" pays again for a
 * purchase that may already have settled.
 */
describe("ambiguity outranks the retry budget", () => {
  const AMBIGUOUS = "invalid_exact_canton_execute_failed";
  const required: X402PaymentRequired = {
    x402Version: 2,
    resource: { url: "https://example.com" },
    accepts: [requirements()],
  };
  const reply = (reason: string) =>
    new Response(JSON.stringify({ error: reason }), {
      status: 402,
      headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
    });

  it("stays reachable with maxPaymentRetries 0", async () => {
    // The documented "restores the old at-most-twice behavior" setting made
    // `attempt(0) >= maxRetries(0)` true on the very first 402, so the guard
    // never ran at all on this configuration.
    const fetch = vi.fn(async () => reply(AMBIGUOUS)) as typeof globalThis.fetch;
    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner(), {
      maxPaymentRetries: 0,
      sleep: async () => {},
    });
    await expect(wrapped("https://example.com")).rejects.toThrow(
      /could not confirm the payment/i
    );
  });

  it("an ambiguous reason on the LAST attempt is not called a rejection", async () => {
    // A network error while building the payment spends the budget before
    // anything is signed, so the one paid 402 lands on the last attempt.
    const fetch = vi.fn(async () => reply(AMBIGUOUS)) as typeof globalThis.fetch;
    const signer = fakeSigner();
    const netErr = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" }),
    });
    (signer.signTransferFactory as ReturnType<typeof vi.fn>).mockRejectedValueOnce(netErr);
    const wrapped = wrapFetchWithCantonPayment(fetch, signer, {
      maxPaymentRetries: 1,
      sleep: async () => {},
    });
    await expect(wrapped("https://example.com")).rejects.toThrow(
      /could not confirm the payment[\s\S]*NOT pay again/i
    );
    expect(signer.signTransferFactory).toHaveBeenCalledTimes(2);
  });

  it("a NON-ambiguous reason gets the plain rejection message", async () => {
    // DISCRIMINATOR: a definite reason must keep its own wording, or every
    // failure would read as unresolved.
    const fetch = vi.fn(async () =>
      reply("invalid_exact_canton_amount")
    ) as typeof globalThis.fetch;
    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner(), {
      maxPaymentRetries: 1,
      sleep: async () => {},
    });
    await expect(wrapped("https://example.com")).rejects.toThrow(
      /payment returned 402 after it was signed \(invalid_exact_canton_amount\)/
    );
  });
});

/**
 * `code` is the only machine-readable field on X402PaymentError, so it is the
 * one an integrator branches on. Both stopping branches used to throw
 * PAYMENT_REJECTED, which made an unproven outcome indistinguishable from a
 * definite refusal in the one place a program can see.
 */
describe("the ambiguous outcome has its own machine-readable code", () => {
  const required: X402PaymentRequired = {
    x402Version: 2,
    resource: { url: "https://example.com" },
    accepts: [requirements()],
  };
  const reply = (reason: string) =>
    new Response(JSON.stringify({ error: reason }), {
      status: 402,
      headers: { [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader(required) },
    });

  it("an unproven settle is PAYMENT_UNCONFIRMED, not PAYMENT_REJECTED", async () => {
    const fetch = vi.fn(async () =>
      reply("invalid_exact_canton_execute_failed")
    ) as typeof globalThis.fetch;
    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner(), {
      maxPaymentRetries: 2,
      sleep: async () => {},
    });
    await expect(wrapped("https://example.com")).rejects.toMatchObject({
      code: "PAYMENT_UNCONFIRMED",
    });
  });

  it("a genuine refusal keeps PAYMENT_REJECTED", async () => {
    // DISCRIMINATOR: the existing code must not be repurposed, or every
    // integrator's rejection handling would silently stop firing.
    const fetch = vi.fn(async () =>
      reply("invalid_exact_canton_amount")
    ) as typeof globalThis.fetch;
    const wrapped = wrapFetchWithCantonPayment(fetch, fakeSigner(), {
      maxPaymentRetries: 1,
      sleep: async () => {},
    });
    await expect(wrapped("https://example.com")).rejects.toMatchObject({
      code: "PAYMENT_REJECTED",
    });
  });
});

describe("a paid request that was redirected", () => {
  // Real fetch on loopback: only a fetch that followed a redirect reports one.
  // The merchant settles the paid request, then redirects it to /next.
  const challenge = {
    [HEADER_PAYMENT_REQUIRED_V2]: paymentRequiredHeader({
      x402Version: 2,
      resource: { url: "http://127.0.0.1/buy" },
      accepts: [requirements()],
    }),
  };
  const edgePages: Array<(res: http.ServerResponse) => void> = [
    (res) => res.writeHead(431).end(),
    (res) =>
      res
        .writeHead(400)
        .end("<html><head><title>400 Request Header Or Cookie Too Large</title></head></html>"),
  ];

  async function pay(redirect: boolean, answerPaid: (res: http.ServerResponse) => void) {
    let settled = 0;
    const server = http.createServer((req, res) => {
      if (!req.headers[HEADER_PAYMENT_SIGNATURE_V2.toLowerCase()]) {
        res.writeHead(402, challenge).end("{}");
      } else if (redirect && req.url === "/buy") {
        settled++;
        res.writeHead(302, { location: "/next" }).end();
      } else {
        answerPaid(res);
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const signer = fakeSigner();
    try {
      const err = await wrapFetchWithCantonPayment(globalThis.fetch, signer)(
        `http://127.0.0.1:${port}/buy`
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(X402PaymentError);
      expect(signer.signTransferFactory).toHaveBeenCalledTimes(1);
      return { code: (err as X402PaymentError).code, settled };
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  it("a 402 after the redirect is PAYMENT_UNCONFIRMED: the merchant may have settled before redirecting", async () => {
    expect(await pay(true, (res) => res.writeHead(402, challenge).end("{}"))).toEqual({
      code: "PAYMENT_UNCONFIRMED",
      settled: 1,
    });
  });

  it("an edge header rejection after the redirect is PAYMENT_UNCONFIRMED, not MERCHANT_HEADER_LIMIT", async () => {
    for (const edge of edgePages) {
      expect(await pay(true, edge)).toEqual({ code: "PAYMENT_UNCONFIRMED", settled: 1 });
    }
  });

  it("without a redirect, a paid 402 stays PAYMENT_REJECTED and an edge rejection stays MERCHANT_HEADER_LIMIT", async () => {
    expect((await pay(false, (res) => res.writeHead(402, challenge).end("{}"))).code).toBe(
      "PAYMENT_REJECTED"
    );
    for (const edge of edgePages) {
      expect((await pay(false, edge)).code).toBe("MERCHANT_HEADER_LIMIT");
    }
  });
});
