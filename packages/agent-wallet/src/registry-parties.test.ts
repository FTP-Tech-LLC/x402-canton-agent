import { describe, it, expect } from "vitest";
import {
  resolveTrustedRegistryParties,
  isTrustedRegistryAdmin,
  KNOWN_REGISTRY_TRUSTED_PARTIES,
  REGISTRY_TRUSTED_PARTIES_ENV,
  resolveSwapSymbol,
  KNOWN_INSTRUMENTS,
} from "./registry-parties.js";

const CBTC_ADMIN =
  "cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262";
const USDXLR_ADMIN =
  "excellar-issuer::12203d1e36930ee0e3fbb898add7e222a47ae9d2a5f0f6187e3a446ea32f871ce2ca";
const CETH_ADMIN =
  "rails-cethMain-1::12200350ba6e96e3b701c3048b5aa013a8c1c08833e8ebf54339cff581055c29003a";

const USDCX_ADMIN =
  "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef";
const DSO =
  "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";

describe("resolveTrustedRegistryParties", () => {
  it("returns the baked-in infra set for a known registry admin (USDCx)", () => {
    const s = resolveTrustedRegistryParties(USDCX_ADMIN, {});
    expect(s.size).toBe(2);
    for (const p of KNOWN_REGISTRY_TRUSTED_PARTIES[USDCX_ADMIN]!) {
      expect(s.has(p)).toBe(true);
    }
  });

  it("returns an empty set for a non-registry admin (Amulet DSO)", () => {
    expect(resolveTrustedRegistryParties(DSO, {}).size).toBe(0);
    expect(isTrustedRegistryAdmin(DSO, {})).toBe(false);
  });

  it("isTrustedRegistryAdmin is true only for a known/configured admin", () => {
    expect(isTrustedRegistryAdmin(USDCX_ADMIN, {})).toBe(true);
  });

  it("merges env-configured infra parties on top of the baked-in set", () => {
    const extra = "extra-op::1220deadbeef";
    const env = {
      [REGISTRY_TRUSTED_PARTIES_ENV]: JSON.stringify({ [USDCX_ADMIN]: [extra] }),
    } as NodeJS.ProcessEnv;
    const s = resolveTrustedRegistryParties(USDCX_ADMIN, env);
    expect(s.has(extra)).toBe(true);
    // baked-in constants still present
    expect(s.size).toBeGreaterThanOrEqual(3);
  });

  it("admits a brand-new registry admin purely from env (generic, no code change)", () => {
    const newAdmin = "some-other-registrar::1220abc";
    const op = "some-operator::1220def";
    const env = {
      [REGISTRY_TRUSTED_PARTIES_ENV]: JSON.stringify({ [newAdmin]: [op] }),
    } as NodeJS.ProcessEnv;
    const s = resolveTrustedRegistryParties(newAdmin, env);
    expect(s.has(op)).toBe(true);
    expect(isTrustedRegistryAdmin(newAdmin, env)).toBe(true);
  });

  it("fails closed to empty on malformed env JSON", () => {
    const env = { [REGISTRY_TRUSTED_PARTIES_ENV]: "{not json" } as NodeJS.ProcessEnv;
    // baked-in still returned; malformed env simply ignored (no throw)
    expect(resolveTrustedRegistryParties(USDCX_ADMIN, env).size).toBe(2);
    expect(resolveTrustedRegistryParties("unknown::1220", env).size).toBe(0);
  });
});

describe("new DA-Utility tokens are trusted out of the box", () => {
  const DA_OPERATOR =
    "auth0_007c6643538f2eadd3e573dd05b9::12205bcc106efa0eaa7f18dc491e5c6f5fb9b0cc68dc110ae66f4ed6467475d7c78e";

  it("CBTC / USDXLR / cETH admins carry the shared DA Registry Utility operator", () => {
    for (const admin of [CBTC_ADMIN, USDXLR_ADMIN, CETH_ADMIN]) {
      const set = resolveTrustedRegistryParties(admin, {} as NodeJS.ProcessEnv);
      expect(set.has(DA_OPERATOR)).toBe(true);
      expect(isTrustedRegistryAdmin(admin, {} as NodeJS.ProcessEnv)).toBe(true);
    }
  });

  it("USDCx keeps BOTH the operator and its xReserve bridge signatory", () => {
    expect(KNOWN_REGISTRY_TRUSTED_PARTIES[USDCX_ADMIN]?.length).toBe(2);
  });
});

describe("KNOWN_INSTRUMENTS", () => {
  it("every admin is a trusted registry admin", () => {
    for (const { admin } of Object.values(KNOWN_INSTRUMENTS)) {
      expect(isTrustedRegistryAdmin(admin, {} as NodeJS.ProcessEnv)).toBe(true);
    }
  });

  it("includes the Ember metals eXAG/eXAU with their DA-Utility admins", () => {
    expect(KNOWN_INSTRUMENTS.eXAG?.id).toBe("eXAG");
    expect(KNOWN_INSTRUMENTS.eXAG?.admin).toMatch(/^ember-silver::1220/);
    expect(KNOWN_INSTRUMENTS.eXAU?.id).toBe("eXAU");
    expect(KNOWN_INSTRUMENTS.eXAU?.admin).toMatch(/^ember-gold::1220/);
  });
});

describe("resolveSwapSymbol", () => {
  it("maps CC aliases to the canonical CC leg", () => {
    for (const s of ["CC", "cc", "canton-coin", "Amulet"]) {
      expect(resolveSwapSymbol(s)).toEqual({ kind: "cc", symbol: "CC" });
    }
  });

  it("resolves a registry token to canonical symbol + instrument, case-insensitively", () => {
    expect(resolveSwapSymbol("usdxlr")).toEqual({
      kind: "registry",
      symbol: "USDXLR",
      instrument: KNOWN_INSTRUMENTS.USDXLR,
    });
    // canonical casing is preserved even when the input casing differs
    expect(resolveSwapSymbol("CETH").symbol).toBe("cETH");
    expect(resolveSwapSymbol("cbtc").symbol).toBe("CBTC");
  });

  it("returns unknown for an unrecognized symbol — never a silent CC fallback", () => {
    // The classic footgun: USDC (missing the trailing x) must NOT resolve to CC.
    expect(resolveSwapSymbol("USDC")).toEqual({ kind: "unknown" });
    expect(resolveSwapSymbol("NOPEx")).toEqual({ kind: "unknown" });
  });
});
