import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadWallet,
  saveWallet,
  walletExists,
  walletPath,
  type AgentWallet,
} from "./store.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cawallet-"));
  process.env.CANTON_AGENT_HOME = tmp;
});
afterEach(() => {
  delete process.env.CANTON_AGENT_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

const w: AgentWallet = {
  network: "canton:testnet",
  relayUrl: "http://relay",
  party: "agent::12201",
  publicKeySpkiB64: "pk",
  privateKeyPkcs8Pem: "pem",
  publicKeyFingerprint: "fp",
  createdAt: "2026-06-03T00:00:00Z",
};

describe("wallet store", () => {
  it("absent before first save", () => {
    expect(walletExists()).toBe(false);
    expect(loadWallet()).toBeNull();
  });

  it("save + load round-trips", () => {
    saveWallet(w);
    expect(walletExists()).toBe(true);
    expect(loadWallet()).toEqual(w);
  });

  it("persists with 0600 permissions", () => {
    saveWallet(w);
    const mode = statSync(walletPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
