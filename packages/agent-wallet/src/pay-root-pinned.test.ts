/**
 * The pay and transfer paths pin WHICH template the root runs on and WHAT the
 * delivery consequence pays, not only the root's own argument (audit
 * 2026-10-23, high 4).
 *
 * `TransferFactory_Transfer` is an interface choice: its name says nothing
 * about the code that runs. Before this, a relay that put its own package on
 * the participant could root a payment on a template it wrote, keep sender,
 * receiver and amount honest in the root, and exercise the merchant's
 * preapproval for the whole balance underneath; the wallet signed it.
 *
 * Ground truth is the real MainNet captures in src/__fixtures__, returned by
 * a stub relay exactly as captured or edited in place (same byte length).
 * Each capture is an expired prepare, so the clock is set to its instant.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deliversViaAmuletPreapproval } from "@ftptech/x402-canton-core";
import { payViaTransferFactory, transfer } from "./tx.js";
import { generateAgentKey } from "./keys.js";
import { resolveTrustedRegistryParties } from "./registry-parties.js";
import {
  decodePrepared,
  extractTransfer,
  PreparedTransferMismatchError,
  type HashBindingOptions,
} from "./verify-prepared.js";
import type { AgentWallet } from "./store.js";

const FX = join(__dirname, "__fixtures__");
const fx = (n: string): string => readFileSync(join(FX, n), "utf8").trim();

/** A stand-in for the V2 hash: binding is exercised, not the hasher. */
const RECOMPUTE = (b64: string): string =>
  createHash("sha256").update(Buffer.from(b64, "base64")).digest("base64");
const BOUND: HashBindingOptions = { recomputeHash: RECOMPUTE };

/** Same-length replace of every occurrence. */
function replaceAll(b64: string, from: string, to: string): string {
  if (from.length !== to.length) throw new Error("patch must keep the length");
  const buf = Buffer.from(b64, "base64");
  let n = 0;
  for (let i = buf.indexOf(from); i >= 0; i = buf.indexOf(from, i + 1)) {
    buf.write(to, i, "latin1");
    n += 1;
  }
  if (n === 0) throw new Error(`${from} not found`);
  return buf.toString("base64");
}

/** Same-length replace of the first `from` after `anchor`. */
function patchAfter(b64: string, anchor: string, from: string, to: string): string {
  const buf = Buffer.from(b64, "base64");
  const i = buf.indexOf(from, buf.indexOf(anchor));
  if (buf.indexOf(anchor) < 0 || i < 0 || from.length !== to.length) throw new Error("bad patch");
  buf.write(to, i, "latin1");
  return buf.toString("base64");
}

