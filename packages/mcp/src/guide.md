# Canton x402 wallet: a guide for agents

This wallet pays for HTTP APIs that answer `402 Payment Required` (the x402 protocol) on Canton Network, in Canton Coin (CC). You call its tools; the keys stay with the wallet and never reach you.

## Start here

1. `get_balance` shows what the wallet holds and how much it may still spend today. It is read-only.
2. `find_paid_apis` lists the paid APIs in the facilitator's catalogue: what each does, its URL and method, its price per call, and how to call it. It is read-only.
3. Agree a budget with the user before you spend anything.

## Paying

- `pay` takes the URL, plus `method`, `headers` and `body` for an API that wants a POST. It pays what the API's 402 answer asks and returns the response.
- Call each API exactly as `find_paid_apis` shows (query, JSON body, fields). An API takes the payment before it reads the request, so a wrong call is still paid.
- When `pay` says the API kept the payment after an HTTP error, fix the request before paying again: the same request pays again for the same error.
- Never call `pay` again for the same purchase, and never call it again in a loop while you wait: the first payment can take 60 to 90 seconds, and that is normal.
- A `pay` call pays at most once: a seller that answers 402 after being paid is not paid again. Set `max_cc` to cap what the call may spend.
- If `pay` fails, call `get_balance` before anything else. When the reply says funds moved, do not pay again for the same request.
- `max_cc` can only lower the owner's limits. `max_response_chars` asks for more of a long response body; set it on the first call. The hosted wallet returns at most 4000 characters, and paying again returns the same part.
- `pay` and `swap` can take longer than your client waits (many stop at 60 seconds). A timeout is not a failure: the call goes on. Do not call it again; wait 2 minutes, then call `get_balance` (and `get_history` on the hosted wallet).
- The owner sets the limits, not you: a cap per payment, a cap per day, and which hosts may be paid. A refused payment says which limit stopped it. Only the owner can change it: on the hosted wallet's account page, or in the local wallet's start command (`--max-per-tx`, `--daily-cap`).

## Funding

- `get_address` returns the wallet's Canton party id; `request_funding` writes a message the user can act on.
- Incoming CC counts only after `claim` accepts it. Call `claim` when the user says they sent CC.
- A new wallet gets a small starter grant of CC, accepted automatically within about a minute.

## Swapping

- `swap_quote` lists the Tradecraft pools with their reserves and prices, and quotes a swap on each venue. It is free and moves nothing; use it for price questions too.
- Before a swap, call `swap_quote` with the same `in`, `out` and `amount`. Then call `swap` once, naming the venue it says quotes more.
- `swap` exchanges CC and tokens such as USDCx on Cantex or Tradecraft only: a quote bought from another API cannot be executed by `swap`. Call it once per swap, and check `get_balance` before trying again.
- If tokens seem to be missing after a swap, call `claim`, then `get_balance`.
- On the local wallet only (`npx @ftptech/canton-x402-mcp`): `tradecraft_queued_setup`, `tradecraft_queued_orders`, `tradecraft_queued_status`, `tradecraft_queued_fills`, `tradecraft_queued_cancel` and `tradecraft_queued_withdraw` trade on the Tradecraft AMM through committed allocations instead of a swap: set up a pool once (funding the allocation you sell), queue orders in batches, watch them fill with `tradecraft_queued_fills` (a fill shows at once; its amount arrives with the settlement), then release the allocations back to the wallet. Funds in an allocation stay yours but only the venue can settle or release them.

## Other tools

- `withdraw` sends CC, and only CC, to another Canton party. A receiver without a CC preapproval gets an offer it must accept; until it does, the CC is locked and this wallet cannot take it back. The hosted wallet only sends to addresses the owner confirmed on its account page.
- On the hosted wallet only: `get_history` lists the latest payments and other money moves, and `send_feedback` tells the team about a bug, something confusing, or an idea. Never put keys, recovery codes, passwords or personal data in feedback.

## Links

- Setup for every assistant: https://www.ftptech.xyz/skill.md
- Hosted wallet account page (limits, history, connections): https://pay.ftptech.xyz/account
- Terms of Service: https://ftp-tech.mintlify.site/terms
