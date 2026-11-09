import { describe, it, expect } from "vitest";
import { resolveHashBinding, TRUST_RELAY_HASH_ENV } from "./hash-binding.js";
import { recomputeHash } from "./canton-hash.js";
import { assertHashBinding } from "./verify-prepared.js";
import { exerciseChildren, mutated } from "../../ledger/src/_graph-fixture.js";

describe("a relay graph the hasher cannot walk is refused, not signed", () => {
  it("refuses a root that is its own child with the default binding", async () => {
    const cyclic = mutated((p) => exerciseChildren(p, "0").push("0"));
    await expect(
      assertHashBinding(cyclic, Buffer.alloc(32, 7).toString("base64"), resolveHashBinding({}))
    ).rejects.toThrow(/could not recompute the prepared-transaction hash.*reached twice/);
  });
});

describe("resolveHashBinding (real binding by default; explicit escape hatch)", () => {
  it("defaults to the REAL conformant recompute binding when the env var is unset", () => {
    // The default is no longer fail-closed-{} — it wires the participant-
    // conformant V2 recompute (canton-hash.ts), so a value-moving transfer
    // signs the recomputed hash and refuses on any mismatch.
    expect(resolveHashBinding({})).toEqual({ recomputeHash });
    expect(resolveHashBinding({}).recomputeHash).toBe(recomputeHash);
    expect(resolveHashBinding({}).trustRelayHash).toBeUndefined();
  });

  it("returns {trustRelayHash:true} only for explicit truthy values (escape hatch)", () => {
    for (const v of ["1", "true", "TRUE", "yes", " Yes "]) {
      expect(resolveHashBinding({ [TRUST_RELAY_HASH_ENV]: v })).toEqual({
        trustRelayHash: true,
      });
    }
  });

  it("stays on the real recompute binding for falsey / unrelated values", () => {
    for (const v of ["", "0", "false", "no", "off", "maybe"]) {
      expect(resolveHashBinding({ [TRUST_RELAY_HASH_ENV]: v })).toEqual({
        recomputeHash,
      });
    }
  });
});
