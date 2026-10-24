# @ftptech/canton-x402-mcp

A self-custody Canton x402 wallet as a local MCP server. The owner connects it once; the agent then calls tools and never sees the key. Built on [`@ftptech/canton-agent-wallet`](../agent-wallet).

Prefer not to run anything? The hosted server at `https://pay.ftptech.xyz/mcp` has the same tools as a custom connector in Claude, ChatGPT (developer mode) or Perplexity. It is custodial: you sign in with a passkey and manage limits on `https://pay.ftptech.xyz/account`.

## Connect

```bash
claude mcp add canton-x402 -- npx -y @ftptech/canton-x402-mcp \
  --relay-url https://facilitator.ftptech.xyz \
  --home ~/.canton-x402-mcp/myagent \
  --allow-domains api.example.com \
  --max-per-tx 1 --daily-cap 2
```

The relay settles on Canton MainNet, so payments spend real CC.

## Spend policy

Set by the owner at launch; the agent cannot change it. Checked before anything is signed.

| Flag | Env | Does |
| --- | --- | --- |
| `--relay-url` | | Required |
| `--allow-domains <hosts\|*>` | `CANTON_MCP_ALLOW_DOMAINS` | Hosts `pay` may reach. Empty denies all |
| `--max-per-tx <CC>` | `CANTON_MCP_MAX_PER_TX` | Cap per payment |
| `--daily-cap <CC>` | `CANTON_MCP_DAILY_CAP` | Outbound CC per UTC day |
| `--no-funded-ceiling` | `CANTON_MCP_FUNDED_CEILING=false` | Allow spending more than was received |
| `--home <dir>` | | Wallet directory |

## Tools

| Tool | Moves money |
| --- | --- |
| `get_address`, `get_balance`, `request_funding` | no |
| `claim` | inbound only |
| `pay({ url, method?, headers?, body? })` | yes |
| `withdraw({ to, amount? })` | yes |
| `swap({ in, out, amount, venue?, slippage?, direct?, wait? })` | yes, to a pinned venue |

Let the agent call the read tools freely; ask or cap the rest.

## Funding

A new wallet gets a 0.2 CC starter grant, accepted in the background. For more, `request_funding` returns the party id and a message for the owner; after the owner sends CC, `claim` accepts it.

## Good to know

- **Back up the key with the CLI**, pointed at the same home. `export` is not a tool on purpose:
  ```bash
  CANTON_AGENT_HOME=~/.canton-x402-mcp/myagent npx @ftptech/canton-agent-wallet export
  ```
- **Never retry `pay` in a loop.** After a timeout or error, check `get_balance` first: the payment may have gone through.
- **CC only by default.** The caps are in CC, so a 402 that asks only for a token is refused. Spending a token also needs `CANTON_AGENT_PAYABLE_INSTRUMENTS`.
- **Call `swap` once.** On a timeout, run `get_balance` and `claim` first: the input may already be sent.
- `get_balance` is the truth for whether a payment went through.
