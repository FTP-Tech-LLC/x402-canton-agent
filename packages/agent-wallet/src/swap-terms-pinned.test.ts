/**
 * A swap's terms ride inside the transfer the wallet signs: Tradecraft reads
 * the slippage floor and Cantex the token to buy from `transfer.meta`, and
 * `transfer.executeBefore` decides how long a sent input can sit in an offer
 * nobody takes. The wallet writes both into the command it hands the relay.
 * Before this, verify-before-sign checked only sender, receiver, amount and
 * instrument, so a relay could prepare the same transfer with the floor
 * dropped, another buy token, or a deadline in 2100, and the wallet signed it
 * (audit 2026-11-07, B #3).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { executeSwap, CANTEX_CONNECT_PARTY, CANTEX_MEMO_KEY, type SwapTicket } from "./swap.js";
import { transfer } from "./tx.js";
import { generateAgentKey } from "./keys.js";
import { KNOWN_DSO_BY_NETWORK } from "./trusted-dso.js";
import { resolveTrustedRegistryParties } from "./registry-parties.js";
import { decodePrepared, extractTransfer, type HashBindingOptions } from "./verify-prepared.js";
import {
  exerciseNode,
  len,
  rootInputContract,
  str,
  vContractId,
  vList,
  vNumeric,
  vParty,
  vRecord,
  vText,
  vTextMap,
  vTimestamp,
} from "./_prepared-fixture.js";
import type { AgentWallet } from "./store.js";

const RECOMPUTE = (b64: string): string =>
  createHash("sha256").update(Buffer.from(b64, "base64")).digest("base64");
const BOUND: HashBindingOptions = { recomputeHash: RECOMPUTE };

const DSO = KNOWN_DSO_BY_NETWORK["canton:mainnet"]!;
const AGENT = "agent::1220" + "aa".repeat(32);
const POOL = "tc-swp_CC-USDCx::1220" + "bb".repeat(32);
const USDCX = {
  admin: "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef",
  id: "USDCx",
};

function wallet(): AgentWallet {
  const k = generateAgentKey();
  return {
    network: "canton:mainnet",
    relayUrl: "http://relay",
    party: AGENT,
    publicKeySpkiB64: k.publicKeySpkiB64,
    privateKeyPkcs8Pem: k.privateKeyPkcs8Pem,
    publicKeyFingerprint: "fp",
    createdAt: "t",
  };
}

/** What the relay changes in the transfer it prepares. */
interface Tamper {
  meta?: Record<string, string>;
  executeBefore?: string;
}

interface TransferCmd {
  contractId: string;
  choiceArgument: {
    expectedAdmin: string;
    transfer: {
      sender: string;
      receiver: string;
      amount: string;
      instrumentId: { admin: string; id: string };
      requestedAt: string;
      executeBefore: string;
      inputHoldingCids: string[];
      meta: { values: Record<string, string> };
    };
  };
}

/** The prepared tree for the command the wallet sent: the root alone, laid out
 *  as the MainNet captures are (all eight transfer fields, labelled). */
function preparedFrom(cmd: TransferCmd, t: Tamper): string {
  const tr = cmd.choiceArgument.transfer;
  const us = (iso: string) => Date.parse(iso) * 1000;
  const transferRecord = vRecord([
    { label: "sender", value: vParty(tr.sender) },
    { label: "receiver", value: vParty(tr.receiver) },
    { label: "amount", value: vNumeric(tr.amount) },
    {
      label: "instrumentId",
      value: vRecord([
        { label: "admin", value: vParty(tr.instrumentId.admin) },
        { label: "id", value: vText(tr.instrumentId.id) },
      ]),
    },
    { label: "requestedAt", value: vTimestamp(us(tr.requestedAt)) },
    { label: "executeBefore", value: vTimestamp(us(t.executeBefore ?? tr.executeBefore)) },
    { label: "inputHoldingCids", value: vList(tr.inputHoldingCids.map(vContractId)) },
    { label: "meta", value: vRecord([{ label: "values", value: vTextMap(t.meta ?? tr.meta.values) }]) },
  ]);
  const arg = vRecord([
    { label: "expectedAdmin", value: vParty(cmd.choiceArgument.expectedAdmin) },
    { label: "transfer", value: transferRecord },
    { label: "extraArgs", value: vRecord([{ label: "meta", value: vRecord([]) }]) },
  ]);
  const node = exerciseNode(
    "TransferFactory_Transfer",
    arg,
    cmd.contractId,
    "Splice.ExternalPartyAmuletRules:ExternalPartyAmuletRules"
  );
  const damlTx = Buffer.concat([str(1, "2.1"), str(2, "0"), len(3, node)]);
  const metadata = Buffer.concat([
    len(2, Buffer.concat([str(1, tr.sender), str(2, "cmd-1")])),
    str(3, "global-domain::1220" + "cc".repeat(32)),
    // The factory, the DSO's ExternalPartyAmuletRules, as every capture lists it.
    len(7, rootInputContract({ dso: cmd.choiceArgument.expectedAdmin, contractId: cmd.contractId })),
  ]);
  return Buffer.concat([len(1, damlTx), len(2, metadata)]).toString("base64");
}

