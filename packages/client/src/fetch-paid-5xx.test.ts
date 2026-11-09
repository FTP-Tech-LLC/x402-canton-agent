/**
 * A 5xx to the paid request is not the end of the payment. Our express
 * middleware settles before the handler and, on a 5xx, gives the ticket back
 * so the SAME PAYMENT-SIGNATURE is served on retry ("retry the same
 * payment"); the facilitator answers a replay of settled bytes from its
 * idempotency record. The client used to hand the 5xx back as an ordinary
 * response and keep the signed header to itself, so nobody could retry the
 * payment, and the CLI exited 0 (audit 2026-11-07, B #6).
 *
 * Now: the same signed payment is re-sent a bounded number of times; if the
 * merchant still fails, PAYMENT_UNCONFIRMED says it may have settled and must
 * not be paid again. Never a second signature.
 */
import { describe, it, expect, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  HEADER_PAYMENT_REQUIRED_V2,
  HEADER_PAYMENT_RESPONSE_V2,
  HEADER_PAYMENT_SIGNATURE_V2,
  encodeBase64Json,
} from "@ftptech/x402-canton-core";
import { wrapFetchWithCantonPayment, X402PaymentError } from "./fetch.js";
import type { CantonSigner } from "./signer.js";

const URL_ = "https://api.example.com/data";

function fakeSigner(): CantonSigner {
  return {
    party: "agent::1220abc",
    signTransferFactory: vi.fn().mockResolvedValue({
      payerParty: "agent::1220abc",
      preparedTxHash: "ab".repeat(32),
      preparedTransactionBytes: new Uint8Array([1, 2, 3, 4]),
      signatureB64: Buffer.alloc(64, 7).toString("base64"),
    }),
  };
}

const challenge = (url: string) => ({
  [HEADER_PAYMENT_REQUIRED_V2]: encodeBase64Json({
    x402Version: 2,
    resource: { url },
    accepts: [
      {
        scheme: "exact",
        network: "canton:devnet",
        amount: "1000000000",
        asset: "CC",
        payTo: "merchant::1220m",
        maxTimeoutSeconds: 60,
        extra: {
          assetTransferMethod: "transfer-factory",
          feePayer: "fac::1220f",
          synchronizerId: "global-domain::1220s",
          instrumentId: { admin: "DSO::1220d", id: "Amulet" },
          executeBeforeSeconds: 120,
        },
      },
    ],
  }),
});

/** A merchant that challenges, then answers paid sends from `answers`. */
function harness(answers: Array<() => Response>, paidResends?: number) {
  const paid: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const sig = new Request(input, init).headers.get(HEADER_PAYMENT_SIGNATURE_V2);
    if (sig === null) return new Response("{}", { status: 402, headers: challenge(URL_) });
    paid.push(sig);
    return (answers.shift() ?? (() => new Response("ok")))();
  }) as typeof globalThis.fetch;
  const sleeps: number[] = [];
  const signer = fakeSigner();
  const wrapped = wrapFetchWithCantonPayment(fetch, signer, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...(paidResends !== undefined ? { paidResends } : {}),
  });
  return { wrapped, paid, sleeps, signer };
}

const status = (s: number, body = "", headers: Record<string, string> = {}) => () =>
  new Response(body, { status: s, headers });

