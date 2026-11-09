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
 *   Uint8Array, FormData). A Request's own body is replayed from a copy; a
 *   stream passed as `init.body` will fail on retry.
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
  /** Retries of a network error while building the payment, before it is signed. Default 4. */
  maxPaymentRetries?: number;
  /** Base backoff before the first retry; doubles each attempt. Default 3000ms.
   *  Also spaces the re-sends of a signed payment answered 5xx. */
  paymentRetryBaseMs?: number;
  /** Cap on any single backoff. Default 12000ms. */
  paymentRetryMaxMs?: number;
  /** Re-sends of the SAME signed payment when the paid request is answered
   *  5xx. Default 2; 0 disables. Never a second payment either way: a 5xx left
   *  after the last re-send is PAYMENT_UNCONFIRMED. */
  paidResends?: number;
  /** Injectable sleep (tests). Default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

export class X402PaymentError extends Error {
  constructor(
    message: string,
    public readonly code: X402PaymentErrorCode,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "X402PaymentError";
  }
}

export type X402PaymentErrorCode =
  | "MISSING_PAYMENT_REQUIRED_HEADER"
  | "MALFORMED_PAYMENT_REQUIRED"
  | "NO_ACCEPTABLE_SCHEME"
  | "PAYMENT_REJECTED"
  /**
   * The facilitator could not confirm the payment. It MAY have settled
   * on-ledger. Do not pay again from this outcome — read the payer's balance or
   * the merchant's receipt first. Also thrown when the paid request fails in
   * transit, or is redirected and then answered 402 or refused for its header,
   * or is still answered 5xx after the same payment was re-sent.
   *
   * Distinct from PAYMENT_REJECTED because `code` is the only machine-readable
   * field on this error, and an integrator branches on it. The ambiguity guard
   * and the retry-budget branch already carry different English, but both threw
   * PAYMENT_REJECTED, so a caller whose "rejected → mint a fresh payment" path
   * fires on that code paid twice for one purchase over an outcome nobody had
   * proven. The sentence is not an API; this is.
   */
  | "PAYMENT_UNCONFIRMED"
  /**
   * The merchant's EDGE (a reverse proxy in front of them) refused the paid
   * retry because the payment header exceeded its buffer — the merchant never
   * saw the request and nothing settled; the signed transaction expires on its
   * own. A real inline payment header is ~8–10 KiB and the scheme's transport
   * guidance requires servers to accept at least 16 KiB end to end, so the fix
   * is the merchant's proxy configuration, not the payer's code.
   */
  | "MERCHANT_HEADER_LIMIT";

