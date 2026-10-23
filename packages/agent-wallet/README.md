# @ftptech/canton-agent-wallet

A self-custody Canton wallet + x402 autopay for AI agents. The agent holds its
own Ed25519 key and pays for x402-gated resources on the Canton Network on its
own. The hard parts of Canton (a party must be hosted on a validator, and its
API is authed) are hidden behind a facilitator **relay** the agent talks to over
plain HTTP. The relay can *prepare* and *submit* on the agent's behalf but never
*signs*, so it has no custody.

Backs the [`canton-x402-agent`](https://www.ftptech.xyz/agents/skill.md) skill.

## Install

```bash
npm install @ftptech/canton-agent-wallet
# or run the CLI without installing:
npx @ftptech/canton-agent-wallet <command>
```

Bin: `canton-agent-wallet`.

## CLI

```
canton-agent-wallet create --relay-url <url>        # generate + onboard a self-custody wallet (idempotent)
canton-agent-wallet address                         # print the party id (fund this)
canton-agent-wallet balance                         # print the balance of every instrument the wallet holds (CC + any CIP-56 registry token, e.g. USDCx; "≥" when the wallet is too large to list in one read)
canton-agent-wallet claim                           # accept incoming transfers — CC and registry tokens (expired offers are skipped; one bad offer never blocks the rest)
canton-agent-wallet merge [--target <n>] [--batch <n>] [--max-rounds <n>] [--dry-run] [--yes] [--admin <registrar> --id <instrument> | --all-tokens]   # consolidate dust (CC, one registry token, or every trusted token) so a busy wallet can be enumerated + spent again
canton-agent-wallet preapproval [--status] [--admin <DSO|registrar>] [--id <instrument>] [--days <n>]   # MERCHANT: self-provision this wallet's own TransferPreapproval so transfer-factory payments settle in one round-trip (--status just checks)
canton-agent-wallet pay [--relay-url <url>] [--asset <symbol>] [--max <amount>] [--pay-to <party>] <url>   # fetch a URL, auto-paying any x402 402 challenge (--max caps one payment, --pay-to pins the payee)
canton-agent-wallet swap --in <SYM> --out <SYM> --amount <n> [--venue cantex|tradecraft|auto] [--slippage <pct>] [--direct] [--no-wait] [--max-fee <cc>] [--swap-merchant <party>] [--no-preapprove]   # swap CC <-> a CIP-56 registry token on Cantex (default) or Tradecraft; waits for the output to land (see below)
canton-agent-wallet withdraw --to <party> [--amount <n>] [--admin <registrar> --id <instrument>]   # send CC (default: full balance) or a registry token back out
canton-agent-wallet export                           # print the private key (backup; guard it)
canton-agent-wallet set-relay <url>                  # switch the relay saved in wallet.json (refuses one on another network)
```

`create` and `pay` **require** a relay (facilitator) URL: pass `--relay-url
<url>` or set `CANTON_AGENT_RELAY_URL`. There is no default: a stale built-in
default would silently send payments to a dead host, so the CLI fails fast when
none is given. Every other command uses the relay stored in the wallet at
`create` time, unless `--relay-url` / `CANTON_AGENT_RELAY_URL` names another for
that run (said on stderr; the saved one is not changed). `set-relay <url>`
changes the saved relay, after checking it settles on the wallet's network. The
current FTP facilitator is `https://facilitator.ftptech.xyz`.

`pay --max <amount>` caps what one payment may cost, in the unit of what is
paid: with `--asset <token>` that token's own amount, otherwise Canton Coin (and
a 402 asking for a token is then refused — add `--asset`). `--pay-to <party>`
pins the only payee the wallet will sign for. Both refuse before anything is
signed; without them `pay` pays whatever the 402 asks, as before.

### Merchant onboarding: self-provision a `TransferPreapproval`

To be paid via the transfer-factory path, a merchant must hold a live
`TransferPreapproval` for the Canton Coin instrument so an incoming
`TransferFactory_Transfer` resolves `direct` and settles in one facilitator-relayed
tx. The merchant self-provisions it from *this* wallet with its OWN key — a single
controller, so **no operator token and no `CanActAs` delegation** to the
facilitator:

