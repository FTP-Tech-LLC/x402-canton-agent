/**
 * Tradecraft QUEUED mode: trade through committed allocations instead of a
 * pool-address transfer (Tradecraft DAR 1.3.12, integration guide 3.3).
 *
 *   setup     once per pool: a SwapOrderBatcher plus one committed allocation
 *             per pool instrument (the one you sell funded, the other empty).
 *   orders    queue exact-input orders in one transaction. No token moves at
 *             submission; the venue fills and settles later, moving value
 *             between your allocations and its vault.
 *   status    your allocations' funding and your open orders on the pool.
 *   withdraw  ask the venue to release an allocation back to your wallet
 *             (whole allocation only; refused while a fill is unsettled, and
 *             for an empty allocation, which simply stays for reuse).
 *
 * Every transaction goes through the same verify-before-sign gate as a
 * payment (`executeTradecraftCommand`): the venue and vault are wallet
 * constants, the pool's instruments must be the ones the wallet trusts, and
 * the core assertions pin what each prepared transaction may create.
 *
 * Trust that remains, by design: a funded committed allocation is settled by
 * its executor, the venue. Put in only what you intend to trade.
 */
import { executeTradecraftCommand } from "./tx.js";
import { resolveHashBinding } from "./hash-binding.js";
import { resolveTrustedDsoParty } from "./trusted-dso.js";
import { resolveSwapSymbol, resolveTrustedRegistryParties } from "./registry-parties.js";
import { computeMinOutput, parseTradecraftQuote, tradecraftMinInput } from "./swap.js";
import { DEFAULT_TRADECRAFT_API } from "./swap-route.js";
import type { RelayClient, ContractsResult, TradecraftUpdate } from "./relay-client.js";
import type { AgentWallet } from "./store.js";
import { KNOWN_TRADECRAFT_PACKAGE_IDS, type HashBindingOptions, type TradecraftParties } from "./verify-prepared.js";

/** Tradecraft's MainNet operator parties, as they sign the AMM contracts
 *  (measured 2026-10-17; the docs' "Tradecraft::…" name is not what the
 *  contracts carry). Override per network with CANTON_AGENT_TRADECRAFT_VENUE /
 *  CANTON_AGENT_TRADECRAFT_VAULT. */
export const DEFAULT_TRADECRAFT_VENUE =
  "CantonSwap::122096fe076cc065af0cb38f94caa60e8ddfecbe8f0cfe10655ae7aa06fab99c66b7";
export const DEFAULT_TRADECRAFT_VAULT =
  "cs-vault::1220b4cd6098eebafd4c88efd2b3986e86542bdc391060675432cd195ad26bcf013b";

export const TC_BATCHER_TEMPLATE_REF = "#canton-swap-amm-vault:TC.V4.OrderBatch:SwapOrderBatcher";
export const TC_SWAP_ORDER_TEMPLATE_REF = "#canton-swap-amm-vault:TC.V4.SwapOrderV2:SwapOrder";
/** The withdrawal request is the one create the agent authorizes alone, so it
 *  names Tradecraft's package by ID (never by name) and verify pins it. */
const TC_WITHDRAWAL_TEMPLATE = "TC.V4.Settle.WithdrawalRequest:SettlementWithdrawalRequest";
export const ALLOCATION_V2_INTERFACE =
  "#splice-api-token-allocation-v2:Splice.Api.Token.AllocationV2:Allocation";
/** Optional on the relay: adds `tc withdraw` outcomes to `tc fills`. */
export const TC_WITHDRAWAL_REQUEST_TEMPLATE_REF =
  "#canton-swap-amm-vault:TC.V4.Settle.WithdrawalRequest:SettlementWithdrawalRequest";
/** The read ids a relay allowlists (CANTON_X402_WALLET_READ_IDS). */
export const TC_RELAY_READ_IDS = [
  TC_BATCHER_TEMPLATE_REF,
  TC_SWAP_ORDER_TEMPLATE_REF,
  ALLOCATION_V2_INTERFACE,
  TC_WITHDRAWAL_REQUEST_TEMPLATE_REF,
];

const META_AMM_ID = "tradecraft.fi/amm-id";
const META_INSTRUMENT_ID = "tradecraft.fi/instrument-id";
/** The settlement id Tradecraft stamps on every allocation it creates. */
const TC_SETTLEMENT_ID = "tc-settlement";

type Instrument = { admin: string; id: string };
type Disclosed = { templateId: string; contractId: string; createdEventBlob: string; synchronizerId: string };

/** Tradecraft package ids trusted for the withdrawal request: the core's
 *  measured set, or CANTON_AGENT_TRADECRAFT_PACKAGE_IDS (comma-separated) for
 *  a newer release. A withdrawal request is created in the venue's package
 *  when it is among them, else in the first one (see withdrawalPackageId). */
export function resolveTradecraftPackageIds(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = env.CANTON_AGENT_TRADECRAFT_PACKAGE_IDS?.trim();
  if (!raw) return KNOWN_TRADECRAFT_PACKAGE_IDS;
  const ids = raw.split(",").map((x) => x.trim()).filter((x) => /^[0-9a-f]{64}$/.test(x));
  if (ids.length === 0) throw new Error("tradecraft: CANTON_AGENT_TRADECRAFT_PACKAGE_IDS has no valid package id");
  return ids;
}

export function resolveTradecraftParties(env: NodeJS.ProcessEnv = process.env): TradecraftParties {
  return {
    venue: env.CANTON_AGENT_TRADECRAFT_VENUE?.trim() || DEFAULT_TRADECRAFT_VENUE,
    vault: env.CANTON_AGENT_TRADECRAFT_VAULT?.trim() || DEFAULT_TRADECRAFT_VAULT,
  };
}

/** A pool as the wallet will use it: id, trusted instruments, the two AMM
 *  contracts every order-creating choice needs disclosed. */
export interface TcPool {
  ammId: string;
  /** Canonical symbol → instrument, for both pool instruments. */
  instruments: Record<string, Instrument>;
  ammRules: Disclosed;
  amm: Disclosed;
}

export interface TcContext {
  relay: RelayClient;
  wallet: AgentWallet;
  tradecraft?: TradecraftParties;
  tradecraftApi?: string;
  hashBinding?: HashBindingOptions;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof globalThis.fetch;
  /** Back-off between retries (tests pass an instant one). */
  sleep?: (ms: number) => Promise<void>;
}

