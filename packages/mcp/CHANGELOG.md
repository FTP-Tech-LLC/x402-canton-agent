# @ftptech/canton-x402-mcp

## 2.7.0

### Minor Changes

- Paid requests follow `@ftptech/x402-canton-client` 1.4.0: a 5xx after
  payment is re-sent with the same payment, then reported as not confirmed;
  the tool never pays twice for it.
- Reads of the wallet's own party are signed for the relay.
- Uses `@ftptech/canton-agent-wallet` 2.8.0.

## 2.6.2

### Patch Changes

- `claim` runs in the wallet's queue with pay, withdraw and swap. Two claims at
  once each prepared and executed an accept for the same pending transfers; one
  failed and could answer that every accept failed although the funds had
  arrived. Uses `@ftptech/canton-agent-wallet` 2.7.2.

## 2.6.1

### Patch Changes

- `swap`: an output not received says the input waits in an offer until it
  expires, for CC as well as tokens (a CC offer comes back by itself), and a
  direct or auto swap without a floor names `CANTON_AGENT_TRADECRAFT_MEMO_KEY`.
  `swap_quote` says when swap would refuse an amount below Tradecraft's minimum.
  Uses `@ftptech/canton-agent-wallet` 2.7.1, which refuses a below-minimum or
  uncovered swap before the ticket fee.

## 2.6.0

### Minor Changes

- `swap_quote`, read-only and free: with no arguments it lists the Tradecraft
  pools; with in, out and amount it quotes each venue `swap` would use, runs
  swap's own limit gate, and names the venue that quotes more.
- `find_paid_apis` shows how to call each API: query, JSON body, fields, note.
- `pay`: with no asset it pays in CC when the API offers CC; a JSON body is
  sent as application/json; after an HTTP error to a paid request the reply
  says the API kept the payment and what to do next.
