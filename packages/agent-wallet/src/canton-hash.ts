/**
 * Re-export shim. The conformant Canton hash recompute moved to
 * `@ftptech/x402-canton-ledger` so the FACILITATOR can use it too: the inline
 * carriage requires the facilitator to recompute the hash from payer-supplied
 * bytes (scheme Rule 3), and a facilitator->agent-wallet dependency would run
 * the wrong way round.
 *
 * This file stays so every existing `./canton-hash.js` import — and the
 * published package's own export surface — keeps working unchanged.
 */
export {
  HASH_PURPOSE,
  recomputeHash,
  recomputeTopologyMultiHash,
  fingerprintHex,
} from "@ftptech/x402-canton-ledger";
