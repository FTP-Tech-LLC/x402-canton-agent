/**
 * withdraw — send the agent's CC back out to any party (e.g. the human who
 * funded it). Default sends the full balance; pass an explicit amount for a
 * partial withdrawal. Same self-custody transfer primitive as paying a
 * merchant: the agent signs locally, the relay only forwards.
 */
import { loadWallet, type AgentWallet } from "./store.js";
import { RelayClient } from "./relay-client.js";
import { transfer } from "./tx.js";
import { resolveHashBinding } from "./hash-binding.js";
import { resolveTrustedRegistryParties } from "./registry-parties.js";
import { venueMetaForInstrument } from "./venue.js";
import { sumLedgerDecimals, compareLedgerDecimals } from "@ftptech/x402-canton-core";
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
  /**
   * Withdraw a REGISTRY (CIP-56) token instead of Canton Coin: the instrument
   * id at its registrar (e.g. "USDCx"), paired with `instrumentAdmin` naming the
   * registrar. Inputs are then read through the HoldingV1 interface — /balance
   * only ever counts Amulet — and the relay resolves the transfer on that
   * token's registry. Omitted: Canton Coin, exactly as before.
   */
  instrumentId?: string;
  /** Pre-loaded, IN-MEMORY wallet. When supplied, withdraw does NOT read the
   *  on-disk store (`loadWallet`). This lets a caller that reconstructed a wallet
   *  from a private-key PEM entirely in memory (e.g. the hosted pay-proxy
   *  `/withdraw`, whose NON-NEGOTIABLE rule is that the key never touches disk)
   *  reuse the same balance-check + DSO-pin + hash-binding transfer path as the
   *  CLI. Defaults to `loadWallet()` (the `canton-agent-wallet withdraw` path,
   *  unchanged). */
  wallet?: AgentWallet;
  /** Injectable relay client (tests, or a caller that already holds one bound to
   *  the same relayUrl). Defaults to a fresh RelayClient built from
   *  `wallet.relayUrl`. */
  relay?: RelayClient;
  /** Arbitrary on-ledger transfer meta to stamp onto the outgoing transfer.
   *  Used by the `swap` command to carry a pool's minimum-output value in the
   *  key the AMM parses. Advisory / not money-critical (verify-before-sign does
   *  not pin transfer meta); omitted → no meta, exactly as before. */
  meta?: Record<string, string>;
  /** Allow the registry two-step transfer-offer shape when the receiver has no
   *  preapproval (a swap to a Tradecraft pool). Threaded to verify-before-sign;
   *  only set by `swap` for a registry input. Default false — a plain withdraw to
   *  a non-preapproved registry receiver still fails closed. */
  allowRegistryOffer?: boolean;
}

export async function withdraw(
  opts: WithdrawOpts
): Promise<{ updateId: string; amount: string }> {
  const wallet = opts.wallet ?? loadWallet();
  if (!wallet) throw new Error("no wallet — run `create` first");
  const relay =
    opts.relay ??
    new RelayClient({ relayUrl: wallet.relayUrl, apiKey: opts.apiKey });
  // A registry token needs BOTH halves: the registrar (admin) and the id. One
  // without the other cannot name an instrument, so it is refused here rather
  // than silently falling back to Canton Coin — sending the wrong asset to an
  // external address is the one mistake a withdraw must never make.
  const isRegistry = opts.instrumentId !== undefined;
  if (isRegistry && !opts.instrumentAdmin) {
    throw new Error(
      `withdraw: instrumentId ${JSON.stringify(opts.instrumentId)} needs instrumentAdmin ` +
        `(the registrar party) alongside it`
    );
  }
  if (isRegistry && opts.instrumentId === "Amulet") {
    throw new Error("withdraw: Amulet is Canton Coin — omit instrumentId to withdraw CC");
  }

  // Read the balance once: it's both the default (full) amount and the
  // pre-flight check so an over-balance / zero withdraw fails FAST with a clear
  // message instead of a cryptic relay 502 (prepare can't fund) downstream.
  //
  // For a registry token the balance comes from the HoldingV1 read, and only
  // UNLOCKED holdings count: a locked holding is owned but not spendable, and
  // offering it as an input would fail at the ledger after the user committed
  // to the amount.
  let available: string;
  let inputCids: string[] | undefined;
  let unit: string;
  if (isRegistry) {
    const h = await relay.holdings(wallet.party, {
      admin: opts.instrumentAdmin!,
      id: opts.instrumentId!,
    });
    const ins = h.instruments[0];
    const spendable = (ins?.holdings ?? []).filter((x) => !x.locked);
    // Exact sum: a float total can land an atomic ABOVE what the wallet holds,
    // and that number is both the transfer amount and the pre-flight guard.
    available = sumLedgerDecimals(spendable.map((x) => x.amount));
    inputCids = spendable.map((x) => x.cid);
    unit = opts.instrumentId!;
  } else {
    const bal = await relay.balance(wallet.party);
    available = bal.cc;
    unit = "CC";
  }
  const amount = opts.amount ?? available;
  let positive = false;
  try {
    positive = compareLedgerDecimals(amount, "0") > 0;
  } catch {
    positive = false;
  }
  if (!positive) {
    throw new Error(
      `withdraw amount must be a positive number (got ${JSON.stringify(amount)})`
    );
  }
  if (compareLedgerDecimals(amount, available) > 0) {
    throw new Error(
      `insufficient funds: wallet balance is ${available} ${unit} but ${amount} ${unit} was requested`
    );
  }
  const instrumentAdmin =
    opts.instrumentAdmin ?? resolveTrustedDsoParty(process.env, wallet.network);
  // Attribution: stamp the issuer's `/venue` key when withdrawing an attributed
  // registry token (CBTC). Keyed off the RAW opts instrument (not the DSO-resolved
  // `instrumentAdmin` above), so a CC withdraw — opts.instrumentAdmin undefined —
  // never carries it. Merged UNDER any caller meta, so an explicit key wins and the
  // swap's slippage memo (a different key) survives alongside it.
  const meta = {
    ...venueMetaForInstrument(opts.instrumentAdmin, opts.instrumentId, process.env),
    ...opts.meta,
  };
  const updateId = await transfer(relay, wallet, {
    receiver: opts.to,
    amount,
    hashBinding: opts.hashBinding ?? resolveHashBinding(),
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
    ...(instrumentAdmin !== undefined ? { expectInstrumentAdmin: instrumentAdmin } : {}),
    ...(isRegistry
      ? {
          registryInstrument: true,
          expectInstrumentId: opts.instrumentId!,
          inputHoldingCids: inputCids!,
          trustedRegistryParties: resolveTrustedRegistryParties(
            opts.instrumentAdmin!,
            process.env
          ),
          ...(opts.allowRegistryOffer === true ? { allowRegistryOffer: true } : {}),
        }
      : {}),
  });
  return { updateId, amount };
}
