# @ftptech/canton-agent-wallet

## 1.4.0

### Minor Changes

- Venue attribution (`CANTON_AGENT_VENUE_KEY` + `CANTON_AGENT_VENUE_TAG`, off by
  default): the wallet stamps the configured `<name>/venue` key into the metadata
  of every outbound CIP-56 registry-token transfer it authors — swap-sell,
  withdraw, and x402 pay (the facilitator merges the client-sent tag into the
  prepared transfer, bounded and validated, with `x402.memo` always last). A
  key/tag the relay would reject is refused at the source with a stderr warning
  instead of stamping on one path and 400-failing another.
- `swap` now waits until the output actually lands (no manual `claim`): pending
  offers are claimed into the baseline pre-send, arrival requires the balance
  rise to reach the ticket minimum (a sub-minimum rise is reported separately,
  never as the fill), locked holdings are excluded from the read, and a relay
  error during the wait degrades to a missed poll — the sent `updateId` is never
  lost. `--no-wait` returns as soon as the input is sent.

## 1.3.1

### Patch Changes

- Docs: `swap` is now listed in the CLI usage string and the README, along with
  the guards that shipped with it — `--max-fee` (the ceiling on what the
  untrusted swap endpoint may charge), `--swap-merchant` (pin the fee payee) and
  `--no-preapprove`. Corrects the description of `--direct`, which queries
  Tradecraft live rather than replaying a snapshot shipped in the release, and
  drops a stale docblock that claimed output preapproval was opt-in.

## 1.3.0

### Minor Changes

- `swap --in <SYMBOL> --out <SYMBOL> --amount <n> [--slippage <pct>]`: swap Canton
  Coin against a CIP-56 registry token (USDCx, CBTC, USDXLR, cETH, eXAG, eXAU) on
  the Tradecraft AMM. The ticket comes from an x402-gated endpoint by default and
  is validated client-side before anything is sent: the pool party must be the
  `tc-swp` party of the requested pair under the client's own AMM contract id, and
  the instruments must equal the ones resolved locally, so a compromised endpoint
  can quote a bad price but cannot redirect funds. `--direct` resolves the ticket
  locally instead, without the fee.
- The ticket fee is bounded: the endpoint is untrusted for money safety, so the
  402 it answers with is capped (default 0.5 CC, `--max-fee`) and, when the
  operator names the merchant (`--swap-merchant` / `CANTON_AGENT_SWAP_MERCHANT`),
  pinned to that payee.
- The slippage floor rides in the transfer memo, so a ticket without a memo key
  carries no protection at all. Both the endpoint and the `--direct` path now say
  so instead of only reporting a floor when one exists.

## 1.2.0

### Minor Changes

- `pay --asset <symbol>` (CLI) / `makePayingFetch({ preferAsset })` (SDK): when a
  402 offers several `accepts[]` entries (e.g. CC and USDCx), pay in the one whose
  asset symbol — or structured `instrumentId.id` — matches, case-insensitively.
  An explicitly requested asset the 402 does not offer fails closed with the
  offered list (never a silent fallback to the merchant's first entry); omitted →
  the first compatible entry, exactly today's default. Selection only: spending a
  registry token still requires `CANTON_AGENT_PAYABLE_INSTRUMENTS`, and a
  preferred-but-unconsented asset fails closed with the usual consent error. The
  pre-pay peek (lock decision) runs the same selector as the paying fetch.

## 1.1.0

### Minor Changes

- Registry-token (CIP-56) parity for the housekeeping commands: `balance` lists every
  instrument the wallet holds; `withdraw --admin <registrar> --id <instrument>`;
  `claim` accepts registry offers (expired ones skipped, one failed offer never blocks
  the rest, offers of an untrusted registrar are skipped and named); `merge --admin --id`
  consolidates a registry token with full-sum self-transfers. Canton Coin is recognised
  by the local DSO anchor, never by a row's own label. `claim` exits 1 when every
  attempted accept failed. Exact BigInt ledger-Decimal arithmetic everywhere an amount
  is summed.
