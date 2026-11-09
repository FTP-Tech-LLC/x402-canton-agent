# @ftptech/x402-canton-client

Payer-side SDK for Canton x402: a `fetch` wrapper that answers a 402 with a signed Canton transfer and retries the request. The merchant's facilitator submits the transfer and pays the traffic.

## Install

```bash
npm install @ftptech/x402-canton-client
```

## Quickstart

The agent wallet (`npm install @ftptech/canton-agent-wallet`) brings the signer and wraps `fetch` for you:

```ts
import { makePayingFetch } from "@ftptech/canton-agent-wallet";
import { readPaymentResponseHeader } from "@ftptech/x402-canton-client";

const payFetch = await makePayingFetch({
  relayUrl: "https://facilitator.ftptech.xyz",
  network: "canton:mainnet",
  maxPaymentValue: "0.05", // the most CC one payment may cost
});

const res = await payFetch("https://api.example.com/data");
const settlement = readPaymentResponseHeader(res);
```

With your own keys, implement `CantonSigner`:

```ts
import { wrapFetchWithCantonPayment, type CantonSigner } from "@ftptech/x402-canton-client";

const signer: CantonSigner = {
  party: "<your party id>",
  async signTransferFactory(input) {
    // Prepare and sign a TransferFactory_Transfer for `input`, then return
    // { payerParty, preparedTxHash, preparedTransactionBytes, signatureB64 }.
    // preparedTxHash is hex: the hash of the bytes you signed.
    throw new Error("not implemented");
  },
};

const payFetch = wrapFetchWithCantonPayment(fetch, signer);
```

With your own signer nothing caps the amount: the wrapper pays what the 402 asks. Check the amount and the payee in `selectRequirements` or in the signer.

## API

- `wrapFetchWithCantonPayment(fetch, signer, options?)`: pays a 402 and retries. Options: `networkFilter`, `selectRequirements` (default: the first match), `maxPaymentRetries`, `paidResends`.
- `peekChosenRequirement(response, signer, options?)`: the entry it would pay, without paying.
- `readPaymentResponseHeader(response)`: decodes `PAYMENT-RESPONSE`.
- `ExactCantonScheme`: builds the x402 v2 payment payload.

## Money safety

Failures throw `X402PaymentError` with a stable `code`:

- `PAYMENT_UNCONFIRMED`: the payment was signed and may have settled (the request failed in transit, the settle was not confirmed, or 5xx kept coming). Never pay again on it; check the balance or the merchant's receipt first.
- `PAYMENT_REJECTED`: the merchant refused the signed payment with a 402. The client does not pay again. A 402 whose reason says the payment may have gone through (`settlement_pending`, `invalid_exact_canton_execute_failed`, `invalid_exact_canton_payment_already_settled`) is `PAYMENT_UNCONFIRMED` instead.
- `MERCHANT_HEADER_LIMIT`: the merchant's proxy refused the 8 to 10 KiB payment header. Nothing settled, so paying again once the merchant accepts 16 KiB is safe.

A 5xx to the paid request is re-sent with the same payment (`paidResends`, default 2) before `PAYMENT_UNCONFIRMED`. The client never signs a second payment for one request.

## Docs

[Agent guide](https://x402-docs.ftptech.xyz/x402-agent) on the FTP docs site.
