import { describe, it, expect, vi } from "vitest";
import { swapNotCovered, SWAP_TICKET_FEE_CC } from "./swap-cover.js";
import { resolveSwapIntent } from "./swap-route.js";

const P = "agent::1220aa";
function relay(cc: string, holdings?: { complete: boolean; rows: Array<{ amount: string; locked: boolean }> }, fail = false) {
  const usdcx = resolveSwapIntent("USDCx", "CC").inInstrument!;
  return {
    balance: vi.fn(async () => {
      if (fail) throw new Error("relay down");
      return { party: P, amulet: Number(cc), cc, holdings: [] };
    }),
    holdings: vi.fn(async () => ({
      party: P,
      complete: holdings?.complete ?? true,
      instruments: [{ admin: usdcx.admin, id: usdcx.id, amount: "0", holdings: (holdings?.rows ?? []).map((r, i) => ({ cid: `c${i}`, ...r })) }],
    })),
  };
}

describe("swapNotCovered", () => {
  const ccIn = resolveSwapIntent("CC", "USDCx");
  const tokenIn = resolveSwapIntent("USDCx", "CC");

  it("refuses a CC input above the balance less the ticket fee, before anything is paid (MainNet, 2026-11-04)", async () => {
    const r = relay("15.3858570269");
    expect(await swapNotCovered(r, P, ccIn, "1000", SWAP_TICKET_FEE_CC)).toBe(
      "swap: the wallet has 15.3858570269 CC, less than 1000 CC plus the 0.01 CC ticket fee. Swap at most 15.3758570269 CC. Nothing was paid. CC in an incoming offer counts once `claim` has taken it."
    );
    expect(await swapNotCovered(r, P, ccIn, "15.38", SWAP_TICKET_FEE_CC)).toBeDefined();
    expect(await swapNotCovered(r, P, ccIn, "15.37", SWAP_TICKET_FEE_CC)).toBeUndefined();
  });

  it("counts no fee when no ticket is bought", async () => {
    expect(await swapNotCovered(relay("10"), P, ccIn, "10", "0")).toBeUndefined();
    expect(await swapNotCovered(relay("10"), P, ccIn, "10.0000000001", "0")).toMatch(/^swap: the wallet has 10 CC, less than 10.0000000001 CC\. Swap at most 10 CC/);
  });

  it("refuses a token input above the unlocked holdings, and says what is locked", async () => {
    const r = relay("5", { complete: true, rows: [{ amount: "2.5", locked: false }, { amount: "1", locked: true }] });
    expect(await swapNotCovered(r, P, tokenIn, "3", SWAP_TICKET_FEE_CC)).toBe(
      "swap: the wallet can spend 2.5 USDCx, less than 3 (1 more is locked, in an offer or an allocation). Nothing was paid."
    );
    expect(await swapNotCovered(r, P, tokenIn, "2.5", SWAP_TICKET_FEE_CC)).toBeUndefined();
  });

  it("refuses a token input when the CC for the ticket fee is missing", async () => {
    expect(await swapNotCovered(relay("0.005", { complete: true, rows: [{ amount: "9", locked: false }] }), P, tokenIn, "1", SWAP_TICKET_FEE_CC)).toBe(
      "swap: the wallet has 0.005 CC, less than the 0.01 CC ticket fee. Nothing was paid."
    );
  });

  it("leaves the decision to the send when a read fails or is partial", async () => {
    expect(await swapNotCovered(relay("1", undefined, true), P, ccIn, "1000", SWAP_TICKET_FEE_CC)).toBeUndefined();
    expect(await swapNotCovered(relay("5", { complete: false, rows: [{ amount: "1", locked: false }] }), P, tokenIn, "3", SWAP_TICKET_FEE_CC)).toBeUndefined();
  });
});
