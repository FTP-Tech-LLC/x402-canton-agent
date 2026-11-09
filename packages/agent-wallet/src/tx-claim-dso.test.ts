/**
 * claimAll holds a Canton Coin claim to the network's DSO: the accepted
 * instruction must be one the DSO signed that pays the agent. Uses the REAL
 * MainNet Canton Coin accept (the faucet paying an agent 0.27 CC), so the
 * verify step runs for real.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { claimAll } from "./tx.js";
import { decodePrepared } from "./verify-prepared.js";
import { KNOWN_DSO_BY_NETWORK, TRUSTED_DSO_PARTY_ENV } from "./trusted-dso.js";

const RECOMPUTE = (b64: string): string => createHash("sha256").update(Buffer.from(b64, "base64")).digest("base64");
const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8").trim();
const ACCEPT = fixture("mainnet-accept-eventlog-0.1.21.b64");
const META = JSON.parse(fixture("mainnet-0.1.21.json")) as { accept: { party: string } };
const d = decodePrepared(ACCEPT);
const NOW = Number(d.minLedgerEffectiveTime ?? d.preparationTime ?? 0n) / 1000 + 1000;
const DSO = KNOWN_DSO_BY_NETWORK["canton:mainnet"]!;

const WALLET = {
  party: META.accept.party,
  privateKeyPkcs8Pem: (await import("./keys.js")).generateAgentKey().privateKeyPkcs8Pem,
  publicKeyFingerprint: "f",
  network: "canton:mainnet",
  relayUrl: "http://r",
};

function relay(rowAdmin = DSO) {
  const executed: string[] = [];
  return {
    executed,
    pending: async () => ({ party: WALLET.party, pending: [{ cid: "cc-1", instrumentId: { admin: rowAdmin, id: "Amulet" } }] }),
    resolveAccept: async () => ({ choiceContextData: {}, disclosedContracts: [] }),
    submitPrepare: async () => ({ preparedTransaction: ACCEPT, hash: RECOMPUTE(ACCEPT) }),
    submitExecute: async () => {
      executed.push("cc-1");
      return { updateId: "upd-cc-1" };
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env[TRUSTED_DSO_PARTY_ENV];
});

describe("claimAll — a Canton Coin claim is held to the DSO", () => {
  it("claims the real MainNet instruction the network's DSO signed", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const r = relay();
    const out = await claimAll(r as never, WALLET as never, { hashBinding: { recomputeHash: RECOMPUTE } });
    expect(out.updateIds).toEqual(["upd-cc-1"]);
  });

  it("refuses when the instruction is not signed by the DSO the wallet trusts", async () => {
    // The row names the trusted DSO, so it is classified as Canton Coin and
    // prepared; the relay's bytes are an instruction another DSO signed.
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const trusted = "DSO::1220" + "d".repeat(64);
    process.env[TRUSTED_DSO_PARTY_ENV] = trusted;
    const r = relay(trusted);
    await expect(
      claimAll(r as never, WALLET as never, { hashBinding: { recomputeHash: RECOMPUTE } })
    ).rejects.toThrow(/the instruction is not signed by the DSO/);
    expect(r.executed).toEqual([]);
  });
});
