/**
 * The self-preapproval verify arm, against the REAL MainNet bytes it guards.
 *
 * `assertPreparedSelfPreapproval` used to check only the root choice name and
 * `act_as`. It never looked at the choice ARGUMENT, so a hostile relay could
 * hand the merchant a transaction that spent the merchant's own CC to create a
 * preapproval naming somebody else — passing every check, because the choice
 * name and the signer were both honest.
 *
 * The fixture is a genuine `AmuletRules_CreateTransferPreapproval` prepared by
 * the live relay and never signed. Tampered variants are produced by editing
 * THOSE bytes, so the positional reader is exercised against the real wire
 * encoding rather than an invented one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertPreparedSelfPreapproval,
  PreparedTransferMismatchError,
} from "./verify-prepared.js";

const B64 = readFileSync(
  join(import.meta.dirname, "__fixtures__", "mainnet-self-preapproval-create.b64"),
  "utf8"
).trim();
const PARTY =
  "agent::122090a6c2579860921db36f24890b137a3a0e4875a0446687ff449cd29f3ad33106";
const EXPIRES = "2026-11-10T00:00:00Z";

/**
 * Overwrite the Nth occurrence of the merchant party with an equal-length
 * replacement, which is what a relay swapping the field emits (the protobuf
 * framing stays valid).
 *
 * MEASURED: the party string occurs 8 times in these bytes, and exactly two of
 * them — the 6th and 7th — fall inside the root exercise's `chosen_value`.
 * Those are `receiver` (declaration position 2) and `provider` (position 3).
 * The other six sit in act_as/metadata/input-contract payloads and are NOT what
 * this arm is about, which is why the index matters: a naive "swap the first
 * occurrence" edits a byte range no check here reads and the test passes for
 * the wrong reason. It did exactly that on the first attempt.
 */
function swapParty(b64: string, occurrence: number, replacement: string): string {
  const buf = Buffer.from(b64, "base64");
  const needle = Buffer.from(PARTY, "utf8");
  const offsets: number[] = [];
  for (let i = buf.indexOf(needle); i !== -1; i = buf.indexOf(needle, i + 1)) {
    offsets.push(i);
  }
  expect(offsets.length).toBe(8);
  const at = offsets[occurrence];
  expect(at).toBeDefined();
  const out = Buffer.from(buf);
  Buffer.from(replacement, "utf8").copy(out, at!);
  return out.toString("base64");
}

const RECEIVER_OCCURRENCE = 5;
const PROVIDER_OCCURRENCE = 6;
const EVIL =
  "agent::1220ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

describe("assertPreparedSelfPreapproval — the real MainNet argument", () => {
  it("accepts the honest capture", () => {
    expect(() => assertPreparedSelfPreapproval(B64, PARTY, EXPIRES)).not.toThrow();
  });

  it("accepts it without an expiresAt expectation (the pre-existing call shape)", () => {
    expect(() => assertPreparedSelfPreapproval(B64, PARTY)).not.toThrow();
  });

  it("refuses when receiver names somebody else", () => {
    expect(EVIL.length).toBe(PARTY.length);
    expect(() =>
      assertPreparedSelfPreapproval(swapParty(B64, RECEIVER_OCCURRENCE, EVIL), PARTY)
    ).toThrow(/receiver/);
  });

  it("refuses when provider names somebody else", () => {
    expect(() =>
      assertPreparedSelfPreapproval(swapParty(B64, PROVIDER_OCCURRENCE, EVIL), PARTY)
    ).toThrow(/provider/);
  });

  it("refuses a horizon that differs from the one the relay stated", () => {
    expect(() =>
      assertPreparedSelfPreapproval(B64, PARTY, "2036-11-10T00:00:00Z")
    ).toThrow(/expiresAt/);
  });

  it("refuses an unparseable stated horizon rather than skipping the check", () => {
    expect(() => assertPreparedSelfPreapproval(B64, PARTY, "whenever")).toThrow(
      /not a parseable timestamp/
    );
  });

  it("still enforces the party it was already enforcing", () => {
    expect(() => assertPreparedSelfPreapproval(B64, "someone-else::1220aa")).toThrow(
      PreparedTransferMismatchError
    );
  });
});