function stubRelay(tamper: Tamper = {}) {
  const executed: unknown[] = [];
  const sent: TransferCmd[] = [];
  const relay = {
    balance: async () => ({
      party: AGENT,
      amulet: 1,
      cc: "100.0000000000",
      holdings: [{ cid: "00h1", amount: "100.0000000000" }],
    }),
    resolveTransferFactory: async () => ({
      factoryId: "00epar",
      transferKind: "offer",
      transferFactoryTemplateId:
        "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory",
      instrumentId: { admin: DSO, id: "Amulet" },
      choiceContextData: { values: {} },
      disclosedContracts: [],
    }),
    submitPrepare: async (b: { commands: Array<{ ExerciseCommand: TransferCmd }> }) => {
      const cmd = b.commands[0]!.ExerciseCommand;
      sent.push(cmd);
      const prepared = preparedFrom(cmd, tamper);
      return { preparedTransaction: prepared, hash: RECOMPUTE(prepared) };
    },
    submitExecute: async (b: unknown) => {
      executed.push(b);
      return { updateId: "u-swap" };
    },
    preapprovalStatus: async () => ({ hasPreapproval: false }),
  };
  return { relay: relay as never, executed, sent };
}

const TRADECRAFT: SwapTicket = {
  venue: "tradecraft",
  poolParty: POOL,
  minOutput: "4.9500000000",
  memoKey: CANTEX_MEMO_KEY,
  memoValue: "4.9500000000",
  quote: "5.0",
  inInstrument: null,
  outInstrument: USDCX,
};
const CANTEX: SwapTicket = {
  venue: "cantex",
  poolParty: CANTEX_CONNECT_PARTY,
  minOutput: "4.9500000000",
  memoKey: CANTEX_MEMO_KEY,
  memoValue: "USDCx",
  quote: "5.0",
  inInstrument: null,
  outInstrument: USDCX,
};

function swap(ticket: SwapTicket, tamper?: Tamper) {
  const s = stubRelay(tamper);
  const run = executeSwap({
    amount: "60",
    ticket,
    wallet: wallet(),
    relay: s.relay,
    hashBinding: BOUND,
    preapproveOutput: false,
    waitForOutput: false,
  });
  return { ...s, run };
}

describe("swap: the wallet signs the terms it asked for", () => {
  it("signs a Tradecraft send whose meta carries the floor it built", async () => {
    const s = swap(TRADECRAFT);
    await expect(s.run).resolves.toMatchObject({ sentUpdateId: "u-swap" });
    expect(s.sent[0]!.choiceArgument.transfer.meta.values).toEqual({ [CANTEX_MEMO_KEY]: "4.9500000000" });
  });

  it("signs a deadline the relay made shorter: that only costs liveness", async () => {
    const s = swap(TRADECRAFT, { executeBefore: new Date(Date.now() + 30_000).toISOString() });
    await expect(s.run).resolves.toMatchObject({ sentUpdateId: "u-swap" });
  });

  it.each([
    ["drops the Tradecraft floor", TRADECRAFT, { meta: {} }],
    ["sets the Tradecraft floor to 0", TRADECRAFT, { meta: { [CANTEX_MEMO_KEY]: "0" } }],
    ["changes the token Cantex buys", CANTEX, { meta: { [CANTEX_MEMO_KEY]: "CBTC" } }],
    ["adds a key of its own", CANTEX, { meta: { [CANTEX_MEMO_KEY]: "USDCx", ref: "partner-7" } }],
  ] as const)("refuses when the relay %s, and sends nothing", async (_what, ticket, tamper) => {
    const s = swap(ticket, tamper);
    await expect(s.run).rejects.toThrow(/meta/);
    expect(s.executed).toHaveLength(0);
  });

  it("refuses a deadline moved to 2100, which would keep the input locked", async () => {
    const s = swap(TRADECRAFT, { executeBefore: "2100-01-01T00:00:00.000Z" });
    await expect(s.run).rejects.toThrow(/executeBefore/);
    expect(s.executed).toHaveLength(0);
  });
});

describe("the deadline is read from real bytes", () => {
  afterEach(() => vi.useRealTimers());

  it("refuses the captured CBTC sell to a Tradecraft pool with executeBefore moved to 2100", async () => {
    const offer = readFileSync(join(__dirname, "__fixtures__", "mainnet-cbtc-registry-offer-to-pool.b64"), "utf8").trim();
    const root = decodePrepared(offer).exercises.find((e) => e.choiceId === "TransferFactory_Transfer")!;
    const t = extractTransfer(root.chosenValue);
    // The deadline sits in the root, the internal transfer and the offer.
    const buf = Buffer.from(offer, "base64");
    const from = Buffer.alloc(8);
    from.writeBigInt64LE(BigInt(t.executeBeforeMs!) * 1000n);
    const to = Buffer.alloc(8);
    to.writeBigInt64LE(BigInt(Date.parse("2100-01-01T00:00:00.000Z")) * 1000n);
    for (let i = buf.indexOf(from); i >= 0; i = buf.indexOf(from, i + 8)) to.copy(buf, i);
    const far = buf.toString("base64");
    expect(extractTransfer(decodePrepared(far).exercises.find((e) => e.choiceId === "TransferFactory_Transfer")!.chosenValue).executeBeforeMs).toBe(
      Date.parse("2100-01-01T00:00:00.000Z")
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-27T10:53:24.000Z"));
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
      submitPrepare: async () => ({ preparedTransaction: far, hash: RECOMPUTE(far) }),
      submitExecute: async (b: unknown) => {
        executed.push(b);
        return { updateId: "u1" };
      },
    } as never;
    const w = { ...wallet(), party: t.sender };
    await expect(
      transfer(relay, w, {
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
    ).rejects.toThrow(/executeBefore/);
    expect(executed).toHaveLength(0);
  });
});
