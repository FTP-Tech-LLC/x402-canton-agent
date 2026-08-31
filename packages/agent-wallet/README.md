# @ftptech/canton-agent-wallet

A self-custody Canton wallet + x402 autopay for AI agents. The agent holds its
own Ed25519 key and pays for x402-gated resources on the Canton Network on its
own. The hard parts of Canton (a party must be hosted on a validator, and its
API is authed) are hidden behind a facilitator **relay** the agent talks to over
plain HTTP. The relay can *prepare* and *submit* on the agent's behalf but never
*signs*, so it has no custody.

Backs the [`canton-x402-agent`](../../skills/canton-x402-agent/SKILL.md) skill.

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
canton-agent-wallet fund --relay-url <url> --pay-proxy-url <url>   # bootstrap a FUNDED wallet via the pay-proxy quest (see below)
canton-agent-wallet address                         # print the party id (fund this)
canton-agent-wallet balance                         # print the balance of every instrument the wallet holds (CC + any CIP-56 registry token, e.g. USDCx)
canton-agent-wallet claim                           # accept incoming transfers — CC and registry tokens (expired offers are skipped; one bad offer never blocks the rest)
canton-agent-wallet merge [--target <n>] [--batch <n>] [--max-rounds <n>] [--dry-run] [--admin <registrar> --id <instrument>]   # consolidate dust (CC, or a registry token) so a busy wallet can be enumerated + spent again
canton-agent-wallet preapproval [--status] [--admin <DSO>] [--days <n>]   # MERCHANT: self-provision this wallet's own TransferPreapproval so transfer-factory payments settle in one round-trip (--status just checks)
canton-agent-wallet pay --relay-url <url> <url>      # fetch a URL, auto-paying any x402 402 challenge
canton-agent-wallet swap --in <SYM> --out <SYM> --amount <n> [--slippage <pct>] [--direct] [--no-wait] [--max-fee <cc>] [--swap-merchant <party>] [--no-preapprove]   # swap CC <-> a CIP-56 registry token via Tradecraft; waits for the output to land (see below)
canton-agent-wallet withdraw --to <party> [--amount <n>] [--admin <registrar> --id <instrument>]   # send CC (default: full balance) or a registry token back out
canton-agent-wallet export                           # print the private key (backup; guard it)
```

`create` and `pay` **require** a relay (facilitator) URL: pass `--relay-url
<url>` or set `CANTON_AGENT_RELAY_URL`. There is no default: a stale built-in
default would silently send payments to a dead host, so the CLI fails fast when
none is given. `address`, `balance`, `claim`, `withdraw` and `export` reuse the
relay stored in the wallet at `create` time. The current FTP facilitator is
`https://facilitator.ftptech.xyz`.

### `fund`: bootstrap a funded wallet through the quest

The facilitator's raw faucet is locked (internal callers only), so out-of-box
funding goes through the pay-proxy QUEST, which binds the grant to a real x402
payment: the pay-proxy mints a wallet, grants it CC, immediately spends the bulk
on a CanTrust image call, and returns the wallet KEY plus the small change (and
the image URL). `fund` runs that flow and IMPORTS the returned key, so the agent
self-custodies the funded wallet afterwards (the pay-proxy keeps nothing).

```
canton-agent-wallet fund --relay-url https://facilitator.ftptech.xyz \
  --pay-proxy-url https://pay.ftptech.xyz [--prompt "an image prompt"]
```

`--pay-proxy-url` (or `CANTON_AGENT_PAY_PROXY_URL`) is required. NO-CLOBBER: if a
wallet already exists AND holds a balance, it is never replaced — `fund` reports
it and exits. Only an absent or empty wallet home is bootstrapped. NOTE the
imported wallet is a fresh server-minted party (bootstrapping replaces an empty
wallet's party); back up any key you care about with `export` first.

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
canton-agent-wallet merge             # consolidate (defaults: --batch 90, --target 2, --max-rounds 30)
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
wallet does not ship with).

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

### Swap: CC ↔ CIP-56 registry tokens

`swap` exchanges CC for a DA Registry token (USDCx, CBTC, USDXLR, cETH, eXAG,
eXAU) or back, on the Tradecraft AMM (`api.tradecraft.fi`). It sends the
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

**Slippage.** `--slippage <pct>` is enforced **on-ledger only when the ticket
carries a memo key** — the floor rides in the transfer memo the pool reads.
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

Env: `CANTON_AGENT_SWAP_URL` (endpoint override), `CANTON_AGENT_TRADECRAFT_AMM_CID`
(the trusted `amm_cid` every ticket's pool party must derive from — a compromised
endpoint cannot redirect funds to another party), `CANTON_AGENT_SWAP_MERCHANT`
(pin the expected fee payee), `CANTON_AGENT_TRADECRAFT_API` and
`CANTON_AGENT_TRADECRAFT_MEMO_KEY` (used by `--direct`).

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
- `HTTPS_PROXY` / `HTTP_PROXY` (or `ALL_PROXY`): if set, the CLI routes all
  relay calls through that proxy. Node's `fetch` does NOT honor these on its
  own, so behind a corporate/regional proxy you must set one of them or every
  call fails with `fetch failed`. Credentials are supported
  (`http://user:pass@host:port`) and never logged.
- `CANTON_AGENT_HOME`: override the wallet directory (default `~/.canton-agent`;
  used by tests and power users).
- `CANTON_AGENT_VENUE_KEY` + `CANTON_AGENT_VENUE_TAG`: venue attribution, **off by
  default** (both must be set). When set — e.g. `CANTON_AGENT_VENUE_KEY=ftp/venue`
  and `CANTON_AGENT_VENUE_TAG=ftp/agentic-wallet` — the wallet stamps that key/value
  into the metadata of every outbound **CIP-56 registry token** transfer it authors
  (swap-sell, withdraw, and x402 pay), so a token issuer's incentive program can
  attribute that activity to this venue. Generic across tokens (CBTC, USDXLR, …);
  set your own key/value, but the key **must end in `/venue`** and fit 64 chars, and
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
