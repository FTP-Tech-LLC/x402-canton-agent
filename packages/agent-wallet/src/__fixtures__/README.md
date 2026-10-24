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

## `mainnet-self-preapproval-create-with-fee.b64`

Taken 2026-10-04 from the live relay's `POST /v1/wallet/preapproval/self/prepare`
for party `merchant-ctai::12200333…` with `expiresAt=2027-04-01T00:00:00Z`.
Never signed, never submitted — inert. Unlike the capture above, the merchant
pays the fee from its own Amulet, so the tree shows the honest fee path: root
`AmuletRules_CreateTransferPreapproval` on `Splice.AmuletRules:AmuletRules`;
consequences `Archive` on `Splice.Amulet:Amulet`, `EventLog_HoldingsChange` on
`Splice.AmuletRules:AmuletRules`, `OpenMiningRound_Fetch` on
`Splice.Round:OpenMiningRound`; creates `Splice.Amulet:Amulet` (change ×2),
`Splice.Amulet:ValidatorRewardCoupon`, `Splice.AmuletRules:TransferPreapproval`;
plus fetches. The only parties anywhere: the merchant and the DSO.

## `mainnet-cbtc-registry-offer-beneficiary2.b64`

Captured 2026-10-16 from the live relay's `POST /v1/wallet/pay/prepare`:
0.0000001 CBTC from `agent::12200c7b…` to the Tradecraft pool
`tc-swp_CBTC-CC::1220…` (registry two-step offer shape). Never signed. Its
`InstrumentConfiguration` input contract (created 2026-10-14T11:27:08Z, signed
by `cbtc-network`) names the reward beneficiary `cbtc-beneficiary-2::122099b6…`,
which replaced `cbtc-beneficiary`. Main as of 2.3.1 refuses it as an unexpected
party; the registrar-configuration rule admits it. preparationTime
1792132332764201µs.

## `mainnet-tc-*.b64` — Tradecraft queued mode

Captured 2026-10-17 through a relay's generic `POST /v1/wallet/submit/prepare`
for the test agent `agent::12203c17…` (node 2) on pool `TC CBTC/CC LP`
(Tradecraft DAR 1.3.12; venue `CantonSwap::122096fe…`, vault
`cs-vault::1220b4cd…`). Unlike the captures above these were SIGNED AND
EXECUTED (except the funded CBTC allocation, prepared only); the bytes
authorize nothing further. The round trip they belong to: 30 CC in, batcher,
20 CC allocation, empty CBTC allocation, 2×6 CC orders filled within ~30 s for
0.0000151825 CBTC, both allocations withdrawn back to the wallet.

| file | root | creates | preparationTime (µs) |
|---|---|---|---|
| `mainnet-tc-create-batcher.b64` | `AMMRules_CreateSwapOrderBatcher` | `SwapOrderBatcher` | 1792242259548689 |
| `mainnet-tc-allocation-cc-funded.b64` | `AMMRules_CreateSettlementAllocation` (20 CC) | `AmuletAllocationV2`, `LockedAmulet`, change `Amulet` | 1792243023798011 |
| `mainnet-tc-allocation-cbtc-empty.b64` | `AMMRules_CreateSettlementAllocation` (no funding) | registry `AllocationV2` | 1792243108208720 |
| `mainnet-tc-allocation-cbtc-funded.b64` | `AMMRules_CreateSettlementAllocation` (0.000015 CBTC) | registry `AllocationV2`, locked + change `Holding` | 1792243595921304 |
| `mainnet-tc-orders-2.b64` | `SwapOrderBatcher_CreateOrdersV2` (2×6 CC, minOut 0.0000072118) | 2× `SwapOrder` | 1792243120072657 |
| `mainnet-tc-withdrawal-request-cc.b64` | (create) | `SettlementWithdrawalRequest` (CC) | 1792243400682338 |
| `mainnet-tc-cancel-order.b64` | `SwapOrder_WithdrawV3` on a pending order (no consequences; the trailing `settlementHelpers = None` is dropped by normalization) | — | 1792254314557232 |
| `mainnet-tc-fund-cc.b64` (prepared only) | `AMMRules_FundSettlementAllocation` (+6 CC into the empty CC allocation on `TC CC/USDCx LP`) | 2× `AmuletAllocationV2` (temporary + successor), 2× `LockedAmulet`, change `Amulet` | 1792248875467357 |
| `mainnet-tc-fund-cbtc.b64` (prepared only) | `AMMRules_FundSettlementAllocation` (+0.000015 CBTC into the empty CBTC allocation) | 2× registry `AllocationV2`, 3× `Holding`; consequences include `TransferRule_SettleAllocationV2` | 1792248905207381 |

Every record is fully labelled in Daml declaration order (matches the DAR).
The Tradecraft choices read the ledger time, so `max_ledger_effective_time`
equals `preparationTime` on all of them.
