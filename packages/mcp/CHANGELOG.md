# @ftptech/canton-x402-mcp

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
