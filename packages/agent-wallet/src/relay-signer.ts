/**
 * makeRelaySigner — a CantonSigner backed by the facilitator relay + the agent's
 * self-custody key. It implements the transfer-factory x402 transfer method:
 *
 *   - `signTransferFactory` (transfer-factory, "V3", 1-tx meta-transaction):
 *     the relay PREPARES a token-standard `TransferFactory_Transfer` (sender =
 *     the agent, receiver = the merchant); verify-before-sign pins every
 *     money-critical field, the agent signs locally, and the signed transaction
 *     is carried INLINE in the payment payload for the facilitator to relay at
 *     /settle.
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
import { venueMetaForInstrument } from "./venue.js";
import {
  resolveTrustedRegistryParties,
  isPayableInstrument,
  instrumentKey,
} from "./registry-parties.js";
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
    /**
     * Optional spend ceiling: the MAX this signer will EVER sign for, **in CC**
     * — the ledger Decimal, e.g. `"0.05"`. NOT the atomic integer the 402
     * quotes.
     *
     * This doc used to say "the same unit the 402 quotes", which is wrong and
     * wrong in the dangerous direction. The 402 carries `amount` as an atomic
     * integer ("500000000" for 0.05 CC); the client converts it once
     * (`wireAmountToLedgerDecimal`, the off-by-10^10 firewall) and hands the
     * signer the ledger Decimal, which is what `input.amount` is here and what
     * this compares against. A caller who followed the old sentence and wrote
     * `"500000000"` meaning 0.05 CC got a ceiling of five hundred million CC:
     * the guard was present, configured, and could never fire.
     *
     * Comparing in CC is the correct half — it bounds what is actually signed —
     * so the fix is this sentence, not the comparison. Pinned by a test that
     * fails if the unit ever drifts back.
     *
     * When set, the signer REFUSES to sign — fail closed, before any relay call
     * — if the to-be-signed amount exceeds it. That is what makes the spend
     * breaker load-bearing against an over-quoting (or MITM'd) merchant.
     * Omitted → no ceiling.
     */
    maxPaymentValue?: string;
    /**
     * Registry (non-Amulet) instruments this signer MAY PAY IN, as
     * `"<admin>|<id>"`. Empty/omitted means Canton Coin only, which is the
     * secure default: being able to VERIFY a registry token is not consent to
     * SPEND it, and without this the 402 author picks the denomination.
     * Falls back to CANTON_AGENT_PAYABLE_INSTRUMENTS.
     */
    payableInstruments?: readonly string[];
    /**
     * Per-instrument ceilings, keyed `"<admin>|<id>"`, in that instrument's own
     * ledger Decimal. `maxPaymentValue` denominates CANTON COIN and cannot
     * stand in for a token whose unit is worth something else.
     */
    maxPaymentValueByInstrument?: Readonly<Record<string, string>>;
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
  // The amount is compared as a Number in the SAME unit as `input.amount` —
  // the ledger Decimal (CC), which is what the client hands the signer and what
  // the balance fast-fail already uses (`Number(bal.cc) < Number(amount)`). The
  // 402's atomic integer never reaches here.
  const enforceSpendLimits = (
    to: string,
    amount: string,
    /** The registry instrument being paid, or undefined for Canton Coin. */
    registryInstrument?: { admin: string; id: string }
  ): void => {
    if (opts.expectedPayTo !== undefined && to !== opts.expectedPayTo) {
      throw new Error(
        `refusing to sign: payee ${to} does not match the expected payTo ` +
          `${opts.expectedPayTo} (a merchant cannot redirect this payment)`
      );
    }
    if (registryInstrument !== undefined) {
      // CONSENT, not trust. See isPayableInstrument.
      if (
        !isPayableInstrument(
          registryInstrument.admin,
          registryInstrument.id,
          opts.payableInstruments,
          process.env
        )
      ) {
        throw new Error(
          `refusing to sign: this wallet is not configured to spend ` +
            `${instrumentKey(registryInstrument.admin, registryInstrument.id)}. ` +
            `Trusting a registry lets us VERIFY its transfers; spending it is a ` +
            `separate opt-in (payableInstruments / ${"CANTON_AGENT_PAYABLE_INSTRUMENTS"}).`
        );
      }
    }
    // Which ceiling applies, and in WHOSE unit. maxPaymentValue denominates
    // Canton Coin; reusing that number for a token whose unit is worth
    // something else would let the 402 author choose the denomination of the
    // operator's cap. A registry payment therefore needs its own ceiling, and
    // a configured-but-wrong-denomination cap fails closed rather than being
    // reinterpreted.
    const capRaw =
      registryInstrument === undefined
        ? opts.maxPaymentValue
        : opts.maxPaymentValueByInstrument?.[
            instrumentKey(registryInstrument.admin, registryInstrument.id)
          ];
    if (
      registryInstrument !== undefined &&
      opts.maxPaymentValue !== undefined &&
      capRaw === undefined
    ) {
      throw new Error(
        `refusing to sign: maxPaymentValue is denominated in Canton Coin and ` +
          `this payment is in ` +
          `${instrumentKey(registryInstrument.admin, registryInstrument.id)}. ` +
          `Set maxPaymentValueByInstrument for it, or clear maxPaymentValue.`
      );
    }
    if (capRaw !== undefined) {
      const want = Number(amount);
      const cap = Number(capRaw);
      // A configured-but-broken ceiling must FAIL CLOSED, never silently disable
      // the cap: `want > NaN` is always false, so a non-finite cap would wave
      // every amount through. Refuse to sign instead.
      if (!Number.isFinite(cap)) {
        throw new Error(
          `refusing to sign: configured max payment value ` +
            `${JSON.stringify(capRaw)} is not a finite number`
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
            `payment value ${capRaw} (the merchant over-quoted)`
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
      // The instrument has to be known BEFORE the spend guard runs, because the
      // guard's answer depends on it: consent and the ceiling are both
      // per-instrument. Determining it here rather than below is the whole
      // ordering fix — the guard used to run first and therefore judged every
      // asset by the Canton Coin ceiling.
      const _admin = input.instrumentId.admin;
      const _registryTrusted = resolveTrustedRegistryParties(_admin, process.env);
      const _isRegistry = _registryTrusted.size > 0;
      enforceSpendLimits(
        input.receiver,
        input.amount,
        _isRegistry ? { admin: _admin, id: input.instrumentId.id } : undefined
      );
      // Carry the merchant-required memo (stamped by the x402 client into
      // transferMeta as `x402.memo` from PaymentRequirements.extra.memo) through
      // to the relay prepare so it lands in the transfer's meta, which the payer
      // signs. Advisory only — not pinned by verify-before-sign (non-money-
      // critical); the merchant's /verify is what enforces it.
      const memo = input.transferMeta?.["x402.memo"];
      // Venue attribution: for a registry-token payment, stamp the wallet's
      // configured `/venue` tag into the transfer meta (relay-side, alongside
      // x402.memo) so an issuer's incentive program can attribute this payment.
      // Empty unless CANTON_AGENT_VENUE_KEY + _TAG are set; never for Amulet.
      const venueMeta = _isRegistry
        ? venueMetaForInstrument(_admin, input.instrumentId.id, process.env)
        : {};
      const trustedDso =
        opts.trustedDso ?? resolveTrustedDsoParty(process.env, wallet.network);
      // Instrument-admin trust, OUT-OF-BAND for BOTH families:
      //  - Amulet: the admin IS the DSO; pin the independently-resolved DSO, never
      //    the 402-supplied value (unchanged behaviour).
      //  - Registry token (USDCx, …): pin the 402-supplied admin ONLY when it is a
      //    KNOWN/CONFIGURED registry admin (resolveTrustedRegistryParties non-empty
      //    — an out-of-band anchor), and admit that registry's infra parties
      //    (operator/bridge) in the foreign-party backstop. An admin we have no
      //    out-of-band anchor for stays on the DSO path and fails closed on the
      //    structural instrument check — a relay cannot get an arbitrary admin
      //    trusted.
      const admin = _admin;
      const registryTrusted = _registryTrusted;
      const isRegistry = _isRegistry;
      const expectInstrumentAdmin = isRegistry ? admin : trustedDso;
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
          ...(expectInstrumentAdmin !== undefined
            ? { expectInstrumentAdmin }
            : {}),
          // Send instrumentId to the relay only for a registry token; Amulet omits
          // it (the DSO is not a configured registry) but keeps the backstop pin.
          registryInstrument: isRegistry,
          ...(isRegistry ? { trustedRegistryParties: registryTrusted } : {}),
          ...(memo !== undefined ? { memo } : {}),
          ...(Object.keys(venueMeta).length > 0 ? { venueMeta } : {}),
        })
      );
      // Hand the scheme builder the signed bytes so the payload carries the
      // transaction itself and resolves at ANY facilitator — the only carriage.
      return {
        payerParty: r.payerParty,
        // Hex, as the scheme's wire form requires — NOT the base64 `txHash`.
        preparedTxHash: r.preparedTxHashHex,
        preparedTransactionBytes: r.preparedTransactionBytes,
        signatureB64: r.signatureB64,
        hashingSchemeVersion: r.hashingSchemeVersion,
      };
    },
  };
}