function ctxParts(ctx: TcContext) {
  const env = ctx.env ?? process.env;
  const dso = resolveTrustedDsoParty(env, ctx.wallet.network);
  if (!dso) {
    throw new Error(
      "tradecraft: no trusted DSO party for this network — set CANTON_AGENT_DSO_PARTY"
    );
  }
  return {
    env,
    dso,
    tradecraft: ctx.tradecraft ?? resolveTradecraftParties(env),
    api: (ctx.tradecraftApi ?? env.CANTON_AGENT_TRADECRAFT_API ?? DEFAULT_TRADECRAFT_API).replace(/\/$/, ""),
    hashBinding: ctx.hashBinding ?? resolveHashBinding(env),
    f: ctx.fetchImpl ?? globalThis.fetch,
  };
}

/** The instrument the wallet trusts for a symbol (CC = the pinned DSO's Amulet). */
function trustedInstrument(symbol: string, dso: string): { canon: string; instrument: Instrument } {
  const leg = resolveSwapSymbol(symbol);
  if (leg.kind === "cc") return { canon: "CC", instrument: { admin: dso, id: "Amulet" } };
  if (leg.kind === "registry") return { canon: leg.symbol, instrument: leg.instrument };
  throw new Error(`tradecraft: ${JSON.stringify(symbol)} is not a known instrument`);
}

async function tcGet(f: typeof globalThis.fetch, url: string): Promise<unknown> {
  // Tradecraft's edge 403s a request with no User-Agent and 5xxs transiently.
  for (let i = 0; ; i++) {
    const res = await f(url, { headers: { "user-agent": "canton-agent-wallet", accept: "application/json" } });
    if (res.ok) return res.json();
    if (res.status >= 500 && i < 3) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    throw new Error(`tradecraft: GET ${url} failed (HTTP ${res.status})`);
  }
}

/** Load a pool by its two symbols, and refuse one whose instruments are not
 *  the ones this wallet trusts for those symbols. */
export async function loadTcPool(ctx: TcContext, a: string, b: string): Promise<TcPool> {
  const { dso, api, f } = ctxParts(ctx);
  const A = trustedInstrument(a, dso);
  const B = trustedInstrument(b, dso);
  const body = (await tcGet(f, `${api}/v1/disclosures/${encodeURIComponent(A.canon)}/${encodeURIComponent(B.canon)}`)) as {
    amm?: Disclosed;
    amm_rules?: Disclosed;
    amm_data?: { amm_id?: string; instrument1?: Instrument; instrument2?: Instrument };
  };
  const d = body.amm_data;
  if (!body.amm || !body.amm_rules || !d?.amm_id || !d.instrument1 || !d.instrument2) {
    throw new Error(`tradecraft: no ${A.canon}/${B.canon} pool disclosures`);
  }
  const same = (x: Instrument, y: Instrument) => x.admin === y.admin && x.id === y.id;
  const ok =
    (same(d.instrument1, A.instrument) && same(d.instrument2, B.instrument)) ||
    (same(d.instrument1, B.instrument) && same(d.instrument2, A.instrument));
  if (!ok) {
    throw new Error(
      `tradecraft: pool ${d.amm_id} trades ${JSON.stringify([d.instrument1, d.instrument2])}, not the ` +
        `instruments this wallet trusts for ${A.canon}/${B.canon} — refusing`
    );
  }
  const pick = (x: Disclosed): Disclosed => ({
    templateId: x.templateId,
    contractId: x.contractId,
    createdEventBlob: x.createdEventBlob,
    synchronizerId: x.synchronizerId,
  });
  return {
    ammId: d.amm_id,
    instruments: { [A.canon]: A.instrument, [B.canon]: B.instrument },
    ammRules: pick(body.amm_rules),
    amm: pick(body.amm),
  };
}

// ── reads ────────────────────────────────────────────────────────────────

type Row = ContractsResult["contracts"][number];

/** A relay read that is only a prefix cannot prove absence: a missing
 *  allocation in a partial list would make setup lock a second one. */
async function readAll(
  ctx: TcContext,
  q: { templateId: string } | { interfaceId: string }
): Promise<Row[]> {
  const r = await ctx.relay.contracts(ctx.wallet.party, q);
  if (r.complete !== true) {
    throw new Error(
      `tradecraft: the relay listed only part of this wallet's ${"templateId" in q ? q.templateId : q.interfaceId} ` +
        "contracts — refusing to act on an incomplete view"
    );
  }
  return r.contracts;
}

/** The agent's own batcher (actor = agent, pinned venue + vault), if any. */
export async function findBatcher(ctx: TcContext): Promise<Row | undefined> {
  const { tradecraft } = ctxParts(ctx);
  return (await readAll(ctx, { templateId: TC_BATCHER_TEMPLATE_REF })).find(
    (c) =>
      c.createArgument.actor === ctx.wallet.party &&
      c.createArgument.venue === tradecraft.venue &&
      c.createArgument.vault === tradecraft.vault
  );
}

export interface TcAllocation {
  contractId: string;
  instrument: Instrument;
  /** Funding available for the next settlement (decimal string). */
  funding: string;
}

/** The agent's committed allocations on `pool`, keyed by symbol. Only
 *  allocations the wallet would itself create count: owned by the agent,
 *  committed, settled by the venue alone, bound to this pool by metadata. */
export async function findAllocations(ctx: TcContext, pool: TcPool): Promise<Record<string, TcAllocation>> {
  const { tradecraft } = ctxParts(ctx);
  const out: Record<string, TcAllocation> = {};
  for (const c of await readAll(ctx, { interfaceId: ALLOCATION_V2_INTERFACE })) {
    const view = c.interfaceViews?.find((v) => v.interfaceId.endsWith("Splice.Api.Token.AllocationV2:Allocation"))
      ?.viewValue as
      | {
          settlement?: { executors?: string[] };
          allocation?: {
            admin?: string;
            authorizer?: { owner?: string | null };
            committed?: boolean;
            nextIterationFunding?: Record<string, string> | null;
            meta?: { values?: Record<string, string> };
          };
        }
      | undefined;
    const al = view?.allocation;
    const meta = al?.meta?.values ?? {};
    if (
      !al ||
      al.authorizer?.owner !== ctx.wallet.party ||
      al.committed !== true ||
      view?.settlement?.executors?.length !== 1 ||
      view.settlement.executors[0] !== tradecraft.venue ||
      meta[META_AMM_ID] !== pool.ammId
    ) {
      continue;
    }
    const sym = Object.keys(pool.instruments).find(
      (s) => pool.instruments[s]!.id === meta[META_INSTRUMENT_ID] && pool.instruments[s]!.admin === al.admin
    );
    if (!sym) continue;
    const id = pool.instruments[sym]!.id;
    out[sym] = {
      contractId: c.contractId,
      instrument: pool.instruments[sym]!,
      funding: al.nextIterationFunding?.[id] ?? "0",
    };
  }
  return out;
}