```bash
canton-agent-wallet preapproval            # self-provision (idempotent; checks first)
canton-agent-wallet preapproval --status   # just report hasPreapproval / transferKind
```

The merchant prepays the holding fee from its OWN CC, so the wallet needs a little
CC first. `--days <N>` sets the preapproval lifetime (default 30; shorter prepays a
smaller fee); `--expires-at <ISO>` overrides. The instrument admin (DSO) is
auto-resolved per network, or pass `--admin <DSO party>`. If a live preapproval
already exists the command prints "nothing to do" and submits nothing.

> A legacy facilitator-as-provider mode (`--operator-token <t>`, the facilitator
> pays the fee) exists ONLY for a merchant that delegated `CanActAs` to the
> facilitator user; it is not for self-custody merchants. Prefer the self default.

### Consolidating dust (`merge`)

Every incoming CC transfer the wallet accepts creates a **fresh Amulet contract**,
so a busy wallet steadily accumulates thousands of tiny "dust" amulets. Past the
participant's JSON-API result cap the wallet can no longer be enumerated on-ledger
at all — `balance` then reports it holds too many contracts, and `pay` (which
selects inputs from that same enumeration) stops working. `merge` fixes both by
self-transferring the amulets back to the wallet's own party in batches; each
batch collapses ~`--batch` amulets into ~2, restoring a spendable wallet:

```bash
canton-agent-wallet merge --dry-run   # show the plan (counts + batches), change nothing
canton-agent-wallet merge             # consolidate (defaults: --batch 70, --target 2, --max-rounds 30)
canton-agent-wallet merge --yes       # required for a LARGE whale pass (>20 batches; see cost note)
```

A CIP-56 registry token (USDCx and the rest of the DA Registry family) merges the
same way, with the instrument named explicitly:

```bash
canton-agent-wallet merge --admin <registrar party> --id USDCx [--dry-run]
```

The mechanics differ underneath: a registry self-transfer only collapses its
inputs when it moves their **full** sum (a 1-atomic self-transfer leaves two
holdings), so each batch is self-transferred for its exact total, holdings are
read through the token-standard `HoldingV1` view, locked holdings are never used
as inputs, and the default target is 1 holding. The registrar must be a known or
trusted registry admin (`CANTON_AGENT_REGISTRY_TRUSTED_PARTIES` for one the
wallet does not ship with). The default batch is 90 for a registry token and 70
for Canton Coin (a transaction is capped at 256 nodes: a registry input costs
~1, an Amulet input ~3).

**A wallet with more holdings than the participant lists in one read** (a
merchant paid thousands of times in a token: the participant refuses an
unbounded list past its element cap, 200 by default). The relay then answers a
bounded read of the wallet's **oldest** holdings instead of an error, and
`merge` works through it: merge a batch, read again — the merged holdings drop
out and the ones behind them come into view. Because the size is unknown up
front, such a run needs `--yes`, and `--max-rounds` (default 30) bounds it.
A per-token merge can only work on its own token; when the oldest holdings are
mostly another token's dust it says so and points at `--all-tokens`, which
merges every token of a trusted registrar, the largest group in view first,
until each is down to one holding:

```bash
canton-agent-wallet merge --all-tokens --dry-run
canton-agent-wallet merge --all-tokens --yes
```

A current relay narrows each read to what was asked for: Canton Coin by its own
templates, a token by its registry's holding template. So thousands of Canton
Coin dust holdings no longer hide a token, or make its total a lower bound —
only more holdings of that token's own registry than one read lists do (tokens
of one registry share a template), and on an older relay any mix does.

On such a wallet `balance` shows token totals as lower bounds ("≥"), `withdraw`
spends the fewest holdings that cover the amount (and refuses a full-balance
withdraw, whose amount it cannot know), and a swap into that token says it
cannot confirm delivery instead of reporting a false timeout (it still claims a
returned input during its window; `claim` picks up one that comes back later).
Paying from it works while the amount is coverable from the visible holdings;
otherwise the relay answers `holdings_merge_required` with the merge to run.

