# @ftptech/canton-x402-mcp

A self-custody Canton x402 wallet as a local MCP server. The owner connects it once with spend limits. The agent then calls tools and never sees the key. Built on [`@ftptech/canton-agent-wallet`](https://www.npmjs.com/package/@ftptech/canton-agent-wallet).

## Connect

```bash
claude mcp add canton-x402 -- npx -y @ftptech/canton-x402-mcp \
  --relay-url https://facilitator.ftptech.xyz \
  --home ~/.canton-x402-mcp/myagent \
  --allow-domains api.example.com \
  --max-per-tx 1 --daily-cap 2
```

The FTP relay settles on Canton MainNet, so payments spend real Canton Coin (CC). The relay sends a new wallet a 0.2 CC starter grant, within its per-IP and daily limits. For more, `request_funding` writes a message for the owner, and `claim` accepts what arrives.

The hosted server `https://pay.ftptech.xyz/mcp` needs no install, only a passkey sign-in. Its wallet is custodial: FTP holds the key.

## Spend policy

Set at launch, checked before anything is signed. The agent cannot change it.

| Flag | Does |
| --- | --- |
| `--relay-url <url>` | Required |
| `--home <dir>` | Wallet directory. Default `~/.canton-agent`, the CLI's wallet |
| `--allow-domains <hosts\|*\|catalog>` | Hosts `pay` may reach. Empty denies all |
| `--max-per-tx <CC>` | Cap per payment. Unset means no cap |
| `--daily-cap <CC>` | Outbound CC per UTC day. Unset means no cap |
| `--no-funded-ceiling` | Allow spending more than the wallet received |

## Tools

| Tool | Moves money |
| --- | --- |
| `get_address`, `get_balance`, `request_funding`, `get_guide`, `find_paid_apis`, `swap_quote` | no |
| `claim` | inbound only |
| `pay({ url, method?, headers?, body?, max_cc?, asset? })` | yes |
| `withdraw({ to, amount? })` | yes |
| `swap({ in, out, amount, venue?, slippage?, direct?, wait? })` | yes, to a pinned venue |
| `tradecraft_queued_*` | yes, into a Tradecraft allocation |

In your MCP client, auto-allow the tools that move no money. Require approval for the rest, or rely on the caps above.

## Money safety

- Never retry `pay` or `swap` in a loop. One `pay` call signs at most one payment. After a timeout or error, call `get_balance` first: the money may already have moved.
- `export` is not a tool, on purpose. Back up the key with the CLI, pointed at the same home:
  ```bash
  CANTON_AGENT_HOME=~/.canton-x402-mcp/myagent npx @ftptech/canton-agent-wallet export
  ```
- `get_balance` is the truth. The Lighthouse check after a payment is advisory: it can say "unverified" for a settled one.
- `pay` with `asset: "USDCx"` runs only when both `--usdcx-max-per-tx` and `--usdcx-daily-cap` are set. The CC caps never apply to it.

## Docs

[Agent guide](https://x402-docs.ftptech.xyz/x402-agent) on the FTP docs site.
