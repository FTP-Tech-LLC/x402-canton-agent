import { describe, it, expect } from "vitest";
import { resolveHashBinding, TRUST_RELAY_HASH_ENV } from "./hash-binding.js";
import { recomputeHash } from "./canton-hash.js";

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