/** The agent's open (unfilled) orders on `pool`. */
export async function findOpenOrders(ctx: TcContext, pool: TcPool): Promise<Row[]> {
  return (await readAll(ctx, { templateId: TC_SWAP_ORDER_TEMPLATE_REF })).filter((c) => c.createArgument.actor === ctx.wallet.party && c.createArgument.ammId === pool.ammId);
}

// ── writes ───────────────────────────────────────────────────────────────

/** Create the agent's batcher. */
export async function createBatcher(ctx: TcContext, pool: TcPool): Promise<string> {
  const { tradecraft, hashBinding } = ctxParts(ctx);
  return executeTradecraftCommand(
    ctx.relay,
    ctx.wallet,
    [
      {
        ExerciseCommand: {
          templateId: pool.ammRules.templateId,
          contractId: pool.ammRules.contractId,
          choice: "AMMRules_CreateSwapOrderBatcher",
          choiceArgument: { actor: ctx.wallet.party },
        },
      },
    ],
    [pool.ammRules],
    { kind: "tcBatcher", expect: { party: ctx.wallet.party, tradecraft } },
    hashBinding
  );
}

/** Smallest set of the agent's unlocked holdings (largest first) covering
 *  `amount`, or throws. Atomic BigInt arithmetic on the 10-dp decimals. */
async function pickInputs(ctx: TcContext, instrument: Instrument, amount: string): Promise<string[]> {
  const h = await ctx.relay.holdings(ctx.wallet.party, instrument, { slice: true });
  const rows = (h.instruments[0]?.holdings ?? [])
    .filter((x) => !x.locked)
    .map((x) => ({ cid: x.cid, atoms: toAtoms(x.amount) }))
    .sort((p, q) => (q.atoms > p.atoms ? 1 : q.atoms < p.atoms ? -1 : 0));
  const want = toAtoms(amount);
  const picked: string[] = [];
  let sum = 0n;
  for (const r of rows) {
    if (sum >= want) break;
    picked.push(r.cid);
    sum += r.atoms;
  }
  if (sum < want) {
    throw new Error(`tradecraft: not enough unlocked ${instrument.id} to fund ${amount} (have ${fromAtoms(sum)})`);
  }
  return picked;
}

/** Create a committed allocation for `symbol` on `pool`, funded with
 *  `funding` (omit for an empty receiving allocation). */
export async function createAllocation(
  ctx: TcContext,
  pool: TcPool,
  symbol: string,
  funding?: string
): Promise<string> {
  const { tradecraft, dso, env, hashBinding } = ctxParts(ctx);
  const instrument = pool.instruments[symbol];
  if (!instrument) throw new Error(`tradecraft: ${symbol} is not an instrument of ${pool.ammId}`);
  if (funding !== undefined && !(toAtoms(funding) > 0n)) throw new Error("tradecraft: funding must be positive");
  const party = ctx.wallet.party;
  const inputs = funding !== undefined ? await pickInputs(ctx, instrument, funding) : [];
  const account = { owner: party, provider: null, id: "" };
  const factory = await ctx.relay.resolveAllocationFactory({
    instrumentId: instrument,
    choiceArguments: {
      settlement: { executors: [tradecraft.venue], id: TC_SETTLEMENT_ID, cid: null, meta: { values: {} } },
      allocation: {
        admin: instrument.admin,
        authorizer: account,
        transferLegSides: [],
        settlementDeadline: null,
        nextIterationFunding: funding !== undefined ? { [instrument.id]: funding } : {},
        committed: true,
        meta: { values: { [META_AMM_ID]: pool.ammId, [META_INSTRUMENT_ID]: instrument.id } },
      },
      requestedAt: new Date().toISOString(),
      inputHoldingCids: inputs,
      extraArgs: { context: { values: {} }, meta: { values: {} } },
      actors: [party],
    },
  });
  const isAmulet = instrument.admin === dso && instrument.id === "Amulet";
  return executeTradecraftCommand(
    ctx.relay,
    ctx.wallet,
    [
      {
        ExerciseCommand: {
          templateId: pool.ammRules.templateId,
          contractId: pool.ammRules.contractId,
          choice: "AMMRules_CreateSettlementAllocation",
          choiceArgument: {
            actor: party,
            ammCid: pool.amm.contractId,
            instrument,
            authorizerAccount: account,
            initialFunding: funding ?? null,
            inputHoldingCids: inputs,
            allocationFactoryCid: factory.factoryId,
            extraArgs: { context: factory.choiceContextData, meta: { values: {} } },
          },
        },
      },
    ],
    [pool.ammRules, pool.amm, ...factory.disclosedContracts],
    {
      kind: "tcAllocation",
      expect: {
        party,
        tradecraft,
        ammId: pool.ammId,
        instrument,
        ...(funding !== undefined ? { funding } : {}),
        dso,
        trustedRegistryParties: isAmulet ? new Set<string>() : resolveTrustedRegistryParties(instrument.admin, env),
      },
    },
    hashBinding
  );
}

/** Top up the agent's existing `symbol` allocation on `pool` by `amount`
 *  (Tradecraft keeps one allocation per pool and instrument). */
