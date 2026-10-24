import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withdraw } from "./withdraw.js";
import { saveWallet } from "./store.js";
import { generateAgentKey } from "./keys.js";
import { KNOWN_INSTRUMENTS } from "./registry-parties.js";

const CBTC = KNOWN_INSTRUMENTS.CBTC!;
const USDCx = KNOWN_INSTRUMENTS.USDCx!;
// Faithful honest prepared-tx so verify-before-sign passes (real field numbers).
import { buildHonest } from "./_prepared-fixture.js";

function prepared(sender: string, receiver: string, amount: string, contractId: string): string {
  return buildHonest({ sender, receiver, amount }, { contractId });
}
/** Deterministic stand-in for Canton's V2 hash (see verify-prepared.ts). */
function RECOMPUTE(b64: string): string {
  return createHash("sha256").update(Buffer.from(b64, "base64")).digest("base64");
}
const BOUND = { recomputeHash: RECOMPUTE };

let tmp: string;
const PARTY = "agent::1220abcd";
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "caw-wd-"));
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

function stub(receiver: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body?: string } = {}) => {
      if (url.endsWith("/balance"))
        return new Response(JSON.stringify({ party: PARTY, amulet: 1, cc: "7.5000000000", holdings: [{ cid: "h1", amount: "7.5" }] }), { status: 200 });
      if (url.endsWith("/resolve/transfer-factory"))
        return new Response(JSON.stringify({ factoryId: "f", transferKind: "k", transferFactoryTemplateId: "#p:M:F", instrumentId: { admin: "DSO::1220cafe", id: "Amulet" }, choiceContextData: {}, disclosedContracts: [] }), { status: 200 });
      if (url.endsWith("/submit/prepare")) {
        const b = JSON.parse(init.body ?? "{}");
        const cmd = b.commands[0].ExerciseCommand;
        const ex = cmd.choiceArgument.transfer;
        const pt = prepared(ex.sender, ex.receiver, ex.amount, cmd.contractId);
        // Honest relay: hash OF the prepared bytes so the binding accepts it.
        return new Response(JSON.stringify({ preparedTransaction: pt, hash: RECOMPUTE(pt) }), { status: 200 });
      }
      if (url.endsWith("/submit/execute"))
        return new Response(JSON.stringify({ updateId: "u-withdraw" }), { status: 200 });
      return new Response("nf", { status: 404 });
    })
  );
}

describe("withdraw", () => {
  it("defaults to the full balance when no amount is given", async () => {
    stub("human::1220face");
    const r = await withdraw({ to: "human::1220face", hashBinding: BOUND });
    expect(r.amount).toBe("7.5000000000"); // == balance.cc
    expect(r.updateId).toBe("u-withdraw");
  });

  it("uses the explicit amount for a partial withdrawal", async () => {
    stub("human::1220face");
    const r = await withdraw({ to: "human::1220face", amount: "2.0000000000", hashBinding: BOUND });
    expect(r.amount).toBe("2.0000000000");
    expect(r.updateId).toBe("u-withdraw");
  });

  it("throws a clear error when no wallet exists yet", async () => {
    rmSync(tmp, { recursive: true, force: true }); // remove the seeded wallet
    await expect(withdraw({ to: "human::1220face" })).rejects.toThrow(/no wallet/);
  });

  it("rejects an over-balance amount with a clear insufficient-funds error (not a relay 502)", async () => {
    stub("human::1220face"); // balance is 7.5 CC
    await expect(
      withdraw({ to: "human::1220face", amount: "99", hashBinding: BOUND })
    ).rejects.toThrow(/insufficient funds/);
  });

  it("rejects a non-positive amount", async () => {
    stub("human::1220face");
    await expect(
      withdraw({ to: "human::1220face", amount: "0", hashBinding: BOUND })
    ).rejects.toThrow(/positive/);
  });

  it("accepts a short-form amount within balance", async () => {
    stub("human::1220face");
    const r = await withdraw({ to: "human::1220face", amount: "2", hashBinding: BOUND });
    expect(r.updateId).toBe("u-withdraw");
  });
});

