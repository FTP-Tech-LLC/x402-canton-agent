/**
 * reclaimExpiredOffers: the wallet takes back its own registry offers that the
 * receiver never took and can no longer take (executeBefore passed).
 *
 * Uses the REAL MainNet withdraw prepared bytes (a hosted wallet's eXAG and cETH
 * sells that Cantex left untaken, prepared only), so verify-before-sign runs
 * for real: the withdraw must be of exactly the listed offer, with the value
 * coming back to the agent.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { reclaimExpiredOffers } from "./tx.js";
import { RelayHttpError } from "./relay-client.js";
import { PreparedTransferMismatchError } from "./verify-prepared.js";

const RECOMPUTE = (b64: string): string => createHash("sha256").update(Buffer.from(b64, "base64")).digest("base64");
const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8").trim();
const EXAG_BYTES = fixture("mainnet-registry-withdraw-exag.b64");
const CETH_BYTES = fixture("mainnet-registry-withdraw-ceth.b64");

const PARTY = "agent::1220caaddc91c71d90c976750c28700c9739bdca5e047d95b0136e4325973902d9ed";
const EXAG = { admin: "ember-silver::1220ad9c097ae75192b4716854fa413aa8582c86a62b16714663cdab55e025cc79c4", id: "eXAG" };
const CETH = { admin: "rails-cethMain-1::12200350ba6e96e3b701c3048b5aa013a8c1c08833e8ebf54339cff581055c29003a", id: "cETH" };
const EXAG_OFFER =
  "00d7d056db9011460c223d07d68b68cad7d2eb77ae6737956c86feb726f6a8ab3dca121220e4f3874f47123a15bbe67bae259fc0edd0cd1a80dfac4f69c10c695397feec6a";
const CETH_OFFER =
  "001dc92a240d45e3b344bcab344a25cdf1431eeb834934abb21b3db1e246f0e660ca12122005a3011fcf0d1c86aef00c16ef59090d100ca8e250515cdb40f3d16ce1fe7063";
const NOW = Date.parse("2026-10-24T16:25:50Z"); // just after both captures
const PAST = "2026-10-24T15:41:23.741Z";
const FUTURE = "2026-10-24T16:40:00.000Z";
const PENDING = "TransferPendingReceiverAcceptance";

const WALLET = {
  party: PARTY,
  privateKeyPkcs8Pem: (await import("./keys.js")).generateAgentKey().privateKeyPkcs8Pem,
  publicKeyFingerprint: "f",
  network: "canton:mainnet",
  relayUrl: "http://r",
};
const BYTES: Record<string, string> = { [EXAG_OFFER]: EXAG_BYTES, [CETH_OFFER]: CETH_BYTES };

/** A relay listing `outgoing`, preparing the measured withdraw for each cid
 *  (or `prepared` for every cid), and refusing execute for cids in `failOn`. */
function relayWith(outgoing: Array<Record<string, unknown>> | Error, opts: { failOn?: string[]; prepared?: string } = {}) {
  const prepared: string[] = [];
  const executed: string[] = [];
  return {
    prepared,
    executed,
    resolveWithdrawCalls: [] as Array<Record<string, unknown>>,
    outgoing: async () => {
      if (outgoing instanceof Error) throw outgoing;
      return { party: PARTY, outgoing };
    },
    async resolveWithdraw(args: Record<string, unknown>) {
      this.resolveWithdrawCalls.push(args);
      return { choiceContextData: {}, disclosedContracts: [] };
    },
    submitPrepare: async (b: { commands: Array<{ ExerciseCommand: { contractId: string; choice: string } }> }) => {
      const ex = b.commands[0]!.ExerciseCommand;
      expect(ex.choice).toBe("TransferInstruction_Withdraw");
      prepared.push(ex.contractId);
      const bytes = opts.prepared ?? BYTES[ex.contractId]!;
      return { preparedTransaction: bytes, hash: RECOMPUTE(bytes) };
    },
    submitExecute: async () => {
      const cid = prepared[prepared.length - 1]!;
      if (opts.failOn?.includes(cid)) throw new Error(`participant refused ${cid}`);
      executed.push(cid);
      return { updateId: `upd-${cid.slice(0, 6)}` };
    },
  };
}
const run = (relay: unknown) =>
  reclaimExpiredOffers(relay as never, WALLET as never, { hashBinding: { recomputeHash: RECOMPUTE }, nowMs: NOW });

afterEach(() => vi.restoreAllMocks());

