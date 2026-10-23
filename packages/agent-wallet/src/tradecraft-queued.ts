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
import type { RelayClient, ContractsResult } from "./relay-client.js";
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
/** The read ids a relay must allowlist (CANTON_X402_WALLET_READ_IDS). */
export const TC_RELAY_READ_IDS = [TC_BATCHER_TEMPLATE_REF, TC_SWAP_ORDER_TEMPLATE_REF, ALLOCATION_V2_INTERFACE];

const META_AMM_ID = "tradecraft.fi/amm-id";
const META_INSTRUMENT_ID = "tradecraft.fi/instrument-id";
/** The settlement id Tradecraft stamps on every allocation it creates. */
const TC_SETTLEMENT_ID = "tc-settlement";

type Instrument = { admin: string; id: string };
type Disclosed = { templateId: string; contractId: string; createdEventBlob: string; synchronizerId: string };

/** Tradecraft package ids trusted for the withdrawal request: the core's
 *  measured set, or CANTON_AGENT_TRADECRAFT_PACKAGE_IDS (comma-separated) for
 *  a newer release. The first one is the package the request is created in. */
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
  return executeTradecraftCommand(
    ctx.relay,
    ctx.wallet,
    [
      {
        CreateCommand: {
          templateId: `${packageIds[0]}:${TC_WITHDRAWAL_TEMPLATE}`,
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
}

export async function tcStatus(ctx: TcContext, pool: TcPool): Promise<TcStatus> {
  const [batcher, allocations, open] = await Promise.all([
    findBatcher(ctx),
    findAllocations(ctx, pool),
    findOpenOrders(ctx, pool),
  ]);
  return {
    ammId: pool.ammId,
    ...(batcher ? { batcher: batcher.contractId } : {}),
    allocations,
    openOrders: open.length,
  };
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