export function wrapFetchWithCantonPayment(
  fetch: typeof globalThis.fetch,
  signer: CantonSigner,
  options: WrapFetchOptions = {}
): typeof globalThis.fetch {
  const scheme = new ExactCantonScheme(signer);

  return async function fetchWithPayment(input, init) {
    // A Request carries its own headers and body, and `init` replaces either
    // only when it sets it (ky and some SDKs call fetch this way). The paid
    // retry used to be built from `init` alone: measured, it went out without
    // the Request's Authorization, and a POST body the first send had read
    // could not be sent again after the payment was signed.
    const request = typeof Request === "function" && input instanceof Request ? input : undefined;
    const sentHeaders = new Headers(init?.headers ?? request?.headers);
    // If the caller is already attempting payment (has the signature
    // header) just pass through — don't recurse.
    if (sentHeaders.has(HEADER_PAYMENT_SIGNATURE_V2)) {
      return fetch(input, init);
    }
    // An unread copy for the paid send; the first send consumes the body.
    const replay = request?.clone();
    const signal = init?.signal !== undefined ? init.signal : request?.signal;

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

    // Only building the payment is retried. Once it is signed, a 402 never
    // re-pays: the merchant writes that 402 and may already have settled.
    const maxRetries = options.maxPaymentRetries ?? 4;
    const baseMs = options.paymentRetryBaseMs ?? 3000;
    const capMs = options.paymentRetryMaxMs ?? 12000;
    const paidResends = Number.isFinite(options.paidResends)
      ? Math.max(0, Math.trunc(options.paidResends as number))
      : PAID_RESENDS;
    const sleep =
      options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    /**
     * Reasons where the outcome is AMBIGUOUS about whether money moved, so a
     * re-pay is not a retry — it is a second payment.
     *
     * `invalid_exact_canton_execute_failed` is the facilitator's catch-all
     * around the submit itself. Some of what lands there is a clean rejection
     * with nothing spent; some of it is a network failure mid-submit, where the
     * participant may well have accepted the transaction. From here the two are
     * indistinguishable, and re-paying re-prepares over the payer's REMAINING
     * holdings — so if the first one did commit, the payer pays twice for one
     * purchase and the second payment exists in no record.
     *
     * `unexpected_canton_ledger_error` is what a facilitator running without
     * the dispatch mark (CANTON_X402_SETTLE_DISPATCH_MARK=off, the default)
     * answers for that same unknown outcome. `payment_already_redeemed` and
     * `invalid_exact_canton_payment_already_settled` say this payment already
     * settled: the money has moved, and paying again is a second payment.
     *
     * Stopping is not enough here: the caller must also be told the payment
     * may have settled, so it does not pay again itself. Ambiguity stops on
     * the FIRST occurrence and hands the decision to whoever can check the
     * ledger.
     */
    const STOP_ON_FIRST = new Set([
      "invalid_exact_canton_execute_failed",
      "unexpected_canton_ledger_error",
      "payment_already_redeemed",
      "invalid_exact_canton_payment_already_settled",
      // The transfer was relayed and its outcome is not known yet.
      "settlement_pending",
    ]);

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
        await sleep(Math.min(baseMs * 2 ** attempt, capMs));
        continue;
      }
      const retryHeaders = new Headers(sentHeaders);
      const signatureHeader = encodeBase64Json(envelope);
      retryHeaders.set(HEADER_PAYMENT_SIGNATURE_V2, signatureHeader);
      // Already aborted: the paid request is never sent, so the abort stands.
      if (signal?.aborted) throw signal.reason;
      const sendPaid = async (): Promise<Response> => {
        try {
          return await fetch(replay?.clone() ?? input, { ...init, headers: retryHeaders });
        } catch (err) {
          // Redirects are followed, so even a refused connection can be a later
          // hop failing after the merchant settled.
          throw new X402PaymentError(
            `the paid request failed in transit, so the payment may already have ` +
              `settled on-ledger and this client will NOT pay again. Check the ` +
              `payer's balance / the merchant's receipt before retrying`,
            "PAYMENT_UNCONFIRMED",
            { cause: err }
          );
        }
      };
      let resp = await sendPaid();
      // A 5XX IS NOT THE END OF THE PAYMENT. Our express middleware settles
      // before the handler and, on a 5xx, gives the ticket back so the SAME
      // header is served again ("retry the same payment"); the facilitator
      // answers a replay of settled bytes from its idempotency record. This
      // used to hand the 5xx back as an ordinary response and keep the header
      // to itself, so nobody could retry it. Re-send the same signed payment,
      // bounded, never a new one. Not after a redirect: an earlier hop may
      // have delivered.
      const firstStatus = resp.status;
      let resent = 0;
      while (isServerError(resp.status) && !resp.redirected && resent < paidResends) {
        await resp.body?.cancel().catch(() => undefined);
        await sleep(Math.min(baseMs * 2 ** resent, capMs));
        resent += 1;
        resp = await sendPaid();
      }
      if (isServerError(resp.status)) {
        await resp.body?.cancel().catch(() => undefined);
        if (resp.redirected) throw unconfirmedAfterRedirect(resp.status);
        const settled = settlementOf(resp);
        throw unconfirmed(
          `the merchant answered HTTP ${resp.status} to the paid request` +
            (resent > 0 ? `, also after re-sending the same payment ${resent === 1 ? "once" : `${resent} times`}` : "") +
            (settled !== undefined ? ` (it reported the settlement ${settled})` : "")
        );
      }
      if (resp.status !== 402) {
        await throwIfEdgeRejectedPaymentHeader(
          resp,
          signatureHeader.length,
          resent > 0 ? firstStatus : undefined
        );
        return resp;
      }
      if (resp.redirected) throw unconfirmedAfterRedirect(resp.status);
      const reason = await read402Reason(resp);
      if (resent > 0) {
        throw unconfirmed(
          `the merchant answered HTTP ${firstStatus} to the paid request and 402` +
            `${reason ? ` (${reason})` : ""} to the same payment re-sent`
        );
      }
      if (reason !== undefined && STOP_ON_FIRST.has(reason)) {
        throw new X402PaymentError(
          `the facilitator could not confirm the payment (${reason}) — it may ` +
            `already have settled on-ledger, so this client will NOT pay again. ` +
            `Check the payer's balance / the merchant's receipt before retrying`,
          "PAYMENT_UNCONFIRMED"
        );
      }
      throw new X402PaymentError(
        `payment returned 402 after it was signed${reason ? ` (${reason})` : ""}; ` +
          `this client will not pay again for this request`,
        "PAYMENT_REJECTED"
      );
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
 * A 431, or nginx's stock 400 page ("Request Header Or Cookie Too Large"), in
 * reply to the PAID retry is an edge in front of the merchant refusing the
 * payment header — not an x402 answer, and not a merchant decision. A real
 * inline payment header is ~8–10 KiB and the scheme's transport guidance
 * requires servers to accept at least 16 KiB end to end, so name the fix
 * instead of handing the caller an opaque error page. The fingerprint is
 * deliberately tight: a merchant's OWN 400 (bad request body, etc.) carries
 * neither the 431 status nor nginx's exact phrase and passes through
 * untouched. The response body is read from a clone, so the caller's stream
 * stays intact on the pass-through path. Money-safety: the signed payment
 * never reached the merchant, so nothing settled; it expires on its own
 * (executeBefore) — this error is safe to re-pay from once the merchant's
 * edge is fixed. After a redirect the merchant may have settled on an earlier
 * hop, so that case is PAYMENT_UNCONFIRMED instead.
 */
async function throwIfEdgeRejectedPaymentHeader(
  resp: Response,
  sentHeaderBytes: number,
  /** Status of an earlier send of this same payment, when this is a re-send:
   *  that send reached the merchant, so "nothing settled" no longer holds. */
  earlierStatus?: number
): Promise<void> {
  if (resp.status !== 431 && resp.status !== 400) return;
  if (resp.status === 400) {
    let body = "";
    try {
      body = await resp.clone().text();
    } catch {
      return;
    }
    if (!/Request Header Or Cookie Too Large/i.test(body)) return;
  }
  if (resp.redirected) throw unconfirmedAfterRedirect(resp.status);
  if (earlierStatus !== undefined) {
    throw unconfirmed(
      `the merchant answered HTTP ${earlierStatus} to the paid request and its edge refused ` +
        `the same payment re-sent (HTTP ${resp.status})`
    );
  }
  throw new X402PaymentError(
    `the merchant's edge rejected the ${sentHeaderBytes}-byte payment header before the ` +
      `merchant ever saw it (HTTP ${resp.status}` +
      (resp.status === 400 ? `, "Request Header Or Cookie Too Large"` : "") +
      `). An x402 server must accept a payment header of at least 16 KiB end to end — ` +
      `on nginx: large_client_header_buffers 4 16k; — on a Node origin: ` +
      `--max-http-header-size=32768. The signed payment never reached the merchant, so ` +
      `nothing settled; it expires on its own.`,
    "MERCHANT_HEADER_LIMIT"
  );
}

/** Default `paidResends`: re-sends of the SAME signed payment after the paid
 *  request is answered 5xx, spaced by the payment backoff (3 s, then 6 s). */
const PAID_RESENDS = 2;

function isServerError(status: number): boolean {
  return status >= 500 && status <= 599;
}

/** PAYMENT_UNCONFIRMED for an outcome that may have settled: `what` says why. */
function unconfirmed(what: string): X402PaymentError {
  return new X402PaymentError(
    `${what}, so the payment may already have settled on-ledger and this client will ` +
      `NOT pay again. Check the payer's balance / the merchant's receipt before retrying`,
    "PAYMENT_UNCONFIRMED"
  );
}

/** The settlement id a merchant attached (PAYMENT-RESPONSE), if readable. */
function settlementOf(resp: Response): string | undefined {
  try {
    const s = readPaymentResponseHeader<{ transaction?: unknown }>(resp);
    return typeof s?.transaction === "string" && s.transaction.length > 0 ? s.transaction : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The answer came after a redirect, and the merchant may already have settled
 * before redirecting.
 */
function unconfirmedAfterRedirect(status: number): X402PaymentError {
  return new X402PaymentError(
    `the paid request was redirected and the last hop answered HTTP ${status}, so ` +
      `the merchant may already have settled the payment and this client will NOT ` +
      `pay again. Check the payer's balance / the merchant's receipt before retrying`,
    "PAYMENT_UNCONFIRMED"
  );
}

/**
 * Best-effort read of the facilitator's failure reason from a 402 the resource
 * server returned to a paid request. The express integration answers a failed
 * settle with `402 {"error": "<errorReason>"}`, and a failed verify with an
 * empty `{}` body and the reason in the `error` field of the PAYMENT-REQUIRED
 * header. So the body is read first and the header is the fallback, decoded the
 * same way as the requirements on the first 402. Always fail-soft (undefined on
 * any read or parse error).
 */
async function read402Reason(resp: Response): Promise<string | undefined> {
  // A server on the official x402 SDK answers a failed settle 402 with an empty
  // body and puts the reason only in PAYMENT-RESPONSE, so it is read first:
  // without it the reason was always unknown and the payment read as rejected.
  return read402SettleReason(resp) ?? (await read402BodyReason(resp)) ?? read402HeaderReason(resp);
}

function read402SettleReason(resp: Response): string | undefined {
  const header = resp.headers.get(HEADER_PAYMENT_RESPONSE_V2);
  if (!header) return undefined;
  try {
    const settle = decodeBase64Json<{ errorReason?: unknown } | null>(header);
    return typeof settle?.errorReason === "string" ? settle.errorReason : undefined;
  } catch {
    return undefined;
  }
}

async function read402BodyReason(resp: Response): Promise<string | undefined> {
  try {
    const text = await resp.text();
    if (!text) return undefined;
    const body = JSON.parse(text) as { error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

function read402HeaderReason(resp: Response): string | undefined {
  const header = resp.headers.get(HEADER_PAYMENT_REQUIRED_V2);
  if (!header) return undefined;
  try {
    const required = decodeBase64Json<{ error?: unknown } | null>(header);
    return typeof required?.error === "string" ? required.error : undefined;
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
 * Peek which accepts[] entry `wrapFetchWithCantonPayment` WOULD pay for a given
 * 402 response + signer, WITHOUT paying. Mirrors the exact selection
 * `fetchWithPayment` runs (decode the PAYMENT-REQUIRED header → keep exact
 * entries the optional networkFilter allows → narrow to the methods THIS signer
 * can produce → `selectRequirements ?? compatible[0]`). Returns the chosen
 * entry, or `undefined` when it cannot tell (non-402, missing or malformed
 * header, no compatible entry).
 *
 * A caller that must decide something BEFORE paying — whether to serialize the
 * pay, whether the quoted amount fits a budget it is about to fund — reads the
 * entry that will actually be paid, not a re-derivation of it. Kept in THIS
 * module beside `fetchWithPayment` so the two selections cannot drift; a test
 * pins that peek agrees with what is actually paid.
 */
export function peekChosenRequirement(
  response: Response,
  signer: CantonSigner,
  options: WrapFetchOptions = {}
): PaymentRequirements | undefined {
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
  return options.selectRequirements?.(compatible) ?? compatible[0];
}

/**
 * The on-ledger transfer method `wrapFetchWithCantonPayment` WOULD use for a
 * 402, or `undefined` when it cannot tell — `peekChosenRequirement` narrowed to
 * `extra.assetTransferMethod`.
 *
 * The agent-wallet pay layer uses this to decide whether a pay needs the
 * per-wallet serialization mutex: the only method is transfer-factory, which is
 * no-nonce and runs concurrently, so a recognized method needs NO mutex.
 * `undefined` ("can't tell") is treated as "serialize" (fail safe) by the caller,
 * so an unparseable 402 never runs unserialized by accident.
 */
export function peekChosenTransferMethod(
  response: Response,
  signer: CantonSigner,
  options: WrapFetchOptions = {}
): string | undefined {
  return peekChosenRequirement(response, signer, options)?.extra.assetTransferMethod;
}
