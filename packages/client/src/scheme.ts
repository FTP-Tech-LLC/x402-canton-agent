/**
 * ExactCantonScheme — payer-side x402 scheme client.
 *
 * Composes a `CantonSigner` (which knows how to create a
 * TransferCommand on the agent's participant) with the x402 v2 wire
 * format to produce the PaymentPayload the facilitator expects.
 *
 * Usage pattern (next-tick wrapFetchWithCantonPayment will inline
 * this):
 *
 *   const scheme = new ExactCantonScheme(signer);
 *   const payload = await scheme.createPaymentPayload(
 *     requirements,
 *     { url: "https://api.example.com/data" }
 *   );
 *   // POST the request again with
 *   //   PAYMENT-SIGNATURE: <base64-encoded JSON payload>
 */

import { randomUUID } from "node:crypto";
import type {
  PaymentRequirements,
  X402ResourceInfo,
  CantonNetwork,
  CantonPaymentPayload,
} from "@ftptech/x402-canton-core";
import type { ExactScheme } from "@ftptech/x402-canton-core";
import { encodeInlinePaymentPayload } from "@ftptech/x402-canton-core";
import { wireAmountToLedgerDecimal } from "@ftptech/x402-canton-core";
import type { CantonSigner } from "./signer.js";

export interface CantonPaymentEnvelope {
  x402Version: 2;
  // x402-ENVELOPE: the scheme name is "exact" (Canton is a network of the exact
  // scheme). The client emits "exact"; the facilitator advertises and accepts
  // "exact" only. See selectServerRequirements.
  scheme: ExactScheme;
  network: CantonNetwork;
  resource: X402ResourceInfo;
  accepted: PaymentRequirements;
  payload: CantonPaymentPayload;
}

/**
 * Thrown when the resource advertises an assetTransferMethod this signer cannot
 * service — e.g. a resource whose 402 demands a method this signer does not
 * implement. Named + carrying both the required and supported method so the
 * caller can branch (e.g. surface "fund a different wallet" vs a cryptic
 * "signer does not implement ..."), instead of leaking a bare Error.
 */
export class SchemeMethodMismatchError extends Error {
  constructor(
    /** What the resource's 402 demanded. */
    public readonly required: string,
    /** What this signer actually supports. */
    public readonly supported: string
  ) {
    const hint =
      supported === "(none)"
        ? " This signer does not implement signTransferFactory."
        : "";
    super(
      `this wallet supports ${supported} only; the resource requires ` +
        `${required}.${hint}`
    );
    this.name = "SchemeMethodMismatchError";
  }
}

export class ExactCantonScheme {
  constructor(private readonly signer: CantonSigner) {}

  /**
   * Build the full PaymentPayload to send back in PAYMENT-SIGNATURE.
   *
   * Generates a fresh paymentId, stamps x402 metadata onto the on-ledger
   * transferLeg.meta, delegates to the signer's transfer-factory arm
   * (signer.signTransferFactory) to land the on-ledger artifact, and wraps the
   * result in the v2 envelope. Throws if the signer can't service the method.
   */
  async createPaymentPayload(
    requirements: PaymentRequirements,
    resource: X402ResourceInfo
  ): Promise<CantonPaymentEnvelope> {
    const extra = requirements.extra;
    const paymentId = randomUUID();

    // UNIT seam: the on-ledger Daml Decimal the signer stamps into the transfer
    // MUST be derived from the WIRE amount. Under scheme "exact" (the only
    // scheme; atomic integer units) it converts EXACTLY via atomicToDecimalCC.
    // Computing it ONCE here is the client-side off-by-10^10 firewall.
    const ledgerAmount = wireAmountToLedgerDecimal(
      requirements.scheme,
      requirements.amount
    );

    if (extra.assetTransferMethod === "transfer-factory") {
      if (!this.signer.signTransferFactory) {
        throw new SchemeMethodMismatchError("transfer-factory", "(none)");
      }
      const transferMeta: Record<string, string> = {
        "x402.paymentId": paymentId,
        "x402.version": "2",
        ...(extra.memo ? { "x402.memo": extra.memo } : {}),
      };
      const signed = await this.signer.signTransferFactory({
        receiver: requirements.payTo,
        amount: ledgerAmount,
        instrumentId: extra.instrumentId,
        executeBeforeSeconds: extra.executeBeforeSeconds,
        transferMeta,
      });
      return {
        x402Version: 2,
        scheme: "exact",
        network: requirements.network,
        resource,
        accepted: requirements,
        payload: {
          // NO `payer` on the wire: the payer would be an untrusted client
          // claim. The facilitator proves the payer from the signed transaction
          // (the signer still returns `payerParty`, but it is not emitted here).
          // The INLINE carriage is the only one: the payload carries the signed
          // transaction itself, so it resolves at ANY facilitator — which is what
          // the protocol requires, since the merchant chooses the facilitator and
          // the payer never learns which one.
          ...encodeInlinePaymentPayload({
            preparedTransactionBytes: signed.preparedTransactionBytes,
            preparedTxHash: signed.preparedTxHash,
            signatureB64: signed.signatureB64,
            ...(signed.hashingSchemeVersion
              ? { hashingSchemeVersion: signed.hashingSchemeVersion }
              : {}),
          }),
        },
      };
    }

    // Exhaustiveness — the only variant (transfer-factory) is handled above, so
    // `extra` narrows to `never` here. Reachable only if a new method arm is
    // added to the core union without a scheme arm.
    throw new Error(
      `unsupported assetTransferMethod: ${
        (extra as { assetTransferMethod?: string }).assetTransferMethod ?? "(none)"
      }`
    );
  }
}
