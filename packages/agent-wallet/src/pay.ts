/**
 * makePayingFetch — a drop-in fetch that auto-pays x402 challenges from the
 * agent's self-custody wallet. Lazily creates the wallet on first use, then
 * wraps fetch so any 402 is paid (relay PREPARES a token-standard
 * TransferFactory_Transfer → verify-before-sign → sign locally → the relay
 * stashes it for the facilitator to settle) and the request retried. The agent
 * just "fetches".
 */
import {
  wrapFetchWithCantonPayment,
  peekChosenTransferMethod,
} from "@ftptech/x402-canton-client";
import { ensureWallet, type EnsureWalletOpts } from "./onboard.js";
import { makeRelaySigner } from "./relay-signer.js";
import { withPayLock } from "./pay-lock.js";
import { walletDir, type AgentWallet } from "./store.js";
import type { HashBindingOptions } from "./verify-prepared.js";

export interface PayOpts extends EnsureWalletOpts {
  /** @deprecated ignored; the relay sets the participant user. */
  userId?: string;
  /**
   * How to bind the relay-returned hash to the validated bytes before signing
   * each autopay transfer. Omitted → the env-resolved default, which is the REAL
   * conformant V2 hash recompute (canton-hash.ts) unless CANTON_AGENT_TRUST_
   * RELAY_HASH opts into the escape hatch. Supply a `recomputeHash` to override.
   * See HashBindingOptions / verify-prepared.ts.
   */
  hashBinding?: HashBindingOptions;
  /** Max on-ledger re-pay attempts on a PERSISTING 402 (passed to
   *  wrapFetchWithCantonPayment; default 4). A custodial/proxy payer should set
   *  1 so one logical pay mints at most one extra Create, bounding gas burn if a
   *  merchant keeps returning 402. */
  maxPaymentRetries?: number;
  /** Optional spend ceiling threaded into the relay signer: the MAX amount the
   *  signer will EVER sign for (same unit the 402 quotes). When set, the autopay
   *  REFUSES — fail closed, before any relay call — to sign a merchant-quoted
   *  amount above it, so an over-quoting (or MITM'd) merchant can never get the
   *  agent to sign a charge larger than the caller authorized. Omitted → no
   *  ceiling (the published MCP/pay path is unaffected when unset). */
  maxPaymentValue?: string;
  /** Optional expected-payee pin threaded into the relay signer: the ONLY
   *  recipient the signer will sign a transfer to. When set, the autopay REFUSES
   *  to sign if the 402's payTo is anything else (MITM'd-merchant defense).
   *  Omitted → no pin (legacy behavior). */
  expectedPayTo?: string;
}

export async function makePayingFetch(
  opts: PayOpts
): Promise<typeof globalThis.fetch> {
  const wallet = await ensureWallet(opts);
  // The file-backed wallet serializes concurrent pays via a directory mutex in
  // its home (cross-process safe), so pass the home as the lock dir — behavior
  // is identical to before this was extracted.
  return makePayingFetchForWallet(wallet, opts, walletDir());
}

/**
 * Like makePayingFetch but for a wallet OBJECT you already hold — used by the
 * hosted quest one-shot, which mints a FRESH ephemeral wallet per request
 * (`ensureWallet({ ephemeral: true })`) and pays from it without ever persisting
 * it to disk. `lockHome` is the directory for the per-wallet pay mutex; OMIT it
 * for an ephemeral wallet — a throwaway wallet does exactly one pay, so there is
 * no same-wallet concurrency to serialize and no home directory to lock in.
 */
export async function makePayingFetchForWallet(
  wallet: AgentWallet,
  opts: Pick<
    PayOpts,
    "apiKey" | "hashBinding" | "maxPaymentRetries" | "maxPaymentValue" | "expectedPayTo"
  >,
  lockHome?: string
): Promise<typeof globalThis.fetch> {
  const signer = makeRelaySigner(wallet, {
    apiKey: opts.apiKey,
    ...(opts.hashBinding ? { hashBinding: opts.hashBinding } : {}),
    ...(opts.maxPaymentValue !== undefined
      ? { maxPaymentValue: opts.maxPaymentValue }
      : {}),
    ...(opts.expectedPayTo !== undefined
      ? { expectedPayTo: opts.expectedPayTo }
      : {}),
  });
  const paying = wrapFetchWithCantonPayment(
    globalThis.fetch,
    signer,
    opts.maxPaymentRetries !== undefined
      ? { maxPaymentRetries: opts.maxPaymentRetries }
      : {}
  );

  // Probe first WITHOUT the lock — only a request that actually challenges 402
  // enters the per-wallet queue, so non-paid traffic is never delayed. An
  // ephemeral wallet has no same-wallet concurrency and no home dir, so it always
  // skips the lock.
  //
  // METHOD-AWARE: the no-nonce transfer-factory path has no same-wallet
  // serialization constraint — each pay signs its OWN relay-prepared transfer
  // over freshly-read holdings, so serializing them only throttles throughput.
  // We therefore peek the method the pay will actually use and SKIP the lock for
  // a recognized (transfer-factory) method; `undefined` ("can't tell" — a
  // non-402-shaped/unparseable challenge) falls through to serialize as a
  // fail-safe.
  return async function payingFetch(input, init) {
    const probe = await globalThis.fetch(input, init);
    if (probe.status !== 402) return probe;
    if (lockHome === undefined) return paying(input, init);
    const method = peekChosenTransferMethod(probe, signer);
    // Only serialize when we cannot determine the method (fail-safe). A
    // recognized no-nonce method (transfer-factory) skips the lock.
    const needsSerialization = method === undefined;
    if (!needsSerialization) return paying(input, init);
    return withPayLock(lockHome, () => paying(input, init));
  };
}
