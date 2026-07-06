/**
 * wrapFetchWithCantonPayment — automate the x402 v2 "detect 402 →
 * pay → retry" flow against any Canton-aware facilitator.
 *
 * Usage:
 *
 *   const fetchWithPay = wrapFetchWithCantonPayment(globalThis.fetch, signer);
 *   const res = await fetchWithPay("https://api.example.com/data");
 *   const settle = readPaymentResponseHeader(res);
 *
 * Wire format: x402 v2 only. v1 fallback is tracked in BACKLOG.md
 * and lands when an older facilitator demands it.
 *
 * Limitations:
 * - The original request body must be replayable (e.g. JSON string,
 *   Uint8Array, FormData). Streaming bodies will fail on retry.
 * - Idempotency: callers should treat the wrapped fetch as
 *   at-most-twice. If the second response is still 402 we throw —
 *   no infinite-loop retries.
 */

import {
  HEADER_PAYMENT_REQUIRED_V2,
  HEADER_PAYMENT_SIGNATURE_V2,
  HEADER_PAYMENT_RESPONSE_V2,
  encodeBase64Json,
  decodeBase64Json,
  type PaymentRequirements,
  type X402ResourceInfo,
  type CantonNetwork,
} from "@ftptech/x402-canton-core";
import type { CantonSigner } from "./signer.js";
import { ExactCantonScheme, SchemeMethodMismatchError } from "./scheme.js";

/** Which on-ledger transfer methods a given signer can actually produce. */
function signerMethods(signer: CantonSigner): Set<string> {
  const m = new Set<string>();
  if (signer.signTransferFactory) m.add("transfer-factory");
  return m;
}

