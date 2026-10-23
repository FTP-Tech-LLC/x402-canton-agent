# @ftptech/canton-agent-wallet

## 2.4.0

### Minor Changes

- Tradecraft queued mode: the new `tc` command (`setup`, `orders`, `status`,
  `cancel`, `withdraw`) trades on Tradecraft through a SwapOrderBatcher and one
  committed token-standard V2 allocation per pool instrument (topped up on later
  setups) instead of a transfer to the pool party. Orders are exact-input with
  per-order minimums taken from the cumulative quote, queued in one transaction;
  `withdraw` asks the venue to release funded allocations back to the wallet.
  Every shape is verified before signing (core 1.4.0): the venue is the sole
  executor, every allocation and holding created is the wallet's, amounts and
  minimums are pinned, and the withdrawal request is pinned to Tradecraft's
  package. Needs a relay with the queued surface enabled. `swap` (pool-address
  swaps) is unchanged. Requires core 1.4.0.
- Published from the release line `release/agent-wallet-2.4.0` (2.3.2 plus
  this feature only). The lock and asset changes already on `main` are not part
  of 2.4.0; they ship in a later release.

## 2.3.2

### Patch Changes

- CBTC transfers sign again. On 2026-10-14 BitSafe replaced CBTC's reward
  beneficiary (`cbtc-beneficiary` → `cbtc-beneficiary-2`) in its
  `InstrumentConfiguration`, and verify-before-sign refused every CBTC transfer
  (pay, withdraw, swap, merge) as naming an unexpected party. With
  `@ftptech/x402-canton-core` 1.3.1 the pinned registrar's own configuration is
  admitted inside that contract only, so the hard-coded `cbtc-beneficiary`
  entry is gone. Requires core 1.3.1.
- Published from the hotfix branch `release/agent-wallet-2.3.2` (2.3.1 plus
  this fix only). The lock and asset changes already on `main` are not part of
  2.3.2; they ship in 2.4.0.

## 2.3.1

### Patch Changes

- Canton Coin dust no longer makes a token look cut off. Against a facilitator
  that narrows its bounded reads, a wallet's token holdings are read by their
  registry's holding template, so `swap` into a token sees the delivery, and
  `balance` and `merge --all-tokens` ask for the tokens only (`class=registry`).
  Against an older relay the behaviour is as in 2.3.0.