function rootOf(b64: string) {
  const ex = decodePrepared(b64).exercises.find((e) => e.choiceId === "TransferFactory_Transfer")!;
  return { ex, t: extractTransfer(ex.chosenValue) };
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

/** A relay that answers every prepare with `prepared`, hash included. */
function relayReturning(prepared: string) {
  const executed: unknown[] = [];
  const relay = {
    payPrepare: async () => ({ preparedTransaction: prepared, txHash: RECOMPUTE(prepared) }),
    resolveTransferFactory: async (b: { instrumentId?: { admin: string; id: string } }) => ({
      factoryId: rootOf(prepared).ex.contractId,
      transferKind: "direct",
      transferFactoryTemplateId:
        "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory",
      instrumentId: b.instrumentId ?? { admin: rootOf(prepared).t.instrumentAdmin, id: "Amulet" },
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
const at = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};

const DSO = "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";

/** The Canton Coin captures: one-step through the receiver's preapproval. */
const CC_CASES = [
  {
    name: "mainnet-transfer-preapproval-0.1.21.b64",
    receiver: "Cantex::122090c527c437b93a66a7aa6d44fb641ff7a8386ef95430aed57e59e8e1bba45f53",
    amount: "0.0100000000",
    now: "2026-08-02T09:52:10.000Z",
  },
  {
    name: "mainnet-preapproval-distinct-provider.b64",
    receiver: "Cantex::122090c527c437b93a66a7aa6d44fb641ff7a8386ef95430aed57e59e8e1bba45f53",
    amount: "0.0001000000",
    now: "2026-07-28T12:27:40.000Z",
  },
  {
    name: "mainnet-preapproval-self-provider.b64",
    receiver: "caf5e4e35cfd1669::12209e866b13a9428411eb9db7448726ec31cf0bcf027d0d642a0c38653ba72515a5",
    amount: "0.0001000000",
    now: "2026-07-28T12:27:47.000Z",
  },
] as const;

function payCc(c: (typeof CC_CASES)[number], prepared: string) {
  at(c.now);
  const { relay } = relayReturning(prepared);
  return payViaTransferFactory(relay, walletFor(rootOf(fx(c.name)).t.sender), {
    receiver: c.receiver,
    amount: c.amount,
    expectInstrumentAdmin: DSO,
    hashBinding: BOUND,
  });
}

const USDCX_ADMIN =
  "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef";
const USDCX = fx("mainnet-usdcx-transfer-preapproval.b64");

function payUsdcx(prepared: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1787383310000);
  const { relay } = relayReturning(prepared);
  return payViaTransferFactory(relay, walletFor(rootOf(USDCX).t.sender), {
    receiver: rootOf(USDCX).t.receiver,
    amount: "0.0010000000",
    expectInstrumentId: "USDCx",
    expectInstrumentAdmin: USDCX_ADMIN,
    registryInstrument: true,
    trustedRegistryParties: resolveTrustedRegistryParties(USDCX_ADMIN, {}),
    hashBinding: BOUND,
  });
}

describe("payViaTransferFactory: the captured payments still sign", () => {
  it.each(CC_CASES)("Canton Coin $name", async (c) => {
    const r = await payCc(c, fx(c.name));
    expect(r.signatureB64.length).toBeGreaterThan(0);
  });

  it("USDCx through the receiver's registry preapproval", async () => {
    const r = await payUsdcx(USDCX);
    expect(r.signatureB64.length).toBeGreaterThan(0);
  });
});

describe("payViaTransferFactory: what a relay with its own package could hand back", () => {
  it.each(CC_CASES)("refuses a SendV2 that delivers more than the root names ($name)", async (c) => {
    const more = `9${c.amount.slice(1)}`;
    const inflated = patchAfter(fx(c.name), "TransferPreapproval_SendV2", c.amount, more);
    // The edit hit the delivery only: the root still names the 402's amount.
    expect(rootOf(inflated).t.amount).toBe(c.amount);
    expect(deliversViaAmuletPreapproval(decodePrepared(inflated), c.receiver, DSO, more)).toBe(true);
    await expect(payCc(c, inflated)).rejects.toThrow(PreparedTransferMismatchError);
  });

  it("refuses a Canton Coin root on a template that is not the DSO's ExternalPartyAmuletRules", async () => {
    const c = CC_CASES[0];
    const foreign = replaceAll(fx(c.name), "Splice.ExternalPartyAmuletRules", "Attack.ExternalPartyAmuletRules");
    expect(rootOf(foreign).ex.templateQualifiedName).toBe(
      "Attack.ExternalPartyAmuletRules:ExternalPartyAmuletRules"
    );
    await expect(payCc(c, foreign)).rejects.toThrow(/template/);
  });

  it("refuses a registry root on a template that is not the registry's", async () => {
    const foreign = replaceAll(
      USDCX,
      "Utility.Registry.App.V0.Model.TransferPreapproval",
      "Utility.Registry.App.V0.Model.TransferPreapprovaX"
    );
    await expect(payUsdcx(foreign)).rejects.toThrow(/template/);
  });

  it("refuses a TransferRule_DirectTransfer that moves more than the root names", async () => {
    const inflated = patchAfter(USDCX, "TransferRule_DirectTransfer", "0.0010000000", "9.0010000000");
    expect(rootOf(inflated).t.amount).toBe("0.0010000000");
    await expect(payUsdcx(inflated)).rejects.toThrow(/delivers/);
  });
});

describe("transfer(): withdraw and the swap send hold the same pins", () => {
  const c = CC_CASES[0];
  const send = async (prepared: string) => {
    at(c.now);
    const { relay, executed } = relayReturning(prepared);
    const t = rootOf(fx(c.name)).t;
    const run = transfer(relay, walletFor(t.sender), {
      receiver: c.receiver,
      amount: c.amount,
      expectInstrumentAdmin: DSO,
      inputHoldingCids: t.inputHoldingCids,
      hashBinding: BOUND,
    });
    return { run, executed };
  };

  it("executes the captured transfer", async () => {
    const { run, executed } = await send(fx(c.name));
    await expect(run).resolves.toBe("u1");
    expect(executed).toHaveLength(1);
  });

  it("refuses an inflated SendV2 and executes nothing", async () => {
    const { run, executed } = await send(
      patchAfter(fx(c.name), "TransferPreapproval_SendV2", c.amount, "9.9900000000")
    );
    await expect(run).rejects.toThrow(/preapproval delivery/);
    expect(executed).toHaveLength(0);
  });

  it("refuses a root on a foreign template and executes nothing", async () => {
    const { run, executed } = await send(
      replaceAll(fx(c.name), "Splice.ExternalPartyAmuletRules", "Attack.ExternalPartyAmuletRules")
    );
    await expect(run).rejects.toThrow(/template/);
    expect(executed).toHaveLength(0);
  });

  it("executes the captured CBTC offer to a Tradecraft pool (AllocationFactory root)", async () => {
    const offer = fx("mainnet-cbtc-registry-offer-to-pool.b64");
    const t = rootOf(offer).t;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-27T10:53:24.000Z"));
    const { relay, executed } = relayReturning(offer);
    await expect(
      transfer(relay, walletFor(t.sender), {
        receiver: t.receiver,
        amount: t.amount,
        expectInstrumentId: "CBTC",
        expectInstrumentAdmin: t.instrumentAdmin,
        registryInstrument: true,
        inputHoldingCids: t.inputHoldingCids,
        trustedRegistryParties: resolveTrustedRegistryParties(t.instrumentAdmin, {}),
        allowRegistryOffer: true,
        hashBinding: BOUND,
      })
    ).resolves.toBe("u1");
    expect(executed).toHaveLength(1);
  });
});