For a wallet already too large to enumerate on-ledger, `merge` reads the holdings
from the public SV Scan ACS snapshot (paginated, no node cap), sweeps over them
once, and then **chains on each batch's own output amulets** — after every batch it
asks the relay for that batch's outputs (by transaction id) and folds them into the
next round. That is what lets one run converge all the way down (e.g. 10,960 → ~244
→ ~6 → 2) **without waiting for the next daily Scan snapshot**. Every merge transfer
is a **self-transfer pinned to your own party and gated by verify-before-sign** — the
relay can never turn a merge into an outbound payment.

The Scan snapshot refreshes only about once a day (~12:00 UTC). A repeat run whose
batches reference amulets a previous run already consumed simply **skips** those
(they are reported as skipped, not errors). If, after consolidating everything this
run can see, the wallet *still* holds more amulets than the participant can
enumerate, those leftovers predate this run and are not yet in the snapshot — `merge`
says so and exits successfully; **re-run it after the next snapshot (~12:00 UTC)** to
continue.

**Cost.** Each large (~90-input) batch consumes meaningful Global Synchronizer
traffic — roughly **1–1.5 USD per transaction on MainNet**, so a 122-batch whale pass
is a ~$150 event. As a guard, a run whose whale pass would exceed **20 batches**
refuses to start unless you pass `--yes` (use `--dry-run` first to see the batch
count). Small merges (≤20 batches) run without `--yes`, as before.

On Canton, incoming CC arrives as a **pending transfer** the agent must accept,
so the first-run flow is:
`create --relay-url https://facilitator.ftptech.xyz` → tell your human to send CC to
the printed party id → `claim` → `balance`. Funding once is the only human step,
exactly like funding an EVM agent.

A new wallet is sent a starter grant by the relay (0.2 CC on MainNet). `create`
waits for it and accepts it, so the wallet can pay small amounts straight away.
In code, `ensureWallet` does the same by default; `starterGrant: "background"`
returns at once and accepts it afterwards, and `"leave"` leaves the offer for
`claim`.

### Swap: CC ↔ CIP-56 registry tokens

`swap` exchanges CC for a DA Registry token (USDCx, CBTC, USDXLR, cETH, eXAG,
eXAU) or back, on a swap venue: **Cantex Connect** (default) or the
**Tradecraft** AMM (`api.tradecraft.fi`). It sends the
input to the pair's pool party and receives the counter-asset; the output
preapproval is auto-provisioned so the pool can deliver directly.

```bash
canton-agent-wallet swap --in CC --out USDCx --amount 7           # buy: 7 CC -> USDCx
canton-agent-wallet swap --in USDCx --out CC --amount 0.78        # sell: 0.78 USDCx -> CC
```

**Default path — our x402 swap endpoint.** The ticket (pool party, `amm_cid`,
slippage minimum) is fetched from a hosted endpoint for a small CC fee, so it
stays correct when Tradecraft rotates a pool address, the `amm_cid`, or a
minimum. Override the endpoint with `CANTON_AGENT_SWAP_URL`.

**`--direct` — free, straight from Tradecraft.** Bypasses the endpoint (and its
fee) and builds the ticket by querying `api.tradecraft.fi` itself, deriving the
pool party from the `amm_cid` baked into this release. Two things are then on
you: that pinned `amm_cid` is only as current as the release (Tradecraft can
rotate it), and the reply is trusted as it comes — the endpoint path re-checks
the ticket against your own trusted `amm_cid` and instruments before signing.
It is the power-user escape hatch, not the preferred path.