export async function fundAllocation(
  ctx: TcContext,
  pool: TcPool,
  symbol: string,
  existing: TcAllocation,
  amount: string
): Promise<string> {
  const { tradecraft, dso, env, hashBinding } = ctxParts(ctx);
  const instrument = existing.instrument;
  if (!(toAtoms(amount) > 0n)) throw new Error("tradecraft: top-up must be positive");
  const party = ctx.wallet.party;
  const inputs = await pickInputs(ctx, instrument, amount);
  const account = { owner: party, provider: null, id: "" };
  const settlement = { executors: [tradecraft.venue], id: TC_SETTLEMENT_ID, cid: null, meta: { values: {} } };
  const meta = { values: { [META_AMM_ID]: pool.ammId, [META_INSTRUMENT_ID]: instrument.id } };
  const noArgs = { context: { values: {} }, meta: { values: {} } };
  const allocFactory = await ctx.relay.resolveAllocationFactory({
    instrumentId: instrument,
    choiceArguments: {
      settlement,
      allocation: {
        admin: instrument.admin,
        authorizer: account,
        transferLegSides: [],
        settlementDeadline: null,
        nextIterationFunding: { [instrument.id]: amount },
        committed: true,
        meta,
      },
      requestedAt: new Date().toISOString(),
      inputHoldingCids: inputs,
      extraArgs: noArgs,
      actors: [party],
    },
  });
  const settleFactory = await ctx.relay.resolveSettlementFactory({
    instrumentId: instrument,
    choiceArguments: {
      settlement,
      transferLegs: [],
      allocations: [
        { allocationCid: existing.contractId, extraTransferLegSides: [], nextIterationFunding: { [instrument.id]: amount } },
      ],
      actors: [party],
      extraArgs: noArgs,
    },
  });
  const disclosed = [pool.ammRules, pool.amm, ...allocFactory.disclosedContracts, ...settleFactory.disclosedContracts];
  const seen = new Set<string>();
  const unique = disclosed.filter((d) => {
    const cid = (d as { contractId?: string }).contractId ?? "";
    if (seen.has(cid)) return false;
    seen.add(cid);
    return true;
  });
  const isAmulet = instrument.admin === dso && instrument.id === "Amulet";
  return executeTradecraftCommand(
    ctx.relay,
    ctx.wallet,
    [
      {
        ExerciseCommand: {
          templateId: pool.ammRules.templateId,
          contractId: pool.ammRules.contractId,
          choice: "AMMRules_FundSettlementAllocation",
          choiceArgument: {
            actor: party,
            ammCid: pool.amm.contractId,
            authorizerAccount: account,
            allocationCid: existing.contractId,
            instrument,
            additionalFunding: amount,
            inputHoldingCids: inputs,
            allocationFactoryCid: allocFactory.factoryId,
            allocationExtraArgs: { context: allocFactory.choiceContextData, meta: { values: {} } },
            settlementFactoryCid: settleFactory.factoryId,
            settlementExtraArgs: { context: settleFactory.choiceContextData, meta: { values: {} } },
          },
        },
      },
    ],
    unique,
    {
      kind: "tcFund",
      expect: {
        party,
        tradecraft,
        ammId: pool.ammId,
        instrument,
        allocationCid: existing.contractId,
        additionalFunding: amount,
        currentFunding: existing.funding,
        dso,
        trustedRegistryParties: isAmulet ? new Set<string>() : resolveTrustedRegistryParties(instrument.admin, env),
      },
    },
    hashBinding
  );
}

/** The participant refused the command because an input contract was being
 *  consumed by another transaction, or was already gone. Nothing executed. */
export function isContractContention(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /LOCKED_CONTRACTS|INACTIVE_CONTRACTS|CONTRACT_NOT_FOUND|CONTRACT_NOT_ACTIVE/.test(m);
}

/** Top up with a bounded retry. Every settlement archives the allocation and
 *  recreates it under a new contract id, so a top-up racing the venue's
 *  settlement is refused (locked or unknown contract) without executing. Wait,
 *  re-read the allocation and try again with its current id and funding
 *  (and fresh registry context). */