- `swap` checks a token sale against the cap on a free quote before the ticket
  fee, refuses an input the wallet cannot cover before the fee, and writes
  failed swaps to the history. `withdraw` refuses a swap venue's party and says
  CC only. `get_history` says what each move was; `get_balance` says what is
  locked (sunstrike228/canton-x402#249).
- Local only: `tradecraft_queued_fills`, the queued orders on a pool and what
  became of them, with what each settlement paid (sunstrike228/canton-x402#251).
- A failed swap's history line keeps this package's own wording, never text a
  venue or endpoint sent back. `swap_quote` stops reading Tradecraft's pool list
  past 1 MB, and says a direct or auto Tradecraft swap fills at market unless
  `CANTON_AGENT_TRADECRAFT_MEMO_KEY` is set.

## 2.5.0

### Minor Changes

- `claim` also takes back this wallet's own expired offers the receiver never
  took, and says what came back and what is still waiting. A verify refusal on
  such a withdraw is an error result.
- `swap`: a token input defaults to Tradecraft; a token swap that times out
  says the input sits in the venue's offer until it expires and `claim` then
  returns it.
- For a hosting server: with `newTools`, `get_balance` states the owner's limits
  once (the `limits:` line names the limits page).
- Requires `@ftptech/canton-agent-wallet` 2.6.0.

## 2.4.0

### Minor Changes

- New read-only tools: `find_paid_apis` (the facilitator's catalogue of paid
  APIs and their prices, cached for 5 minutes) and `get_guide` (a short guide
  for the agent). Neither creates a wallet.
- `get_balance` adds one line per token held and the spend limits left today.
  Its first line is unchanged.
- `pay` takes `max_cc` (a lower cap for this call only), `max_response_chars`
  (default 4000, at most 20000) and `asset` (`CC` or `USDCx`). USDCx payments
  run only when the owner sets both `--usdcx-max-per-tx` and
  `--usdcx-daily-cap`; a cap that is not set is not "no cap".
- Money moves (pay, withdraw, swap) are queued across processes that share one
  wallet home (`<home>/.policy-lock`), so two hosts on one home cannot both pass
  the daily cap.
- `--single-payment` / `CANTON_MCP_SINGLE_PAYMENT`: at most one payment per
  `pay` call.
- `--allow-domains catalog`: pay only resources listed in the facilitator's
  catalogue.
- `pay` refuses to pay the wallet's own relay.
- The money-move lock covers only the spend gate, the payment and its record,
  not the merchant's body: a merchant that trickles its body no longer holds
  every other move on the wallet, and a body that never ends is read for 30 s
  at most. A queued withdraw or swap whose client stopped waiting sends
  nothing. The Lighthouse cross-check gives up after 10 seconds.
- Tradecraft queued mode on the local server: `tradecraft_queued_setup`,
  `_orders`, `_status`, `_cancel` and `_withdraw` drive the wallet's `tc`
  command (agent-wallet 2.4.0). Funding an allocation runs the spend policy
  like `swap`. Needs a relay with the queued surface enabled; the hosted server
  does not register them.
- The server instructions start by pointing at `get_guide` and
  `find_paid_apis`, and say that `pay` is one call, never retried.
- For a hosting server: `SpendPolicy.limitsUrl` makes a refusal at a spend cap,
  and `get_balance`, name the page where the owner changes the limits.
  `get_history` and `send_feedback` are listed only when the host passes a
  history store or a feedback sink; the local server has neither.
- Includes everything in 2.3.1 (published from the release line).
- Requires `@ftptech/canton-agent-wallet` 2.5.0.

## 2.3.1

### Patch Changes

- `pay` counts the larger of the balance drop and the Canton Coin the signer
  signed. A merchant that answered first and settled a few seconds later was
  not in the balance read right after the call, so the daily cap and the
  funded ceiling never saw it. When the signed amount is not in the balance
  yet, the answer says so and that funds may still move.
- Requires `@ftptech/canton-agent-wallet` 2.4.1. Published from the release
  line `release/agent-wallet-2.4.1`.

## 2.3.0

### Minor Changes

- `pay` hands the signer the smaller of the per-transaction cap and what is
  left of today's budget (and of the funded ceiling, when it is on). Before,
  the daily cap only refused a payment once it was already spent, so the last
  payment of the day could overshoot it by a whole per-transaction cap. A daily
  cap set without a per-transaction cap now caps each payment too.
- `registerWalletTools` takes an optional `serialize`, which runs pay, withdraw
  and swap one at a time for a wallet (the hosted server passes a per-user
  queue).
- A tool error now carries the cause behind a generic network message, e.g. why
  a connection was refused rather than only "fetch failed".
- `SpendPolicy.withdrawAllowlist` (with `withdrawAllowlistUrl`): when set,
  `withdraw` sends only to those parties and names where the owner adds one.
  Unset on the local server, so nothing changes there.
- `PolicyLedgerStore.recordOperation` (optional): one history line per pay,
  withdraw, swap and claim, written best effort.

## 2.2.0

### Minor Changes

- A new wallet's starter grant (0.2 CC from the MainNet relay) is accepted in
  the background right after the first tool call creates the wallet, and
  counts toward the funded ceiling the way a `claim` would. The first call
  does not wait for it.
- `get_balance` says when incoming transfers are waiting to be claimed.
- Two tool calls racing to create the wallet now share one onboarding;
  before, each could onboard its own party and the second save won.
- Requires @ftptech/canton-agent-wallet ^2.1.0.

## 2.1.0

### Minor Changes

- The seven tools are registered by `registerWalletTools(server, deps)`
  (exported, with `WalletToolDeps`), where the wallet, relay client, paying
  fetch and spend-policy ledger are injected. `createServer` wires the same
  local behaviour as before (one wallet in `--home`, the file ledger); the
  hosted remote MCP wires a per-user wallet and a database ledger. One copy of
  the money logic serves both. Also exported: `PolicyLedgerStore`,
  `createFilePolicyLedgerStore`.

## 2.0.0

### Major Changes

- `auto_fund` is removed, together with `--pay-proxy-url` /
  `CANTON_AGENT_PAY_PROXY_URL`: it bootstrapped a funded wallet through the
  hosted quest, which no longer exists. A new wallet is funded by its owner:
  `request_funding` returns the party id and a message to paste, then
  `claim`. The flag is ignored if still passed. Requires
  @ftptech/canton-agent-wallet ^2.0.0.

## 1.2.1

### Patch Changes

- Republish of 1.2.0 with a resolved dependency range. 1.2.0 went out through
  `npm publish` instead of `pnpm publish`, so its `@ftptech/canton-agent-wallet`
  dependency was left as `workspace:^` and it does not install; it is
  deprecated. Requires @ftptech/canton-agent-wallet ^1.6.1. No code change.

## 1.2.0

### Minor Changes

- New `swap` tool: swap CC and the known registry tokens (USDCx, CBTC, USDXLR,
  cETH, eXAG, eXAU) on Cantex Connect (default) or the Tradecraft AMM, or
  `auto`, through the same venue router as `canton-agent-wallet swap`. The
  input only ever goes to the pinned venue parties. Bounded by the spend
  policy on its CC leg: a CC input gets the full withdraw gate before any
  quote (the ticket fee is itself a payment); a token input is checked against
  the per-tx cap on the venue's quoted CC value; no CC figure under a cap is a
  refusal. The fee and the input are booked to the ledger separately, the
  moment each leaves. Waits for the output to land and reports what arrived,
  what was claimed, and what bounded the fill (on Cantex: nothing on-ledger).
  A CC input the venue hands back unfilled (below its minimum) is reported
  as returned — the CC balance shows it even though the wait loop watches
  the output — and counts as funding again for the ceiling, like `claim`.
  Requires @ftptech/canton-agent-wallet ^1.6.0.

## 1.1.0

### Minor Changes

- `claim` reports expired/failed/untrusted-registrar offers and returns an error when
  every attempted accept failed. Requires @ftptech/canton-agent-wallet ^1.1.0.
