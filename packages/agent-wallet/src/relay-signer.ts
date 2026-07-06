/**
 * makeRelaySigner — a CantonSigner backed by the facilitator relay + the agent's
 * self-custody key. It implements the transfer-factory x402 transfer method:
 *
 *   - `signTransferFactory` (transfer-factory, "V3", 1-tx meta-transaction):
 *     the relay PREPARES a token-standard `TransferFactory_Transfer` (sender =
 *     the agent, receiver = the merchant); verify-before-sign pins every
 *     money-critical field, the agent signs locally, and the relay stashes the
 *     signed submission for the facilitator to relay at /settle.
 *
 * The x402 client (`ExactCantonScheme`) calls `signTransferFactory` when the
 * 402's `extra.assetTransferMethod === "transfer-factory"` (see scheme.ts). The
 * relay only prepares + forwards; it never holds the key, so it can never move
 * the agent's funds, and verify-before-sign + hash-binding keep the self-custody
 * guarantee.
 */
import type { CantonSigner } from "@ftptech/x402-canton-client";
import { RelayClient } from "./relay-client.js";
import {
  isStaleInputHoldingError,
  payViaTransferFactory,
} from "./tx.js";
import { resolveHashBinding } from "./hash-binding.js";
import { resolveTrustedDsoParty } from "./trusted-dso.js";
import type { AgentWallet } from "./store.js";
import type { HashBindingOptions } from "./verify-prepared.js";

/** Bounded backoff (ms) for retrying an allocate the relay rejected because its
 *  chosen input holding was STALE — the relay `/balance` ACS read lagged the
 *  validation state and handed back a holding the ledger had already archived
 *  (e.g. after a prior allocate whose execute timed out but still committed; a
 *  single-holding wallet then loops on the archived cid). Each retry re-runs the
 *  thunk, which re-reads balance + re-picks a holding. A healthy pay never
 *  retries; only `isStaleInputHoldingError` failures back off. Bounded — bubbles
 *  up after the last attempt. */
const STALE_INPUT_BACKOFF_MS = [1000, 2000, 4000, 8000, 12000];

export async function withStaleInputRetry<T>(
  run: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms))
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (
        attempt < STALE_INPUT_BACKOFF_MS.length &&
        isStaleInputHoldingError(err)
      ) {
        await sleep(STALE_INPUT_BACKOFF_MS[attempt]!);
        continue;
      }
      throw err;
    }
  }
}

