/**
 * withdraw — send the agent's CC back out to any party (e.g. the human who
 * funded it). Default sends the full balance; pass an explicit amount for a
 * partial withdrawal. Same self-custody transfer primitive as paying a
 * merchant: the agent signs locally, the relay only forwards.
 */
import { loadWallet } from "./store.js";
import { RelayClient } from "./relay-client.js";
import { transfer } from "./tx.js";
import { resolveHashBinding } from "./hash-binding.js";
import { resolveTrustedDsoParty } from "./trusted-dso.js";
import type { HashBindingOptions } from "./verify-prepared.js";

export interface WithdrawOpts {
  to: string;
  /** Atomic CC amount; omit to send the full balance. */
  amount?: string;
  apiKey?: string | undefined;
  /** Override how the relay hash is bound to the validated bytes (see tx.ts). */
  hashBinding?: HashBindingOptions;
  /** Independently-trusted Amulet DSO (instrument admin) to pin. Defaults to
   *  CANTON_AGENT_DSO_PARTY (see trusted-dso.ts) — without it a relay-prepared tx
   *  that carries the DSO outside the root choice arg fails closed. */
  instrumentAdmin?: string;
}

export async function withdraw(
  opts: WithdrawOpts
): Promise<{ updateId: string; amount: string }> {
  const wallet = loadWallet();
  if (!wallet) throw new Error("no wallet — run `create` first");
  const relay = new RelayClient({ relayUrl: wallet.relayUrl, apiKey: opts.apiKey });
  // Read the balance once: it's both the default (full) amount and the
  // pre-flight check so an over-balance / zero withdraw fails FAST with a clear
  // message instead of a cryptic relay 502 (prepare can't fund) downstream.
  const bal = await relay.balance(wallet.party);
  const amount = opts.amount ?? bal.cc;
  if (!(Number(amount) > 0)) {
    throw new Error(
      `withdraw amount must be a positive number (got ${JSON.stringify(amount)})`
    );
  }
  if (Number(amount) > Number(bal.cc)) {
    throw new Error(
      `insufficient funds: wallet balance is ${bal.cc} CC but ${amount} CC was requested`
    );
  }
  const instrumentAdmin =
    opts.instrumentAdmin ?? resolveTrustedDsoParty(process.env, wallet.network);
  const updateId = await transfer(relay, wallet, {
    receiver: opts.to,
    amount,
    hashBinding: opts.hashBinding ?? resolveHashBinding(),
    ...(instrumentAdmin !== undefined ? { expectInstrumentAdmin: instrumentAdmin } : {}),
  });
  return { updateId, amount };
}
