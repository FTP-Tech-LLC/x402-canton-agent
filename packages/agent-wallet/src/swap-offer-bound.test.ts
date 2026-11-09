// The offer shape a swap to a pool signs (allowRegistryOffer): one pending
// TransferOffer the pool accepts later. The root names the swap's terms; the
// offer must carry exactly them. Each test edits the real MainNet CBTC offer
// bytes INSIDE the TransferOffer only, so every root pin still matches, and the
// wallet must refuse before signing.
import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PreparedTransaction } from "@canton-network/core-ledger-proto";
import { transfer, RegistryOfferRefusedError } from "./tx.js";
import { generateAgentKey } from "./keys.js";
import { resolveTrustedRegistryParties } from "./registry-parties.js";
import { decodePrepared, extractTransfer, type HashBindingOptions } from "./verify-prepared.js";
import type { AgentWallet } from "./store.js";

const here = dirname(fileURLToPath(import.meta.url));
const RECOMPUTE = (b64: string): string => createHash("sha256").update(Buffer.from(b64, "base64")).digest("base64");
const BOUND: HashBindingOptions = { recomputeHash: RECOMPUTE };
const offer = readFileSync(join(here, "__fixtures__", "mainnet-cbtc-registry-offer-to-pool.b64"), "utf8").trim();
const root = decodePrepared(offer).exercises.find((e) => e.choiceId === "TransferFactory_Transfer")!;
const t = extractTransfer(root.chosenValue);

type Field = { label: string; value: { sum: Record<string, unknown> & { oneofKind: string } } };

/** Re-encode the fixture with `edit` applied to the TransferOffer's `transfer`
 *  record only (exactly one such create must exist). */
function tamperOffer(edit: (fields: Field[]) => void): string {
  const pt = PreparedTransaction.fromBinary(Buffer.from(offer, "base64"));
  let hits = 0;
  for (const n of pt.transaction!.nodes) {
    const vn = n.versionedNode as unknown as Record<string, { nodeType: { oneofKind: string; create?: unknown } }>;
    const v1 = vn[(n.versionedNode as { oneofKind: string }).oneofKind]!;
    if (v1.nodeType.oneofKind !== "create") continue;
    const c = v1.nodeType.create as {
      templateId?: { entityName: string };
      argument: { sum: { oneofKind: string; record: { fields: Field[] } } };
    };
    if (c.templateId?.entityName !== "TransferOffer") continue;
    const tr = c.argument.sum.record.fields.find((f) => f.label === "transfer")!;
    edit((tr.value.sum as unknown as { record: { fields: Field[] } }).record.fields);
    hits++;
  }
  if (hits !== 1) throw new Error(`expected one TransferOffer create, found ${hits}`);
  return Buffer.from(PreparedTransaction.toBinary(pt)).toString("base64");
}
const field = (fields: Field[], label: string): Field => fields.find((f) => f.label === label)!;

/** Rename the internal-transfer exercise (the relay writes that label too) and,
 *  optionally, edit the offer in the same bytes. */
function relabelInternal(to: string, b64 = offer): string {
  const pt = PreparedTransaction.fromBinary(Buffer.from(b64, "base64"));
  let hits = 0;
  for (const n of pt.transaction!.nodes) {
    const vn = n.versionedNode as unknown as Record<string, { nodeType: { oneofKind: string; exercise?: { choiceId: string } } }>;
    const v1 = vn[(n.versionedNode as { oneofKind: string }).oneofKind]!;
    if (v1.nodeType.oneofKind !== "exercise") continue;
    if (v1.nodeType.exercise!.choiceId !== "AllocationFactory_TransferInternal") continue;
    v1.nodeType.exercise!.choiceId = to;
    hits++;
  }
  if (hits !== 1) throw new Error(`expected one internal transfer, found ${hits}`);
  return Buffer.from(PreparedTransaction.toBinary(pt)).toString("base64");
}

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

async function swapSign(bytes: string, optIn = true): Promise<{ result: unknown; executed: number }> {
  const executed: unknown[] = [];
  const relay = {
    resolveTransferFactory: async () => ({
      factoryId: root.contractId,
      transferKind: "offer",
      transferFactoryTemplateId: "#x:TransferFactory",
      instrumentId: { admin: t.instrumentAdmin, id: "CBTC" },
      choiceContextData: { values: {} },
      disclosedContracts: [],
    }),
    submitPrepare: async () => ({ preparedTransaction: bytes, hash: RECOMPUTE(bytes) }),
    submitExecute: async (b: unknown) => {
      executed.push(b);
      return { updateId: "u1" };
    },
  } as never;
  const result = await transfer(relay, wallet(), {
    receiver: t.receiver,
    amount: t.amount,
    expectInstrumentId: "CBTC",
    expectInstrumentAdmin: t.instrumentAdmin,
    registryInstrument: true,
    inputHoldingCids: t.inputHoldingCids,
    trustedRegistryParties: resolveTrustedRegistryParties(t.instrumentAdmin, {}),
    ...(optIn ? { allowRegistryOffer: true } : {}),
    hashBinding: BOUND,
  }).catch((e: unknown) => e);
  return { result, executed: executed.length };
}

