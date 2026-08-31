import { describe, it, expect } from "vitest";
import { venueMetaForInstrument, VENUE_KEY_ENV, VENUE_TAG_ENV } from "./venue.js";
import { KNOWN_INSTRUMENTS } from "./registry-parties.js";

const CBTC = KNOWN_INSTRUMENTS.CBTC!;
const USDCx = KNOWN_INSTRUMENTS.USDCx!;
const USDXLR = KNOWN_INSTRUMENTS.USDXLR!;
const KEY = "ftp/venue";
const TAG = "ftp/agentic-wallet";
const on = { [VENUE_KEY_ENV]: KEY, [VENUE_TAG_ENV]: TAG } as NodeJS.ProcessEnv;

describe("venueMetaForInstrument", () => {
  it("stamps the configured key/value on ANY registry token when both env are set", () => {
    for (const ins of [CBTC, USDCx, USDXLR]) {
      expect(venueMetaForInstrument(ins.admin, ins.id, on)).toEqual({ [KEY]: TAG });
    }
  });

  it("uses the operator's own key from CANTON_AGENT_VENUE_KEY", () => {
    const env = { [VENUE_KEY_ENV]: "acme/venue", [VENUE_TAG_ENV]: "acme" } as NodeJS.ProcessEnv;
    expect(venueMetaForInstrument(CBTC.admin, CBTC.id, env)).toEqual({ "acme/venue": "acme" });
  });

  it("stamps nothing when the KEY env is unset (only the value set)", () => {
    const env = { [VENUE_TAG_ENV]: TAG } as NodeJS.ProcessEnv;
    expect(venueMetaForInstrument(CBTC.admin, CBTC.id, env)).toEqual({});
  });

  it("stamps nothing when the VALUE env is unset (only the key set)", () => {
    const env = { [VENUE_KEY_ENV]: KEY } as NodeJS.ProcessEnv;
    expect(venueMetaForInstrument(CBTC.admin, CBTC.id, env)).toEqual({});
  });

  it("treats blank/whitespace env as unset", () => {
    const env = { [VENUE_KEY_ENV]: "  ", [VENUE_TAG_ENV]: "  " } as NodeJS.ProcessEnv;
    expect(venueMetaForInstrument(CBTC.admin, CBTC.id, env)).toEqual({});
  });

  it("does NOT stamp Canton Coin (undefined admin/id) even with both env set", () => {
    expect(venueMetaForInstrument(undefined, undefined, on)).toEqual({});
  });

  it("does NOT stamp the Amulet id (Canton Coin) even if an admin is present", () => {
    expect(venueMetaForInstrument("DSO::1220dso", "Amulet", on)).toEqual({});
  });

  it("trims surrounding whitespace off the key and value", () => {
    const env = { [VENUE_KEY_ENV]: `  ${KEY}  `, [VENUE_TAG_ENV]: `  ${TAG}  ` } as NodeJS.ProcessEnv;
    expect(venueMetaForInstrument(CBTC.admin, CBTC.id, env)).toEqual({ [KEY]: TAG });
  });

  // ONE contract with the facilitator's pay/prepare bounds: a key/tag the relay
  // would 400 is refused HERE, so a misconfigured env stamps nothing anywhere
  // instead of working on withdraw and then failing every registry x402 payment.
  it("refuses a key that does not end in /venue (would 400 on pay/prepare)", () => {
    const env = { [VENUE_KEY_ENV]: "acme-attribution", [VENUE_TAG_ENV]: TAG } as NodeJS.ProcessEnv;
    expect(venueMetaForInstrument(CBTC.admin, CBTC.id, env)).toEqual({});
  });

  it("refuses a key longer than 64 chars even with the right suffix", () => {
    const env = { [VENUE_KEY_ENV]: `${"a".repeat(60)}/venue`, [VENUE_TAG_ENV]: TAG } as NodeJS.ProcessEnv;
    expect(venueMetaForInstrument(CBTC.admin, CBTC.id, env)).toEqual({});
  });

  it("refuses a tag longer than 128 chars", () => {
    const env = { [VENUE_KEY_ENV]: KEY, [VENUE_TAG_ENV]: "x".repeat(129) } as NodeJS.ProcessEnv;
    expect(venueMetaForInstrument(CBTC.admin, CBTC.id, env)).toEqual({});
  });

  it("accepts a key/tag exactly at the bounds", () => {
    const key = `${"a".repeat(58)}/venue`; // 64 chars
    const tag = "x".repeat(128);
    const env = { [VENUE_KEY_ENV]: key, [VENUE_TAG_ENV]: tag } as NodeJS.ProcessEnv;
    expect(venueMetaForInstrument(CBTC.admin, CBTC.id, env)).toEqual({ [key]: tag });
  });
});