describe("reclaimExpiredOffers", () => {
  it("withdraws expired offers the receiver never took, and leaves one still in its window alone", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const relay = relayWith([
      { cid: EXAG_OFFER, amount: "0.1808893116", receiver: "cantex-swap::1220c", instrumentId: EXAG, executeBefore: PAST, status: PENDING },
      { cid: CETH_OFFER, amount: "0.0041874702", receiver: "cantex-swap::1220c", instrumentId: CETH, executeBefore: PAST, status: PENDING },
      { cid: "00live", amount: "1.0", receiver: "pool::1220p", instrumentId: EXAG, executeBefore: FUTURE, status: PENDING },
    ]);
    const r = await run(relay);
    expect(r.supported).toBe(true);
    expect(r.reclaimed.map((x) => [x.instrument, x.amount])).toEqual([
      ["eXAG", "0.1808893116"],
      ["cETH", "0.0041874702"],
    ]);
    expect(r.waiting).toEqual([{ cid: "00live", instrument: "eXAG", amount: "1.0", executeBefore: FUTURE }]);
    expect(relay.executed).toEqual([EXAG_OFFER, CETH_OFFER]);
    expect(relay.resolveWithdrawCalls).toEqual([
      { instructionCid: EXAG_OFFER, instrumentAdmin: EXAG.admin },
      { instructionCid: CETH_OFFER, instrumentAdmin: CETH.admin },
    ]);
  });

  it("an older relay without /outgoing (404) is not an error: nothing is done", async () => {
    const r = await run(relayWith(new RelayHttpError("relay GET /v1/wallet/x/outgoing -> 404", 404, undefined)));
    expect(r).toEqual({ supported: false, reclaimed: [], waiting: [], failed: [], skippedUntrusted: [] });
  });

  it("a VERIFY refusal stops the run: bytes for another offer are never signed", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const relay = relayWith(
      [
        { cid: CETH_OFFER, instrumentId: CETH, executeBefore: PAST, status: PENDING },
        { cid: EXAG_OFFER, instrumentId: EXAG, executeBefore: PAST, status: PENDING },
      ],
      { prepared: EXAG_BYTES }
    );
    await expect(run(relay)).rejects.toThrow(PreparedTransferMismatchError);
    expect(relay.executed).toEqual([]);
    expect(relay.prepared).toEqual([CETH_OFFER]); // never reached the second row
  });

  it("a ledger refusal after an honest sign is isolated to its row", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const relay = relayWith(
      [
        { cid: EXAG_OFFER, instrumentId: EXAG, executeBefore: PAST, status: PENDING },
        { cid: CETH_OFFER, instrumentId: CETH, executeBefore: PAST, status: PENDING },
      ],
      { failOn: [EXAG_OFFER] }
    );
    const r = await run(relay);
    expect(r.failed.map((f) => f.cid)).toEqual([EXAG_OFFER]);
    expect(r.reclaimed.map((x) => x.cid)).toEqual([CETH_OFFER]);
  });

  it("a relay that calls a live offer expired is caught by the SIGNED executeBefore — nothing is signed", async () => {
    // The signed eXAG offer expires 15:41:23; at 15:39 the relay's row lies.
    const early = Date.parse("2026-10-24T15:39:00Z");
    vi.spyOn(Date, "now").mockReturnValue(early);
    const relay = relayWith([{ cid: EXAG_OFFER, instrumentId: EXAG, executeBefore: "2026-10-24T15:00:00Z", status: PENDING }]);
    await expect(
      reclaimExpiredOffers(relay as never, WALLET as never, { hashBinding: { recomputeHash: RECOMPUTE }, nowMs: early })
    ).rejects.toThrow(/has not passed/);
    expect(relay.executed).toEqual([]);
  });

  it("an unreadable executeBefore is not expired: the offer waits", async () => {
    const relay = relayWith([{ cid: EXAG_OFFER, instrumentId: EXAG, executeBefore: "not a date", status: PENDING }]);
    const r = await run(relay);
    expect(r.reclaimed).toEqual([]);
    expect(r.waiting.map((x) => x.cid)).toEqual([EXAG_OFFER]);
    expect(relay.prepared).toEqual([]);
  });

  it("an offer of a registrar the wallet does not trust, or one not pending, is never prepared", async () => {
    const relay = relayWith([
      { cid: "00untrusted", instrumentId: { admin: "stranger::1220s", id: "TOK" }, executeBefore: PAST, status: PENDING },
      { cid: "00busy", instrumentId: EXAG, executeBefore: PAST, status: "TransferPendingInternalWorkflow" },
    ]);
    const r = await run(relay);
    expect(r.skippedUntrusted).toEqual([{ cid: "00untrusted", admin: "stranger::1220s" }]);
    expect(r.reclaimed).toEqual([]);
    expect(relay.prepared).toEqual([]);
  });
});