async function topUpWithRetry(
  ctx: TcContext,
  pool: TcPool,
  sym: string,
  first: TcAllocation,
  add: string,
  attempts = 4
): Promise<TcAllocation> {
  let have = first;
  for (let i = 1; ; i++) {
    try {
      await fundAllocation(ctx, pool, sym, have, add);
      return have;
    } catch (e) {
      if (!isContractContention(e) || i >= attempts) throw e;
      // 5 s, 10 s, 20 s: measured, a cETH top-up right after a fill was still
      // refused at +15 s and accepted a minute later.
      await (ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(5_000 * 2 ** (i - 1));
      const again = (await findAllocations(ctx, pool))[sym];
      if (!again) throw e;
      have = again;
    }
  }
}

export interface TcSetupResult {
  batcher: { contractId?: string; created: boolean };
  /** `toppedUp` = an existing allocation received `fund[symbol]`. */
  allocations: Record<string, { created: boolean; toppedUp?: boolean; funding: string }>;
}

/** Idempotent setup: the batcher, then an allocation for each pool instrument
 *  that has none — funded from `fund[symbol]` when given, empty otherwise. An
 *  existing allocation is kept, and topped up by `fund[symbol]` when given. */
export async function tcSetup(ctx: TcContext, pool: TcPool, fund: Record<string, string> = {}): Promise<TcSetupResult> {
  for (const s of Object.keys(fund)) {
    if (!pool.instruments[s]) throw new Error(`tradecraft: ${s} is not an instrument of ${pool.ammId}`);
  }
  let batcher = await findBatcher(ctx);
  let createdBatcher = false;
  if (!batcher) {
    await createBatcher(ctx, pool);
    createdBatcher = true;
    batcher = await findBatcher(ctx);
  }
  const existing = await findAllocations(ctx, pool);
  const allocations: TcSetupResult["allocations"] = {};
  for (const sym of Object.keys(pool.instruments)) {
    const have = existing[sym];
    if (have) {
      const add = fund[sym];
      if (add !== undefined) {
        const funded = await topUpWithRetry(ctx, pool, sym, have, add);
        allocations[sym] = { created: false, toppedUp: true, funding: fromAtoms(toAtoms(funded.funding) + toAtoms(add)) };
      } else {
        allocations[sym] = { created: false, funding: have.funding };
      }
      continue;
    }
    await createAllocation(ctx, pool, sym, fund[sym]);
    allocations[sym] = { created: true, funding: fund[sym] ?? "0" };
  }
  return {
    batcher: { ...(batcher ? { contractId: batcher.contractId } : {}), created: createdBatcher },
    allocations,
  };
}

/** Live exact-input quote: how much of `out` `amount` of `inp` buys now. */
export async function tcQuote(ctx: TcContext, inp: string, out: string, amount: string): Promise<number> {
  const { api, f } = ctxParts(ctx);
  return parseTradecraftQuote(
    await tcGet(f, `${api}/v1/quoteForFixedInput/${encodeURIComponent(inp)}/${encodeURIComponent(out)}?givingAmount=${encodeURIComponent(amount)}`)
  );
}

export interface TcOrdersResult {
  updateId: string;
  orders: Array<{ amount: string; minOut: string; quote: number }>;
}

/** Queue `amounts` of `sell` as exact-input orders on `pool`, each with a
 *  minimum output of its live quote less `slippagePct`. Checks before
 *  sending that the batcher and both allocations exist and the sell
 *  allocation covers the total, so a doomed batch is never submitted. */
export async function tcOrders(
  ctx: TcContext,
  pool: TcPool,
  sell: string,
  amounts: string[],
  slippagePct: number
): Promise<TcOrdersResult> {
  const { tradecraft, hashBinding } = ctxParts(ctx);
  const sellInstrument = pool.instruments[sell];
  const buy = Object.keys(pool.instruments).find((s) => s !== sell);
  if (!sellInstrument || !buy) throw new Error(`tradecraft: ${sell} is not an instrument of ${pool.ammId}`);
  if (amounts.length === 0) throw new Error("tradecraft: no orders");
  const min = tradecraftMinInput(sell);
  for (const a of amounts) {
    if (!(toAtoms(a) > 0n)) throw new Error(`tradecraft: order amount ${a} must be positive`);
    if (min !== undefined && Number(a) < min) {
      throw new Error(`tradecraft: ${a} ${sell} is below the pool's minimum input (${min})`);
    }
  }
  const batcher = await findBatcher(ctx);
  if (!batcher) throw new Error("tradecraft: no batcher — run setup first");
  const allocs = await findAllocations(ctx, pool);
  if (!allocs[sell] || !allocs[buy]) {
    throw new Error(`tradecraft: setup is incomplete — need ${sell} and ${buy} allocations on ${pool.ammId}`);
  }
  const total = amounts.reduce((s, a) => s + toAtoms(a), 0n);
  if (toAtoms(allocs[sell].funding) < total) {
    throw new Error(
      `tradecraft: the ${sell} allocation holds ${allocs[sell].funding}, less than the ${fromAtoms(total)} these orders sell`
    );
  }
  // Quote each order as the venue will fill it: after the ones before it in
  // the batch. Order k's quote is quote(first k) - quote(first k-1), so later
  // orders' minimums account for the earlier orders' price impact.
  const orders: TcOrdersResult["orders"] = [];
  let prefix = 0n;
  let prefixOut = 0;
  for (const amount of amounts) {
    prefix += toAtoms(amount);
    const cumulative = await tcQuote(ctx, sell, buy, fromAtoms(prefix));
    const quote = Math.max(0, cumulative - prefixOut);
    prefixOut = cumulative;
    orders.push({ amount, minOut: computeMinOutput(quote, slippagePct), quote });
  }
  const updateId = await executeTradecraftCommand(
    ctx.relay,
    ctx.wallet,
    [
      {
        ExerciseCommand: {
          templateId: batcher.templateId,
          contractId: batcher.contractId,
          choice: "SwapOrderBatcher_CreateOrdersV2",
          choiceArgument: {
            ammId: pool.ammId,
            instrument: sellInstrument,
            orders: orders.map((o) => ({ amount: o.amount, minOut: o.minOut })),
          },
        },
      },
    ],
    [],
    {
      kind: "tcOrders",
      expect: {
        party: ctx.wallet.party,
        tradecraft,
        ammId: pool.ammId,
        sellInstrument,
        orders: orders.map((o) => ({ amount: o.amount, minOut: o.minOut })),
        batcherCid: batcher.contractId,
      },
    },
    hashBinding
  );
  return { updateId, orders };
}

/** Abandon the agent's pending orders on `pool` (all of them, or `orderCid`).
 *  A pending order has moved nothing, so its input simply stays in the
 *  allocation. An order the venue fills or cancels first is already gone:
 *  that race is reported as `gone`, never as a failure. */
export async function tcCancel(
  ctx: TcContext,
  pool: TcPool,
  orderCid?: string
): Promise<Array<{ orderCid: string; updateId?: string; gone?: true }>> {
  const { tradecraft, hashBinding } = ctxParts(ctx);
  const open = (await findOpenOrders(ctx, pool)).filter((o) => orderCid === undefined || o.contractId === orderCid);
  if (orderCid !== undefined && open.length === 0) {
    throw new Error(`tradecraft: order ${orderCid} is not open on ${pool.ammId} (already filled or cancelled?)`);
  }
  const admins = Object.values(pool.instruments).map((i) => i.admin);
  const out: Array<{ orderCid: string; updateId?: string; gone?: true }> = [];
  for (const o of open) {
    try {
      const updateId = await executeTradecraftCommand(
        ctx.relay,
        ctx.wallet,
        [
          {
            ExerciseCommand: {
              templateId: o.templateId,
              contractId: o.contractId,
              choice: "SwapOrder_WithdrawV3",
              choiceArgument: { tradingBalanceCids: [], settlementHelpers: null },
            },
          },
        ],
        [],
        {
          kind: "tcCancel",
          expect: { party: ctx.wallet.party, tradecraft, orderCid: o.contractId, instrumentAdmins: admins },
        },
        hashBinding
      );
      out.push({ orderCid: o.contractId, updateId });
    } catch (e) {
      if (!isContractContention(e)) throw e;
      out.push({ orderCid: o.contractId, gone: true });
    }
  }
  return out;
}

/** The package a withdrawal request is created in: the one the venue's live
 *  AMMRules comes from, when this wallet trusts it (the venue moved to it), else
 *  the first trusted id. The pool's disclosure is venue data, so it can only
 *  pick among ids the wallet already trusts; verify-before-sign pins the same
 *  list. */
export function withdrawalPackageId(pool: Pick<TcPool, "ammRules">, trusted: readonly string[]): string {
  const live = pool.ammRules.templateId.split(":")[0] ?? "";
  return trusted.includes(live) ? live : trusted[0]!;
}

/** Ask the venue to release the agent's `symbol` allocation on `pool` to the
 *  wallet. Asynchronous: the venue fulfils or rejects the request later. */
export async function tcWithdraw(ctx: TcContext, pool: TcPool, symbol: string): Promise<string> {
  const { tradecraft, hashBinding, env } = ctxParts(ctx);
  const instrument = pool.instruments[symbol];
  if (!instrument) throw new Error(`tradecraft: ${symbol} is not an instrument of ${pool.ammId}`);
  // Tradecraft releases only a FUNDED allocation; a request for an empty one
  // is rejected by the venue, so say so before spending a transaction on it.
  const have = (await findAllocations(ctx, pool))[symbol];
  if (!have) throw new Error(`tradecraft: no ${symbol} allocation on ${pool.ammId} to withdraw`);
  if (!(toAtoms(have.funding) > 0n)) {
    throw new Error(
      `tradecraft: the ${symbol} allocation on ${pool.ammId} is empty — the venue releases only funded ` +
        "allocations; an empty one holds nothing and is reused by the next setup"
    );
  }
  const packageIds = resolveTradecraftPackageIds(env);
  const pkg = withdrawalPackageId(pool, packageIds);
  return executeTradecraftCommand(
    ctx.relay,
    ctx.wallet,
    [
      {
        CreateCommand: {
          templateId: `${pkg}:${TC_WITHDRAWAL_TEMPLATE}`,
          createArguments: {
            actor: ctx.wallet.party,
            venue: tradecraft.venue,
            ammId: pool.ammId,
            instrument,
            createdAt: new Date().toISOString(),
          },
        },
      },
    ],
    [],
    {
      kind: "tcWithdrawal",
      expect: { party: ctx.wallet.party, tradecraft, ammId: pool.ammId, instrument, trustedPackageIds: packageIds },
    },
    hashBinding
  );
}

export interface TcStatus {
  ammId: string;
  batcher?: string;
  allocations: Record<string, TcAllocation>;
  openOrders: number;
  /** Filled orders no settlement has paid out yet; undefined when the relay
   *  could not say (see `fillsError`). */
  awaitingSettlement?: number;
  fillsError?: string;
}

export async function tcStatus(ctx: TcContext, pool: TcPool): Promise<TcStatus> {
  const [batcher, allocations, open, fills] = await Promise.all([
    findBatcher(ctx),
    findAllocations(ctx, pool),
    findOpenOrders(ctx, pool),
    // The history read is extra: a relay without it must not cost the rest
    // of the status.
    tcFills(ctx, pool).then(
      (f) => ({ ok: true as const, f }),
      (e: unknown) => ({ ok: false as const, error: shownError(e) })
    ),
  ]);
  return {
    ammId: pool.ammId,
    ...(batcher ? { batcher: batcher.contractId } : {}),
    allocations,
    openOrders: open.length,
    ...(!fills.ok
      ? { fillsError: fills.error }
      : fills.f.awaitingSettlement !== undefined
        ? { awaitingSettlement: fills.f.awaitingSettlement }
        : { fillsError: fills.f.unknown ?? "the history could not be read" }),
  };
}

// ── fills and settlements ────────────────────────────────────────────────

/** Where on the ledger something happened. */
export interface TcAt {
  offset: number;
  updateId: string;
  recordTime?: string;
}

export interface TcOrderHistory {
  orderCid: string;
  /** What the order sells, as the pool's symbol. */
  sell?: { symbol: string; amount: string };
  minOut?: string | null;
  createdAt?: string;
  /** `archived`: closed by a choice this wallet does not interpret (see `choice`). */
  status: "open" | "filled" | "cancelled" | "withdrawn" | "expired" | "archived";
  /** The choice that closed the order. */
  choice?: string;
  /** The transaction that filled or ended the order. */
  ended?: TcAt;
  /** The venue's reason on a cancellation. */
  reason?: string;
  /** A filled order: has its settlement paid out yet? */
  settled?: boolean;
  /** A settled order: what its settlement paid into the side it buys. */
  received?: TcAt & { symbol: string; amount: string };
}

export interface TcSettlement extends TcAt {
  /** `settlement`: the venue moved funds between the agent's allocations and
   *  its vault; `top-up`: the agent funded its own allocation. */
  kind: "settlement" | "top-up";
  legs: Array<{ side: "receive" | "send"; amount: string; symbol: string }>;
}

export interface TcWithdrawalHistory {
  requestCid: string;
  symbol?: string;
  status: "requested" | "fulfilled" | "rejected" | "cancelled" | "archived";
  reason?: string;
  /** The request's latest event. */
  at: TcAt;
}

export interface TcFillsResult {
  ammId: string;
  /** Every order on the pool, oldest first. */
  orders: TcOrderHistory[];
  /** Settlements no order accounts for, and top-ups. */
  settlements: TcSettlement[];
  withdrawals: TcWithdrawalHistory[];
  /** Filled orders whose settlement has not paid out yet; undefined when this
   *  read cannot tell, and `unknown` says why. */
  awaitingSettlement?: number;
  unknown?: string;
  /** False when the history was longer than one read. */
  complete: boolean;
  /** The ledger offset the read reached. */
  readTo: number;
  /** False when the relay does not read withdrawal requests. */
  withdrawalsRead: boolean;
}

/** The pool's symbol for an instrument id as legs and orders name it. */
function symbolFor(pool: TcPool, id: string, admin?: string): string {
  const hit = Object.entries(pool.instruments).find(([, i]) => i.id === id && (admin === undefined || i.admin === admin));
  return hit ? hit[0] : id;
}

function sameAmount(a: string, b: string): boolean {
  try {
    return toAtoms(a) === toAtoms(b);
  } catch {
    return false;
  }
}

// ── text from the relay and the venue ──
// tc fills and tc status print to a terminal and, through the MCP tools, to an
// agent. The venue writes a cancellation's reason and the relay everything
// else, so a value is shown only in the shape it is expected to have.
// Contract and update ids are hex on the ledger; letters, digits, "_" and "-"
// cannot carry a sentence or a party id ("::").
const ID_SHAPE = /^[0-9A-Za-z_-]{1,600}$/;
const CHOICE_SHAPE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const TIME_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const AMOUNT_SHAPE = /^\d{1,28}(\.\d{1,10})?$/;
const SYMBOL_SHAPE = /^[A-Za-z0-9._-]{1,32}$/;
/** A venue reason is shown when it has a known shape: Tradecraft's slippage
 *  message, or plain words. Words alone cannot carry a party id or an amount,
 *  so a reason cannot tell an agent where to send funds. */
const REASON_SHAPES = [
  /^Output \d{1,28}(\.\d{1,10})? is below minimum \d{1,28}(\.\d{1,10})?$/,
  /^[A-Za-z][A-Za-z ]{0,79}$/,
];
const HIDDEN_REASON = "a reason this wallet does not show";

function reasonShown(r: unknown): string | undefined {
  if (r === undefined || r === null) return undefined;
  if (typeof r === "string") return REASON_SHAPES.some((x) => x.test(r)) ? r : HIDDEN_REASON;
  const tag = (r as { tag?: unknown }).tag;
  return typeof tag === "string" && CHOICE_SHAPE.test(tag) ? tag : HIDDEN_REASON;
}

/** An error message for display: no control characters, at most 200 characters. */
export function shownError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 200);
}

