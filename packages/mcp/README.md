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
| `claim` | inbound only (accepts incoming transfers) | auto-allow ok |
| `pay({url})` | **funds OUT** | **ask / cap** |
| `withdraw({to,amount?})` | **funds OUT** | **ask** |
| `swap({in,out,amount,venue?,slippage?,direct?,wait?})` | **funds OUT** to a pinned swap venue; the counter-asset comes back | **ask / cap** |

`export`/`import` are **deliberately not tools**; they would hand the agent the
private key. Back up/restore the key out-of-band with the `canton-agent-wallet`
CLI against the same `--home`.

## Funding

A new wallet is sent a starter grant by the relay (0.2 CC on MainNet); the server
accepts it in the background within about a minute of the first tool call, and
it counts toward the funded ceiling. For more, `request_funding` returns the
party id and a message to paste to the owner; once the owner has sent CC,
`claim` accepts it. `get_balance` says when a transfer is waiting to be claimed.

## Spend policy (set by the owner at startup; the agent cannot change it)

- `--max-per-tx <CC>` / `CANTON_MCP_MAX_PER_TX`: per-transaction cap.
- `--daily-cap <CC>` / `CANTON_MCP_DAILY_CAP`: rolling 24h outbound (pay+withdraw).
- `--allow-domains <csv|*>` / `CANTON_MCP_ALLOW_DOMAINS`: hostnames `pay` may target. **Empty = deny-all (fail-closed).** `*` = any.
- `--no-funded-ceiling` / `CANTON_MCP_FUNDED_CEILING=false`: disable the default "outbound never exceeds claimed inbound" guard.

Enforced **before** anything is signed; a refusal sends nothing to the relay.
Totals persist in `<home>/mcp-policy-ledger.json` (0600).

`swap` is bounded too, on its CC leg. A **CC input** is a known amount and gets
the full `withdraw` gate (per-tx, daily, funded ceiling) before any quote — the
ticket fee is itself a payment, so the gate runs first. A **token input** is
checked against the per-tx cap using the venue's quoted CC value; the daily cap
and funded ceiling bound CC *leaving* the wallet, and a token→CC swap brings CC
in (counting it out would later block withdrawing the very CC it delivered).
With a cap set and no CC figure available (neither leg CC, or a market-fill
ticket with no numeric quote) the swap is refused — a cap that cannot be
applied is never "no cap". The ticket fee (`0.01` CC live, ceiling `0.5` CC or
the per-tx cap, whichever is lower) is booked to the ledger the moment it is
paid; the domain allowlist does not apply to it because the agent cannot choose
the endpoint (`CANTON_AGENT_SWAP_URL`, operator config; pin its payee with
`CANTON_AGENT_SWAP_MERCHANT`).

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
- `swap` runs the SAME venue routing as `canton-agent-wallet swap` (one shared
  router, not a copy): Cantex Connect by default (50 CC minimum, fills at its
  own rate — **no on-ledger floor**, `slippage` only sets the delivery
  threshold the tool reports against), `venue: "tradecraft"` for the AMM (the
  floor rides in the memo when `CANTON_AGENT_TRADECRAFT_MEMO_KEY` is set), or
  `"auto"` (free quotes from both, better output wins). When `venue` is NOT
  named, a CC input under 50 CC or a Cantex quote failure routes to Tradecraft
  with a note; named explicitly, those are errors. The input only ever goes to
  the pinned venue parties. It waits up to ~2 minutes for the output to land;
  the result says what arrived, what was claimed, and what bounded the fill.
  Call it **once** per swap — on a timeout or error, `get_balance` and `claim`
  first: the input may already have been sent (the result carries the updateId
  and says so).
- Verification: `get_balance` is the on-ledger truth; `pay`/`withdraw` also
  cross-check Lighthouse (`verdict==accepted` AND `send==TransferCommandResultSuccess`).
- `--relay-url` is required (no default). `network` is auto-resolved from the
  relay's `/supported`; the `--network` fallback is only used if the relay can't
  be reached at create time.
