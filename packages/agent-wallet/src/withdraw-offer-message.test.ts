// A plain withdraw of a registry token to a receiver with no preapproval for it.
// The relay prepares the offer shape (AllocationFactory_TransferInternal plus a
// TransferOffer), verify-before-sign refuses it, and nothing is signed. The
// refusal says what is missing only when the same bytes pass the offer-shape
// check, whose root names the intended receiver and amount. A redirected or
// resized transfer keeps the original refusal, which is evidence about the relay.
// Driven by a real MainNet CBTC offer-shape transaction.
import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PreparedTransferMismatchError } from "@ftptech/x402-canton-core";
import { withdraw } from "./withdraw.js";
import { RegistryOfferRefusedError } from "./tx.js";
import { generateAgentKey } from "./keys.js";
import { decodePrepared, extractTransfer, type HashBindingOptions } from "./verify-prepared.js";
import type { AgentWallet } from "./store.js";

const here = dirname(fileURLToPath(import.meta.url));
const RECOMPUTE = (b64: string): string => createHash("sha256").update(Buffer.from(b64, "base64")).digest("base64");
const BOUND: HashBindingOptions = { recomputeHash: RECOMPUTE };
const offer = readFileSync(join(here, "__fixtures__", "mainnet-cbtc-registry-offer-to-pool.b64"), "utf8").trim();
const root = decodePrepared(offer).exercises.find((e) => e.choiceId === "TransferFactory_Transfer")!;
const t = extractTransfer(root.chosenValue);

function wallet(): AgentWallet {
  const k = generateAgentKey();
  return {
    network: "canton:mainnet",
    relayUrl: "http://relay",
    party: t.sender,
    publicKeySpkiB64: k.publicKeySpkiB64,
    privateKeyPkcs8Pem: k.privateKeyPkcs8Pem,
    publicKeyFingerprint: "fp",
    createdAt: "t",
  };
}

// The relay answers with the fixture whatever was asked; it has no
// preapproval-status route, so the classification cannot lean on its word.
function relay(execute: () => Promise<{ updateId: string }> = async () => ({ updateId: "u1" })) {
  const executed: unknown[] = [];
  const r = {
    holdings: async () => ({
      complete: true,
      instruments: [
        {
          instrumentId: { admin: t.instrumentAdmin, id: "CBTC" },
          // Two halves of the amount, in the fixture's input order, so the
          // wallet picks exactly the inputs the transaction spends.
          holdings: t.inputHoldingCids.map((cid) => ({ cid, amount: "0.0000100000", locked: false })),
        },
      ],
    }),
    resolveTransferFactory: async () => ({
      factoryId: root.contractId,
      transferKind: "offer",
      transferFactoryTemplateId: "#x:TransferFactory",
      instrumentId: { admin: t.instrumentAdmin, id: "CBTC" },
      choiceContextData: { values: {} },
      disclosedContracts: [],
    }),
    submitPrepare: async () => ({ preparedTransaction: offer, hash: RECOMPUTE(offer) }),
    submitExecute: async (b: unknown) => {
      executed.push(b);
      return execute();
    },
  };
  return { r: r as never, executed };
}

const run = (r: never, over: { to?: string; amount?: string; allowRegistryOffer?: boolean } = {}) =>
  withdraw({
    to: over.to ?? t.receiver,
    amount: over.amount ?? t.amount,
    instrumentAdmin: t.instrumentAdmin,
    instrumentId: "CBTC",
    wallet: wallet(),
    relay: r,
    hashBinding: BOUND,
    ...(over.allowRegistryOffer === true ? { allowRegistryOffer: true } : {}),
  });

describe("plain registry withdraw that the relay prepared as an offer", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  // The fixture carries no transfer meta, so the venue tag a withdraw stamps by
  // default is turned off: the bytes then match the intent exactly.
  const at = () => {
    vi.stubEnv("CANTON_AGENT_VENUE_KEY", "off");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-27T10:53:24.000Z"));
  };

  it("an offer to the intended receiver and amount: names the missing preapproval, signs nothing", async () => {
    at();
    const { r, executed } = relay();
    const err = await run(r).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistryOfferRefusedError);
    expect(err).toBeInstanceOf(PreparedTransferMismatchError);
    const msg = (err as Error).message;
    expect(msg).toContain(`to ${t.receiver} as a pending offer`);
    expect(msg).toContain("without a CBTC TransferPreapproval");
    expect(msg).toContain("nothing was signed");
    expect(msg).toContain(`preapproval --admin ${t.instrumentAdmin} --id CBTC`);
    const cause = (err as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(PreparedTransferMismatchError);
    expect((cause as Error).message).toMatch(/unexpected exercise\(s\) "AllocationFactory_TransferInternal"/);
    expect(Object.keys(err as object)).not.toContain("cause");
    expect(executed).toHaveLength(0);
  });

  it("an offer to another receiver keeps the original refusal", async () => {
    at();
    const { r, executed } = relay();
    const err = await run(r, { to: "bob-victim::1220" + "aa".repeat(32) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreparedTransferMismatchError);
    expect(err).not.toBeInstanceOf(RegistryOfferRefusedError);
    expect((err as Error).message).toMatch(/unexpected exercise\(s\) "AllocationFactory_TransferInternal"/);
    expect(executed).toHaveLength(0);
  });

  it("an offer for another amount keeps the original refusal", async () => {
    at();
    const { r, executed } = relay();
    const err = await run(r, { amount: "0.0000150000" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreparedTransferMismatchError);
    expect(err).not.toBeInstanceOf(RegistryOfferRefusedError);
    expect(executed).toHaveLength(0);
  });

  it("errors after signing pass through as they are", async () => {
    at();
    const boom = new Error('execute failed after signing: "AllocationFactory_TransferInternal"');
    const { r, executed } = relay(async () => {
      throw boom;
    });
    // The swap path opts into the offer shape: verify passes, the wallet signs.
    await expect(run(r, { allowRegistryOffer: true })).rejects.toBe(boom);
    expect(executed).toHaveLength(1);
  });
});
