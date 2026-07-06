import { describe, it, expect } from "vitest";
import { reserveHolding } from "./tx.js";

/**
 * Disjoint input-holding selection for concurrent allocation(-direct) pays from a
 * single wallet. The on-ledger danger is two concurrent allocates picking the SAME
 * Amulet holding: the first to settle archives it and the loser's prepared tx 400s.
 * reserveHolding picks the smallest-covering single holding and reserves its cid in
 * a per-party set until the dance finishes, so siblings pick different holdings.
 */
describe("reserveHolding (disjoint concurrent allocate selection)", () => {
  const P = "agent::reserve-test-1";

  it("picks the SMALLEST single holding that covers the amount", () => {
    const holdings = [
      { cid: "big", amount: "100.0" },
      { cid: "small", amount: "1.0" },
      { cid: "mid", amount: "10.0" },
    ];
    const r = reserveHolding(P, holdings, "0.5");
    try {
      // smallest single ≥ 0.5 is "small" (1.0), not the whole set.
      expect(r.cids).toEqual(["small"]);
    } finally {
      r.release();
    }
  });

  it("two concurrent reservations from one wallet pick DISJOINT holdings", () => {
    const party = "agent::reserve-test-2";
    const holdings = [
      { cid: "a", amount: "5.0" },
      { cid: "b", amount: "5.0" },
    ];
    const r1 = reserveHolding(party, holdings, "0.01");
    const r2 = reserveHolding(party, holdings, "0.01");
    try {
      expect(r1.cids).toEqual(["a"]);
      // r2 must SKIP a (reserved by r1) and pick b — no collision.
      expect(r2.cids).toEqual(["b"]);
      expect(r1.cids).not.toEqual(r2.cids);
    } finally {
      r1.release();
      r2.release();
    }
  });

  it("release() frees the cid so a later allocate can reuse it", () => {
    const party = "agent::reserve-test-3";
    const holdings = [{ cid: "only", amount: "5.0" }];
    const r1 = reserveHolding(party, holdings, "0.01");
    expect(r1.cids).toEqual(["only"]);
    r1.release();
    // After release, the same holding is selectable again.
    const r2 = reserveHolding(party, holdings, "0.01");
    try {
      expect(r2.cids).toEqual(["only"]);
    } finally {
      r2.release();
    }
  });

  it("accumulates multiple holdings (largest-first) when no single covers the amount", () => {
    const party = "agent::reserve-test-4";
    const holdings = [
      { cid: "h2", amount: "2.0" },
      { cid: "h3", amount: "3.0" },
      { cid: "h1", amount: "1.0" },
    ];
    const r = reserveHolding(party, holdings, "4.0");
    try {
      // No single holding covers 4.0 → accumulate largest-first: 3.0 + 2.0 ≥ 4.0.
      expect(r.cids).toEqual(["h3", "h2"]);
    } finally {
      r.release();
    }
  });

  it("falls back to the FULL set when every holding is already reserved by a sibling", () => {
    const party = "agent::reserve-test-5";
    const holdings = [
      { cid: "a", amount: "5.0" },
      { cid: "b", amount: "5.0" },
    ];
    const r1 = reserveHolding(party, holdings, "0.01"); // a
    const r2 = reserveHolding(party, holdings, "0.01"); // b
    const r3 = reserveHolding(party, holdings, "0.01"); // nothing free → full set
    try {
      expect(r3.cids).toEqual(["a", "b"]);
    } finally {
      r1.release();
      r2.release();
      r3.release();
    }
  });

  it("release() is idempotent (double release does not under-flow the set)", () => {
    const party = "agent::reserve-test-6";
    const holdings = [
      { cid: "x", amount: "5.0" },
      { cid: "y", amount: "5.0" },
    ];
    const r1 = reserveHolding(party, holdings, "0.01"); // x
    r1.release();
    r1.release(); // no-op
    // x is free again; a fresh reservation gets it (proves release didn't corrupt).
    const r2 = reserveHolding(party, holdings, "0.01");
    try {
      expect(r2.cids).toEqual(["x"]);
    } finally {
      r2.release();
    }
  });
});
