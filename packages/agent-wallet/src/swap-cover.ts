/**
 * A swap the wallet cannot cover, refused before anything is paid.
 *
 * The swap endpoint's ticket is itself a payment (0.01 CC), bought before the
 * swap runs. Without this check a swap of more than the wallet holds bought the
 * ticket and only then failed on the balance (MainNet, 2026-11-04: CLI 2.7.0,
 * `swap --in CC --amount 1000` on a 15 CC wallet paid 0.01 CC each time). The
 * MCP `swap` tool had the same check inline since 2.6.0.
 */
import { atomicToDecimalCC, decimalToAtomicCC, sumLedgerDecimals } from "@ftptech/x402-canton-core";
import type { RelayClient } from "./relay-client.js";
import type { SwapIntent } from "./swap-route.js";

/** The swap endpoint's live ticket fee, in CC, for this check only: the
 *  endpoint's 402 sets the real price. */
export const SWAP_TICKET_FEE_CC = "0.01";

const atomic = (d: string): bigint | undefined => {
  try {
    return BigInt(decimalToAtomicCC(d));
  } catch {
    return undefined;
  }
};
const decimal = (a: bigint): string => atomicToDecimalCC(a.toString()).replace(/\.?0+$/, "");

/**
 * Why the wallet cannot cover `amount` of the intent's input plus `feeCc`
 * ("0" when no ticket is bought), or undefined when it can, or when a read
 * failed or was partial (the send then checks the balance itself, as before).
 * The text says that nothing was paid.
 */
export async function swapNotCovered(
  relay: Pick<RelayClient, "balance" | "holdings">,
  party: string,
  intent: SwapIntent,
  amount: string,
  feeCc: string
): Promise<string | undefined> {
  const want = atomic(amount);
  const fee = atomic(feeCc) ?? 0n;
  if (want === undefined) return undefined;
  let cc: bigint | undefined;
  try {
    cc = atomic((await relay.balance(party)).cc);
  } catch {
    return undefined;
  }
  if (cc === undefined) return undefined;
  const feeText = fee > 0n ? ` plus the ${feeCc} CC ticket fee` : "";
  if (intent.inInstrument === null) {
    if (want + fee <= cc) return undefined;
    const most = cc > fee ? decimal(cc - fee) : "0";
    return (
      `swap: the wallet has ${decimal(cc)} CC, less than ${amount} CC${feeText}. Swap at most ${most} CC. ` +
      "Nothing was paid. CC in an incoming offer counts once `claim` has taken it."
    );
  }
  if (fee > cc) {
    return `swap: the wallet has ${decimal(cc)} CC, less than the ${feeCc} CC ticket fee. Nothing was paid.`;
  }
  const inst = intent.inInstrument;
  try {
    const h = await relay.holdings(party, inst, { slice: true });
    if (!h.complete) return undefined;
    const rows = h.instruments.find((i) => i.admin === inst.admin && i.id === inst.id)?.holdings ?? [];
    const free = atomic(sumLedgerDecimals(rows.filter((r) => !r.locked).map((r) => r.amount)));
    if (free === undefined || want <= free) return undefined;
    const locked = atomic(sumLedgerDecimals(rows.filter((r) => r.locked).map((r) => r.amount))) ?? 0n;
    return (
      `swap: the wallet can spend ${decimal(free)} ${intent.inCanon}, less than ${amount}` +
      (locked > 0n ? ` (${decimal(locked)} more is locked, in an offer or an allocation)` : "") +
      ". Nothing was paid."
    );
  } catch {
    return undefined;
  }
}