const ORDER_KINDS = new Set(["created", "filled", "cancelled", "withdrawn", "expired", "archived"]);
const REQUEST_KINDS = new Set(["requested", "fulfilled", "rejected", "cancelled", "archived"]);
const POOL_SHAPE = /^[A-Za-z0-9 /._-]{1,64}$/;

/** Why a relay record is not used, or undefined when every field has its shape. */
function malformed(u: TradecraftUpdate): string | undefined {
  if (!Number.isSafeInteger(u.offset) || !ID_SHAPE.test(u.updateId)) return "an update without a readable offset or id";
  for (const o of u.orders) {
    if (!ID_SHAPE.test(o.orderCid)) return "an order with an unreadable id";
    if (!ORDER_KINDS.has(o.kind)) return "an order with an unknown kind";
    if (o.choice !== undefined && !CHOICE_SHAPE.test(o.choice)) return "an order closed by an unreadable choice";
    if (o.sell && (!AMOUNT_SHAPE.test(o.sell.amount) || !SYMBOL_SHAPE.test(o.sell.instrument.id))) return "an order with an unreadable sale";
  }
  for (const a of u.allocations) {
    for (const l of a.legs) {
      if (!AMOUNT_SHAPE.test(l.amount) || !SYMBOL_SHAPE.test(l.instrumentId)) return "a settlement leg with an unreadable amount";
    }
  }
  for (const w of u.withdrawals) {
    if (!ID_SHAPE.test(w.requestCid)) return "a withdrawal request with an unreadable id";
    if (!REQUEST_KINDS.has(w.kind)) return "a withdrawal request with an unknown kind";
  }
  return undefined;
}