export interface X402PaymentRequired {
  x402Version: number;
  error?: string;
  resource: X402ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export interface WrapFetchOptions {
  /** Restrict which Canton networks this client will pay on.
   *  Default: any `canton:*`. */
  networkFilter?: (network: CantonNetwork) => boolean;
  /** Tiebreaker among multiple exact accepts. Default: first matching entry. */
  selectRequirements?: (candidates: PaymentRequirements[]) => PaymentRequirements;
  /** On a 402 that PERSISTS after paying — transient facilitator/ledger states,
   *  not a hard rejection: the v1 first-payment `counter_not_ready` dead-zone
   *  (the SV creates the payer's counter a few seconds after the first
   *  TransferCommand), or a payer input amulet that rolled over (holding-fee per
   *  mining round) on rapid-fire back-to-back payments — re-pay FROM SCRATCH
   *  (a fresh `createPaymentPayload` reads the ledger again: fresh nonce + fresh
   *  input amulet) up to this many EXTRA times with exponential backoff. Default
   *  4. 0 restores the old at-most-twice behavior. */
  maxPaymentRetries?: number;
  /** Base backoff before the first re-pay; doubles each attempt. Default 3000ms. */
  paymentRetryBaseMs?: number;
  /** Cap on any single backoff. Default 12000ms. */
  paymentRetryMaxMs?: number;
  /** Injectable sleep (tests). Default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

export class X402PaymentError extends Error {
  constructor(message: string, public readonly code: X402PaymentErrorCode) {
    super(message);
    this.name = "X402PaymentError";
  }
}

export type X402PaymentErrorCode =
  | "MISSING_PAYMENT_REQUIRED_HEADER"
  | "MALFORMED_PAYMENT_REQUIRED"
  | "NO_ACCEPTABLE_SCHEME"
  | "PAYMENT_REJECTED";

export function wrapFetchWithCantonPayment(
  fetch: typeof globalThis.fetch,
  signer: CantonSigner,
  options: WrapFetchOptions = {}
): typeof globalThis.fetch {
  const scheme = new ExactCantonScheme(signer);

  return async function fetchWithPayment(input, init) {
    // If the caller is already attempting payment (has the signature
    // header) just pass through — don't recurse.
    const initHeaders = new Headers(init?.headers);
    if (initHeaders.has(HEADER_PAYMENT_SIGNATURE_V2)) {
      return fetch(input, init);
    }

    const first = await fetch(input, init);
    if (first.status !== 402) return first;

    const requiredHeader = first.headers.get(HEADER_PAYMENT_REQUIRED_V2);
    if (!requiredHeader) {
      throw new X402PaymentError(
        "402 response missing PAYMENT-REQUIRED header (v1 wire format not supported in client v0.1)",
        "MISSING_PAYMENT_REQUIRED_HEADER"
      );
    }

    // The PAYMENT-REQUIRED header is server-controlled and untrusted:
    // bad base64, non-JSON, or JSON missing `accepts[]` must surface as a
    // discriminated X402PaymentError, not leak a raw SyntaxError/TypeError
    // out of the wrapped fetch (the whole contract of this wrapper is that
    // it only ever throws X402PaymentError).
    let required: X402PaymentRequired;
    try {
      required = decodeBase64Json<X402PaymentRequired>(requiredHeader);
    } catch {
      throw new X402PaymentError(
        "402 PAYMENT-REQUIRED header is not valid base64-encoded JSON",
        "MALFORMED_PAYMENT_REQUIRED"
      );
    }
    if (!required || !Array.isArray(required.accepts)) {
      throw new X402PaymentError(
        "402 PAYMENT-REQUIRED payload missing a valid accepts[] array",
        "MALFORMED_PAYMENT_REQUIRED"
      );
    }

    const candidates = required.accepts.filter((a) => {
      if (a.scheme !== "exact") return false;
      if (options.networkFilter && !options.networkFilter(a.network)) return false;
      return true;
    });
    if (candidates.length === 0) {
      throw new X402PaymentError(
        "no exact entry in 402 accepts[] (or networkFilter excluded all)",
        "NO_ACCEPTABLE_SCHEME"
      );
    }

    // Narrow to entries whose assetTransferMethod THIS signer can actually
    // produce. The only method is transfer-factory; a wallet that cannot produce
    // it (no signTransferFactory) gets a clear, named mismatch error instead of a
    // cryptic downstream failure rather than blindly taking accepts[0] and failing.
    const methods = signerMethods(signer);
    const compatible = candidates.filter((a) => methods.has(a.extra.assetTransferMethod ?? ""));
    if (compatible.length === 0) {
      const required_ = [
        ...new Set(candidates.map((a) => a.extra.assetTransferMethod ?? "(none)")),
      ].join(", ");
      const supported = [...methods].join(", ") || "(none)";
      throw new SchemeMethodMismatchError(required_, supported);
    }

    const chosen =
      options.selectRequirements?.(compatible) ?? (compatible[0] as PaymentRequirements);

    // Re-pay loop. A 402 that persists after paying is usually TRANSIENT on the
    // v1 facilitator-pays-gas path: the first-payment counter dead-zone (the SV
    // creates the payer's TransferCommandCounter a few seconds after the first
    // TransferCommand), or a payer input amulet that rolled over (holding-fee per
    // mining round) on rapid-fire back-to-back payments. Each attempt re-runs
    // createPaymentPayload, which reads the ledger fresh (fresh nonce + fresh
    // input amulet), so the next attempt picks up the now-ready counter / current
    // amulet. Bounded with exponential backoff; the funds-moved gate on the
    // facilitator guarantees no double-spend across attempts (a settled payment
    // returns non-402 and we stop).
    const maxRetries = options.maxPaymentRetries ?? 4;
    const baseMs = options.paymentRetryBaseMs ?? 3000;
    const capMs = options.paymentRetryMaxMs ?? 12000;
    const sleep =
      options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    // Each attempt re-runs createPaymentPayload, which on the v1
    // (external-party-amulet-rules) path mints a FRESH `TransferCommand`
    // on-ledger — a Create the payer pays Global Synchronizer traffic for
    // (~$0.40). So a blind "retry maxRetries times" loop burns one Create per
    // attempt even when re-paying cannot possibly help (e.g. the payer has no
    // funds, or the merchant has no preapproval — both surface as a repeating
    // `unexpected_canton_ledger_error`). Read the facilitator's reason off the
    // 402 body and STOP EARLY when a fresh re-pay is demonstrably not making
    // progress, instead of spending the whole budget on doomed Creates.
    //
    // A reason that a fresh envelope is expected to CLEAR IN ONE SHOT (a fresh
    // input amulet / preapproval for a ledger error) but that REPEATS is
    // systemic — re-paying again only burns another Create, so we bail.
    // Deliberately NOT in this set:
    //   - counter_not_ready — the first-payment dead-zone clears with TIME; a
    //     repeat is expected, keep retrying with backoff.
    //   - nonce_reuse — ALWAYS transient: either same-wallet contention (the
    //     counter is advancing — the next fresh nonce wins) or Scan lag (the
    //     relay's lag-free high-water clamp hands the correct nonce on the next
    //     resolve, and raw-Scan readers clear within a backoff or two). Bailing
    //     early here turned recoverable rapid-fire into hard payment failures.
    const STOP_IF_REPEATED = new Set(["unexpected_canton_ledger_error"]);
    let lastReason: string | undefined;

    for (let attempt = 0; ; attempt++) {
      // createPaymentPayload talks to the relay/ledger over the network; a
      // dropped TLS read (ETIMEDOUT/ECONNRESET/undici "fetch failed") is
      // TRANSIENT, not a payment rejection — surfacing it as a hard throw
      // killed the whole pay on a single network blip. Retry it within the
      // same bounded budget (with the same backoff) instead.
      let envelope;
      try {
        envelope = await scheme.createPaymentPayload(chosen, required.resource);
      } catch (err) {
        if (attempt >= maxRetries || !isTransientNetworkError(err)) throw err;
        lastReason = undefined; // a network blip is not a settle reason
        await sleep(Math.min(baseMs * 2 ** attempt, capMs));
        continue;
      }
      const retryHeaders = new Headers(init?.headers);
      retryHeaders.set(HEADER_PAYMENT_SIGNATURE_V2, encodeBase64Json(envelope));
      const resp = await fetch(input, { ...init, headers: retryHeaders });
      if (resp.status !== 402) return resp;
      const reason = await read402Reason(resp);
      if (attempt >= maxRetries) {
        throw new X402PaymentError(
          `payment retry still returned 402 after ${attempt + 1} attempt(s) — ` +
            `facilitator rejected the payment${reason ? ` (${reason})` : ""}`,
          "PAYMENT_REJECTED"
        );
      }
      // Non-progressing: the same clear-in-one-shot reason twice in a row means a
      // further re-pay would only burn another doomed Create. Stop now.
      if (reason !== undefined && reason === lastReason && STOP_IF_REPEATED.has(reason)) {
        throw new X402PaymentError(
          `payment kept failing with the same reason (${reason}) across re-pays — ` +
            `a fresh payment is not resolving it; not burning further attempts`,
          "PAYMENT_REJECTED"
        );
      }
      lastReason = reason;
      await sleep(Math.min(baseMs * 2 ** attempt, capMs));
    }
  };
}

/**
 * Is this error a transient NETWORK failure (as opposed to a payment
 * rejection)? Walks the `cause` chain looking for the classic socket/undici
 * signatures: node `fetch` throws `TypeError: fetch failed` with the real
 * `ETIMEDOUT`/`ECONNRESET`/… buried in `cause`.
 */
function isTransientNetworkError(err: unknown): boolean {
  const TRANSIENT_CODES = new Set([
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "EAI_AGAIN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
  ]);
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) return true;
    if (typeof e.message === "string" && /fetch failed/i.test(e.message) && !e.cause) {
      return true; // bare undici wrapper with no further detail
    }
    cur = e.cause;
  }
  return false;
}