describe("a 5xx after the payment was sent", () => {
  it("re-sends the SAME payment and returns what the merchant then serves", async () => {
    const h = harness([status(502), status(200, "served")]);
    const res = await h.wrapped(URL_);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("served");
    expect(h.signer.signTransferFactory).toHaveBeenCalledTimes(1);
    expect(h.paid).toHaveLength(2);
    expect(new Set(h.paid).size).toBe(1);
    expect(h.sleeps).toHaveLength(1);
  });

  it("gives up after a bounded number of re-sends with PAYMENT_UNCONFIRMED, never a second payment", async () => {
    const h = harness([status(503), status(503), status(503), status(200)]);
    const err = await h.wrapped(URL_).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(X402PaymentError);
    expect((err as X402PaymentError).code).toBe("PAYMENT_UNCONFIRMED");
    expect((err as Error).message).toMatch(/HTTP 503/);
    expect((err as Error).message).toMatch(/may already have settled/);
    expect((err as Error).message).toMatch(/NOT pay again/);
    expect(h.signer.signTransferFactory).toHaveBeenCalledTimes(1);
    expect(h.paid).toHaveLength(3);
    expect(new Set(h.paid).size).toBe(1);
  });

  it("a 402 to the re-sent payment is PAYMENT_UNCONFIRMED, not a rejection: the first send may have settled", async () => {
    const h = harness([
      status(502),
      status(402, JSON.stringify({ error: "invalid_exact_canton_input_contention" })),
    ]);
    const err = await h.wrapped(URL_).catch((e: unknown) => e);
    expect((err as X402PaymentError).code).toBe("PAYMENT_UNCONFIRMED");
    expect(h.signer.signTransferFactory).toHaveBeenCalledTimes(1);
  });

  it("names the settlement when the failing merchant reported one", async () => {
    const settled = {
      [HEADER_PAYMENT_RESPONSE_V2]: encodeBase64Json({ success: true, transaction: "1220upd" }),
    };
    const h = harness([status(500, "", settled), status(500, "", settled), status(500, "", settled)]);
    const err = await h.wrapped(URL_).catch((e: unknown) => e);
    expect((err as X402PaymentError).code).toBe("PAYMENT_UNCONFIRMED");
    expect((err as Error).message).toContain("1220upd");
  });

  it("a redirected 5xx is not re-sent: the merchant may have settled on an earlier hop", async () => {
    const redirected = () => {
      const r = new Response("", { status: 502 });
      Object.defineProperty(r, "redirected", { value: true });
      return r;
    };
    const h = harness([redirected]);
    const err = await h.wrapped(URL_).catch((e: unknown) => e);
    expect((err as X402PaymentError).code).toBe("PAYMENT_UNCONFIRMED");
    expect(h.paid).toHaveLength(1);
  });

  it("paidResends sets how many re-sends; 0 disables them and the 5xx is still PAYMENT_UNCONFIRMED", async () => {
    const off = harness([status(502), status(200)], 0);
    const err = await off.wrapped(URL_).catch((e: unknown) => e);
    expect((err as X402PaymentError).code).toBe("PAYMENT_UNCONFIRMED");
    expect(off.paid).toHaveLength(1);
    expect(off.sleeps).toHaveLength(0);

    const one = harness([status(502), status(502), status(200)], 1);
    const err1 = await one.wrapped(URL_).catch((e: unknown) => e);
    expect((err1 as X402PaymentError).code).toBe("PAYMENT_UNCONFIRMED");
    expect(one.paid).toHaveLength(2);
    expect(one.signer.signTransferFactory).toHaveBeenCalledTimes(1);
  });

  it("a paid 4xx is the merchant's answer: returned as before, not re-sent", async () => {
    const h = harness([status(401, "no key")]);
    const res = await h.wrapped(URL_);
    expect(res.status).toBe(401);
    expect(h.paid).toHaveLength(1);
    expect(h.sleeps).toHaveLength(0);
  });

  it("re-sends a POST Request with its body each time", async () => {
    const bodies: Array<[boolean, string]> = [];
    let paidSends = 0;
    let url = "";
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += String(c);
      const isPaid = typeof req.headers[HEADER_PAYMENT_SIGNATURE_V2.toLowerCase()] === "string";
      bodies.push([isPaid, body]);
      if (!isPaid) return void res.writeHead(402, challenge(url)).end("{}");
      paidSends += 1;
      res.writeHead(paidSends === 1 ? 502 : 200).end(paidSends === 1 ? "" : "served");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`;
    try {
      const res = await wrapFetchWithCantonPayment(globalThis.fetch, fakeSigner(), {
        sleep: async () => {},
      })(new Request(url, { method: "POST", body: '{"q":1}' }));
      expect(res.status).toBe(200);
      expect(bodies).toEqual([
        [false, '{"q":1}'],
        [true, '{"q":1}'],
        [true, '{"q":1}'],
      ]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
