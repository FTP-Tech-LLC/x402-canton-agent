# @ftptech/x402-canton-client

Payer-side SDK for Canton x402. Lets an autonomous agent pay for
x402-gated HTTP resources using a `CantonSigner` that submits a CIP-56
`TransferFactory_Transfer` from the agent's Canton participant.

## Install

```bash
npm i @ftptech/x402-canton-client
```

> Note: the `@ftp` npm scope is not final and may change before the
> first public release (see [`docs/PUBLISHING.md`](https://github.com/sunstrike228/canton-x402/blob/main/docs/PUBLISHING.md)).
> Pin the version you install and check the README for the current
> package name.

## What's in here

- `CantonSigner` interface: abstracts how a CIP-56 transfer is
  signed and submitted (self-custody wallet + facilitator relay,
  mock for tests, hosted-party variants).
  This package ships the INTERFACE, not a signer. Two ways to get one:
  `makePayingFetch` from
  [`@ftptech/canton-agent-wallet`](https://www.npmjs.com/package/@ftptech/canton-agent-wallet)
  (self-custody key + facilitator relay — the live path), or your own
  class implementing `signTransferFactory`.
- `ExactCantonScheme`: builds x402 v2 PaymentPayload envelopes
  from PaymentRequirements + a signer.
- `wrapFetchWithCantonPayment(fetch, signer)`: drop-in fetch
  replacement that detects 402, decodes `PAYMENT-REQUIRED`, calls
  the signer, retries with `PAYMENT-SIGNATURE`, throws
  `X402PaymentError` with a stable `code` field on failure.
- `readPaymentResponseHeader(response)`: decodes the v2
  `PAYMENT-RESPONSE` settlement header.

## Quick example

The shortest real path is the agent wallet, which builds the signer and
wraps fetch for you:

```ts
import { makePayingFetch } from "@ftptech/canton-agent-wallet";
import { readPaymentResponseHeader } from "@ftptech/x402-canton-client";

const fetchWithPay = await makePayingFetch({
  relayUrl: "https://facilitator.example",   // BASE url — the client appends /v1/wallet/...
  network:  "canton:mainnet",
  // optional, and worth setting: a ceiling the signer will never sign past,
  // in CC — not the atomic integer the 402 quotes.
  maxPaymentValue: "0.05",
});

const res = await fetchWithPay("https://api.example.com/data");
const settle = readPaymentResponseHeader(res);
```

To drive it from your own key material instead, implement `CantonSigner`
and pass it positionally:

```ts
import {
  wrapFetchWithCantonPayment,
  type CantonSigner,
} from "@ftptech/x402-canton-client";

const signer: CantonSigner = {
  party: "agent_party::1220...",
  async signTransferFactory(input) {
    // Prepare + sign a TransferFactory_Transfer for `input`, then return the
    // INLINE bundle — the signed transaction itself, so any facilitator can
    // relay it:
    //   { payerParty, preparedTxHash, preparedTransactionBytes, signatureB64 }
    // `preparedTxHash` is HEX and must be the hash OF the bytes you signed
    // (Canton hands it to you base64 — convert it).
    //
    // The old `{ submissionRef, preparedTxHash }` pointer form is gone as of
    // 1.0.0: it tied a payment to the one facilitator that prepared it. If you
    // are upgrading from 0.x, this is the change to make.
  },
};
const fetchWithPay = wrapFetchWithCantonPayment(fetch, signer);
```

See [`docs/quickstart.md`](https://github.com/sunstrike228/canton-x402/blob/main/docs/quickstart.md)
for the full demo flow and `examples/agent-buyer/` for a runnable
agent.

## Payment header size (`MERCHANT_HEADER_LIMIT`)

A real inline payment header is **~8-10 KiB** (gzipped transaction, base64 JSON
envelope). The scheme's transport guidance requires servers to accept a payment
header of **at least 16 KiB end to end**. When a merchant's edge rejects it
(nginx default 8k buffers → `400 Request Header Or Cookie Too Large`, or a
plain 431), the wrapped fetch throws `X402PaymentError` with code
`MERCHANT_HEADER_LIMIT` naming the fix (`large_client_header_buffers 4 16k;`,
Node: `--max-http-header-size=32768`). The signed payment never reached the
merchant, so nothing settled — it expires on its own, and re-paying after the
merchant fixes their edge is safe.

## Project

[github.com/sunstrike228/canton-x402](https://github.com/sunstrike228/canton-x402).
