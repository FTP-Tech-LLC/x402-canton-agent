import { describe, it, expect } from "vitest";
import { explainRelayFailure } from "./relay-client.js";

// The VERBATIM participant body from the 2026-09-07 MainNet outage: a merchant's
// TransferPreapproval lapsed at 08:13:59Z and every payment to them failed from
// 08:14:20 on. The payer-side message truncated at 200 chars, so what agents saw
// ended mid-sentence at "Ledger time is at or " — losing both the deadline name
// and the timestamp, and sending three of them to debug the wrong system.
const REAL_BODY =
  '{"error":"POST /v2/interactive-submission/prepare returned HTTP 400 ' +
  "[DAML_FAILURE: Interpretation error: Error: User failure: " +
  "stdlib.daml.com/deadline-exceeded (error category 9): Ledger time is at or past " +
  "deadline 'TransferPreapproval.expiresAt' at 2026-09-07T08:13:59.232Z]\"}";

describe("explainRelayFailure names the lapsed payee preapproval", () => {
  it("extracts the expiry instant the truncated body would have hidden", () => {
    const why = explainRelayFailure(REAL_BODY);
    expect(why).toBeDefined();
    expect(why).toContain("2026-09-07T08:13:59.232Z");
  });

  it("says whose problem it is, so the payer stops debugging their own wallet", () => {
    const why = explainRelayFailure(REAL_BODY)!;
    expect(why).toMatch(/PAYEE|receiver/i);
    expect(why).toMatch(/renew/i);
  });

  it("states that nothing was charged — it fails before signing", () => {
    expect(explainRelayFailure(REAL_BODY)!).toMatch(/nothing was charged/i);
  });

  it("stays silent on failures it has no remedy for", () => {
    expect(explainRelayFailure('{"error":"insufficient holdings: balance 1 CC < amount 2 CC"}')).toBeUndefined();
    expect(explainRelayFailure("")).toBeUndefined();
  });
});

describe("explainRelayFailure names a rejection verdict as final", () => {
  it("a contract that changed meanwhile, and any other local verdict", () => {
    // Only this transaction is known not to have committed: earlier steps of
    // the command stand, and a LOCKED input belongs to a transaction in flight.
    expect(explainRelayFailure('{"detail":"interactive submission rejected: LOCAL_VERDICT_LOCKED_CONTRACTS(11,ab): x"}')).toBe(
      "the participant rejected the transaction (LOCAL_VERDICT_LOCKED_CONTRACTS): another pending transaction holds an input of this one. Wait for it, then check `balance` before running this again."
    );
    expect(explainRelayFailure('{"detail":"interactive submission rejected: LOCAL_VERDICT_INACTIVE_CONTRACTS(11,ab): x"}')).toBe(
      "the participant rejected the transaction (LOCAL_VERDICT_INACTIVE_CONTRACTS): a contract it spends changed meanwhile. This transaction did not commit and charged nothing. Steps this command finished before it stand: check `balance` (and `tc status`) before running it again."
    );
    expect(explainRelayFailure('{"detail":"interactive submission rejected: DAML_AUTHORIZATION_ERROR(8,ab): x"}')).toBe(
      "the participant rejected the transaction (DAML_AUTHORIZATION_ERROR). This transaction did not commit and charged nothing. Steps this command finished before it stand: check `balance` (and `tc status`) before running it again."
    );
    expect(explainRelayFailure('{"detail":"POST /v2/interactive-submission/execute failed: fetch failed"}')).toBeUndefined();
  });
});