**Waits for the output (default).** `swap` returns only once the counter-asset is
actually in the wallet — it polls your output balance (claiming any returning offer
each tick, which also recovers a below-minimum trade's returned input) until the
rise reaches the ticket's minimum output, so there is no separate `claim` step
afterwards. This covers both a registry output the pool delivers directly to your
preapproval and a CC output that arrives as an offer. Anything already pending
before the swap is claimed into the baseline first, and a rise below the minimum is
reported as such — an unrelated inbound landing mid-wait is never presented as the
fill. It prints `received <amount> <SYM>` on arrival, or, if the wait window
(~2 min) elapses, a note that it may still be settling or the trade was below the
pool minimum (input returned). A relay error during the wait never fails the
command — the input was already sent, so it degrades to a missed poll and the
`updateId` is always printed. Pass **`--no-wait`** to return as soon as the input is
sent (fire-and-forget) and pick up the output yourself with `claim` — for
automation that must not block.

**Venues (`--venue`).** `cantex` (default) routes through Cantex Connect: the
input goes to Cantex's swap party, the transfer memo names the buy symbol, and
Cantex delivers the output at the rate it has when it executes. Its minimum is
50 CC-equivalent per trade; a smaller CC input never uses Cantex and the CLI
says so. `tradecraft` routes through the Tradecraft AMM pool for the pair.
`auto` quotes both and takes the better expected output. Whatever the venue,
the receiver is pinned to a client-side constant (Cantex: the Connect party,
override `CANTON_AGENT_CANTEX_PARTY`; Tradecraft: the pool derived from your
trusted `amm_cid`), and a ticket naming any other party is refused before
anything moves. eXAG and eXAU are supported in code but their Cantex pools are
illiquid at the time of writing, so those inputs come back.

**Slippage.** On **Cantex** there is no on-ledger floor: Cantex fills at its
own rate at execution time, and `--slippage <pct>` only sets the delivery
threshold the wait loop reports against (the CLI prints `! no on-ledger floor
on Cantex …`). On **Tradecraft** `--slippage <pct>` is enforced **on-ledger only
when the ticket carries a memo key** — the floor rides in the transfer memo the
pool reads.
Without a memo key the trade fills at **market price** and the CLI prints
`! no slippage protection on this ticket …` so the absence is never silent. An
input below the pool's minimum is safely returned by the pool (no loss).

**The endpoint fee is bounded.** The endpoint is untrusted for money safety, so
the 402 it answers with is capped at 0.5 CC (`--max-fee <cc>` to change) and, when
you name the merchant (`--swap-merchant <party>` or `CANTON_AGENT_SWAP_MERCHANT`),
the payment is pinned to that payee — a hijacked endpoint then cannot be paid at
all.

The output preapproval is provisioned automatically so the pool can deliver the
counter-asset directly; `--no-preapprove` skips it (e.g. it already exists).

Env: `CANTON_AGENT_SWAP_URL` (endpoint override), `CANTON_AGENT_CANTEX_PARTY` and
`CANTON_AGENT_CANTEX_URL` (Cantex Connect party / quote URL), `CANTON_AGENT_TRADECRAFT_AMM_CID`
(the trusted `amm_cid` every ticket's pool party must derive from — a compromised
endpoint cannot redirect funds to another party), `CANTON_AGENT_SWAP_MERCHANT`
(pin the expected fee payee), `CANTON_AGENT_TRADECRAFT_API` and
`CANTON_AGENT_TRADECRAFT_MEMO_KEY` (used by `--direct`).

### Tradecraft queued mode (`tc`)

The alternative to a pool-address `swap` on Tradecraft: trade through
**committed allocations** and **batched orders** (Tradecraft DAR 1.3.12,
integration guide §3.3). Set a pool up once, then queue as many orders as you
like; each batch is one small transaction and no token moves when you submit
it — the venue fills the orders and settles them between your allocations and
its vault within seconds.

```bash
canton-agent-wallet tc setup  --pair CC/CBTC --fund CC=20     # batcher + CC allocation (20 CC) + empty CBTC allocation
canton-agent-wallet tc orders --pair CC/CBTC --sell CC --amount 6 --count 2   # two 6 CC orders, one tx
canton-agent-wallet tc status --pair CC/CBTC                  # allocation funding, open orders
canton-agent-wallet tc orders --pair CC/CBTC --sell CBTC --amounts 0.0000151825
canton-agent-wallet tc cancel --pair CC/CBTC                     # abandon still-pending orders
canton-agent-wallet tc withdraw --pair CC/CBTC --instrument CC   # release an allocation to the wallet
```

- **Allocations hold your funds for trading.** They stay yours, but only the
  Tradecraft venue can settle or release them. `withdraw` releases a whole
  allocation, asynchronously; the venue refuses while one of your fills is
  still settling (ask again a little later), and releases only a funded
  allocation — an empty one simply stays and is reused. Running `setup` with
  `--fund` on an existing allocation tops it up.
- **Minimums.** Each order's minimum output is its live quote — counted after
  the orders before it in the batch — less `--slippage` (default 1%). An order
  that cannot meet it is cancelled and its input stays in the allocation. The
  pool's per-token minimum input applies (e.g. 6 CC, 0.0000125 CBTC).
- **No preapproval needed**: proceeds land in your allocation, and a released
  allocation returns to the wallet as ordinary holdings.
- **Verify-before-sign covers every step** (see below): the venue
  (`CantonSwap::122096fe…`) must be the allocation's sole executor, every
  holding the setup creates must be yours, the pool, amounts and minimums are
  pinned, and the withdrawal request must come from Tradecraft's package.
- **Relay requirement**: the relay must enable the queued surface
  (`CANTON_X402_WALLET_SUBMIT_CHOICES` with the five Tradecraft choices,
  `CANTON_X402_WALLET_SUBMIT_CREATE_TEMPLATES`, `CANTON_X402_WALLET_READ_IDS` —
  see `ops/mainnet-standalone/.env.example`).
- Overrides: `CANTON_AGENT_TRADECRAFT_VENUE`, `CANTON_AGENT_TRADECRAFT_VAULT`,
  `CANTON_AGENT_TRADECRAFT_PACKAGE_IDS` (a newer Tradecraft release),
  `CANTON_AGENT_TRADECRAFT_API`.

## Programmatic API

`makePayingFetch()` returns a `fetch` that transparently pays x402 challenges
from the agent's wallet (lazily creating the wallet on first use):

```ts
import { makePayingFetch } from "@ftptech/canton-agent-wallet";

const fetch = await makePayingFetch({
  relayUrl: process.env.CANTON_AGENT_RELAY_URL,
  network: "canton:testnet",
});

const res = await fetch("https://paid.api/resource"); // 402 -> pay -> retry, transparently
```

On a 402 it resolves the transfer factory via the relay, builds the CIP-56
transfer, signs the prepared-transaction hash locally, has the relay submit it,
then retries the request with the on-ledger proof.

The swap is exported too, as the two halves the CLI itself runs — venue routing
(`resolveSwapIntent` → `resolveSwapTicket`, which pays the endpoint fee only on
the non-direct path and returns advisory `notes`) and execution
(`executeSwap`). The MCP server's `swap` tool is built on exactly these, so a
routing rule cannot drift between the two:

```ts
import {
  resolveSwapIntent, resolveSwapTicket, swapFloorNotes, executeSwap,
  resolveTrustedDsoParty, makePayingFetch, SWAP_MAX_FEE_CC,
} from "@ftptech/canton-agent-wallet";

const intent = resolveSwapIntent("CC", "USDCx");            // fail-closed on unknown symbols
const { ticket, notes } = await resolveSwapTicket({
  intent, amount: "60", slippagePct: 1,
  venue: "cantex", venueExplicit: false,                   // default routing, Tradecraft fallback
  direct: false,                                            // endpoint ticket (fee) — true = free direct quote
  dsoParty: resolveTrustedDsoParty(process.env, "canton:mainnet"),
  payingFetch: () => makePayingFetch({ relayUrl, network: "canton:mainnet", maxPaymentValue: SWAP_MAX_FEE_CC }),
});
const floor = swapFloorNotes(ticket, 1, intent.outCanon);   // what bounds the fill — say it
const r = await executeSwap({ amount: "60", ticket });      // sends, waits for the output to land
```

## Config (env)

- `CANTON_AGENT_RELAY_URL`: facilitator relay base URL. **Required** for the
  commands that talk to a relay (`create`, `pay`); there is intentionally no
  built-in default (a stale default would silently send payments to a dead
  host). Supply it here or via `--relay-url <url>`. The current FTP facilitator
  is `https://facilitator.ftptech.xyz`.
- `CANTON_AGENT_NETWORK`: `canton:testnet` (default) or `canton:mainnet`; also
  settable via `--network <net>`.
- `CANTON_AGENT_API_KEY`: only if the relay requires one (sent as the
  `X-Agent-Key` header).
- `CANTON_AGENT_RELAY_TIMEOUT_MS`: per-request relay timeout (default 120000). A
  timed-out read fails the command; a timed-out SUBMISSION is reported as
  "outcome unknown" — check `balance` before retrying, it may have committed.
- `HTTPS_PROXY` / `HTTP_PROXY` (or `ALL_PROXY`): if set, the CLI routes all
  relay calls through that proxy. Node's `fetch` does NOT honor these on its
  own, so behind a corporate/regional proxy you must set one of them or every
  call fails with `fetch failed`. Credentials are supported
  (`http://user:pass@host:port`) and never logged.
- `CANTON_AGENT_HOME`: override the wallet directory (default `~/.canton-agent`;
  used by tests and power users).
- `CANTON_AGENT_VENUE_KEY` + `CANTON_AGENT_VENUE_TAG`: venue attribution, **on by
  default** as `ftp/venue` = `ftp/agentic-wallet`. The wallet stamps that key/value
  into the metadata of every outbound **CIP-56 registry token** transfer it authors
  (swap-sell, withdraw, and x402 pay), so a token issuer's incentive program can
  attribute that activity to this venue. Generic across tokens (CBTC, USDXLR, …).
  `CANTON_AGENT_VENUE_KEY=off` disables it. To attribute to your own venue, set
  your own key/value: the key **must end in `/venue`** and fit 64 chars, and
  the tag 128 chars — the facilitator's pay/prepare enforces exactly these bounds,
  so a non-conforming config stamps nothing (one stderr warning) instead of breaking
  payments. Advisory metadata only (rides in `transfer.meta.values`, not
  money-critical); Canton Coin is never stamped.

## Your wallet is YOURS (self-custody)

The wallet lives at `~/.canton-agent/wallet.json` (mode `0600`). **This file IS
your money, so back it up.** Losing it loses the funds. The agent reuses the same
wallet forever and never silently creates a second one. The validator only
*hosts* your party; it can never spend your CC. Only your signature authorizes a
transfer. `canton-agent-wallet export` prints the private key for backup or
import.

## How it works

Self-custody external party per **CIP-0103**: you generate and hold the Ed25519
key; the facilitator relay bridges onboarding and submission to the Canton
participant using the validator's auth, so you need no Canton account.

- **Onboard:** the relay runs `generate-topology`; the agent signs the returned
  multi-hash locally; the relay allocates the party.
- **Pay / withdraw:** the relay prepares the transaction (and proxies the public
  Scan registry resolves the agent can't reach); the agent **verifies the
  prepared transaction matches its intent and binds the hash to those exact
  bytes** before signing; the relay only forwards the signed submission.

Every state-changing operation is authorized by the agent's signature.

### Verify-before-sign and hash binding (fail-closed)

The relay is treated as untrusted. Before signing any transfer that moves funds,
the agent structurally decodes the relay-prepared transaction and checks the
sender / receiver / amount / instrument against its own intent (rejecting
ambiguous encodings that a spec-conformant parser would read differently). It
then **binds** the hash it signs to those validated bytes, because the Canton
Ledger API is explicit that "clients MUST recompute the hash from the raw
transaction if the preparing participant is not trusted". A compromised relay
that returns honest bytes paired with the hash of a different (tampered)
transaction is therefore rejected.

Binding requires one of:

- **`recomputeHash`** (programmatic): pass `hashBinding: { recomputeHash }` to
  `makePayingFetch` / `withdraw` / `transfer`, where `recomputeHash` reproduces
  Canton's `HASHING_SCHEME_VERSION_V2` for the prepared bytes. This is the real
  cryptographic binding.
- **`CANTON_AGENT_TRUST_RELAY_HASH=1`** (operator opt-in): accept the relay's
  hash WITHOUT recomputation. This re-opens the blind-signing risk and is only
  acceptable when a human reviews each transfer or the relay is fully trusted.

With neither configured, a value-moving transfer **refuses to sign** (fail-closed)
rather than blind-sign a relay-chosen hash. Accepting incoming transfers
(`claim`) needs no binding, since no funds leave.

## License

Apache-2.0.
