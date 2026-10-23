# @ftptech/x402-canton-client

Payer-side SDK for Canton x402: a `fetch` wrapper that answers a 402 with a signed Canton transfer and retries. The facilitator submits the transfer, so the payer needs no Canton node.

## Install

```bash
npm i @ftptech/x402-canton-client
```

## Example

The shortest path is the agent wallet, which brings the signer:

```ts
import { makePayingFetch } from "@ftptech/canton-agent-wallet";
import { readPaymentResponseHeader } from "@ftptech/x402-canton-client";

const payFetch = await makePayingFetch({
  relayUrl: "https://facilitator.ftptech.xyz",
  network: "canton:mainnet",
  maxPaymentValue: "0.05", // CC per payment
});

const res = await payFetch("https://api.example.com/data");
const settlement = readPaymentResponseHeader(res);
```

With your own keys, implement `CantonSigner` and wrap `fetch`:

```ts
import { wrapFetchWithCantonPayment, type CantonSigner } from "@ftptech/x402-canton-client";

const signer: CantonSigner = {
  party: "<your party>",
  async signTransferFactory(input) {
    // Prepare and sign a TransferFactory_Transfer for `input`, then return
    // { payerParty, preparedTxHash (hex, of the signed bytes), preparedTransactionBytes, signatureB64 }.
  },
};

const payFetch = wrapFetchWithCantonPayment(fetch, signer);
```

## API

- `wrapFetchWithCantonPayment(fetch, signer, options?)`: pays a 402 and retries. Throws `X402PaymentError` with a stable `code`.
- `peekChosenRequirement(response, signer, options?)`: the entry it would pay (payee, amount, token), without paying.
- `readPaymentResponseHeader(response)`: decodes `PAYMENT-RESPONSE`.
- `ExactCantonScheme`: builds the x402 v2 payment payload.

Options: `networkFilter`, `selectRequirements` (default: the first match), `maxPaymentRetries`.

## Errors worth handling

- `PAYMENT_UNCONFIRMED`: the outcome is unknown. Check the balance before paying again.
- `MERCHANT_HEADER_LIMIT`: the merchant's proxy rejects the 8 to 10 KiB payment header. Nothing settled; it needs 16 KiB (nginx `large_client_header_buffers 4 16k;`).

Guide: [x402-docs.ftptech.xyz/x402-agent](https://x402-docs.ftptech.xyz/x402-agent).
