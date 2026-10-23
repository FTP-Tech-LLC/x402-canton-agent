# @ftptech/canton-agent-wallet

Self-custody Canton wallet with x402 autopay, as a CLI and a library. The agent holds its own Ed25519 key. A facilitator relay onboards the party and prepares transactions over plain HTTPS, so no Canton node is needed; the relay never signs.

## Quickstart

```bash
npm i -g @ftptech/canton-agent-wallet
canton-agent-wallet create --relay-url https://facilitator.ftptech.xyz
canton-agent-wallet pay --max 0.5 https://api.example.com/resource
```

The FTP relay settles on Canton MainNet, so payments spend real CC. A new wallet gets a 0.2 CC starter grant. For more, send CC to `canton-agent-wallet address` and run `canton-agent-wallet claim`. Creating a wallet accepts the [Terms of Service](https://ftp-tech.mintlify.site/terms).

`create`, `import`, and `pay` on a new home need `--relay-url` or `CANTON_AGENT_RELAY_URL`; there is no default. Other commands use the relay saved at `create`.

## Commands

| Command | Does |
| --- | --- |
| `create --relay-url <url>` | Create the wallet and its party (once) |
| `address` | Print the party id |
| `balance` | Holdings of every token |
| `claim` | Accept incoming transfers (CC and tokens) |
| `pay [--max <n>] [--pay-to <party>] [--asset <SYM>] <url>` | Fetch a URL and pay its 402 |
| `withdraw --to <party> [--amount <n>] [--admin <registrar> --id <SYM>]` | Send CC or a token. Without `--amount` it sends the full balance |
| `preapproval [--status] [--admin <registrar> --id <SYM>] [--days <n>]` | Merchant: let payments settle to this wallet |
| `merge [--dry-run] [--yes] [--admin <registrar> --id <SYM> \| --all-tokens]` | Consolidate many small holdings |
| `swap --in <SYM> --out <SYM> --amount <n>` | Swap CC and a registry token |
| `tc setup\|orders\|status\|cancel\|withdraw --pair <A>/<B>` | Tradecraft queued mode |
| `export` / `import [--key-file <path>]` | Back up or restore the key |
| `set-relay <url>` | Change the saved relay |

## Paying safely

- `--max` caps one payment and `--pay-to` pins the only payee. Both refuse before anything is signed. Without them `pay` pays what the 402 asks.
- `--max` is in CC, or in the token's own unit with `--asset`.
- Spending a token needs consent:
  ```bash
  export CANTON_AGENT_PAYABLE_INSTRUMENTS="decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef|USDCx"
  canton-agent-wallet pay --asset USDCx --max 1 <url>
  ```
- After a timeout or error, check `balance` before paying again: the payment may have gone through.

## Merchants: `preapproval`

A merchant needs a live `TransferPreapproval` per token it accepts, or payments fail with `invalid_exact_canton_preapproval_missing`.

```bash
canton-agent-wallet preapproval            # CC: the fee comes from your CC, lasts 30 days
canton-agent-wallet preapproval --status   # check it
canton-agent-wallet preapproval --admin <registrar> --id USDCx   # a token, no fee
```

Running it again renews an expired one; `--force` renews early.

## `merge`

Every incoming transfer adds a holding. A busy wallet ends up with thousands and stops listing or paying. `merge` folds them back into a few:

```bash
canton-agent-wallet merge --dry-run   # show the plan
canton-agent-wallet merge             # CC
canton-agent-wallet merge --all-tokens --yes
```

A large run costs network traffic (about 1 to 1.5 USD per batch on MainNet), so a run over 20 batches needs `--yes`.

## `swap`

```bash
canton-agent-wallet swap --in CC --out USDCx --amount 60
canton-agent-wallet swap --in USDCx --out CC --amount 0.78
```

- Tokens: USDCx, CBTC, USDXLR, cETH, eXAG, eXAU.
- Venues: `--venue cantex` (default, 50 CC minimum), `tradecraft`, or `auto` (better quote). A smaller trade goes to Tradecraft.
- The ticket comes from FTP's swap endpoint for 0.01 CC (capped by `--max-fee`, default 0.5). `--direct` gets a free quote from the venue.
- `swap` waits until the output is in the wallet (about 2 minutes at most); `--no-wait` returns once the input is sent.
- Cantex fills at its own rate with no on-ledger floor; Tradecraft enforces `--slippage` only when the ticket carries a memo key. The CLI says when there is no floor.

`tc` trades on Tradecraft through committed allocations and batched orders instead:

```bash
canton-agent-wallet tc setup  --pair CC/CBTC --fund CC=20
canton-agent-wallet tc orders --pair CC/CBTC --sell CC --amount 6 --count 2
canton-agent-wallet tc status --pair CC/CBTC
canton-agent-wallet tc withdraw --pair CC/CBTC --instrument CC
```

Funds in an allocation stay yours, but only Tradecraft can settle or release them. It needs a relay that enables queued mode.

## Library

```ts
import { makePayingFetch } from "@ftptech/canton-agent-wallet";

const payFetch = await makePayingFetch({
  relayUrl: "https://facilitator.ftptech.xyz",
  network: "canton:mainnet",
  maxPaymentValue: "0.5", // CC per payment
});

const res = await payFetch("https://api.example.com/resource"); // 402 is paid and retried
```

Options: `maxPaymentValue` (CC), `maxPaymentValueByInstrument` (per token, keyed `"<admin>|<id>"`), `expectedPayTo` (the only payee), `preferAsset` (which token when the 402 offers several). The wallet is created on first use.

The swap is exported as `resolveSwapIntent`, `resolveSwapTicket` and `executeSwap`, the same code the CLI and the MCP `swap` tool run.

## Environment

| Variable | Use |
| --- | --- |
| `CANTON_AGENT_RELAY_URL` | Relay URL, instead of `--relay-url` |
| `CANTON_AGENT_HOME` | Wallet directory (default `~/.canton-agent`) |
| `CANTON_AGENT_PAYABLE_INSTRUMENTS` | Tokens you consent to spend, `<admin>\|<id>`, comma-separated |
| `CANTON_AGENT_REGISTRY_TRUSTED_PARTIES` | Extra registrars to trust, as JSON |
| `CANTON_AGENT_API_KEY` | Only for a relay that requires a key |
| `CANTON_AGENT_RELAY_TIMEOUT_MS` | Relay timeout (default 120000) |
| `HTTPS_PROXY` | Proxy for the CLI. Node's `fetch` ignores it otherwise |
| `CANTON_AGENT_DSO_PARTY` | DSO party, off MainNet only |
| `CANTON_AGENT_VENUE_KEY` | `off` stops the `ftp/venue` tag on token transfers (on by default, CC is never tagged) |

Swap and venue overrides (`CANTON_AGENT_SWAP_*`, `CANTON_AGENT_CANTEX_*`, `CANTON_AGENT_TRADECRAFT_*`) are for operators.

## Your key

The wallet is `~/.canton-agent/wallet.json` (mode `0600`). It is your money: back it up.

```bash
canton-agent-wallet export > key.pem
CANTON_AGENT_HOME=./restored canton-agent-wallet import --relay-url https://facilitator.ftptech.xyz --key-file key.pem
```

## How it works

- The relay prepares every transaction. Before signing, the wallet decodes it, checks sender, receiver, amount and token against its intent, and recomputes the hash itself. A mismatch is refused.
- An x402 payment is signed but not submitted: it travels to the merchant, whose facilitator submits it and pays the traffic.
- `CANTON_AGENT_TRUST_RELAY_HASH=1` skips the hash check. Never set it in normal use.

## License

Apache-2.0.
