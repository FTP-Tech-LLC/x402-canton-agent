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
   * MERCHANT/payTo) and leave it STASHED on the relay; the facilitator relays it
   * at /settle and pays the GS traffic. Returns the small `submissionRef` the
   * x402 payload carries (the signed prepared tx is 100s of KB and never travels
   * in the header). Optional: signers that only support other methods may omit it.
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
  /** x402 metadata (paymentId, version, memo?) — advisory; the facilitator does
   *  not match it on this path. */
  transferMeta?: Record<string, string>;
}

export interface SignedTransferFactory {
  payerParty: string;
  /** Opaque relay stash reference — the x402 payload's `submissionRef`. */
  submissionRef: string;
  /** Hex hash of the prepared tx the payer signed — the payload's
   *  `preparedTxHash` (binds the ref to the exact signed bytes). */
  preparedTxHash: string;
}
