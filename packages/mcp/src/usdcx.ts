/**
 * Paying in USDCx: which instrument it is, and how its balance is read for the
 * spend counter.
 */
import { KNOWN_INSTRUMENTS, instrumentKey, type RelayClient } from "@ftptech/canton-agent-wallet";

/** MainNet USDCx, as the signer's consent list and instrument caps key it. */
const USDCX = KNOWN_INSTRUMENTS["USDCx"]!;
export const USDCX_INSTRUMENT_KEY = instrumentKey(USDCX.admin, USDCX.id);

/**
 * The wallet's USDCx total, or undefined when it cannot be known: the read
 * failed, or the relay answered a bounded read that may not list every USDCx
 * holding. The caller then counts the full ceiling instead of a delta.
 */
export async function readUsdcxHolding(relay: RelayClient, party: string): Promise<number | undefined> {
  try {
    const h = await relay.holdings(party, { admin: USDCX.admin, id: USDCX.id }, { slice: true });
    if (!h.complete) return undefined;
    let total = 0;
    for (const i of h.instruments) {
      if (instrumentKey(i.admin, i.id) === USDCX_INSTRUMENT_KEY) total += Number(i.total);
    }
    return Number.isFinite(total) ? total : undefined;
  } catch {
    return undefined;
  }
}
