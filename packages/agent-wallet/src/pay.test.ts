import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePayingFetch } from "./pay.js";
import { saveWallet } from "./store.js";
import { generateAgentKey } from "./keys.js";
// Faithful honest prepared transfer-tx so verify-before-sign passes (real field
// numbers — see _prepared-fixture).
import { buildHonest } from "./_prepared-fixture.js";

/** Deterministic stand-in for Canton's V2 hash (see verify-prepared.ts). */
function RECOMPUTE(b64: string): string {
  return createHash("sha256").update(Buffer.from(b64, "base64")).digest("base64");
}

// inline of @ftptech/x402-canton-core's encodeBase64Json (not a declared dep here)
function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

const PARTY = "agent::1220abcd";
const MERCHANT = "merchant::1220beef";
const FACILITATOR = "FTP::1220fee";
const DSO = "DSO::1220cafe";
const SYNC = "global-domain::1220sync";
const RESOURCE = "https://api.example.com/data";

/** A faithful TransferFactory_Transfer prepared blob the honest relay returns for
 *  the agent's pay/prepare (sender = agent, receiver = merchant). verify-before-
 *  sign (assertPreparedTransferMatches) accepts it. */
function preparedTransfer(receiver: string, amount: string): string {
  return buildHonest(
    { sender: PARTY, receiver, amount },
    { admin: DSO, id: "Amulet" }
  );
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "caw-pay-"));
  process.env.CANTON_AGENT_HOME = tmp;
  const k = generateAgentKey();
  saveWallet({
    network: "canton:testnet",
    relayUrl: "http://relay",
    party: PARTY,
    publicKeySpkiB64: k.publicKeySpkiB64,
    privateKeyPkcs8Pem: k.privateKeyPkcs8Pem,
    publicKeyFingerprint: "fp",
    createdAt: "t",
  });
});
afterEach(() => {
  delete process.env.CANTON_AGENT_HOME;
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function challenge(memo?: string): string {
  return encodeBase64Json({
    x402Version: 2,
    resource: { url: RESOURCE },
    accepts: [
      {
        scheme: "exact",
        network: "canton:testnet",
        amount: "10000000000",
        asset: "canton-coin",
        payTo: MERCHANT,
        maxTimeoutSeconds: 60,
        resource: RESOURCE,
        extra: {
          assetTransferMethod: "transfer-factory",
          feePayer: FACILITATOR,
          synchronizerId: SYNC,
          instrumentId: { admin: DSO, id: "Amulet" },
          executeBeforeSeconds: 120,
          ...(memo !== undefined ? { memo } : {}),
        },
      },
    ],
  });
}

describe("makePayingFetch (402 → pay → retry)", () => {
  it("pays a transfer-factory 402 from the relay-backed wallet and retries to 200", async () => {
    let resourceHits = 0;
    let committed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { headers?: HeadersInit; body?: string } = {}) => {
        // ── relay endpoints (transfer-factory pay: prepare → verify → sign inline) ──
        if (url.includes("/v1/wallet/")) {
          if (url.endsWith("/balance"))
            return new Response(JSON.stringify({ party: PARTY, amulet: 1, cc: "10.0", holdings: [{ cid: "h1", amount: "10.0" }] }), { status: 200 });
          if (url.endsWith("/pay/prepare")) {
            const b = JSON.parse(init.body ?? "{}");
            const pt = preparedTransfer(b.receiver, b.amount);
            // Honest relay: hash OF the prepared bytes so the binding accepts it.
            return new Response(JSON.stringify({
              submissionRef: "sub-1",
              preparedTransaction: pt,
              txHash: RECOMPUTE(pt),
              executeBefore: "2026-01-01T00:00:00Z",
              sender: PARTY,
              receiver: b.receiver,
              amount: b.amount,
              instrumentId: { admin: DSO, id: "Amulet" },
            }), { status: 200 });
          }
          if (url.endsWith("/pay/commit")) {
            committed = true;
            return new Response(JSON.stringify({ committed: true, submissionRef: "sub-1", executeBefore: "2026-01-01T00:00:00Z" }), { status: 200 });
          }
          return new Response("nf", { status: 404 });
        }
        // ── the resource being paid for ──
        resourceHits++;
        const headers = new Headers(init.headers);
        if (headers.has("payment-signature")) {
          return new Response(JSON.stringify({ data: "premium" }), { status: 200 });
        }
        return new Response("payment required", {
          status: 402,
          headers: { "payment-required": challenge() },
        });
      })
    );

    const f = await makePayingFetch({
      relayUrl: "http://relay",
      network: "canton:testnet",
      hashBinding: { recomputeHash: RECOMPUTE },
    });
    const res = await f(RESOURCE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: "premium" });
    // 3 hits: the OUTER probe (402 → peek the method to decide the lock), then
    // wrapFetch's own probe (402) + the paid retry (200). transfer-factory is a
    // no-nonce method so the per-wallet lock is SKIPPED, but the outer probe is
    // still spent to peek the method — see pay.ts.
    expect(resourceHits).toBe(3);
    // Inline carriage: the signed transfer travels in the payment payload, so
    // the relay's pay/commit is never called.
    expect(committed).toBe(false);
  });

  it("forwards the merchant's extra.memo to the relay pay/prepare as `memo`", async () => {
    // The x402 client stamps extra.memo into transferMeta as x402.memo; the relay
    // signer extracts it and threads it to payViaTransferFactory → relay.payPrepare.
    let prepareBody: { memo?: unknown } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { headers?: HeadersInit; body?: string } = {}) => {
        if (url.includes("/v1/wallet/")) {
          if (url.endsWith("/balance"))
            return new Response(JSON.stringify({ party: PARTY, amulet: 1, cc: "10.0", holdings: [{ cid: "h1", amount: "10.0" }] }), { status: 200 });
          if (url.endsWith("/pay/prepare")) {
            const b = JSON.parse(init.body ?? "{}");
            prepareBody = b;
            const pt = preparedTransfer(b.receiver, b.amount);
            return new Response(JSON.stringify({
              submissionRef: "sub-1", preparedTransaction: pt, txHash: RECOMPUTE(pt),
              executeBefore: "2026-01-01T00:00:00Z", sender: PARTY, receiver: b.receiver,
              amount: b.amount, instrumentId: { admin: DSO, id: "Amulet" },
            }), { status: 200 });
          }
          if (url.endsWith("/pay/commit"))
            return new Response(JSON.stringify({ committed: true, submissionRef: "sub-1", executeBefore: "2026-01-01T00:00:00Z" }), { status: 200 });
          return new Response("nf", { status: 404 });
        }
        const headers = new Headers(init.headers);
        if (headers.has("payment-signature")) return new Response(JSON.stringify({ data: "premium" }), { status: 200 });
        return new Response("payment required", { status: 402, headers: { "payment-required": challenge("invoice-7") } });
      })
    );
    const f = await makePayingFetch({ relayUrl: "http://relay", network: "canton:testnet", hashBinding: { recomputeHash: RECOMPUTE } });
    const res = await f(RESOURCE);
    expect(res.status).toBe(200);
    expect(prepareBody?.memo).toBe("invoice-7");
  });

  it("omits `memo` from pay/prepare when the merchant sets none", async () => {
    let prepareBody: { memo?: unknown } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { headers?: HeadersInit; body?: string } = {}) => {
        if (url.includes("/v1/wallet/")) {
          if (url.endsWith("/balance"))
            return new Response(JSON.stringify({ party: PARTY, amulet: 1, cc: "10.0", holdings: [{ cid: "h1", amount: "10.0" }] }), { status: 200 });
          if (url.endsWith("/pay/prepare")) {
            const b = JSON.parse(init.body ?? "{}");
            prepareBody = b;
            const pt = preparedTransfer(b.receiver, b.amount);
            return new Response(JSON.stringify({
              submissionRef: "sub-1", preparedTransaction: pt, txHash: RECOMPUTE(pt),
              executeBefore: "2026-01-01T00:00:00Z", sender: PARTY, receiver: b.receiver,
              amount: b.amount, instrumentId: { admin: DSO, id: "Amulet" },
            }), { status: 200 });
          }
          if (url.endsWith("/pay/commit"))
            return new Response(JSON.stringify({ committed: true, submissionRef: "sub-1", executeBefore: "2026-01-01T00:00:00Z" }), { status: 200 });
          return new Response("nf", { status: 404 });
        }
        const headers = new Headers(init.headers);
        if (headers.has("payment-signature")) return new Response(JSON.stringify({ data: "premium" }), { status: 200 });
        return new Response("payment required", { status: 402, headers: { "payment-required": challenge() } });
      })
    );
    const f = await makePayingFetch({ relayUrl: "http://relay", network: "canton:testnet", hashBinding: { recomputeHash: RECOMPUTE } });
    await f(RESOURCE);
    expect(prepareBody).toBeDefined();
    expect(prepareBody!.memo).toBeUndefined();
  });

  it("REFUSES to pay a 402 that quotes ABOVE maxPaymentValue (over-quoting merchant)", async () => {
    // The merchant's 402 quotes 1.0 CC but the caller capped the signer at 0.5.
    // makePayingFetch must thread maxPaymentValue into the signer, which refuses
    // to sign — the signed transfer must NEVER be committed. The spend breaker
    // fires at the TOP of signTransferFactory, before any relay call, so the
    // pay/commit endpoint is never reached.
    let committed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { headers?: HeadersInit; body?: string } = {}) => {
        if (url.includes("/v1/wallet/")) {
          if (url.endsWith("/balance"))
            return new Response(JSON.stringify({ party: PARTY, amulet: 1, cc: "10.0", holdings: [{ cid: "h1", amount: "10.0" }] }), { status: 200 });
          if (url.endsWith("/pay/commit")) {
            committed = true;
            return new Response(JSON.stringify({ committed: true, submissionRef: "sub-1", executeBefore: "x" }), { status: 200 });
          }
          return new Response("nf", { status: 404 });
        }
        const headers = new Headers(init.headers);
        if (headers.has("payment-signature")) return new Response(JSON.stringify({ data: "premium" }), { status: 200 });
        return new Response("payment required", { status: 402, headers: { "payment-required": challenge() } });
      })
    );

    const f = await makePayingFetch({
      relayUrl: "http://relay",
      network: "canton:testnet",
      hashBinding: { recomputeHash: RECOMPUTE },
      maxPaymentValue: "0.5", // challenge() quotes 1.0 CC > 0.5 → refuse
    });
    await expect(f(RESOURCE)).rejects.toThrow(/exceeds|max payment value/i);
    expect(committed).toBe(false); // nothing landed on-ledger
  });

  it("REFUSES to pay a 402 whose payTo is not the expectedPayTo (MITM'd merchant)", async () => {
    let committed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { headers?: HeadersInit; body?: string } = {}) => {
        if (url.includes("/v1/wallet/")) {
          if (url.endsWith("/balance"))
            return new Response(JSON.stringify({ party: PARTY, amulet: 1, cc: "10.0", holdings: [{ cid: "h1", amount: "10.0" }] }), { status: 200 });
          if (url.endsWith("/pay/commit")) { committed = true; return new Response(JSON.stringify({ committed: true, submissionRef: "sub-1", executeBefore: "x" }), { status: 200 }); }
          return new Response("{}", { status: 200 });
        }
        const headers = new Headers(init.headers);
        if (headers.has("payment-signature")) return new Response(JSON.stringify({ data: "premium" }), { status: 200 });
        return new Response("payment required", { status: 402, headers: { "payment-required": challenge() } });
      })
    );
    const f = await makePayingFetch({
      relayUrl: "http://relay",
      network: "canton:testnet",
      hashBinding: { recomputeHash: RECOMPUTE },
      expectedPayTo: "merchant::not-the-one-in-the-402", // challenge() pays MERCHANT
    });
    await expect(f(RESOURCE)).rejects.toThrow(/payee|expected payTo/i);
    expect(committed).toBe(false);
  });

  it("passes a non-402 response straight through without paying", async () => {
    let relayCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v1/wallet/")) { relayCalled = true; return new Response("{}", { status: 200 }); }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );
    const f = await makePayingFetch({ relayUrl: "http://relay", network: "canton:testnet" });
    const res = await f(RESOURCE);
    expect(res.status).toBe(200);
    expect(relayCalled).toBe(false);
  });
});
