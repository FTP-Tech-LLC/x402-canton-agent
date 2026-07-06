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
  signed and submitted (real participant via `Cip56KeyfileSigner`,
  mock for tests, hosted-party variants).
- `Cip56KeyfileSigner` + `makeCip56KeyfileSigner(config)`: production
  signer that loads an Ed25519 key from a PEM file (or env-var PEM
  string) and drives the participant's interactive-submission
  prepare/sign/execute flow for `TransferFactory_Transfer`.
- `ExactCantonScheme`: builds x402 v2 PaymentPayload envelopes
  from PaymentRequirements + a signer.
- `wrapFetchWithCantonPayment(fetch, signer)`: drop-in fetch
  replacement that detects 402, decodes `PAYMENT-REQUIRED`, calls
  the signer, retries with `PAYMENT-SIGNATURE`, throws
  `X402PaymentError` with a stable `code` field on failure.
- `readPaymentResponseHeader(response)`: decodes the v2
  `PAYMENT-RESPONSE` settlement header.

## Quick example

```ts
import {
  wrapFetchWithCantonPayment,
  readPaymentResponseHeader,
  makeCip56KeyfileSigner,
} from "@ftptech/x402-canton-client";

const signer = makeCip56KeyfileSigner({
  participantUrl:   "https://your-participant/ledger-api",
  participantToken: "<bearer>",
  scanUrl:          "https://scan.your-sv/api/scan",
  party:            "agent_party::1220...",
  keyPath:          "/run/secrets/agent.pem",
});

const fetchWithPay = wrapFetchWithCantonPayment(fetch, signer);
const res = await fetchWithPay("https://api.example.com/data");
const settle = readPaymentResponseHeader(res);
```

See [`docs/quickstart.md`](https://github.com/sunstrike228/canton-x402/blob/main/docs/quickstart.md)
for the full demo flow and `examples/agent-buyer/` for a runnable
agent.

## Project

[github.com/sunstrike228/canton-x402](https://github.com/sunstrike228/canton-x402).