- `swap`: a wait that ends on an incomplete read of the output token (the
  wallet crossed the participant's list cap mid-wait) is reported as
  `deliveryUnobservable` rather than as a timeout, and a sub-minimum rise seen
  before that is still reported as `partialRise`. Claims and the returned-input
  watch run for the whole window, as in 2.3.0, and the message says to run
  `claim` for an input handed back later.
- `merge --all-tokens` no longer asks for `--yes` when nothing in view can be
  merged (e.g. the view is Canton Coin dust); it says to run plain `merge`
  first.
- The input caps (70 Canton Coin / 90 registry inputs per transaction) come
  from `@ftptech/x402-canton-ledger`, shared with the relay. Requires ledger
  0.5.1.

## 2.3.0

### Minor Changes

- Wallets with more holdings than the participant lists in one read (the
  200-element cap) work again. Reads go through the relay's bounded
  `/holdings?slice=1`; `merge` works through the wallet slice by slice and
  `merge --all-tokens` consolidates every token of a mixed wallet; `withdraw`
  and `swap` sell pick a covering subset of holdings; `balance` shows "≥" for a
  token it cannot see in full instead of hiding it; `swap` says when delivery
  cannot be observed. Needs a facilitator that serves the slice; against an
  older relay these commands behave as before.
- `pay --max <amount> [--asset <symbol>]` and `pay --pay-to <party>` cap and pin
  a payment before anything is signed. A cap applies to the instrument actually
  paid (its admin and id, never the 402's label): a cap set only for some
  tokens refuses Canton Coin and any other payable token rather than signing
  them uncapped.
- `--asset` / `--max` with a known symbol (USDCx, CBTC, …) also match that
  instrument from a registrar trusted through
  `CANTON_AGENT_REGISTRY_TRUSTED_PARTIES`, so they work on testnet/devnet; the
  MainNet registrar's entry is preferred when both are offered.
- Merchant self-preapproval is verified in full before signing (root template,
  consequences, creates, receiver/provider/expiry and parties). On testnet set
  `CANTON_AGENT_DSO_PARTY`.
- `--relay-url` and `CANTON_AGENT_RELAY_URL` are honoured by every command;
  `set-relay` stores a relay for the wallet; `makePayingFetch` uses
  `opts.relayUrl`.
- Relay calls time out; a submission whose outcome is unknown says so instead of
  failing. `preapproval` no longer assumes `--id USDCx` for every registrar.
- Removed the `@internal` `reserveHolding` export.

## 2.2.0

### Minor Changes

- Venue attribution is on by default. Every outbound CIP-56 registry-token
  transfer the wallet authors (x402 pay, withdraw, swap-sell) now carries
  `ftp/venue = ftp/agentic-wallet` in `transfer.meta.values` with no env set.
  `CANTON_AGENT_VENUE_KEY` / `CANTON_AGENT_VENUE_TAG` still override the key /
  value, and `CANTON_AGENT_VENUE_KEY=off` disables stamping. Canton Coin is
  never stamped.

## 2.1.0

### Minor Changes

- The starter grant. A relay that pays every new wallet a grant says so in
  its onboard/finalize answer (`starterGrant`), and the grant lands shortly
  after as a pending transfer only the wallet's key can accept. `ensureWallet`
  now waits for it and accepts it before returning, so a new wallet comes
  back funded; `create` prints what arrived. Options: `starterGrant: "wait"`
  (default) | `"background"` (return at once, accept afterwards, for a
  long-lived process) | `"leave"` (the offer stays for `claim`), plus
  `starterGrantTimeoutMs` (90 s), `starterGrantPollMs` and `onStarterGrant`.
  A grant that does not come, or cannot be accepted, never fails the wallet.
  An existing or imported wallet gets no grant.
- `acceptStarterGrant(relay, wallet, grant, opts)` for a caller that wants to
  run that step itself. It never throws.

## 2.0.0

### Major Changes

- The hosted quest is gone, and with it everything that only served it:
  the `fund` CLI command, `questFund` / `fundViaQuest` / `QuestFundError` /
  `writeRescueKey`, and `RelayClient.faucetClaim` with its `faucetSecret`
  option. A new wallet is funded by its owner: `address` (or the MCP's
  `request_funding`), then `claim`.

### Minor Changes

- `peekWalletPayment(response, wallet)` says what a paying fetch for this
  wallet would pay for a 402 without paying: payee, atomic amount, and
  whether the chosen entry is a registry token (same selection as paying).
- `RelayClient.missingRoutes(paths)` and `PAY_AND_CLAIM_RELAY_ROUTES`: ask a
  facilitator whether it still serves the routes this wallet's pay and
  claim steps call (one empty POST each; only Fastify's route-not-found
  counts as missing). The client methods use the same route strings.
- Requires @ftptech/x402-canton-client ^1.2.0 (`peekChosenRequirement`).

## 1.6.1

### Patch Changes

- Republish of 1.6.0 with resolved dependency ranges. 1.6.0 went out through
  `npm publish` instead of `pnpm publish`, so its `@ftptech/x402-canton-*`
  dependencies were left as `workspace:^` and it does not install; it is
  deprecated. No code change.

## 1.6.0

### Minor Changes

- The swap's venue routing is now a module of its own (`swap-route.ts`) and is
  exported along with the swap primitive: `resolveSwapIntent`,
  `resolveSwapTicket`, `swapFloorNotes`, `parseSwapVenue`, `parseSlippagePct`,
  `executeSwap`, `SWAP_MAX_FEE_CC`, the Cantex constants. The CLI `swap`
  command runs on it unchanged (same venues, fallbacks, minimums, receiver
  pins), and the MCP server's new `swap` tool runs on the same code — one
  router, so a routing rule cannot drift between the two. Advisory lines
  (`auto:` comparison, fallback taken, minimum not met, what bounds the fill)
  come back as structured `notes` for callers that do not own the terminal.
- `executeSwap` notices a CC input coming BACK. A venue that will not fill
  the trade (Tradecraft, below its minimum) hands the CC back — directly,
  to a wallet holding a CC preapproval — which the output watch could not
  see, so the wait ran its full window and reported "not received yet".
  The CC balance standing back at its pre-send level (from the second tick
  on) now ends the wait early with `inputReturned: true`, and `swap` says
  the input was returned rather than hedging.

## 1.5.0

### Minor Changes

- `swap --venue cantex|tradecraft|auto` (default `cantex`). Cantex Connect is
  keyless and delivers CC <-> USDCx, CBTC, USDXLR and cETH both ways; eXAG and
  eXAU are wired but their pools are illiquid today (the input comes back).
  Tradecraft stays available, with a hardcoded pool-order fallback so a swap
  can still be built when its API is down, and retries on flaky quotes. The
  receiver is pinned per venue to a client-side constant (Cantex: the Connect
  party; Tradecraft: the pool derived from your trusted `amm_cid`), and a
  ticket naming any other party is refused before anything moves.
- Honest slippage per venue: on Cantex there is no on-ledger floor (the memo
  names the buy symbol, not a minimum), so `--slippage` only sets the delivery
  threshold the wait loop reports against, and the CLI says so. On Tradecraft
  the memo floor is enforced on-ledger when the ticket carries a memo key.

## 1.4.3

### Patch Changes

- Registry-token sends sign again. Since the registry-utility 0.14.4 bundle
  every USDCx/CBTC/USDXLR/cETH transfer carries an `EventLog_HoldingsChange`
  accounting node on the registrar's Holding, and verify-before-sign refused
  it ("unexpected exercise(s)"): withdrawals, token→CC swaps and token x402
  payments all stopped. The node is admitted (it is a leaf: no creates,
  archives or nested exercises; everything money-relevant stays pinned).
  Ships @ftptech/x402-canton-core 1.2.1.

## 1.4.2

### Patch Changes

- A payment refused because the payee's TransferPreapproval expired is now
  named as such instead of surfacing as a bare relay 400: the message carries
  the ledger's own cause, so an agent can tell a lapsed merchant from a broken
  relay.
- `withdraw` reports whether the funds landed in the receiver's wallet
  (direct settle) or await their `claim` (pending offer). A bare "withdrew N
  to <party>" read as delivery in the case where nothing had been delivered
  yet. The relay's answer is tri-state; "unknown" is reported as unknown.

## 1.4.1

### Patch Changes

- `create` now prints the Terms of Service acceptance line with a link to
  https://ftp-tech.mintlify.site/terms. The wallet is self-custody and the
  facilitator is a relay; the Terms say so, and set the acceptable-use and
  fair-use rules the facilitator's abuse controls enforce.

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
