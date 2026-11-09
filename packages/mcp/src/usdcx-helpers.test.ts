import { describe, it, expect } from "vitest";
import { KNOWN_INSTRUMENTS } from "@ftptech/canton-agent-wallet";
import { USDCX_INSTRUMENT_KEY, readUsdcxHolding } from "./usdcx.js";

const U = KNOWN_INSTRUMENTS.USDCx!;
const relay = (h: unknown) =>
  ({
    holdings: async () => {
      if (h instanceof Error) throw h;
      return h;
    },
  }) as never;

describe("USDCx helpers", () => {
  it("key MainNet USDCx the way the signer does", () => {
    expect(USDCX_INSTRUMENT_KEY).toBe(`${U.admin}|USDCx`);
  });

  it("read the USDCx total, and nothing they cannot vouch for", async () => {
    const inst = { admin: U.admin, id: "USDCx", total: "2.5000000000", holdings: [] };
    expect(await readUsdcxHolding(relay({ party: "p", complete: true, instruments: [inst] }), "p")).toBe(2.5);
    expect(await readUsdcxHolding(relay({ party: "p", complete: true, instruments: [] }), "p")).toBe(0);
    // An older relay lists everything; only USDCx counts.
    const cc = { admin: "DSO::1220", id: "Amulet", total: "99", holdings: [] };
    expect(await readUsdcxHolding(relay({ party: "p", complete: true, instruments: [cc, inst] }), "p")).toBe(2.5);
    expect(await readUsdcxHolding(relay({ party: "p", complete: false, instruments: [inst] }), "p")).toBeUndefined();
    expect(await readUsdcxHolding(relay(new Error("413")), "p")).toBeUndefined();
  });
});
