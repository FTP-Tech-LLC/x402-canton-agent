/**
 * CantonSigner abstraction for the payer (agent) side.
 *
 * The signer lands the on-ledger artifact the facilitator later verifies, via
 * `signTransferFactory` — the payer PREPARES + SIGNS a token-standard
 * `TransferFactory_Transfer` (sender = the payer, receiver = the merchant) and
 * leaves it stashed on the relay; the facilitator relays it in ONE tx and pays
 * the GS traffic (no escrow, no facilitator custody).
 *
 * Implementation: the agent-wallet relay signer (`makeRelaySigner`). Test stubs
 * use vi.fn().
 */

export interface CantonSigner {
  /** Party this signer signs as. Same value the facilitator sees
   *  in `payload.payer`. */
  readonly party: string;

  /**
   * transfer-factory ("V3", 1-tx meta-transaction): PREPARE + verify-before-sign
   * + SIGN a `TransferFactory_Transfer` (sender = this party, receiver = the
   * MERCHANT/payTo) and return the signed transaction INLINE; the x402 payload
   * carries it and the facilitator relays it at /settle (paying the GS traffic).
   * Optional: signers that only support other methods may omit it.
   */
  signTransferFactory?(
    input: SignTransferFactoryInput
  ): Promise<SignedTransferFactory>;
}

export interface SignTransferFactoryInput {
  /** Merchant party id (PaymentRequirements.payTo). */
  receiver: string;
  /** Daml Decimal amount string, e.g. "0.2500000000". */
  amount: string;
  /** `{admin, id}` of the instrument the merchant advertised. */
  instrumentId: { admin: string; id: string };
  /** Relative deadline (seconds from now) for the transfer's executeBefore. */
  executeBeforeSeconds: number;
  /** x402 metadata stamped into the transfer's meta: `x402.paymentId`,
   *  `x402.version`, and — when the merchant set PaymentRequirements.extra.memo —
   *  `x402.memo`. The facilitator ENFORCES `x402.memo` against the merchant's
   *  required memo on the transfer-factory path (fail-closed at /verify + /settle);
   *  the other keys are advisory reconciliation aids. */
  transferMeta?: Record<string, string>;
}

export interface SignedTransferFactory {
  payerParty: string;
  /** Hex hash of the prepared tx the payer signed. It is what the signature is
   *  over, and the facilitator recomputes it from the bytes to check both. */
  preparedTxHash: string;
  /** The raw prepared transaction bytes the payer signed — carried INLINE in the
   *  payment payload, self-contained so any facilitator can relay it. */
  preparedTransactionBytes: Uint8Array;
  /** Base64 Ed25519 signature over `preparedTxHash`. Travels with the bytes. */
  signatureB64: string;
  /** Canton hashing scheme used for `preparedTxHash`. Defaults to V2. */
  hashingSchemeVersion?: "HASHING_SCHEME_VERSION_V1" | "HASHING_SCHEME_VERSION_V2";
}
