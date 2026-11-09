/**
 * `fetch(request)`, the form ky and several SDKs use, must pay the same
 * request it was given. A Request carries its own headers and body, and
 * `init` replaces either only when it sets it. The paid retry used to be
 * rebuilt from `init` alone: it went out without the Request's headers
 * (Authorization included), and a body already read by the first send could
 * not be sent again. Against a server that settles before its handler, that
 * is a payment for a 401 (audit 2026-11-07, B #5).
 *
 * Real fetch against a loopback merchant, so the Request semantics are the
 * runtime's, not a mock's.
 */
import { describe, it, expect, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  HEADER_PAYMENT_REQUIRED_V2,
  HEADER_PAYMENT_SIGNATURE_V2,
  encodeBase64Json,
} from "@ftptech/x402-canton-core";
import { wrapFetchWithCantonPayment } from "./fetch.js";
import type { CantonSigner } from "./signer.js";

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

interface Seen {
  method: string;
  paid: boolean;
  authorization: string | undefined;
  userAgent: string | undefined;
  contentType: string | undefined;
  body: string;
}

/** A merchant that asks for payment and serves once paid. */
async function merchant(): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  let url = "";
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const paid = typeof req.headers[HEADER_PAYMENT_SIGNATURE_V2.toLowerCase()] === "string";
    seen.push({
      method: req.method ?? "",
      paid,
      authorization: req.headers.authorization,
      userAgent: req.headers["user-agent"],
      contentType: req.headers["content-type"],
      body,
    });
    if (paid) {
      res.writeHead(200).end("paid");
      return;
    }
    res
      .writeHead(402, {
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
      })
      .end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/data`;
  return { url, seen, close: () => new Promise((r) => server.close(() => r())) };
}

describe("a Request input is paid as sent", () => {
  it("keeps the Request's headers on the paid retry", async () => {
    const m = await merchant();
    try {
      const signer = fakeSigner();
      const res = await wrapFetchWithCantonPayment(globalThis.fetch, signer)(
        new Request(m.url, { headers: { authorization: "Bearer T", "user-agent": "my-bot/1" } })
      );
      expect(res.status).toBe(200);
      const paid = m.seen.filter((s) => s.paid);
      expect(paid).toHaveLength(1);
      expect(paid[0]).toMatchObject({ authorization: "Bearer T", userAgent: "my-bot/1" });
      expect(signer.signTransferFactory).toHaveBeenCalledTimes(1);
    } finally {
      await m.close();
    }
  });

  it("sends a POST Request's body again on the paid retry", async () => {
    const m = await merchant();
    try {
      const signer = fakeSigner();
      const res = await wrapFetchWithCantonPayment(globalThis.fetch, signer)(
        new Request(m.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"q":1}',
        })
      );
      expect(res.status).toBe(200);
      expect(m.seen.map((s) => [s.method, s.paid, s.body, s.contentType])).toEqual([
        ["POST", false, '{"q":1}', "application/json"],
        ["POST", true, '{"q":1}', "application/json"],
      ]);
      expect(signer.signTransferFactory).toHaveBeenCalledTimes(1);
    } finally {
      await m.close();
    }
  });

  it("lets init override the Request on both sends, as fetch does", async () => {
    const m = await merchant();
    try {
      await wrapFetchWithCantonPayment(globalThis.fetch, fakeSigner())(
        new Request(m.url, { headers: { authorization: "Bearer FROM-REQUEST" } }),
        { headers: { authorization: "Bearer FROM-INIT" } }
      );
      expect(m.seen.map((s) => s.authorization)).toEqual(["Bearer FROM-INIT", "Bearer FROM-INIT"]);
    } finally {
      await m.close();
    }
  });

  it("passes a Request that already carries PAYMENT-SIGNATURE straight through", async () => {
    const m = await merchant();
    try {
      const signer = fakeSigner();
      const res = await wrapFetchWithCantonPayment(globalThis.fetch, signer)(
        new Request(m.url, { headers: { [HEADER_PAYMENT_SIGNATURE_V2]: "preexisting" } })
      );
      expect(res.status).toBe(200);
      expect(m.seen).toHaveLength(1);
      expect(signer.signTransferFactory).not.toHaveBeenCalled();
    } finally {
      await m.close();
    }
  });
});