export function makeRelaySigner(
  wallet: AgentWallet,
  opts: {
    apiKey?: string | undefined;
    hashBinding?: HashBindingOptions;
    /** Independently-trusted Amulet DSO (instrument admin / expectedDso) to pin
     *  on both arms. Defaults to CANTON_AGENT_DSO_PARTY (see trusted-dso.ts).
     *  Without it, a relay-prepared tx that carries the DSO outside the root
     *  choice arg fails closed (the round-3 no-pin-fallback removal). */
    trustedDso?: string;
    /** Optional spend ceiling: the MAX amount this signer will EVER sign for, in
     *  the same unit the 402 quotes (compared against `input.amount`). When set,
     *  the signer REFUSES to sign — fail closed, before any relay call — if the
     *  to-be-signed amount exceeds it. This makes the spend breaker load-bearing
     *  against an over-quoting (or MITM'd) merchant: the agent never signs a
     *  charge larger than the caller authorized, no matter what the 402 returns.
     *  Omitted → no ceiling (legacy behavior; the published MCP/pay path is
     *  unaffected when unset). */
    maxPaymentValue?: string;
    /** Optional expected-payee pin: the ONLY recipient this signer will sign a
     *  transfer to (compared against `input.receiver`). When set, the signer
     *  REFUSES to sign — fail closed, before any relay call — if the 402's payTo
     *  is anything else, defending against a MITM'd merchant that swaps `payTo`
     *  to drain funds to an attacker. Omitted → no pin (legacy behavior). */
    expectedPayTo?: string;
  } = {}
): CantonSigner {
  const relay = new RelayClient({ relayUrl: wallet.relayUrl, apiKey: opts.apiKey });
  // Default to the env-resolved binding: the REAL conformant V2 hash recompute
  // (canton-hash.ts) unless the operator explicitly sets the
  // CANTON_AGENT_TRUST_RELAY_HASH escape hatch. A programmatic caller may pass a
  // different `recomputeHash` instead.
  const hashBinding = opts.hashBinding ?? resolveHashBinding();
  // The network-constant Amulet DSO, resolved OUT-OF-BAND (never from the relay):
  // pins the instrument admin / expectedDso so the foreign-party backstop can
  // safely exclude the honest DSO that legitimately appears in the transfer's
  // consequence. Resolved PER CALL so the v1 path keys off the PAYMENT network
  // (input.network from the 402) rather than the wallet's configured network —
  // auto-DSO then works for any mainnet payment no matter how the wallet was
  // created. Without a resolvable DSO, value-moving prepared bytes carrying it
  // outside the root choice arg are refused (fail-closed).
  // Spend breaker — applied at the TOP of BOTH signer arms, fail-CLOSED, BEFORE
  // any relay call. Refuses to sign a merchant-quoted amount above the caller's
  // ceiling or to a payee the caller did not authorize. Both pins are OPTIONAL;
  // unset means the corresponding check is skipped (legacy behavior preserved).
  // The amount is compared as a Number in the SAME unit as `input.amount`,
  // matching the existing balance fast-fail (`Number(bal.cc) < Number(amount)`).
  const enforceSpendLimits = (to: string, amount: string): void => {
    if (opts.expectedPayTo !== undefined && to !== opts.expectedPayTo) {
      throw new Error(
        `refusing to sign: payee ${to} does not match the expected payTo ` +
          `${opts.expectedPayTo} (a merchant cannot redirect this payment)`
      );
    }
    if (opts.maxPaymentValue !== undefined) {
      const want = Number(amount);
      const cap = Number(opts.maxPaymentValue);
      // A configured-but-broken ceiling must FAIL CLOSED, never silently disable
      // the cap: `want > NaN` is always false, so a non-finite cap would wave
      // every amount through. Refuse to sign instead.
      if (!Number.isFinite(cap)) {
        throw new Error(
          `refusing to sign: configured max payment value ` +
            `${JSON.stringify(opts.maxPaymentValue)} is not a finite number`
        );
      }
      if (!Number.isFinite(want)) {
        throw new Error(
          `refusing to sign: payment amount ${JSON.stringify(amount)} is not a ` +
            `finite number`
        );
      }
      if (want > cap) {
        throw new Error(
          `refusing to sign: payment amount ${amount} exceeds the max ` +
            `payment value ${opts.maxPaymentValue} (the merchant over-quoted)`
        );
      }
    }
  };
  return {
    party: wallet.party,
    async signTransferFactory(input) {
      // Spend breaker FIRST (fail-closed, before any relay call) — the agent
      // never signs a charge above the caller's ceiling or to a payee it did not
      // authorize.
      enforceSpendLimits(input.receiver, input.amount);
      const trustedDso =
        opts.trustedDso ?? resolveTrustedDsoParty(process.env, wallet.network);
      // Prepare (relay-built) → verify-before-sign (assertPreparedTransferMatches
      // pins sender/receiver/amount/instrument to intent) → sign → commit. A
      // stale-holding failure (the wallet spent/merged the pinned holdings after
      // prepare) re-prepares ONCE with fresh holdings (T5 liveness).
      const r = await withStaleInputRetry(() =>
        payViaTransferFactory(relay, wallet, {
          receiver: input.receiver,
          amount: input.amount,
          executeBeforeSeconds: input.executeBeforeSeconds,
          expectInstrumentId: input.instrumentId.id,
          hashBinding,
          ...(trustedDso !== undefined
            ? { expectInstrumentAdmin: trustedDso }
            : {}),
        })
      );
      return {
        payerParty: r.payerParty,
        submissionRef: r.submissionRef,
        preparedTxHash: r.txHash,
      };
    },
  };
}
