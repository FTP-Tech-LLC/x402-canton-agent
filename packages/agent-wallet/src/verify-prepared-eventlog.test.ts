import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPreparedAcceptMatches,
  assertPreparedTransferMatches,
  decodePrepared,
  PreparedTransferMismatchError,
} from "./verify-prepared.js";

/* ════════════════════════════════════════════════════════════════════════
 * splice-amulet 0.1.21 (MainNet, adopted 2026-07-28) added
 * `EventLog_HoldingsChange`. Our consequence-choice allowlist did not carry it,
 * so verify-before-sign refused every CLAIM — an agent could be funded but could
 * not take the funds. Captured live via e2e/capture-accept-bytes.mjs on
 * 2026-08-02; the transfer capture is the matching pay-path control.
 *
 * These run against the REAL bytes, not synthetic ones: the point is to prove
 * the guard tracks what MainNet actually produces, and that widening it did not
 * turn the choice into a blanket "any node named EventLog_HoldingsChange".
 * ════════════════════════════════════════════════════════════════════════ */

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => readFileSync(join(here, "__fixtures__", name), "utf8").trim();
const meta = JSON.parse(fx("mainnet-0.1.21.json")) as {
  accept: { file: string; party: string };
  transfer: {
    file: string;
    sender: string;
    receiver: string;
    amount: string;
    instrumentId: { admin: string; id: string };
  };
};
const ACCEPT_B64 = fx(meta.accept.file);
const TRANSFER_B64 = fx(meta.transfer.file);

/** A captured prepared transaction carries a short relay-chosen validity window,
 *  which has long since passed. Both arms assert timing, so every structural
 *  assertion below would otherwise be masked by an expiry failure — evaluate
 *  them as of the capture instant instead. The accept arm takes an explicit
 *  `nowMs`; the transfer arm reads `Date.now()` internally, so that one needs
 *  the clock frozen. */
const capturedNowMs = (b64: string): number => {
  const d = decodePrepared(b64);
  return Number(d.minLedgerEffectiveTime ?? d.preparationTime ?? 0n) / 1000 + 1000;
};
const acceptNowMs = capturedNowMs(ACCEPT_B64);

afterEach(() => {
  vi.useRealTimers();
});

describe("EventLog_HoldingsChange (splice-amulet 0.1.21) — real MainNet bytes", () => {
  it("the captured accept really does carry the new nodes (fixture is not stale)", () => {
    const d = decodePrepared(ACCEPT_B64);
    const byChoice = d.exercises.map((e) => `${e.choiceId}@${e.templateQualifiedName}`);
    expect(byChoice).toContain(
      "EventLog_HoldingsChange@Splice.ExternalPartyConfigState:ExternalPartyConfigState"
    );
    expect(byChoice).toContain("EventLog_HoldingsChange@Splice.AmuletEventLog:AmuletEventLog");
    // Both depths are represented: a DIRECT child of the accept root and a
    // GRANDCHILD under LockedAmulet_UnlockV2. Any future rule that pins depth
    // would break on one of them.
    expect(
      byChoice.filter((c) => c.startsWith("EventLog_HoldingsChange@")).length
    ).toBeGreaterThanOrEqual(3);
  });

  it("ACCEPT: signs the real MainNet claim (the outage case)", () => {
    expect(() =>
      assertPreparedAcceptMatches(ACCEPT_B64, {
        selfParty: meta.accept.party,
        nowMs: acceptNowMs,
      })
    ).not.toThrow();
  });

  it("TRANSFER: the real preapproval pay path carries NO EventLog node", () => {
    // Measured, and worth locking in: the pay path was never broken by 0.1.21 —
    // only the claim path was. If a future release starts emitting the node here
    // too, this expectation flips and we learn it from a test, not from prod.
    const d = decodePrepared(TRANSFER_B64);
    expect(d.exercises.map((e) => e.choiceId)).not.toContain("EventLog_HoldingsChange");
  });

  it("TRANSFER: still signs the real MainNet payment", () => {
    vi.useFakeTimers();
    vi.setSystemTime(capturedNowMs(TRANSFER_B64));
    expect(() =>
      assertPreparedTransferMatches(TRANSFER_B64, {
        sender: meta.transfer.sender,
        receiver: meta.transfer.receiver,
        amount: meta.transfer.amount,
        instrumentId: meta.transfer.instrumentId.id,
        instrumentAdmin: meta.transfer.instrumentId.admin,
      })
    ).not.toThrow();
  });

  it("the allowance is TEMPLATE-PINNED, not a bare name", () => {
    // `EventLog_HoldingsChange` is declared on an INTERFACE, so its body is
    // whatever the implementing package supplies. Renaming the template the node
    // runs on must therefore lose the allowance — otherwise any package that
    // implements the interface could smuggle arbitrary code past the guard under
    // a name we trust. Rewrite the template string inside the captured bytes and
    // require a refusal.
    const raw = Buffer.from(ACCEPT_B64, "base64");
    const from = Buffer.from("ExternalPartyConfigState", "utf8");
    const to = Buffer.from("ExternalPartyConfigStatX", "utf8"); // same length, keeps offsets
    let hits = 0;
    for (let i = 0; (i = raw.indexOf(from, i)) !== -1; i += from.length) {
      to.copy(raw, i);
      hits++;
    }
    expect(hits).toBeGreaterThan(0);
    expect(() =>
      assertPreparedAcceptMatches(raw.toString("base64"), {
        selfParty: meta.accept.party,
        nowMs: acceptNowMs,
      })
    ).toThrow(PreparedTransferMismatchError);
  });
});
