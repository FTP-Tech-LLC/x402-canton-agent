/**
 * The pay and transfer paths refuse a tree that creates a contract the agent
 * signs without the instrument's issuer, and a Canton Coin root that is not
 * the DSO's own contract (review of PR #279). Real MainNet captures, edited the
 * way a relay with its own package could, through the functions that sign.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { payViaTransferFactory, transfer } from "./tx.js";
import { generateAgentKey } from "./keys.js";
import { resolveTrustedRegistryParties } from "./registry-parties.js";
import {
  assertPreparedTransferMatches,
  decodePrepared,
  extractTransfer,
  type HashBindingOptions,
} from "./verify-prepared.js";
import { buildPrepared, withChildCreate, withRootSignedBy } from "./_prepared-fixture.js";
import type { AgentWallet } from "./store.js";

const fx = (n: string): string => readFileSync(join(__dirname, "__fixtures__", n), "utf8").trim();
const RECOMPUTE = (b64: string): string =>
  createHash("sha256").update(Buffer.from(b64, "base64")).digest("base64");
const BOUND: HashBindingOptions = { recomputeHash: RECOMPUTE };
const DSO = "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";
const ATTACK = "Attack.Proxy:Proxy";

function rootOf(b64: string) {
  const d = decodePrepared(b64);
  const ex = d.exercises.find((e) => e.choiceId === "TransferFactory_Transfer")!;
  return { d, ex, t: extractTransfer(ex.chosenValue) };
}

function walletFor(party: string): AgentWallet {
  const k = generateAgentKey();
  return {
    network: "canton:mainnet",
    relayUrl: "http://relay",
    party,
    publicKeySpkiB64: k.publicKeySpkiB64,
    privateKeyPkcs8Pem: k.privateKeyPkcs8Pem,
    publicKeyFingerprint: "fp",
    createdAt: "t",
  };
}

/** A relay that answers every prepare with `prepared`. */
function relayReturning(prepared: string) {
  const executed: unknown[] = [];
  const relay = {
    payPrepare: async () => ({ preparedTransaction: prepared, txHash: RECOMPUTE(prepared) }),
    resolveTransferFactory: async () => ({
      factoryId: rootOf(prepared).ex.contractId,
      transferKind: "direct",
      transferFactoryTemplateId: "#x:TransferFactory",
      instrumentId: { admin: DSO, id: "Amulet" },
      choiceContextData: { values: {} },
      disclosedContracts: [],
    }),
    submitPrepare: async () => ({ preparedTransaction: prepared, hash: RECOMPUTE(prepared) }),
    submitExecute: async (b: unknown) => {
      executed.push(b);
      return { updateId: "u1" };
    },
  };
  return { relay: relay as never, executed };
}

afterEach(() => vi.useRealTimers());
function clockAt(b64: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Number(decodePrepared(b64).preparationTime! / 1000n) + 1000);
}

const CC = fx("mainnet-transfer-preapproval-0.1.21.b64");
const USDCX = fx("mainnet-usdcx-transfer-preapproval.b64");
const USDCX_ADMIN =
  "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef";

function payCc(prepared: string) {
  clockAt(CC);
  const { t } = rootOf(CC);
  return payViaTransferFactory(relayReturning(prepared).relay, walletFor(t.sender), {
    receiver: t.receiver,
    amount: t.amount,
    expectInstrumentAdmin: DSO,
    hashBinding: BOUND,
  });
}

describe("a create the agent signs without the issuer is never signed", () => {
  it("payViaTransferFactory refuses it beside the captured Canton Coin payment", async () => {
    const { t } = rootOf(CC);
    const attack = withChildCreate(CC, { template: ATTACK, signatories: [t.sender], stakeholders: [t.sender, t.receiver] });
    await expect(payCc(attack)).rejects.toThrow(/signed by the sender/);
  });

  it("payViaTransferFactory refuses it beside the captured USDCx payment", async () => {
    const { t } = rootOf(USDCX);
    const attack = withChildCreate(USDCX, { template: ATTACK, signatories: [t.sender], stakeholders: [t.sender, t.receiver] });
    clockAt(USDCX);
    await expect(
      payViaTransferFactory(relayReturning(attack).relay, walletFor(t.sender), {
        receiver: t.receiver,
        amount: t.amount,
        expectInstrumentId: "USDCx",
        expectInstrumentAdmin: USDCX_ADMIN,
        registryInstrument: true,
        trustedRegistryParties: resolveTrustedRegistryParties(USDCX_ADMIN, {}),
        hashBinding: BOUND,
      })
    ).rejects.toThrow(/signed by the sender/);
  });

  it("transfer() refuses it and executes nothing", async () => {
    const { t } = rootOf(CC);
    const attack = withChildCreate(CC, { template: ATTACK, signatories: [t.sender], stakeholders: [t.sender, t.receiver] });
    clockAt(CC);
    const { relay, executed } = relayReturning(attack);
    await expect(
      transfer(relay, walletFor(t.sender), {
        receiver: t.receiver,
        amount: t.amount,
        expectInstrumentAdmin: DSO,
        inputHoldingCids: t.inputHoldingCids,
        hashBinding: BOUND,
      })
    ).rejects.toThrow(/signed by the sender/);
    expect(executed).toHaveLength(0);
  });

  it("the captured payment, unedited, still signs", async () => {
    const r = await payCc(CC);
    expect(r.signatureB64.length).toBeGreaterThan(0);
  });
});

describe("the Canton Coin root pin, as the wallet applies it", () => {
  it("payViaTransferFactory refuses a Canton Coin root the merchant signed", async () => {
    const { t } = rootOf(CC);
    await expect(payCc(withRootSignedBy(CC, [t.receiver]))).rejects.toThrow(/not by the DSO alone/);
  });

  it("a registry token named Amulet is not Canton Coin: its root is not held to the DSO", () => {
    const REGISTRAR = "registrar::1220" + "aa".repeat(32);
    const SENDER = "agent::1220" + "bb".repeat(32);
    const RECEIVER = "merchant::1220" + "cc".repeat(32);
    const bytes = buildPrepared({
      sender: SENDER,
      receiver: RECEIVER,
      amount: "1.0000000000",
      admin: REGISTRAR,
      id: "Amulet",
      templateId: "Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval",
    });
    expect(() =>
      assertPreparedTransferMatches(bytes, {
        sender: SENDER,
        receiver: RECEIVER,
        amount: "1.0000000000",
        instrumentId: "Amulet",
        instrumentAdmin: REGISTRAR,
        dsoParty: DSO,
      })
    ).not.toThrow();
  });
});
