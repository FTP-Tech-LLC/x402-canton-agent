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
import { assetMatches, type PaymentRequirements } from "@ftptech/x402-canton-core";
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
  /**
   * Pay in the `accepts[]` entry whose asset matches this symbol (e.g.
   * `"USDCx"`, case-insensitive) when a 402 offers several. An explicitly
   * requested asset the 402 does not offer FAILS CLOSED (error naming the
   * offered instruments) — never a silent fallback to the merchant's first
   * entry. Omitted → today's "first compatible" default, unchanged. This
   * chooses which instrument to pay in; it is NOT consent to spend it: a
   * registry token still requires `CANTON_AGENT_PAYABLE_INSTRUMENTS`, and a
   * preferred-but-unconsented asset fails closed with the usual consent error.
   */
  preferAsset?: string;
}

/**
 * Build the `selectRequirements` tiebreaker for a preferred asset symbol, or
 * `undefined` when none is set (so the client keeps its default "first compatible
 * entry"). Matches by asset symbol (via the x402-ENVELOPE `assetMatches`) or the
 * structured `instrumentId.id`, case-insensitively. An EXPLICITLY requested
 * asset the 402 does not offer FAILS CLOSED with the offered list — silently
 * paying whatever the merchant listed first is exactly the surprise a payer who
 * named an instrument was trying to rule out. Pure + exported for unit testing.
 *
 * @param preferAsset - The asset symbol to prefer, e.g. `"USDCx"`, or undefined.
 * @returns A selector over the compatible candidates, or undefined.
 */
export function buildPreferAssetSelector(
  preferAsset: string | undefined
): ((cands: PaymentRequirements[]) => PaymentRequirements) | undefined {
  if (!preferAsset) return undefined;
  const want = preferAsset.toLowerCase();
  return (cands: PaymentRequirements[]): PaymentRequirements => {
    const hit = cands.find(
      (a) =>
        assetMatches(a.asset, preferAsset) ||
        a.asset.toLowerCase() === want ||
        a.extra?.instrumentId?.id?.toLowerCase() === want
    );
    if (hit) return hit;
    const offered = [
      ...new Set(cands.map((a) => a.extra?.instrumentId?.id ?? a.asset)),
    ].join(", ");
    throw new Error(
      `--asset ${preferAsset}: the 402 does not offer that instrument (offered: ${offered}). ` +
        `Pass one of those, or drop --asset to pay the first offered entry.`
    );
  };
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
    | "apiKey"
    | "hashBinding"
    | "maxPaymentRetries"
    | "maxPaymentValue"
    | "expectedPayTo"
    | "preferAsset"
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
  // When a preferred asset is set, pick the matching accepts[] entry; else the
  // first compatible entry — identical to the default when no preference is given.
  const selectRequirements = buildPreferAssetSelector(opts.preferAsset);
  const paying = wrapFetchWithCantonPayment(globalThis.fetch, signer, {
    ...(opts.maxPaymentRetries !== undefined
      ? { maxPaymentRetries: opts.maxPaymentRetries }
      : {}),
    ...(selectRequirements ? { selectRequirements } : {}),
  });

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
    // The peek must run the SAME selection as the paying fetch — including the
    // preferred-asset tiebreaker — or the lock decision could be made for one
    // accepts[] entry while a different one is paid. Today every compatible
    // entry is transfer-factory, so a divergence would be inert; pinning the
    // selector here keeps it inert when that stops being true.
    const method = peekChosenTransferMethod(
      probe,
      signer,
      selectRequirements ? { selectRequirements } : {}
    );
    // Only serialize when we cannot determine the method (fail-safe). A
    // recognized no-nonce method (transfer-factory) skips the lock.
    const needsSerialization = method === undefined;
    if (!needsSerialization) return paying(input, init);
    return withPayLock(lockHome, () => paying(input, init));
  };
}
