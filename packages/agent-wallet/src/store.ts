/**
 * Persistent, self-custody wallet store at ~/.canton-agent/wallet.json (0600).
 *
 * This file IS the wallet — the agent reuses the same one forever and never
 * silently creates a second. It must be backed up; losing it loses the funds.
 * Override the directory with CANTON_AGENT_HOME (used by tests + power users).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";

export interface AgentWallet {
  network: string;
  relayUrl: string;
  party: string;
  publicKeySpkiB64: string;
  privateKeyPkcs8Pem: string;
  /** Participant-supplied multihash fingerprint (signedBy for signatures). */
  publicKeyFingerprint: string;
  createdAt: string;
}

function dir(): string {
  return process.env.CANTON_AGENT_HOME || join(homedir(), ".canton-agent");
}

/** The wallet home directory (CANTON_AGENT_HOME or ~/.canton-agent). Exported
 *  for the per-wallet pay lock, which keys on the same directory. */
export function walletDir(): string {
  return dir();
}

export function walletPath(): string {
  return join(dir(), "wallet.json");
}

export function walletExists(): boolean {
  return existsSync(walletPath());
}

export function loadWallet(): AgentWallet | null {
  const p = walletPath();
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as AgentWallet;
}

export function saveWallet(w: AgentWallet): void {
  const d = dir();
  mkdirSync(d, { recursive: true, mode: 0o700 });
  const p = walletPath();
  writeFileSync(p, JSON.stringify(w, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600); // enforce even if the file pre-existed with looser perms
}
