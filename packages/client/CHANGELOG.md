# @ftptech/x402-canton-client

## 1.4.0

### Minor Changes

- 2740103: A 5xx to the paid request is re-sent with the same PAYMENT-SIGNATURE up to `paidResends` times (default 2, `0` turns it off), 3 s and then 6 s apart (`paymentRetryBaseMs`). If the merchant still fails, the client throws `PAYMENT_UNCONFIRMED` instead of returning the 5xx: the payment may have settled and must not be paid again. A 402 to a re-sent payment is `PAYMENT_UNCONFIRMED` too. It never signs a second payment.

### Patch Changes

- 1f6a003: A `Request` passed to the paying fetch is paid as sent: the paid retry keeps the Request's headers and sends its body again. It used to drop the headers, Authorization included, and could sign a payment and then fail to send a POST body the first request had read.
- db1d351: The express and next middlewares understand the facilitator's scheme answers. A repeat of a settled payment, refused with its `updateId`, is served through the redeemed store: once, or again after a failed delivery gave the payment back. `settlement_pending`, as a 503 with its body or a 200, is retried with the same payment for about 7 s, then answered 502 "do NOT pay again", never 402. The client reads the reason from PAYMENT-RESPONSE on a 402, where a server on the official x402 SDK puts it, and stops without paying again on `settlement_pending`. A failed SettleResponse in core carries `transaction`, `network` and `payer`.
- Updated dependencies [d418335]
- Updated dependencies [db1d351]
- Updated dependencies [fb41063]
- Updated dependencies [672bf45]
- Updated dependencies [cddefd2]
- Updated dependencies [7f6f15b]
  - @ftptech/x402-canton-ledger@0.6.5
  - @ftptech/x402-canton-core@1.9.0

## 1.3.0

### Minor Changes

- 075bf5a: A 402 after a signed payment never re-pays, so maxPaymentRetries now only retries a network error while building the payment.

### Patch Changes

- 6530aec: A paid request that fails in transit now throws X402PaymentError PAYMENT_UNCONFIRMED with the network error as cause, and so does a redirected paid request that ends in a 402 or an edge header rejection. A paid 402 whose reason says the payment may already have moved (`unexpected_canton_ledger_error`, `payment_already_redeemed`, `invalid_exact_canton_payment_already_settled`) is PAYMENT_UNCONFIRMED too.
- Updated dependencies [580bff2]
  - @ftptech/x402-canton-core@1.5.0

## 1.2.2

### Patch Changes

- Updated dependencies [7fa848e]
- Updated dependencies [068b32d]
  - @ftptech/x402-canton-ledger@0.6.0
  - @ftptech/x402-canton-core@1.4.0

## 1.2.1

### Patch Changes

- Updated dependencies [d9cd495]
  - @ftptech/x402-canton-ledger@0.5.0
  - @ftptech/x402-canton-core@1.3.0

## 1.2.0

### Minor Changes

- ecca81b: `peekChosenRequirement(response, signer, options)` returns the accepts[] entry
  `wrapFetchWithCantonPayment` would pay for a 402, without paying (payee, atomic
  amount, instrument). `peekChosenTransferMethod` is now that entry's
  `assetTransferMethod`, so the two cannot select differently.

## 1.1.0

### Minor Changes

- 350b61b: A 431 — or nginx's stock `400 Request Header Or Cookie Too Large` page — in
  reply to the paid retry now throws `X402PaymentError` with the new code
  `MERCHANT_HEADER_LIMIT`, naming the actual fix: an x402 server must accept a
  payment header of at least 16 KiB end to end (a real inline payment header is
  ~8-10 KiB; nginx: `large_client_header_buffers 4 16k;`, Node origin:
  `--max-http-header-size=32768`). The fingerprint is tight — a merchant's own
  400 passes through untouched, body intact. The signed payment never reached
  the merchant in this case, so nothing settled and it expires on its own.

## 1.0.0

### Major Changes

- 6428700: Remove the legacy stash (`submissionRef`) carriage — inline is now the only carriage.

  BREAKING: a `transfer-factory` payment carries the payer-signed transaction
  INLINE (`preparedTransaction` + `preparedTxHash` + `signature`), so any
  facilitator can relay it. The `submissionRef` pointer form, the two-call
  `pay/prepare` + `pay/commit` relay dance, and the server-side `tf_stash` table
  are gone. This is the shape upstream x402-foundation adopted, and it serves both
  Canton Coin and any CIP-56 registry token (they differ only by
  `instrumentId.admin`).

  - core: `CantonPaymentPayload` is now `CantonInlinePayload` only
    (`CantonSubmissionRefPayload` removed); `SupportedResponse.extra.carriages` is
    `["inline"]`; the now-unreachable error codes
    `invalid_exact_canton_submission_not_found` and
    `invalid_exact_canton_signature` are removed.
  - client: `SignedTransferFactory` no longer carries `submissionRef`; a
    `CantonSigner.signTransferFactory` MUST return the inline bundle
    (`preparedTransactionBytes` + `signatureB64`), and `ExactCantonScheme` emits
    only the inline payload.

  Clients that defaulted to the stash carriage stop working: upgrade to a client
  that emits the inline payload. The facilitator (`/settle` accepts inline only,
  `pay/commit` removed) and `@ftptech/canton-agent-wallet` (inline is the sole
  signer path) carry the same breaking change; they are versioned outside
  changesets and must take a matching major bump.

### Patch Changes

- Updated dependencies [6428700]
  - @ftptech/x402-canton-core@1.0.0

## 0.7.1

### Patch Changes

- Ship the fixes the registry never got.

  Four packages carried changed code under a version number npm already had, so
  `changeset publish` skipped them silently and no consumer could ever receive the
  fix. Verified by unpacking the published tarballs and hashing every `dist/*.js`
  against the local build: core differs in 2 files, client in 1, express in 1,
  next in 1; ledger is byte-identical and needs nothing.

  **core** — the published 0.7.0 decoder reads protobuf tags and lengths with the
  64-bit varint reader. The bound that refuses an over-32-bit tag (`readVarint32`,
  `> 0xffffffff`) exists only in the working tree, and that module IS
  verify-before-sign: agent-wallet re-exports `assertPreparedTransferMatches` from
  here. A participant's `readRawVarint32` and protobufjs both truncate such a tag
  and parse the field, so bytes the agent's validator skips as an unknown field are
  fully effective on execute and covered by the hash it signs. Every payer
  installed from npm runs without that bound today.

  The published 0.7.0 also ships no `network-failure.js` at all, while express and
  next now import `connectionNeverEstablished` from it — so this bump is a
  prerequisite for publishing them, not an optional companion.

  **client** — the ambiguity fixes in `fetch.ts`: the guard ordered ahead of the
  retry-budget branch, and the machine-readable `PAYMENT_UNCONFIRMED` code.

  **express** — the payment gate now covers every spelling the router will serve:
  `baseUrl + path` as well as the mount-relative path, and both the app's own
  normalisation and the loosest one (an `express.Router()` does not inherit the
  app's `strict routing` / `case sensitive routing`). Each of those gaps served a
  paid resource for free, silently. The default redeemed store is now one per
  process rather than one per middleware instance, and a settle reported successful
  without a transaction id is refused rather than deduped under a shared empty key.

  **next** — the same unidentifiable-settle refusal, so the twins stay in step.

- Updated dependencies
  - @ftptech/x402-canton-core@0.7.1
