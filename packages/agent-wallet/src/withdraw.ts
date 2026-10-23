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
import {
  sumLedgerDecimals,
  compareLedgerDecimals,
  decimalToAtomicCC,
} from "@ftptech/x402-canton-core";
import { MAX_TRANSFER_INPUTS_REGISTRY } from "@ftptech/x402-canton-ledger";
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
   *  not pin transfer meta); omitted → only the venue tag on a registry token
   *  (see venue.ts), no meta on Canton Coin. */
  meta?: Record<string, string>;
  /** Allow the registry two-step transfer-offer shape when the receiver has no
   *  preapproval (a swap to a Tradecraft pool). Threaded to verify-before-sign;
   *  only set by `swap` for a registry input. Default false — a plain withdraw to
   *  a non-preapproved registry receiver still fails closed. */
  allowRegistryOffer?: boolean;
}

function assertPositive(amount: string): void {
  let positive = false;
  try {
    positive = compareLedgerDecimals(amount, "0") > 0;
  } catch {
    positive = false;
  }
  if (!positive) {
    throw new Error(`withdraw amount must be a positive number (got ${JSON.stringify(amount)})`);
  }
}

export async function withdraw(
  opts: WithdrawOpts
): Promise<{ updateId: string; amount: string; landed: boolean | null }> {
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
  let amount: string;
  if (isRegistry) {
    // BOUNDED read, narrowed by the relay to this token: a wallet whose
    // holdings of it cannot all be listed in one read gets part of them
    // (complete:false) instead of a 413 — other tokens' dust no longer counts.
    // That is enough to SPEND from, never enough to know the balance — so a
    // full withdraw, or a shortfall, on an incomplete read points at `merge`
    // instead of quoting a number that is only a lower bound.
    const h = await relay.holdings(
      wallet.party,
      { admin: opts.instrumentAdmin!, id: opts.instrumentId! },
      { slice: true }
    );
    const { complete } = h;
    const ins = h.instruments[0];
    const spendable = (ins?.holdings ?? []).filter((x) => !x.locked);
    // Exact sum: a float total can land an atomic ABOVE what the wallet holds,
    // and that number is both the transfer amount and the pre-flight guard.
    available = sumLedgerDecimals(spendable.map((x) => x.amount));
    unit = opts.instrumentId!;
    const mergeHint =
      `canton-agent-wallet merge --admin ${opts.instrumentAdmin} --id ${opts.instrumentId}` +
      ` (or --all-tokens)`;
    if (opts.amount === undefined && !complete) {
      throw new Error(
        `withdraw: this wallet holds more ${unit} holdings than the participant lists in one read, ` +
          `so its full balance is not known. Consolidate first with: ${mergeHint} — or pass --amount.`
      );
    }
    amount = opts.amount ?? available;
    assertPositive(amount);
    if (compareLedgerDecimals(amount, available) > 0) {
      throw new Error(
        complete
          ? `insufficient funds: wallet balance is ${available} ${unit} but ${amount} ${unit} was requested`
          : `withdraw: only ${available} ${unit} is visible among this wallet's oldest holdings — it ` +
              `holds more than the participant lists in one read. Consolidate first with: ${mergeHint}`
      );
    }
    // The fewest holdings that cover the amount, largest first: the registry
    // returns the rest as change, and a transaction may spend at most
    // MAX_TRANSFER_INPUTS_REGISTRY before it hits the 256-node cap.
    const byAmount = [...spendable].sort((a, b) => {
      const d = BigInt(decimalToAtomicCC(b.amount)) - BigInt(decimalToAtomicCC(a.amount));
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    });
    const want = BigInt(decimalToAtomicCC(amount));
    // The cap binds only when choosing from a slice; a complete read keeps the
    // old behaviour and may spend every holding it needs.
    const maxInputs = complete ? Number.POSITIVE_INFINITY : MAX_TRANSFER_INPUTS_REGISTRY;
    const picked: typeof spendable = [];
    let got = 0n;
    for (const x of byAmount) {
      if (got >= want || picked.length >= maxInputs) break;
      picked.push(x);
      got += BigInt(decimalToAtomicCC(x.amount));
    }
    if (got < want) {
      throw new Error(
        `withdraw: ${amount} ${unit} is spread over more than ${MAX_TRANSFER_INPUTS_REGISTRY} holdings, more ` +
          `than one transfer can spend. Consolidate first with: ${mergeHint}`
      );
    }
    inputCids = picked.map((x) => x.cid);
  } else {
    const bal = await relay.balance(wallet.party);
    available = bal.cc;
    unit = "CC";
    amount = opts.amount ?? available;
    assertPositive(amount);
    if (compareLedgerDecimals(amount, available) > 0) {
      throw new Error(
        `insufficient funds: wallet balance is ${available} ${unit} but ${amount} ${unit} was requested`
      );
    }
  }
  const instrumentAdmin =
    opts.instrumentAdmin ?? resolveTrustedDsoParty(process.env, wallet.network);
  // Attribution: stamp the `/venue` tag (on by default) when withdrawing a
  // registry token. Keyed off the RAW opts instrument (not the DSO-resolved
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
  // DID IT ACTUALLY LAND? A transfer to a receiver holding a TransferPreapproval
  // settles DIRECT — the funds are in their wallet when this returns. Without one
  // it settles as a pending OFFER the receiver must `claim`, and until they do,
  // the money is on-ledger but NOT spendable by them. Reporting both as a bare
  // "withdrew N to <party>" reads as delivery in the case where nothing has been
  // delivered yet, so the caller is told which happened.
  //
  // Queried AFTER the send: the transfer has already committed, so a failure here
  // can only cost us the label, never the money. `hasPreapproval` is tri-state and
  // `null` means the relay could not say (an older relay omits `expiresAt` and
  // answers null) — that is UNKNOWN, never "landed", so it is passed through as
  // null and the caller stays silent rather than claiming either outcome.
  //
  // The instrument must be NAMED to ask: for Canton Coin that is the resolved DSO
  // (which `resolveTrustedDsoParty` may not know for an unconfigured network) and
  // for a registry token the registrar. With no admin in hand the question cannot
  // be posed, so it stays unknown rather than guessed.
  const statusAdmin = isRegistry ? opts.instrumentAdmin : instrumentAdmin;
  let landed: boolean | null = null;
  if (statusAdmin !== undefined) {
    try {
      const st = await relay.preapprovalStatus(
        opts.to,
        statusAdmin,
        isRegistry ? opts.instrumentId! : "Amulet"
      );
      landed = st.hasPreapproval;
    } catch {
      landed = null; // unreachable/older relay: unknown, not "delivered"
    }
  }
  return { updateId, amount, landed };
}