/**
 * Best-effort read of the facilitator's failure reason from a 402 the resource
 * server returned after a settle attempt. The express integration responds
 * `402 {"error": "<errorReason>"}` on a failed settle, so the reason rides the
 * JSON body. Always fail-soft (returns undefined on any parse/read error) — the
 * reason only ever lets the re-pay loop stop SOONER; it is never required for
 * correctness.
 */
async function read402Reason(resp: Response): Promise<string | undefined> {
  try {
    const text = await resp.text();
    if (!text) return undefined;
    const body = JSON.parse(text) as { error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decode the `PAYMENT-RESPONSE` header (x402 v2) attached to a
 * response that came back through wrapFetchWithCantonPayment.
 * Returns null when the header is absent (e.g. response unrelated to
 * x402).
 */
export function readPaymentResponseHeader<T = unknown>(
  response: Response
): T | null {
  const header = response.headers.get(HEADER_PAYMENT_RESPONSE_V2);
  if (!header) return null;
  return decodeBase64Json<T>(header);
}

/**
 * Peek which on-ledger transfer method `wrapFetchWithCantonPayment` WOULD choose
 * for a given 402 response + signer, WITHOUT paying. Mirrors the exact selection
 * `fetchWithPayment` runs (decode the PAYMENT-REQUIRED header → keep exact
 * entries the optional networkFilter allows → narrow to the methods THIS signer
 * can produce → `selectRequirements ?? compatible[0]`). Returns the chosen
 * `extra.assetTransferMethod`, or `undefined` when it cannot tell (non-402,
 * missing or malformed header, no compatible entry).
 *
 * The agent-wallet pay layer uses this to decide whether a pay needs the
 * per-wallet serialization mutex: the only method is transfer-factory, which is
 * no-nonce and runs concurrently, so a recognized method needs NO mutex.
 * `undefined` ("can't tell") is treated as "serialize" (fail safe) by the caller,
 * so an unparseable 402 never runs unserialized by accident.
 *
 * Kept in THIS module beside `fetchWithPayment` so the two selections cannot
 * drift; a test pins that peek agrees with the method actually paid.
 */
export function peekChosenTransferMethod(
  response: Response,
  signer: CantonSigner,
  options: WrapFetchOptions = {}
): string | undefined {
  if (response.status !== 402) return undefined;
  const header = response.headers.get(HEADER_PAYMENT_REQUIRED_V2);
  if (!header) return undefined;
  let required: X402PaymentRequired;
  try {
    required = decodeBase64Json<X402PaymentRequired>(header);
  } catch {
    return undefined;
  }
  if (!required || !Array.isArray(required.accepts)) return undefined;
  const candidates = required.accepts.filter((a) => {
    if (a.scheme !== "exact") return false;
    if (options.networkFilter && !options.networkFilter(a.network)) return false;
    return true;
  });
  const methods = signerMethods(signer);
  const compatible = candidates.filter((a) => methods.has(a.extra.assetTransferMethod ?? ""));
  if (compatible.length === 0) return undefined;
  const chosen =
    options.selectRequirements?.(compatible) ?? (compatible[0] as PaymentRequirements);
  return chosen ? chosen.extra.assetTransferMethod : undefined;
}
