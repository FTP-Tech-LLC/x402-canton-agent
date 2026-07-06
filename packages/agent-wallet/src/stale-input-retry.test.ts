import { describe, it, expect, vi } from "vitest";
import { isStaleInputHoldingError } from "./tx.js";
import { withStaleInputRetry } from "./relay-signer.js";

/**
 * Stale input-holding retry: the relay /balance ACS read lags the validation
 * state and hands back a holding the ledger already archived (e.g. after a prior
 * allocate whose execute timed out but committed). The prepare then 400s
 * UNKNOWN_CONTRACT_SYNCHRONIZERS. We classify that as transient and re-run the
 * allocate (which re-reads balance) with backoff.
 */
const instant = (): Promise<void> => Promise.resolve();

// A realistic relay error: 502 wrapper whose detail carries the participant 400.
const staleErr = (): Error =>
  new Error(
    "wallet relay submit/prepare failed: POST /v2/interactive-submission/prepare " +
      "returned HTTP 400 [UNKNOWN_CONTRACT_SYNCHRONIZERS: The following contracts " +
      "have been archived: List(0086abcd...)]"
  );

describe("isStaleInputHoldingError", () => {
  it("matches UNKNOWN_CONTRACT_SYNCHRONIZERS in the message", () => {
    expect(isStaleInputHoldingError(staleErr())).toBe(true);
  });

  it('matches "have been archived"', () => {
    expect(isStaleInputHoldingError(new Error("contracts have been archived"))).toBe(true);
  });

  it("matches via the cause chain", () => {
    const wrapped = new Error("wallet relay submit/prepare failed");
    (wrapped as { cause?: unknown }).cause = new Error(
      "UNKNOWN_CONTRACT_SYNCHRONIZERS: archived"
    );
    expect(isStaleInputHoldingError(wrapped)).toBe(true);
  });

  it("does NOT match unrelated errors", () => {
    expect(isStaleInputHoldingError(new Error("insufficient funds"))).toBe(false);
    expect(isStaleInputHoldingError(new Error("no completion within timeout"))).toBe(false);
    expect(isStaleInputHoldingError(undefined)).toBe(false);
  });
});

describe("withStaleInputRetry", () => {
  it("retries a stale-input failure, then returns the success value", async () => {
    const run = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(staleErr())
      .mockResolvedValueOnce("ok");
    const r = await withStaleInputRetry(run, instant);
    expect(r).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a non-stale failure (fails fast)", async () => {
    const run = vi.fn<[], Promise<string>>().mockRejectedValue(new Error("insufficient funds"));
    await expect(withStaleInputRetry(run, instant)).rejects.toThrow(/insufficient funds/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("bounds retries and bubbles the last stale error", async () => {
    const run = vi.fn<[], Promise<string>>().mockRejectedValue(staleErr());
    await expect(withStaleInputRetry(run, instant)).rejects.toThrow(
      /UNKNOWN_CONTRACT_SYNCHRONIZERS/
    );
    // 1 initial attempt + 5 backoff retries (STALE_INPUT_BACKOFF_MS.length) = 6.
    expect(run).toHaveBeenCalledTimes(6);
  });

  it("never sleeps on the happy path", async () => {
    const sleep = vi.fn(instant);
    const run = vi.fn<[], Promise<number>>().mockResolvedValue(42);
    expect(await withStaleInputRetry(run, sleep)).toBe(42);
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
