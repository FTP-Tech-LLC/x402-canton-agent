# @ftptech/canton-agent-wallet

Self-custody Canton wallet with x402 autopay, as a CLI and a library. The agent holds its own Ed25519 key. A facilitator relay creates the party and prepares each transaction over HTTPS, so no Canton node is needed. The relay never signs.

## Install

```bash
npm install -g @ftptech/canton-agent-wallet   # the CLI
npm install @ftptech/canton-agent-wallet      # the library
```

## Quickstart

```bash
canton-agent-wallet create --relay-url https://facilitator.ftptech.xyz
canton-agent-wallet pay --max 0.05 https://api.example.com/resource
```

To find an API to pay: `curl https://facilitator.ftptech.xyz/discovery/resources`.

The FTP relay settles on Canton MainNet, so payments spend real Canton Coin (CC). The relay sends a new wallet a 0.2 CC starter grant, within its per-IP and daily limits. To add more, send CC to the party id from `address`, then run `claim`. Creating a wallet accepts the [Terms of Service](https://ftp-tech.mintlify.site/terms).

In code:

```ts
import { makePayingFetch } from "@ftptech/canton-agent-wallet";

const payFetch = await makePayingFetch({
  relayUrl: "https://facilitator.ftptech.xyz",
  network: "canton:mainnet",
  maxPaymentValue: "0.05", // the most CC one payment may cost
});

const res = await payFetch("https://api.example.com/resource");
```

## Commands

| Command | Does |
| --- | --- |
| `create --relay-url <url>` | Create the wallet (once) |
| `address` | Print the party id |
| `balance` | Show every token the wallet holds |
| `claim` | Accept incoming transfers |
| `pay [--max <n>] [--pay-to <party>] [--asset <SYM>] <url>` | Fetch a URL and pay its 402 |
| `withdraw --to <party> [--amount <n>]` | Send CC, or a token with `--admin <registrar> --id <SYM>` |
| `preapproval [--status]` | Merchant: let payments settle to this wallet |
| `merge [--dry-run] [--yes]` | Fold many small holdings into a few |
| `swap --in <SYM> --out <SYM> --amount <n>` | Swap CC and a registry token |
| `tc setup\|orders\|status\|fills\|cancel\|withdraw --pair <A>/<B>` | Tradecraft queued mode |
| `export`, `import [--key-file <path>]` | Back up or restore the key |
| `set-relay <url>` | Change the saved relay |

`canton-agent-wallet` with no command prints every flag.

## Money safety

- `--max` caps one payment in CC (in the token's unit with `--asset`), and `--pay-to` pins the payee. Both refuse before anything is signed. Without them `pay` pays what the 402 asks.
- If a payment was signed and the request does not end in a 2xx, `pay` exits 2. The payment may have settled: do not pay again for that request, check `balance` first. Exit 1 means nothing was signed. The library throws `PAYMENT_UNCONFIRMED` when it cannot tell whether a signed payment settled.
- If `withdraw`, `swap`, `merge` or `claim` times out, loses the connection or gets a 5xx, it may still have gone through. Check `balance` before you run it again.
- `withdraw` without `--amount` sends the full balance.
- A token such as USDCx is paid only with consent: list it in `CANTON_AGENT_PAYABLE_INSTRUMENTS` as `<admin>|<id>`.
- `~/.canton-agent/wallet.json` holds the key, so it is your money. Back it up with `export`.
- A merchant needs a live `TransferPreapproval` for each token it accepts, or payments to it fail.

## Docs

[Agent guide](https://x402-docs.ftptech.xyz/x402-agent) on the FTP docs site.

## License

Apache-2.0.
