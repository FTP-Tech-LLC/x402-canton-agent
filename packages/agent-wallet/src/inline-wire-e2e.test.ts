/**
 * The seam nobody was testing: PRODUCER → wire → CONSUMER.
 *
 * Every inline test until now started at `encodeInlinePaymentPayload` with a
 * hand-written hash, and every producer test stopped at the fields the producer
 * returns. Both sides were green while the wire between them was broken: Canton
 * returns `preparedTransactionHash` as BASE64, the decoder demands lower-case
 * HEX, so the first honest payment would have died at decode with
 * `malformed_payload` — a bug that reads like client tampering.
 *
 * This suite runs the real chain — RelayClient → relay-signer →
 * ExactCantonScheme → the core decoder and the same structural validator the
 * facilitator runs. Only the network is stubbed (at `fetch`, the repo's own
 * convention), so verify-before-sign, the signature and the payload build are
 * all genuinely exercised.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { ExactCantonScheme } from "@ftptech/x402-canton-client";
import {
  decodeInlinePaymentPayload,
  assertPreparedTransferMatches,
  wireAmountToLedgerDecimal,
} from "@ftptech/x402-canton-core";
import { makeRelaySigner } from "./relay-signer.js";
import { generateAgentKey } from "./keys.js";
import { buildPrepared } from "./_prepared-fixture.js";
import type { AgentWallet } from "./store.js";

const key = generateAgentKey();
const PARTY = "agent::1220" + "aa".repeat(32);
const MERCHANT = "merch::1220" + "bb".repeat(32);
const DSO = "DSO::1220" + "ee".repeat(32);
/** 0.25 CC in the wire's atomic units. The scheme's own conversion is what
 *  turns this into the ledger Decimal the transfer carries — so the unit seam
 *  is exercised too, not assumed. */
const WIRE_AMOUNT = "2500000000";
const LEDGER_AMOUNT = wireAmountToLedgerDecimal("exact", WIRE_AMOUNT);

const PREPARED = buildPrepared({
  sender: PARTY,
  receiver: MERCHANT,
  amount: LEDGER_AMOUNT,
  admin: DSO,
  id: "Amulet",
});
/** BASE64 — the shape Canton's interactive-submission prepare really returns.
 *  Writing hex here would make this suite agree with the bug it exists to
 *  catch. */
const CANTON_HASH_B64 = createHash("sha256").update(PREPARED).digest("base64");

function wallet(): AgentWallet {
  return {
    network: "canton:mainnet",
    relayUrl: "http://relay",
    party: PARTY,
    publicKeySpkiB64: key.publicKeySpkiB64,
    privateKeyPkcs8Pem: key.privateKeyPkcs8Pem,
    publicKeyFingerprint: "1220" + "aa".repeat(32),
    createdAt: "t",
  };
}

/** Stub the RELAY, not the client: every layer below the network stays real. */
function stubRelay(): { commits: unknown[] } {
  const commits: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    async (url: string, init?: { body?: string }) => {
      const path = String(url);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (path.endsWith("/v1/wallet/pay/prepare")) {
        return json({
          submissionRef: "ref-1",
          preparedTransaction: PREPARED,
          txHash: CANTON_HASH_B64,
          executeBefore: new Date(Date.now() + 60_000).toISOString(),
          sender: PARTY,
          receiver: MERCHANT,
          amount: LEDGER_AMOUNT,
          instrumentId: { admin: DSO, id: "Amulet" },
        });
      }
      if (path.endsWith("/v1/wallet/pay/commit")) {
        commits.push(init?.body);
        return json({ ok: true });
      }
      throw new Error(`unexpected relay call: ${path}`);
    }
  );
  return { commits };
}

afterEach(() => vi.unstubAllGlobals());

function requirements() {
  return {
    scheme: "exact",
    network: "canton:mainnet",
    amount: WIRE_AMOUNT,
    asset: "CC",
    payTo: MERCHANT,
    maxTimeoutSeconds: 60,
    extra: {
      assetTransferMethod: "transfer-factory",
      feePayer: "ftp_facilitator::1220" + "ff".repeat(32),
      instrumentId: { admin: DSO, id: "Amulet" },
      executeBeforeSeconds: 60,
    },
  } as never;
}

async function produceEnvelope() {
  const signer = makeRelaySigner(wallet(), {
    inline: true,
    // The hash-binding leg has its own dedicated suite; trusting the relay hash
    // here keeps this test about the WIRE.
    hashBinding: { trustRelayHash: true },
    trustedDso: DSO,
  });
  return new ExactCantonScheme(signer).createPaymentPayload(requirements(), {
    url: "https://api.example.com/x",
  });
}

describe("inline carriage — producer to consumer, over the real wire", () => {
  it("emits a payload the facilitator's own decoder accepts", async () => {
    const { commits } = stubRelay();
    const envelope = await produceEnvelope();

    // Inline means the client leaves nothing on the relay to look up later.
    expect(commits).toHaveLength(0);

    // THE ASSERTION THIS FILE EXISTS FOR: what the producer emits is what the
    // consumer accepts. Before the fix this threw `malformed_payload` on a
    // completely honest payment.
    const decoded = decodeInlinePaymentPayload(envelope.payload);
    expect(decoded.preparedTransactionBytes).toEqual(Buffer.from(PREPARED, "base64"));

    // The hash SURVIVED the conversion rather than merely passing a syntax
    // check: it is the same digest Canton returned, re-spelled.
    expect(decoded.claimedPreparedTxHash).toBe(
      Buffer.from(CANTON_HASH_B64, "base64").toString("hex")
    );

    // And the consumer's structural gate agrees the transfer inside those bytes
    // is the one the 402 quoted.
    assertPreparedTransferMatches(
      decoded.preparedTransactionBytes.toString("base64"),
      {
        sender: PARTY,
        receiver: MERCHANT,
        amount: LEDGER_AMOUNT,
        instrumentAdmin: DSO,
        instrumentId: "Amulet",
      }
    );
  });

  it("proves the conversion is load-bearing, not decorative", async () => {
    // Canton's own spelling must NOT decode. This is what made a passthrough a
    // money bug rather than a cosmetic one, and it is the mutation that would
    // have failed had the conversion been dropped.
    expect(CANTON_HASH_B64).not.toMatch(/^[0-9a-f]+$/);
    stubRelay();
    const envelope = await produceEnvelope();
    expect(() =>
      decodeInlinePaymentPayload({
        ...(envelope.payload as Record<string, unknown>),
        preparedTxHash: CANTON_HASH_B64,
      })
    ).toThrow();
  });
});
