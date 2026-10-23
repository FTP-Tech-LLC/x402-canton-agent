/**
 * The starter grant a relay pays every newly created wallet.
 *
 * A relay that funds new wallets says so in its onboard/finalize answer and
 * pays in the background: the party is seconds old, and the synchronizer may
 * not know it yet. A new wallet has no transfer preapproval, so the grant
 * arrives as a pending transfer offer, and only the wallet's own key can
 * accept it. So the client watches for the offer and accepts it with the same
 * accept `claim` runs. Nothing here can move funds out.
 */
import { claimAll } from "./tx.js";
import type { RelayClient } from "./relay-client.js";
import type { AgentWallet } from "./store.js";

/** What the relay said it will send (onboard/finalize `starterGrant`). */
export interface StarterGrant {
  amountCc: string;
}

export interface StarterGrantResult {
  /**
   * accepted: the grant is in the wallet.
   * not_arrived: no offer showed up in time. It may still come, and `claim`
   *   accepts it; an offer that is never accepted expires and goes back.
   * failed: an offer arrived but accepting it failed; `claim` can retry.
   */
  status: "accepted" | "not_arrived" | "failed";
  amountCc: string;
  updateIds: string[];
  error?: string;
}

export interface AcceptStarterGrantOpts {
  /** Give up after this long. Default 90 s: the relay may retry for ~20 s
   *  while the new party propagates, and grants are paid one at a time. */
  timeoutMs?: number;
  /** Poll interval for the offer. Default 3 s. */
  pollMs?: number;
}

/** A Canton Coin offer that can still be accepted. The grant is Canton Coin;
 *  a row without an instrument comes from a relay that only lists CC. */
function isLiveCcOffer(
  p: { instrumentId?: { id: string } | undefined; executeBefore?: string | undefined },
  nowMs: number
): boolean {
  if (p.instrumentId !== undefined && p.instrumentId.id !== "Amulet") return false;
  return p.executeBefore === undefined || Date.parse(p.executeBefore) > nowMs;
}

/** Wait for the starter grant's offer and accept it. Never throws. */
export async function acceptStarterGrant(
  relay: RelayClient,
  wallet: AgentWallet,
  grant: StarterGrant,
  opts: AcceptStarterGrantOpts = {}
): Promise<StarterGrantResult> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const pollMs = opts.pollMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  const base = { amountCc: grant.amountCc, updateIds: [] as string[] };
  let acceptError: string | undefined;
  let pollError: string | undefined;
  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
  for (;;) {
    let offered = false;
    try {
      const { pending } = await relay.pending(wallet.party);
      offered = pending.some((p) => isLiveCcOffer(p, Date.now()));
    } catch (err) {
      pollError = message(err);
    }
    if (offered) {
      try {
        const r = await claimAll(relay, wallet);
        if (r.claimed > 0) return { ...base, status: "accepted", updateIds: r.updateIds };
        if (r.failed.length > 0) acceptError = r.failed.map((f) => f.error).join("; ");
      } catch (err) {
        acceptError = message(err);
      }
    }
    if (Date.now() + pollMs > deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (acceptError !== undefined) return { ...base, status: "failed", error: acceptError };
  return { ...base, status: "not_arrived", ...(pollError !== undefined ? { error: pollError } : {}) };
}