describe("withdraw of a registry token reads HoldingV1, not /balance", () => {
  // /balance only counts Amulet. A USDCx withdraw that consulted it would either
  // refuse ("insufficient funds: 0 CC") or, worse, hand the registry factory
  // Canton Coin contract ids. The registry path must go through /holdings and
  // offer only UNLOCKED holdings as inputs.
  const USDCX = "usdcx-admin::1220";
  const wallet = { party: "agent::1220a", privateKeyPkcs8Pem: "x", publicKeyFingerprint: "f", network: "canton:mainnet", relayUrl: "http://r" };

  it("sizes the withdraw from unlocked holdings and passes their cids as inputs", async () => {
    let seen: Record<string, unknown> | undefined;
    const relay = {
      balance: async () => { throw new Error("/balance must NOT be consulted for a registry withdraw"); },
      holdings: async () => ({
        party: wallet.party,
        instruments: [{ admin: USDCX, id: "USDCx", total: "1.0500000000", holdings: [
          { cid: "u1", amount: "0.0300000000", locked: false },
          { cid: "u2", amount: "0.0200000000", locked: false },
          { cid: "uL", amount: "1.0000000000", locked: true },
        ]}],
        complete: true,
      }),
    };
    const tx = await import("./tx.js");
    const spy = vi.spyOn(tx, "transfer").mockImplementation(async (_r, _w, o) => { seen = o as never; return "upd-1"; });
    const r = await withdraw({ to: "merchant::1220m", instrumentAdmin: USDCX, instrumentId: "USDCx", relay: relay as never, wallet: wallet as never, hashBinding: {} });
    spy.mockRestore();
    // Full balance = the UNLOCKED total only; the locked 1.0 is not spendable.
    expect(r.amount).toBe("0.0500000000");
    expect(seen).toMatchObject({ registryInstrument: true, expectInstrumentId: "USDCx", expectInstrumentAdmin: USDCX });
    expect(seen!.inputHoldingCids).toEqual(["u1", "u2"]);
  });

  it("refuses half an instrument, and refuses 'Amulet' as a registry id", async () => {
    await expect(withdraw({ to: "m::1", instrumentId: "USDCx", wallet: wallet as never, relay: {} as never, hashBinding: {} }))
      .rejects.toThrow(/needs instrumentAdmin/);
    await expect(withdraw({ to: "m::1", instrumentAdmin: "DSO::1", instrumentId: "Amulet", wallet: wallet as never, relay: {} as never, hashBinding: {} }))
      .rejects.toThrow(/omit instrumentId/);
  });

  it("Canton Coin withdraw is untouched — still /balance, no registry flags", async () => {
    let seen: Record<string, unknown> | undefined;
    const relay = {
      balance: async () => ({ party: wallet.party, amulet: 1, cc: "0.5000000000", holdings: [{ cid: "c1", amount: "0.5000000000" }] }),
      holdings: async () => { throw new Error("/holdings must NOT be needed for a CC withdraw"); },
    };
    const tx = await import("./tx.js");
    const spy = vi.spyOn(tx, "transfer").mockImplementation(async (_r, _w, o) => { seen = o as never; return "upd-2"; });
    const r = await withdraw({ to: "merchant::1220m", relay: relay as never, wallet: wallet as never, hashBinding: {}, instrumentAdmin: "DSO::1220d" });
    spy.mockRestore();
    expect(r.amount).toBe("0.5000000000");
    expect(seen!.registryInstrument).toBeUndefined();
  });
});

