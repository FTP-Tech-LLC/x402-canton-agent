import { describe, it, expect } from "vitest";
import { classifyPending } from "./tx.js";

const DSO = "DSO::1220dso";
const USDCX = "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef";
const NOW = Date.parse("2026-09-21T12:00:00Z");
const later = "2026-09-21T13:00:00Z";
const row = (instrumentId?: { admin: string; id: string }, executeBefore: string | undefined = later) => ({
  cid: "00c",
  ...(instrumentId ? { instrumentId } : {}),
  ...(executeBefore ? { executeBefore } : {}),
});
const noEnv = {} as NodeJS.ProcessEnv;

describe("classifyPending — what claimAll would do with a pending row", () => {
  it("expired rows are skipped, whatever the token", () => {
    expect(classifyPending(row({ admin: DSO, id: "Amulet" }, "2026-09-21T11:00:00Z"), DSO, NOW, noEnv)).toEqual({ kind: "expired" });
  });

  it("Canton Coin from the known DSO is claimable on the Scan path", () => {
    expect(classifyPending(row({ admin: DSO, id: "Amulet" }), DSO, NOW, noEnv)).toEqual({ kind: "claimable" });
    expect(classifyPending(row(), DSO, NOW, noEnv)).toEqual({ kind: "claimable" }); // older relay: no instrument
  });

  it("a token that calls itself Amulet but is not the DSO's is a registry token", () => {
    expect(classifyPending(row({ admin: "evil::1220", id: "Amulet" }), DSO, NOW, noEnv)).toEqual({
      kind: "untrusted",
      admin: "evil::1220",
    });
  });

  it("a registry token is claimable only with a local trust anchor", () => {
    expect(classifyPending(row({ admin: USDCX, id: "USDCx" }), DSO, NOW, noEnv)).toEqual({
      kind: "claimable",
      registryAdmin: USDCX,
    });
    expect(classifyPending(row({ admin: "reg::1220other", id: "TOK" }), DSO, NOW, noEnv)).toEqual({
      kind: "untrusted",
      admin: "reg::1220other",
    });
  });
});
