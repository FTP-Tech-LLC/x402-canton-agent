import { describe, it, expect } from "vitest";
import { paidNotServed, PAID_NOT_SERVED_EXIT_CODE } from "./cli-args.js";

/**
 * `pay` printed the merchant's status and body and exited 0 whatever they
 * were, so a script that checks only the exit code read a paid 4xx/5xx as
 * success, and the next run paid again. A 5xx the client could not resolve by
 * re-sending the same payment now throws (non-zero through the CLI's error
 * handler); this covers the rest: a signed payment answered with anything but
 * 2xx.
 */
describe("paidNotServed", () => {
  it("is silent for a 2xx", () => {
    expect(paidNotServed({ signed: true, status: 200 })).toBeUndefined();
    expect(paidNotServed({ signed: true, status: 204 })).toBeUndefined();
  });

  it("is silent when nothing was signed: no payment, the merchant's answer is all there is", () => {
    expect(paidNotServed({ signed: false, status: 404 })).toBeUndefined();
    expect(paidNotServed({ signed: false, status: 500 })).toBeUndefined();
  });

  it("says a signed payment answered 4xx may have settled and must not be paid again", () => {
    const msg = paidNotServed({ signed: true, status: 401 });
    expect(msg).toMatch(/HTTP 401/);
    expect(msg).toMatch(/do NOT pay again/);
    expect(msg).toMatch(/canton-agent-wallet balance/);
  });

  it("names the settlement when the merchant reported one", () => {
    expect(paidNotServed({ signed: true, status: 400, settlement: "1220abc" })).toMatch(/1220abc/);
  });

  it("covers a request that failed after signing, such as PAYMENT_UNCONFIRMED", () => {
    expect(paidNotServed({ signed: true })).toMatch(/request failed\. It may have settled: do NOT pay again/);
    expect(paidNotServed({ signed: false })).toBeUndefined();
  });

  it("exits with its own code, not the generic 1", () => {
    expect(PAID_NOT_SERVED_EXIT_CODE).toBe(2);
  });
});
