/**
 * claimAll must not let one bad pending instruction block the rest — but a
 * verify-before-sign refusal must still stop EVERYTHING, because that is
 * evidence about the relay, not about one row.
 *
 * Measured live: three EXPIRED USDCx offers sat ahead of one live one in
 * /pending (oldest first). claimAll threw on the first (deadline-exceeded) and
 * never reached the claimable one. Balance stayed 0.
 *
 * Uses the REAL MainNet registry-accept prepared bytes, so the verify step is
 * exercised for real — a stub that skipped it would not prove the rethrow.
 */
import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { claimAll } from "./tx.js";
import { PreparedTransferMismatchError } from "./verify-prepared.js";
import { KNOWN_DSO_BY_NETWORK } from "./trusted-dso.js";
const DSO = KNOWN_DSO_BY_NETWORK["canton:mainnet"]!;

function RECOMPUTE(b64: string): string {
  return createHash("sha256").update(Buffer.from(b64, "base64")).digest("base64");
}
const HONEST = readFileSync(
  new URL("./__fixtures__/mainnet-usdcx-registry-accept.b64", import.meta.url),
  "utf8"
).trim();
const PARTY = "agent::12207b62889735d6f02727e1cf0d889aca5ea05b8b05d6786ee5f60eb537c7eaa143";
const WALLET = {
  party: PARTY,
  // a real key is needed only to SIGN; the fixture is verified, not re-signed
  privateKeyPkcs8Pem: (await import("./keys.js")).generateAgentKey().privateKeyPkcs8Pem,
  publicKeyFingerprint: "f",
  network: "canton:mainnet",
  relayUrl: "http://r",
};
// Anchored to the MOCKED clock below, not the real one: the fixture's accept
// is only valid inside its own executeBefore window, so tests run at a fixed
// instant — and "expired" has to mean expired relative to THAT instant.
const USDCX_ADMIN =
  "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef";
/** What /pending names on a USDCx offer row — the registry claim the HONEST
 *  fixture is the accept of. */
const USDCX = { admin: USDCX_ADMIN, id: "USDCx" };
const NOW_IN_WINDOW = Date.parse("2026-08-23T13:03:00Z");
const PAST = new Date(NOW_IN_WINDOW - 60_000).toISOString();
const FUTURE = new Date(NOW_IN_WINDOW + 300_000).toISOString();

/** A relay whose submit/prepare returns the HONEST accept (so verify passes)
 *  and whose submit/execute fails for the cids in `failOn`. */
function relayWith(pending: Array<Record<string, unknown>>, failOn: string[] = [], prepared = HONEST) {
  const executed: string[] = [];
  return {
    executed,
    resolveAcceptCalls: [] as Array<Record<string, unknown>>,
    pending: async () => ({ party: PARTY, pending }),
    async resolveAccept(args: Record<string, unknown>) {
      this.resolveAcceptCalls.push(args);
      return { choiceContextData: {}, disclosedContracts: [] };
    },
    submitPrepare: async (b: { commands: Array<{ ExerciseCommand: { contractId: string } }> }) => {
      executed.push(b.commands[0]!.ExerciseCommand.contractId);
      return { preparedTransaction: prepared, hash: RECOMPUTE(prepared) };
    },
    submitExecute: async () => {
      const cid = executed[executed.length - 1]!;
      if (failOn.includes(cid)) throw new Error(`participant refused ${cid}`);
      return { updateId: `upd-${cid}` };
    },
  };
}

