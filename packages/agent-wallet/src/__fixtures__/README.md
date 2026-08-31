# Live MainNet prepared-transaction fixtures

Two REAL `PreparedTransaction` captures from Canton MainNet, supplied by the
integrator, used as the conformance ground truth for the validator-provided
`TransferPreapproval` work. Both were interactive-prepared and deliberately
NEVER signed, committed, or submitted: without the payer's Ed25519 signature
they authorize nothing, so they are inert.

Both carry a 60s `executeBefore` and are therefore EXPIRED. Tests must inject
`nowMs` (the capture instant is ~2026-07-28T12:37:3xZ) or the timing check fires
before the check under test.

| file | shape | nodes | input contracts |
|---|---|---|---|
| `mainnet-preapproval-distinct-provider.b64` | receiver `Cantex::1220…`, provider `Cantex-validator-1::1220…` (a FEATURED app) | 12 | 5 |
| `mainnet-preapproval-self-provider.b64` | receiver == provider `caf5e4e35cfd1669::1220…` (not featured) | 10 | 4 |

Verified against the CURRENT verifier (main behavior):
  - self-provider  → PASSES
  - distinct       → REJECTED with exactly one reason: unexpected party (the provider)

Observed structure (distinct): root `TransferFactory_Transfer` on
`Splice.ExternalPartyAmuletRules:ExternalPartyAmuletRules`; consequences
`TransferPreapproval_SendV2` on `Splice.AmuletRules:TransferPreapproval`,
`Archive` on `Splice.Amulet:Amulet`; plain creates of `Splice.Amulet:Amulet`
(receiver output + sender change) and `Splice.Amulet:FeaturedAppActivityMarker`.
The marker is a plain CREATE, not an exercise, so the consequence-choice
allowlist is unaffected. `EventLog_HoldingsChange` is ABSENT, so the MainNet
amulet package predates Splice 0.6.11.

Preapproval input-contract argument party order on the wire: dso, receiver,
provider.

The provider never appears in a money-owner position in either capture.

## `mainnet-self-preapproval-create.b64`

A third capture, taken 2026-08-12 from the live relay's
`POST /v1/wallet/preapproval/self/prepare` for party
`agent::122090a6…` with `expiresAt=2026-11-10T00:00:00Z`. Root choice
`AmuletRules_CreateTransferPreapproval`, 4 nodes, `act_as` the merchant alone.

Prepared and never signed, so like the other two it authorizes nothing.

It exists because `extractSelfPreapproval` reads the choice argument
POSITIONALLY, and this repo has been burned three times by inferring a wire
shape from a hand-built fixture (the zigzag nonce, the fixed64 timestamp, the
Optional DSO — each passed against an invented fixture and failed against the
real wire). Measured here: labels ARE present, the record is `Value.record`
(field 14), and the declaration order is
`[0] context [1] inputs [2] receiver:Party [3] provider:Party
[4] expiresAt:Time [5] expectedDso:Optional Party`.
