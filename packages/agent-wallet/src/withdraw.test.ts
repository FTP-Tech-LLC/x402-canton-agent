import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withdraw } from "./withdraw.js";
import { saveWallet } from "./store.js";
import { generateAgentKey } from "./keys.js";
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