/**
 * The agent's queued-mode history on `pool`, read from the relay's per-party
 * Tradecraft history from the start of the ledger, at most `maxPages` reads of
 * 200 rows.
 *
 * A fill carries no amount. The venue settles each fill on its own, later, in
 * one transaction that sends exactly the order's input from the agent's
 * allocation to the vault and pays the output into the other one (MainNet,
 * October 2026: five fills in one transaction got five settlements, and two
 * waited ten hours). So a filled order is matched to the first later
 * settlement that sent its input amount on this pool, and `received` is that
 * settlement's payout. Legs between the agent's own holdings and its
 * allocation are top-ups, never settlements. A filled order with no match
 * counts in `awaitingSettlement`.
 *
 * The match needs the whole history: read from a later offset, an earlier
 * fill's late settlement would be credited to a newer fill of the same
 * amount. So there is no cursor here, and the count is withheld when the read
 * stopped early, when the relay could not read some of the agent's records,
 * or when an order on the pool was closed by a choice this wallet does not
 * interpret.
 */
export async function tcFills(ctx: TcContext, pool: TcPool, opts: { maxPages?: number } = {}): Promise<TcFillsResult> {
  const party = ctx.wallet.party;
  const orders = new Map<string, TcOrderHistory>();
  const withdrawals = new Map<string, TcWithdrawalHistory>();
  const moves: TcSettlement[] = [];
  const anomalies: string[] = [];
  // Every order's pool, from its create: an archive whose create was on an
  // earlier page carries no terms and is placed by its contract id.
  const poolOf = new Map<string, string>();
  const unplaced = new Set<string>();
  let withdrawalsRead = true;
  let after = 0;
  let complete = false;
  let participant: string | undefined;
  const maxPages = opts.maxPages ?? 20;
  const at = (u: TradecraftUpdate): TcAt => ({
    offset: u.offset,
    updateId: u.updateId,
    ...(u.recordTime && TIME_SHAPE.test(u.recordTime) ? { recordTime: u.recordTime } : {}),
  });
  const take = (u: TradecraftUpdate): void => {
    // The relay's own wording of what it could not read is not shown.
    for (const a of u.anomalies ?? []) {
      if (a.ammId === undefined || a.ammId === pool.ammId) anomalies.push(`at offset ${u.offset}`);
    }
    const bad = malformed(u);
    if (bad !== undefined) {
      anomalies.push(`${bad} at offset ${Number.isSafeInteger(u.offset) ? u.offset : "?"}`);
      return;
    }
    for (const o of u.orders) {
      if (o.ammId !== undefined) poolOf.set(o.orderCid, o.ammId);
      const ammId = o.ammId ?? poolOf.get(o.orderCid);
      if (ammId === undefined) {
        unplaced.add(o.orderCid);
        continue;
      }
      if (ammId !== pool.ammId) continue;
      const entry: TcOrderHistory = orders.get(o.orderCid) ?? {
        orderCid: o.orderCid,
        ...(o.sell ? { sell: { symbol: symbolFor(pool, o.sell.instrument.id, o.sell.instrument.admin), amount: o.sell.amount } } : {}),
        ...(o.minOut === null || (typeof o.minOut === "string" && AMOUNT_SHAPE.test(o.minOut)) ? { minOut: o.minOut } : {}),
        ...(o.createdAt ? { createdAt: o.createdAt } : {}),
        status: "open",
      };
      if (o.kind !== "created") {
        entry.status = o.kind;
        entry.ended = at(u);
        if (o.choice !== undefined) entry.choice = o.choice;
        const reason = reasonShown(o.reason);
        if (reason !== undefined) entry.reason = reason;
      }
      orders.set(o.orderCid, entry);
    }
    for (const w of u.withdrawals) {
      if (w.ammId !== pool.ammId) continue;
      const prev = withdrawals.get(w.requestCid);
      const reason = reasonShown(w.reason);
      withdrawals.set(w.requestCid, {
        requestCid: w.requestCid,
        ...(w.instrument && SYMBOL_SHAPE.test(w.instrument.id)
          ? { symbol: symbolFor(pool, w.instrument.id, w.instrument.admin) }
          : prev?.symbol
            ? { symbol: prev.symbol }
            : {}),
        status: w.kind,
        ...(reason !== undefined ? { reason } : {}),
        at: at(u),
      });
    }
    const settle: TcSettlement["legs"] = [];
    const topUp: TcSettlement["legs"] = [];
    for (const a of u.allocations) {
      if (a.ammId !== pool.ammId) continue;
      for (const l of a.legs) {
        (l.counterparty === party ? topUp : settle).push({ side: l.side, amount: l.amount, symbol: symbolFor(pool, l.instrumentId) });
      }
    }
    if (settle.length > 0) moves.push({ ...at(u), kind: "settlement", legs: settle });
    if (topUp.length > 0) moves.push({ ...at(u), kind: "top-up", legs: topUp });
  };
  for (let page = 0; page < maxPages; page++) {
    const r = await ctx.relay.tradecraftUpdates(party, { after, limit: 200 });
    // Offsets belong to one participant: a switch mid-read mixes two ledgers.
    if (participant !== undefined && r.participant !== undefined && r.participant !== participant) {
      throw new Error("the relay moved this party to another participant during the read; run it again");
    }
    participant ??= r.participant;
    if (r.withdrawalsRead === false) withdrawalsRead = false;
    // The cursor is a number and moves forward, or the read stops here.
    if (!Number.isSafeInteger(r.next) || typeof r.complete !== "boolean" || !Array.isArray(r.updates)) {
      throw new Error("the relay answered the history read in an unexpected shape");
    }
    for (const u of r.updates) take(u);
    if (r.complete) {
      after = r.next;
      complete = true;
      break;
    }
    // A cursor that does not move would ask for the same page again.
    if (!(r.next > after)) throw new Error(`the relay's history cursor did not advance past offset ${after}`);
    after = r.next;
  }

  // Match settlements to fills, oldest first; a settlement in the fill's own
  // transaction counts.
  const filled = [...orders.values()]
    .filter((o) => o.status === "filled" && o.ended !== undefined)
    .sort((a, b) => a.ended!.offset - b.ended!.offset);
  for (const o of filled) o.settled = false;
  const unmatched: TcSettlement[] = [];
  for (const m of moves) {
    if (m.kind === "top-up") {
      unmatched.push(m);
      continue;
    }
    const sends = m.legs.filter((l) => l.side === "send");
    const receives = m.legs.filter((l) => l.side === "receive");
    let used = false;
    for (const leg of sends) {
      const o = filled.find(
        (f) => !f.settled && f.ended!.offset <= m.offset && f.sell?.symbol === leg.symbol && sameAmount(f.sell.amount, leg.amount)
      );
      if (!o) continue;
      o.settled = true;
      used = true;
      // The payout is this fill's only when the settlement moved one fill.
      const got = sends.length === 1 && receives.length === 1 && receives[0]!.symbol !== leg.symbol ? receives[0]! : undefined;
      if (got) o.received = { offset: m.offset, updateId: m.updateId, ...(m.recordTime ? { recordTime: m.recordTime } : {}), symbol: got.symbol, amount: got.amount };
    }
    if (!used) unmatched.push(m);
  }

  const strange = [...orders.values()].find((o) => o.status === "archived");
  const termless = filled.find((o) => o.sell === undefined);
  const unknown = !complete
    ? `the history is longer than one read (it stopped at offset ${after})`
    : anomalies.length > 0
      ? `${anomalies.length} of this wallet's records could not be read (the first ${anomalies[0]})`
      : strange
        ? `order ${strange.orderCid} was closed by ${strange.choice ?? "a choice"} this wallet does not interpret`
        : termless
          ? `order ${termless.orderCid} filled, but what it sold is not in this history`
          : unplaced.size > 0
            ? `${unplaced.size} orders closed whose creation is not in this history`
            : undefined;
  return {
    ammId: pool.ammId,
    orders: [...orders.values()],
    settlements: unmatched,
    withdrawals: [...withdrawals.values()],
    ...(unknown === undefined ? { awaitingSettlement: filled.filter((o) => !o.settled).length } : { unknown }),
    complete,
    readTo: after,
    withdrawalsRead,
  };
}