describe("claimAll — one bad instruction must not block the rest", () => {
  it("skips expired offers up front and still claims the live one behind them", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_IN_WINDOW);
    const relay = relayWith([
      { cid: "old1", executeBefore: PAST, instrumentId: USDCX },
      { cid: "old2", executeBefore: PAST, instrumentId: USDCX },
      { cid: "live", executeBefore: FUTURE, instrumentId: USDCX },
    ]);
    const r = await claimAll(relay as never, WALLET as never, { hashBinding: { recomputeHash: RECOMPUTE } });
    vi.restoreAllMocks();
    expect(r.skippedExpired).toBe(2);
    expect(relay.executed).toEqual(["live"]);
    expect(r.updateIds).toEqual(["upd-live"]);
    expect(r.claimed).toBe(1);
  });

  it("a ledger refusal AFTER an honest sign is isolated to its row", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_IN_WINDOW);
    const relay = relayWith([{ cid: "bad", executeBefore: FUTURE, instrumentId: USDCX }, { cid: "good", executeBefore: FUTURE, instrumentId: USDCX }], ["bad"]);
    const r = await claimAll(relay as never, WALLET as never, { hashBinding: { recomputeHash: RECOMPUTE } });
    vi.restoreAllMocks();
    expect(r.failed.map((f) => f.cid)).toEqual(["bad"]);
    expect(r.updateIds).toEqual(["upd-good"]);
    expect(r.claimed).toBe(1); // what LANDED, not pending.length
  });

  it("a VERIFY refusal is NOT isolated — it stops the whole claim", async () => {
    // The discriminator against over-correcting. A relay that hands back bytes
    // that are not our accept is a compromised relay; swallowing that into
    // `failed` and moving on would let it try again on the next row.
    vi.spyOn(Date, "now").mockReturnValue(NOW_IN_WINDOW);
    const tampered = Buffer.from("not-an-accept").toString("base64");
    const relay = relayWith([{ cid: "a", executeBefore: FUTURE, instrumentId: USDCX }, { cid: "b", executeBefore: FUTURE, instrumentId: USDCX }], [], tampered);
    await expect(
      claimAll(relay as never, WALLET as never, { hashBinding: { recomputeHash: RECOMPUTE } })
    ).rejects.toThrow();
    vi.restoreAllMocks();
    expect(relay.executed).toEqual(["a"]); // never reached "b"
  });

  it("a row with no executeBefore (older relay) is still attempted", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_IN_WINDOW);
    const relay = relayWith([{ cid: "amulet", instrumentId: USDCX }]);
    const r = await claimAll(relay as never, WALLET as never, { hashBinding: { recomputeHash: RECOMPUTE } });
    vi.restoreAllMocks();
    expect(r.skippedExpired).toBe(0);
    expect(r.updateIds).toEqual(["upd-amulet"]);
  });

  it("a Canton Coin row carries the DSO as its instrumentId, and is resolved WITHOUT a registry admin; a registry row WITH", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_IN_WINDOW);
    const relay = relayWith([
      { cid: "usdcx", executeBefore: FUTURE, instrumentId: USDCX },
      { cid: "cc", executeBefore: FUTURE, instrumentId: { admin: DSO, id: "Amulet" } },
    ]);
    // This stub hands back the REGISTRY fixture for every prepare. The USDCx
    // row declares its token and is claimed; the Canton Coin row declares none,
    // so the same bytes are a verify REFUSAL for it — and a verify refusal is
    // evidence about the relay, so claimAll stops there rather than isolating it.
    await expect(
      claimAll(relay as never, WALLET as never, { hashBinding: { recomputeHash: RECOMPUTE } })
    ).rejects.toThrow(/unexpected exercise\(s\) "TransferRule_TwoStepTransfer"/);
    vi.restoreAllMocks();
    expect(relay.resolveAcceptCalls).toEqual([
      { instructionCid: "usdcx", instrumentAdmin: USDCX_ADMIN },
      { instructionCid: "cc" },
    ]);
    expect(relay.executed).toEqual(["usdcx", "cc"]);
  });

  it("an offer of a token whose registrar this wallet has no trust anchor for is SKIPPED up front — it never reaches prepare, and the Canton Coin row behind it is still claimed", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_IN_WINDOW);
    const relay = relayWith([
      { cid: "eurx", executeBefore: FUTURE, instrumentId: { admin: "some-other-registrar::1220beef", id: "EURx" } },
      { cid: "usdcx", executeBefore: FUTURE, instrumentId: USDCX },
    ]);
    const r = await claimAll(relay as never, WALLET as never, { hashBinding: { recomputeHash: RECOMPUTE } });
    vi.restoreAllMocks();
    expect(r.skippedUntrusted).toEqual([{ cid: "eurx", admin: "some-other-registrar::1220beef" }]);
  });

  it("a registrar that names its token \"Amulet\" is still a registrar: the local DSO anchor decides what Canton Coin is", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_IN_WINDOW);
    const relay = relayWith([
      { cid: "fake-amulet", executeBefore: FUTURE, instrumentId: { admin: "attacker::1220bad", id: "Amulet" } },
      { cid: "usdcx", executeBefore: FUTURE, instrumentId: USDCX },
    ]);
    const r = await claimAll(relay as never, WALLET as never, { hashBinding: { recomputeHash: RECOMPUTE } });
    vi.restoreAllMocks();
    expect(r.skippedUntrusted).toEqual([{ cid: "fake-amulet", admin: "attacker::1220bad" }]);
    expect(relay.resolveAcceptCalls.map((c) => c["instructionCid"])).toEqual(["usdcx"]);
    expect(relay.resolveAcceptCalls.map((c) => c["instructionCid"])).toEqual(["usdcx"]);
    expect(relay.executed).toEqual(["usdcx"]);
    expect(r.claimed).toBe(1);
  });
});
