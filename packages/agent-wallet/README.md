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
canton-agent-wallet address                         # print the party id (fund this)
canton-agent-wallet balance                         # print CC balance
canton-agent-wallet claim                           # accept incoming transfers (e.g. the initial funding)
canton-agent-wallet merge [--target <n>] [--batch <n>] [--max-rounds <n>] [--dry-run]   # consolidate dust amulets so a busy wallet can be enumerated + spent again
canton-agent-wallet preapproval [--status] [--admin <DSO>] [--days <n>]   # MERCHANT: self-provision this wallet's own TransferPreapproval so transfer-factory payments settle in one round-trip (--status just checks)
canton-agent-wallet pay --relay-url <url> <url>      # fetch a URL, auto-paying any x402 402 challenge
canton-agent-wallet withdraw --to <party> [--amount <cc>]   # send CC back out (default: full balance)
canton-agent-wallet export                           # print the private key (backup; guard it)
```

`create` and `pay` **require** a relay (facilitator) URL: pass `--relay-url
<url>` or set `CANTON_AGENT_RELAY_URL`. There is no default: a stale built-in
default would silently send payments to a dead host, so the CLI fails fast when
none is given. `address`, `balance`, `claim`, `withdraw` and `export` reuse the
relay stored in the wallet at `create` time. The current FTP facilitator is
`https://facilitator.ftptech.xyz`.

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