describe("swap offer shape: the pending offer carries the root's terms", () => {
  afterEach(() => vi.useRealTimers());
  const at = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-27T10:53:24.000Z"));
  };
  const refused = /pending offer does not carry the root's sender, receiver, amount, instrument, deadline and meta/;

  it("the untouched MainNet offer is signed", async () => {
    at();
    const { result, executed } = await swapSign(offer);
    expect(result).toBe("u1");
    expect(executed).toBe(1);
  });

  it("the re-encoded but unchanged offer is signed (the tamper helper changes nothing by itself)", async () => {
    at();
    const { result, executed } = await swapSign(tamperOffer(() => {}));
    expect(result).toBe("u1");
    expect(executed).toBe(1);
  });

  it("another receiver inside the offer is refused", async () => {
    at();
    const ns = t.instrumentAdmin.split("::")[1]!;
    const bytes = tamperOffer((f) => {
      (field(f, "receiver").value.sum as { party: string }).party = `xxxxxxxxxxxxxx::${ns}`;
    });
    const { result, executed } = await swapSign(bytes);
    expect(String((result as Error).message)).toMatch(refused);
    expect(executed).toBe(0);
  });

  it("another amount inside the offer is refused", async () => {
    at();
    const bytes = tamperOffer((f) => {
      (field(f, "amount").value.sum as { numeric: string }).numeric = "0.0000900000";
    });
    const { result, executed } = await swapSign(bytes);
    expect(String((result as Error).message)).toMatch(refused);
    expect(executed).toBe(0);
  });

  it("another deadline inside the offer is refused", async () => {
    at();
    const bytes = tamperOffer((f) => {
      const ts = field(f, "executeBefore").value.sum as { timestamp: bigint | string };
      ts.timestamp = typeof ts.timestamp === "bigint" ? 4102444800000000n : "4102444800000000";
    });
    const { result, executed } = await swapSign(bytes);
    expect(String((result as Error).message)).toMatch(refused);
    expect(executed).toBe(0);
  });

  it("a relabeled internal transfer does not switch the offer check off (swap)", async () => {
    at();
    const ns = t.instrumentAdmin.split("::")[1]!;
    const edited = tamperOffer((f) => {
      (field(f, "receiver").value.sum as { party: string }).party = `xxxxxxxxxxxxxx::${ns}`;
    });
    const { result, executed } = await swapSign(relabelInternal("Archive", edited));
    expect(String((result as Error).message)).toMatch(refused);
    expect(executed).toBe(0);
  });

  it("a relabeled internal transfer does not let a plain transfer sign an offer", async () => {
    at();
    const { result, executed } = await swapSign(relabelInternal("Archive"), false);
    // The offer itself carries the root's terms, so the plain transfer explains
    // the offer shape (RegistryOfferRefusedError); the strict refusal is its cause.
    expect(result).toBeInstanceOf(RegistryOfferRefusedError);
    expect(String(((result as { cause?: Error }).cause as Error).message)).toMatch(
      /creates a pending .*TransferOffer although it did not opt into the offer shape/
    );
    expect(executed).toBe(0);
  });

  it("a relabeled internal transfer with an edited offer keeps the strict refusal on a plain transfer", async () => {
    at();
    const ns = t.instrumentAdmin.split("::")[1]!;
    const edited = tamperOffer((f) => {
      (field(f, "receiver").value.sum as { party: string }).party = `xxxxxxxxxxxxxx::${ns}`;
    });
    const { result, executed } = await swapSign(relabelInternal("Archive", edited), false);
    expect(result).not.toBeInstanceOf(RegistryOfferRefusedError);
    expect(String((result as Error).message)).toMatch(/creates a pending .*TransferOffer although it did not opt into the offer shape/);
    expect(executed).toBe(0);
  });

  it("meta added inside the offer is refused", async () => {
    at();
    const bytes = tamperOffer((f) => {
      const meta = field(f, "meta").value.sum as unknown as { record: { fields: Field[] } };
      const values = meta.record.fields.find((x) => x.label === "values")!;
      const tm = values.value.sum as unknown as { textMap: { entries: unknown[] } };
      tm.textMap.entries.push({ key: "x", value: { sum: { oneofKind: "text", text: "y" } } });
    });
    const { result, executed } = await swapSign(bytes);
    expect(String((result as Error).message)).toMatch(refused);
    expect(executed).toBe(0);
  });
});