describe("withdraw stamps the venue attribution tag on any registry token, never on CC", () => {
  const wallet = { party: "agent::1220a", privateKeyPkcs8Pem: "x", publicKeyFingerprint: "f", network: "canton:mainnet", relayUrl: "http://r" };
  const registryRelay = (admin: string, id: string) => ({
    balance: async () => { throw new Error("/balance must NOT be consulted for a registry withdraw"); },
    holdings: async () => ({ party: wallet.party, instruments: [{ admin, id, total: "1.0000000000", holdings: [{ cid: "h1", amount: "1.0000000000", locked: false }] }], complete: true }),
  });
  const ccRelay = () => ({
    balance: async () => ({ party: wallet.party, amulet: 1, cc: "1.0000000000", holdings: [{ cid: "c1", amount: "1.0000000000" }] }),
    holdings: async () => { throw new Error("/holdings must NOT be needed for a CC withdraw"); },
  });

  const setEnv = () => { process.env.CANTON_AGENT_VENUE_KEY = "ftp/venue"; process.env.CANTON_AGENT_VENUE_TAG = "ftp/agentic-wallet"; };
  afterEach(() => { delete process.env.CANTON_AGENT_VENUE_KEY; delete process.env.CANTON_AGENT_VENUE_TAG; });

  async function capture(relay: unknown, opts: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    let seen: Record<string, unknown> | undefined;
    const tx = await import("./tx.js");
    const spy = vi.spyOn(tx, "transfer").mockImplementation(async (_r, _w, o) => { seen = o as never; return "u"; });
    await withdraw({ relay: relay as never, wallet: wallet as never, hashBinding: {}, ...opts } as never);
    spy.mockRestore();
    return seen;
  }

  it("stamps ftp/venue on a CBTC withdraw when both env vars are set", async () => {
    setEnv();
    const seen = await capture(registryRelay(CBTC.admin, "CBTC"), { to: "m::1220m", instrumentAdmin: CBTC.admin, instrumentId: "CBTC" });
    expect((seen!.meta as Record<string, string>)?.["ftp/venue"]).toBe("ftp/agentic-wallet");
  });

  it("stamps ftp/venue on ANOTHER registry token (USDCx) too — generic, no allowlist", async () => {
    setEnv();
    const seen = await capture(registryRelay(USDCx.admin, "USDCx"), { to: "m::1220m", instrumentAdmin: USDCx.admin, instrumentId: "USDCx" });
    expect((seen!.meta as Record<string, string>)?.["ftp/venue"]).toBe("ftp/agentic-wallet");
  });

  it("stamps the default ftp/venue on a CBTC withdraw when the env is unset", async () => {
    delete process.env.CANTON_AGENT_VENUE_KEY;
    delete process.env.CANTON_AGENT_VENUE_TAG;
    const seen = await capture(registryRelay(CBTC.admin, "CBTC"), { to: "m::1220m", instrumentAdmin: CBTC.admin, instrumentId: "CBTC" });
    expect(seen!.meta).toEqual({ "ftp/venue": "ftp/agentic-wallet" });
  });

  it("stamps NOTHING on a CBTC withdraw when CANTON_AGENT_VENUE_KEY=off", async () => {
    process.env.CANTON_AGENT_VENUE_KEY = "off";
    const seen = await capture(registryRelay(CBTC.admin, "CBTC"), { to: "m::1220m", instrumentAdmin: CBTC.admin, instrumentId: "CBTC" });
    expect(seen!.meta).toBeUndefined();
  });

  it("does NOT stamp a Canton Coin withdraw with the env unset (default never reaches CC)", async () => {
    delete process.env.CANTON_AGENT_VENUE_KEY;
    delete process.env.CANTON_AGENT_VENUE_TAG;
    const seen = await capture(ccRelay(), { to: "m::1220m", instrumentAdmin: "DSO::1220d" });
    expect(seen!.meta).toBeUndefined();
  });

  it("does NOT stamp a Canton Coin withdraw with the env set", async () => {
    setEnv();
    const seen = await capture(ccRelay(), { to: "m::1220m", instrumentAdmin: "DSO::1220d" });
    expect(seen!.meta).toBeUndefined();
  });

  it("keeps a caller-supplied memo alongside the venue tag on a registry withdraw", async () => {
    setEnv();
    const seen = await capture(registryRelay(CBTC.admin, "CBTC"), { to: "m::1220m", instrumentAdmin: CBTC.admin, instrumentId: "CBTC", meta: { "tc.min": "1.23" } });
    expect(seen!.meta).toMatchObject({ "ftp/venue": "ftp/agentic-wallet", "tc.min": "1.23" });
  });
});

describe("withdraw reports whether the funds LANDED or await the receiver's claim", () => {
  // A transfer to a receiver with no TransferPreapproval settles as a pending
  // offer: on-ledger, but not spendable by them until they `claim`. Reporting
  // that identically to a direct settle told a sender "withdrew N to <party>"
  // for money the party did not have — the case that made a top-up look done
  // while the recipient still saw its old balance.
  const wallet = { party: "agent::1220a", privateKeyPkcs8Pem: "x", publicKeyFingerprint: "f", network: "canton:mainnet", relayUrl: "http://r" };
  const relayWith = (status: unknown) => ({
    balance: async () => ({ party: wallet.party, amulet: 1, cc: "5.0000000000", holdings: [{ cid: "c1", amount: "5.0000000000" }] }),
    holdings: async () => { throw new Error("/holdings must NOT be needed for a CC withdraw"); },
    preapprovalStatus: async () => {
      if (status instanceof Error) throw status;
      return status;
    },
  });

  async function run(relay: unknown): Promise<boolean | null> {
    const tx = await import("./tx.js");
    const spy = vi.spyOn(tx, "transfer").mockResolvedValue("u1" as never);
    const r = await withdraw({
      relay: relay as never,
      wallet: wallet as never,
      hashBinding: {},
      to: "m::1220m",
      amount: "1",
      instrumentAdmin: "DSO::1220d",
    } as never);
    spy.mockRestore();
    return r.landed;
  }

  it("landed=true when the receiver holds a preapproval (direct settle)", async () => {
    expect(await run(relayWith({ hasPreapproval: true, transferKind: "direct" }))).toBe(true);
  });

  it("landed=false when the receiver has none — the money awaits their claim", async () => {
    expect(await run(relayWith({ hasPreapproval: false, transferKind: "offer" }))).toBe(false);
  });

  it("landed=null when the relay cannot say — UNKNOWN is never reported as delivered", async () => {
    expect(await run(relayWith({ hasPreapproval: null, transferKind: "direct" }))).toBeNull();
  });

  it("a failing status query costs the label, never the transfer", async () => {
    // The transfer already committed; a status error must not turn a completed
    // withdraw into a thrown one.
    expect(await run(relayWith(new Error("relay down")))).toBeNull();
  });
});

