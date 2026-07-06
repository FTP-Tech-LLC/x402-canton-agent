import { describe, it, expect, vi } from "vitest";
import { selfProvisionPreapproval } from "./tx.js";

// Minimal wallet stub — prepare throws before the key fields are used.
const wallet = {
  party: "agent::1220aa",
  privateKeyPkcs8Pem: "x",
  publicKeyFingerprint: "1220bb",
} as never;

describe("selfProvisionPreapproval stale-input retry", () => {
  it("retries on INACTIVE_CONTRACTS then gives up bounded (5 backoffs)", async () => {
    const prepare = vi.fn().mockRejectedValue(
      new Error(
        "LOCAL_VERDICT_INACTIVE_CONTRACTS(11,6dc62cb0): Rejected transaction is referring to inactive contracts"
      )
    );
    const relay = { preapprovalSelfPrepare: prepare } as never;
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    await expect(
      selfProvisionPreapproval(relay, wallet, {}, sleep)
    ).rejects.toThrow(/INACTIVE_CONTRACTS/);
    expect(prepare).toHaveBeenCalledTimes(6); // 1 initial + 5 retries
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 12000]);
  });

  it("does NOT retry a non-stale error", async () => {
    const prepare = vi.fn().mockRejectedValue(new Error("some other failure"));
    const relay = { preapprovalSelfPrepare: prepare } as never;
    const sleep = vi.fn(async () => {});
    await expect(
      selfProvisionPreapproval(relay, wallet, {}, sleep)
    ).rejects.toThrow(/some other failure/);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
