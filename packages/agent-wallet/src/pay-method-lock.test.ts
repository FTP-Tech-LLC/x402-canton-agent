import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Spy the per-wallet mutex as a pass-through so we can assert WHEN it is taken.
// The method-aware decision (pay.ts) skips the lock for a no-nonce path
// (transfer-factory) and takes it only when the method can't be peeked
// (fail-safe). vi.hoisted so the spy exists before vi.mock's hoisted factory
// references it.
const { withPayLockSpy } = vi.hoisted(() => ({
  withPayLockSpy: vi.fn(async (_home: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock("./pay-lock.js", () => ({ withPayLock: withPayLockSpy }));

import { makePayingFetch } from "./pay.js";
import { saveWallet } from "./store.js";
import { generateAgentKey } from "./keys.js";

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

const PARTY = "agent::1220abcd";
const MERCHANT = "merchant::1220beef";
const RESOURCE = "https://api.example.com/data";

function challenge(transferMethod: string): string {
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
          assetTransferMethod: transferMethod,
          feePayer: "FTP::1220fee",
          synchronizerId: "global-domain::1220sync",
          instrumentId: { admin: "DSO::1220cafe", id: "Amulet" },
          allocateBeforeSeconds: 30,
          settleBeforeSeconds: 60,
        },
      },
    ],
  });
}

let tmp: string;
beforeEach(() => {
  withPayLockSpy.mockClear();
  tmp = mkdtempSync(join(tmpdir(), "caw-paylock-"));
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

describe("makePayingFetch — method-aware pay lock", () => {
  it("SKIPS the lock for a transfer-factory 402 (no nonce → concurrent)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { headers?: HeadersInit } = {}) => {
        if (url.includes("/v1/wallet/")) {
          // Make the pay dance fail fast (we only assert the lock decision).
          if (url.endsWith("/balance"))
            return new Response(
              JSON.stringify({ party: PARTY, amulet: 1, cc: "10.0", holdings: [{ cid: "h1", amount: "10.0" }] }),
              { status: 200 }
            );
          return new Response("nope", { status: 404 });
        }
        const h = new Headers(init.headers);
        if (h.has("payment-signature"))
          return new Response(JSON.stringify({ data: "premium" }), { status: 200 });
        return new Response("payment required", {
          status: 402,
          headers: { "payment-required": challenge("transfer-factory") },
        });
      })
    );
    const f = await makePayingFetch({ relayUrl: "http://relay", network: "canton:testnet" });
    await f(RESOURCE).catch(() => {}); // outcome irrelevant — assert the lock decision
    expect(withPayLockSpy).not.toHaveBeenCalled();
  });

  // transfer-factory is the sole payment method and is a no-nonce path, so the
  // "skips the lock" guarantee is carried by the case above. The lock is now
  // taken only on the fail-safe path below, when the 402's method can't be peeked.

  it("TAKES the lock when the 402 method can't be peeked (fail safe)", async () => {
    // Malformed PAYMENT-REQUIRED → peek returns undefined → serialize (so an
    // unparseable challenge never silently loses v1's protection).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { headers?: HeadersInit } = {}) => {
        if (url.includes("/v1/wallet/")) return new Response("{}", { status: 200 });
        const h = new Headers(init.headers);
        if (h.has("payment-signature"))
          return new Response(JSON.stringify({ data: "premium" }), { status: 200 });
        return new Response("payment required", {
          status: 402,
          headers: { "payment-required": "!!!not-base64-json!!!" },
        });
      })
    );
    const f = await makePayingFetch({ relayUrl: "http://relay", network: "canton:testnet" });
    await f(RESOURCE).catch(() => {});
    expect(withPayLockSpy).toHaveBeenCalledTimes(1);
  });
});