describe("withdraw of a registry token from a wallet past the participant list cap", () => {
  // The relay answers a bounded slice of the oldest holdings (complete:false).
  // Enough to spend from; never enough to quote a balance.
  const USDCX = "usdcx-admin::1220";
  const wallet = { party: "agent::1220a", privateKeyPkcs8Pem: "x", publicKeyFingerprint: "f", network: "canton:mainnet", relayUrl: "http://r" };
  const rows = (n: number, amount: string) =>
    Array.from({ length: n }, (_, i) => ({ cid: `u${i}`, amount, locked: false }));
  const relayOf = (holdings: Array<{ cid: string; amount: string; locked: boolean }>, complete: boolean) => {
    const calls: unknown[][] = [];
    return {
      calls,
      relay: {
        balance: async () => { throw new Error("no /balance for a registry withdraw"); },
        holdings: async (...a: unknown[]) => {
          calls.push(a);
          return { party: wallet.party, instruments: [{ admin: USDCX, id: "USDCx", total: "0", holdings }], complete };
        },
        preapprovalStatus: async () => ({ hasPreapproval: null }),
      },
    };
  };
  async function run(relay: unknown, amount?: string) {
    let seen: Record<string, unknown> | undefined;
    const tx = await import("./tx.js");
    const spy = vi.spyOn(tx, "transfer").mockImplementation(async (_r, _w, o) => { seen = o as never; return "upd"; });
    try {
      const r = await withdraw({ to: "merchant::1220m", instrumentAdmin: USDCX, instrumentId: "USDCx", relay: relay as never, wallet: wallet as never, hashBinding: {}, ...(amount ? { amount } : {}) });
      return { r, seen };
    } finally {
      spy.mockRestore();
    }
  }

  it("asks the relay for a bounded slice", async () => {
    const { relay, calls } = relayOf(rows(3, "1.0000000000"), true);
    await run(relay, "1");
    expect(calls[0]![2]).toEqual({ slice: true });
  });

  it("spends only the fewest, largest holdings that cover the amount", async () => {
    const holdings = [
      { cid: "small", amount: "0.1000000000", locked: false },
      { cid: "big", amount: "5.0000000000", locked: false },
      { cid: "mid", amount: "1.0000000000", locked: false },
    ];
    const { relay } = relayOf(holdings, true);
    const { seen } = await run(relay, "5.5");
    expect(seen!.inputHoldingCids).toEqual(["big", "mid"]);
    expect(seen!.amount).toBe("5.5");
  });

  it("refuses a full (no --amount) withdraw on an incomplete slice — the balance is unknown", async () => {
    const { relay } = relayOf(rows(200, "0.0100000000"), false);
    await expect(run(relay)).rejects.toThrow(/full balance is not known.*merge --admin usdcx-admin::1220 --id USDCx/);
  });

  it("a shortfall on an incomplete slice points at merge, not 'insufficient funds'", async () => {
    const { relay } = relayOf(rows(200, "0.0100000000"), false);
    const err = await run(relay, "5").catch((e: unknown) => e as Error);
    expect(err.message).toMatch(/only 2\.0000000000 USDCx is visible/);
    expect(err.message).not.toMatch(/insufficient funds/);
  });

  it("from a slice, an amount spread over more than 90 holdings is refused up front with a merge hint", async () => {
    const { relay } = relayOf(rows(200, "0.0100000000"), false);
    await expect(run(relay, "1.0")).rejects.toThrow(/more than 90 holdings/);
  });

  it("a complete read keeps the old behaviour: a full withdraw spends every holding", async () => {
    const { relay } = relayOf(rows(150, "0.0100000000"), true);
    const { seen } = await run(relay);
    expect((seen!.inputHoldingCids as string[]).length).toBe(150);
  });

  it("a coverable amount on an incomplete slice goes through", async () => {
    const { relay } = relayOf(rows(200, "0.0100000000"), false);
    const { seen } = await run(relay, "0.5");
    expect((seen!.inputHoldingCids as string[]).length).toBe(50);
  });
});
