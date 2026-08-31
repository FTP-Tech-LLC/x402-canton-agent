# @ftptech/canton-x402-mcp

A self-custody **Canton x402 agent wallet, exposed as an MCP server**. The owner
connects it **out-of-band** (`claude mcp add ...`); the agent then *calls tools*.
It never runs an install and never sees the private key. This is the delivery
model that the old "skill tells the agent to `npm i` a money CLI" approach could
not use: agent-safety classifiers hard-deny in-session untrusted-install +
money movement, and chat consent cannot clear a hard-deny. Connecting an MCP
server is the human's out-of-band trust grant.

Thin wrapper over [`@ftptech/canton-agent-wallet`](../agent-wallet): all crypto,
relay, and verify-before-sign live there and are reused verbatim. Relay-only:
the server talks only to the facilitator over HTTPS (+ a read-only Lighthouse
GET for verification). No node/validator.

## Connect it (the owner does this once)

```bash
claude mcp add canton-x402 -- npx -y @ftptech/canton-x402-mcp \
  --relay-url https://facilitator.ftptech.xyz \
  --pay-proxy-url https://pay.ftptech.xyz \
  --home ~/.canton-x402-mcp/myagent \
  --allow-domains api.example.com \
  --daily-cap 2 --max-per-tx 1
```

Everything after `--` is the launch command the MCP client spawns. The flags are
the **spend policy**: the owner's trust boundary that makes auto-approving small
payments defensible.

## Tools

| Tool | Moves money? | Recommended permission |
|------|--------------|------------------------|
| `get_address` | no (read) | auto-allow |
| `get_balance` | no (read) | auto-allow |
| `request_funding` | no (read; returns party id + a paste-ready owner message) | auto-allow |
| `auto_fund` | inbound only (bootstraps a FUNDED wallet via the pay-proxy quest; see below) | auto-allow ok |
| `claim` | inbound only (accepts incoming transfers) | auto-allow ok |
| `pay({url})` | **funds OUT** | **ask / cap** |
| `withdraw({to,amount?})` | **funds OUT** | **ask** |

`export`/`import` are **deliberately not tools**; they would hand the agent the
private key. Back up/restore the key out-of-band with the `canton-agent-wallet`
CLI against the same `--home`.

## Funding (`auto_fund`): the quest, not a bare faucet

The facilitator's raw faucet is locked (internal callers only), so `auto_fund`
bootstraps through the pay-proxy QUEST: the pay-proxy mints a wallet, grants it
CC, immediately spends the bulk on a CanTrust image call, and hands back the
wallet KEY plus the small change (and the image URL). The MCP imports that key
into `--home`, so the agent self-custodies the funded wallet afterwards.

- Requires `--pay-proxy-url` (or `CANTON_AGENT_PAY_PROXY_URL`). Without it,
  `auto_fund` falls back to the manual-funding ask (same as `request_funding`).
- NO-CLOBBER: a wallet that already holds a balance is never replaced —
  `auto_fund` just reports it. Only an absent or empty wallet is bootstrapped
  (note: bootstrapping an EMPTY wallet imports a fresh server-minted party).
- Any quest failure (paused, over budget, upstream down) degrades to the
  manual-funding message — never a hard tool error.

## Spend policy (set by the owner at startup; the agent cannot change it)

- `--max-per-tx <CC>` / `CANTON_MCP_MAX_PER_TX`: per-transaction cap.
- `--daily-cap <CC>` / `CANTON_MCP_DAILY_CAP`: rolling 24h outbound (pay+withdraw).
- `--allow-domains <csv|*>` / `CANTON_MCP_ALLOW_DOMAINS`: hostnames `pay` may target. **Empty = deny-all (fail-closed).** `*` = any.
- `--no-funded-ceiling` / `CANTON_MCP_FUNDED_CEILING=false`: disable the default "outbound never exceeds claimed inbound" guard.

Enforced **before** anything is signed; a refusal sends nothing to the relay.
Totals persist in `<home>/mcp-policy-ledger.json` (0600).

`pay` is covered too, and pre-sign. The CC price is only known mid-x402-dance,
so the cap is handed to the paying fetch as `maxPaymentValue` and enforced by
the relay signer BEFORE it signs anything: a quote above the cap is refused with
nothing sent to the relay. The daily cap, funded ceiling, domain allowlist and
balance-delta accounting all still apply on top.

This sentence used to describe `pay` as bounded by everything EXCEPT a pre-sign
per-tx block, which stopped being true when the cap was wired through. A README
that understates a money guard is not a harmless doc lag: someone reading it
either builds a second guard they do not need, or widens their daily cap to
compensate for protection they already had.

## Notes

- First payment takes ~60 to 90s (Canton creates the payment counter lazily;
  `counter_not_ready` is normal internal retry). `pay` calls the URL **exactly
  once**; never wrap it in a retry loop (double-pay risk). On a timeout, check
  `get_balance` before retrying.
- Verification: `get_balance` is the on-ledger truth; `pay`/`withdraw` also
  cross-check Lighthouse (`verdict==accepted` AND `send==TransferCommandResultSuccess`).
- `--relay-url` is required (no default). `network` is auto-resolved from the
  relay's `/supported`; the `--network` fallback is only used if the relay can't
  be reached at create time.
