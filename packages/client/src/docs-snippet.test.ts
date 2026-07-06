/**
 * Compile-checked guard for the headline "how to pay" snippet in
 * docs/INTEGRATION.md (Role 2 — Payer / agent).
 *
 * The doc snippet must keep compiling against the REAL signature of
 * `wrapFetchWithCantonPayment`, which is POSITIONAL:
 *
 *     wrapFetchWithCantonPayment(fetch, signer, options?)
 *
 * A previous revision of the doc passed `{ signer }` (an object) as the
 * second argument. That does not type-check and produces a broken signer
 * at runtime. This test pins both directions so the example cannot drift
 * away from the signature again:
 *
 *  - the positional form (mirroring the doc) must type-check and run, and
 *  - the old object form must remain a *compile error* (asserted with
 *    `@ts-expect-error`; if the signature ever widened to accept an object
 *    again, this file would fail to typecheck — surfacing the drift).
 */
import { describe, it, expect, vi } from "vitest";
import { wrapFetchWithCantonPayment } from "./fetch.js";
import type { CantonSigner } from "./signer.js";

const PAYER = "agent::1220snippet";

function snippetSigner(): CantonSigner {
  return {
    party: PAYER,
    signTransferFactory: vi.fn().mockResolvedValue({
      payerParty: PAYER,
      submissionRef: "1220-snippet-submission",
      preparedTxHash: "aa".repeat(32),
    }),
  };
}

describe("docs/INTEGRATION.md Role 2 snippet — compile-checked signature", () => {
  it("the documented positional form type-checks and returns a fetch", () => {
    const signer = snippetSigner();
    // This is the exact shape the INTEGRATION.md snippet shows:
    //   const fetchPaid = wrapFetchWithCantonPayment(fetch, signer);
    const fetchPaid = wrapFetchWithCantonPayment(fetch, signer);
    expect(typeof fetchPaid).toBe("function");
  });

  it("accepts the optional third (options) argument positionally", () => {
    const signer = snippetSigner();
    const fetchPaid = wrapFetchWithCantonPayment(fetch, signer, {
      networkFilter: (n) => n === "canton:mainnet",
    });
    expect(typeof fetchPaid).toBe("function");
  });

  it("rejects the old broken `{ signer }` object form at compile time", () => {
    const signer = snippetSigner();
    // @ts-expect-error — second arg is a positional `CantonSigner`, NOT
    // an object `{ signer }`. If this ever stops being an error, the
    // signature drifted and the doc snippet would silently break again.
    const broken = () => wrapFetchWithCantonPayment(fetch, { signer });
    // Reference `broken` so it is not an unused binding; never invoked
    // (it would throw at runtime — the point is the compile-time error).
    expect(typeof broken).toBe("function");
  });
});
