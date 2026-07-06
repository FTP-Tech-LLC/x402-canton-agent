/**
 * Tests for the out-of-band trusted-DSO anchor (CANTON_AGENT_DSO_PARTY) and its
 * env/network resolution.
 *
 * The trusted DSO is the independently-known Amulet instrument admin. The signer
 * pins it as `expectInstrumentAdmin` so the foreign-party backstop can exempt the
 * DSO at its instrument-admin position WITHOUT trusting a relay-supplied value.
 * These tests assert the env/network resolver helper (env override → baked-in
 * network constant → undefined); the signer's threading of it into
 * verify-before-sign is covered in tx.test.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  resolveTrustedDsoParty,
  TRUSTED_DSO_PARTY_ENV,
  KNOWN_DSO_BY_NETWORK,
} from "./trusted-dso.js";

const DSO = "dso.global::nonhexNS99";

afterEach(() => {
  delete process.env[TRUSTED_DSO_PARTY_ENV];
});

describe("resolveTrustedDsoParty", () => {
  it("returns undefined when unset / blank", () => {
    delete process.env[TRUSTED_DSO_PARTY_ENV];
    expect(resolveTrustedDsoParty({})).toBeUndefined();
    expect(resolveTrustedDsoParty({ [TRUSTED_DSO_PARTY_ENV]: "   " })).toBeUndefined();
  });
  it("returns the trimmed party id when set", () => {
    expect(resolveTrustedDsoParty({ [TRUSTED_DSO_PARTY_ENV]: ` ${DSO} ` })).toBe(DSO);
  });
  it("auto-resolves the baked-in DSO for a known network when env is unset", () => {
    expect(resolveTrustedDsoParty({}, "canton:mainnet")).toBe(
      KNOWN_DSO_BY_NETWORK["canton:mainnet"]
    );
    expect(KNOWN_DSO_BY_NETWORK["canton:mainnet"]).toMatch(/^DSO::1220[0-9a-f]+$/);
  });
  it("env override beats the baked-in network constant", () => {
    expect(
      resolveTrustedDsoParty({ [TRUSTED_DSO_PARTY_ENV]: DSO }, "canton:mainnet")
    ).toBe(DSO);
  });
  it("returns undefined for a network with no baked-in constant and no env", () => {
    expect(resolveTrustedDsoParty({}, "canton:testnet")).toBeUndefined();
    expect(resolveTrustedDsoParty({}, "canton:devnet")).toBeUndefined();
    expect(resolveTrustedDsoParty({})).toBeUndefined();
  });
});
