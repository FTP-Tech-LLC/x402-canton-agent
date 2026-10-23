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