/** `tcFills` as lines of text, for the CLI and the MCP tool: open orders and
 *  fills awaiting settlement in full, then the `recent` latest other orders. */
export function formatTcFills(f: TcFillsResult, opts: { fullIds: boolean; recent?: number }): string[] {
  const short = (s: string) => (opts.fullIds ? s : `${s.slice(0, 16)}…`);
  const when = (e: TcAt) => `${e.recordTime ?? "?"}, update ${short(e.updateId)}`;
  const what = (o: TcOrderHistory) => (o.sell ? `sell ${o.sell.amount} ${o.sell.symbol}${o.minOut ? `, min out ${o.minOut}` : ""}` : "order");
  const lines = [`pool ${POOL_SHAPE.test(f.ammId) ? f.ammId : "?"}`];
  if (!f.complete) lines.push(`history read up to offset ${f.readTo} only: later events are missing below`);
  // With the count withheld, "awaiting" is not established either.
  const pendingLabel = f.awaitingSettlement !== undefined ? "awaiting settlement" : "no settlement found in what was read";
  const open = f.orders.filter((o) => o.status === "open");
  const waiting = f.orders.filter((o) => o.status === "filled" && !o.settled);
  const rest = f.orders.filter((o) => o.status !== "open" && !(o.status === "filled" && !o.settled));
  const keep = Math.max(0, opts.recent ?? 20);
  const recent = keep > 0 ? rest.slice(-keep) : []; // slice(-0) would keep them all
  // An open order's id is what `cancel` takes, so it is never shortened.
  for (const o of open) lines.push(`open order ${o.orderCid}: ${what(o)}`);
  for (const o of waiting) lines.push(`order ${short(o.orderCid)}: ${what(o)}: filled (${when(o.ended!)}); ${pendingLabel}`);
  if (rest.length > recent.length) lines.push(`(${rest.length - recent.length} earlier orders not shown)`);
  for (const o of recent) {
    const state =
      o.status === "filled"
        ? `filled (${when(o.ended!)}); settled${o.received ? `: received ${o.received.amount} ${o.received.symbol} (${when(o.received)})` : ""}`
        : `${o.status === "archived" ? `closed by ${o.choice ?? "an unknown choice"}` : o.status} (${when(o.ended!)})${o.reason ? `: ${o.reason}` : ""}`;
    lines.push(`order ${short(o.orderCid)}: ${what(o)}: ${state}`);
  }
  if (!f.withdrawalsRead) lines.push("withdrawal requests: this relay does not read them");
  for (const w of f.withdrawals.slice(-5)) {
    lines.push(`withdrawal request ${short(w.requestCid)}${w.symbol ? ` (${w.symbol})` : ""}: ${w.status}${w.reason ? `: ${w.reason}` : ""} (${when(w.at)})`);
  }
  for (const s of f.settlements.filter((m) => m.kind === "settlement")) {
    const legs = s.legs.map((l) => `${l.side === "receive" ? "received" : "sent"} ${l.amount} ${l.symbol}`).join(", ");
    lines.push(`settlement matched to no order (${when(s)}): ${legs}`);
  }
  const counts = (["filled", "cancelled", "withdrawn", "expired", "archived", "open"] as const)
    .map((k) => [k, f.orders.filter((o) => o.status === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k === "archived" ? "closed otherwise" : k}`);
  lines.push(counts.length > 0 ? `orders: ${counts.join(", ")}` : "no orders on this pool");
  lines.push(
    f.awaitingSettlement !== undefined
      ? `filled, awaiting settlement: ${f.awaitingSettlement}`
      : `filled, awaiting settlement: unknown (${f.unknown ?? "the history could not be read"})`
  );
  return lines;
}

// 10-dp decimals as BigInt atoms (every Tradecraft instrument is 10-dp).
function toAtoms(d: string): bigint {
  const m = String(d).trim().match(/^(\d+)(?:\.(\d{1,10}))?$/);
  if (!m) throw new Error(`tradecraft: invalid amount ${JSON.stringify(d)}`);
  return BigInt(m[1]!) * 10n ** 10n + BigInt((m[2] ?? "").padEnd(10, "0"));
}
function fromAtoms(a: bigint): string {
  const s = a.toString().padStart(11, "0");
  return `${s.slice(0, -10)}.${s.slice(-10)}`.replace(/\.?0+$/, "") || "0";
}
