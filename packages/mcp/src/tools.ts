/**
 * The wallet tools, registered on any McpServer. Everything a tool needs is
 * injected, so one set of tools serves both the local stdio server (one
 * wallet on disk in the owner's home) and the hosted remote server (one wallet
 * per signed-in user, keys held server-side). A tool body cannot reach for a
 * home directory, a global wallet or a file ledger on its own; that is what
 * lets one copy of the money logic serve both.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  claimAll,
  reclaimExpiredOffers,
  PreparedDecodeError,
  PreparedHashUnavailableError,
  PreparedTransferMismatchError,
  classifyPending,
  withdraw,
  executeSwap,
  resolveSwapIntent,
  resolveSwapTicket,
  swapFloorNotes,
  parseSwapVenue,
  parseSlippagePct,
  resolveTrustedDsoParty,
  SWAP_MAX_FEE_CC,
  CANTEX_CONNECT_PARTY,
  KNOWN_INSTRUMENTS,
  isHoldingsExceedNodeLimitError,
  loadTcPool,
  tcOrders,
  tcQuote,
  tcSetup,
  tcStatus,
  tcWithdraw,
  tcCancel,
  tcFills,
  formatTcFills,
  type TcContext,
  type AgentWallet,
  type BalanceResult,
  type RelayClient,
} from "@ftptech/canton-agent-wallet";
import type { SpendPolicy } from "./config.js";
import {
  PolicyError,
  assertNotRelay,
  assertPayAllowed,
  assertUsdcxPayAllowed,
  assertWithdrawAllowed,
  assertSwapAllowed,
  isCatalogOnly,
  payValueCeiling,
  limitsLink,
  type PolicyLedgerStore,
  type OperationRecord,
} from "./policy.js";
import { USDCX_INSTRUMENT_KEY, readUsdcxHolding } from "./usdcx.js";
import { capDecimal10, decimal10, trimDecimal } from "./amounts.js";
import { holdingsLines, limitLines } from "./balance-lines.js";
import type { CatalogCache, InstrumentSymbols } from "./catalog.js";
import { formatCatalog } from "./catalog-format.js";
import { GUIDE } from "./guide.js";
import { formatHistory, HISTORY_MAX, type HistoryRow } from "./history.js";
import { fetchPoolRows, formatPools, quoteSwap, timedQuoteDeps, venueReason } from "./swap-quote.js";
import { atomicToDecimalCC, decimalToAtomicCC, sumLedgerDecimals } from "@ftptech/x402-canton-core";

/** How much of a paid response body `pay` returns unless asked for more. */
const DEFAULT_RESPONSE_CHARS = 4000;

/** What send_feedback accepts: the kinds, the longest text, a day's count. */
export const FEEDBACK_KINDS = ["bug", "confusing", "idea"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_MAX_CHARS = 2000;
export const FEEDBACK_PER_DAY = 6;

/** Where send_feedback writes (the hosted store, bound to one user). */
export interface FeedbackSink {
  add(kind: FeedbackKind, text: string): Promise<void>;
  /** This user's feedback in the last 24 hours. */
  countToday(): Promise<number>;
}

/** What `pay` hands the paying fetch. The asset fields are set only when the
 *  caller names an asset; without one the options are exactly today's. */
export interface PayingFetchOpts {
  maxPaymentValue?: string;
  expectedPayTo?: string;
  /** Pick this asset's entry when the 402 offers several (fails closed when it
   *  is not offered). */
  preferAsset?: string;
  /** The asset to pay in when the agent named none, if the 402 offers it. */
  defaultAsset?: string;
  /** Consent to spend these registry instruments (`"<admin>|<id>"`). */
  payableInstruments?: readonly string[];
  /** Per-instrument ceilings, in each instrument's own unit. */
  maxPaymentValueByInstrument?: Readonly<Record<string, string>>;
  /** Called for every transfer the signer signs. */
  onSigned?: (signed: { instrument: string; amount: string }) => void;
  /** `0` means this call pays at most once: no re-pay of a merchant that keeps
   *  answering 402 (pay asks for it whenever max_cc is set, and for USDCx).
   *  Absent, the server's own setting applies. */
  maxPaymentRetries?: number;
}

/** What the tools act on. */
export interface WalletToolDeps {
  /** The wallet the tools act on. The local server creates it on first use. */
  getWallet(): Promise<AgentWallet>;
  /** A relay client for that wallet. */
  relayFor(w: AgentWallet): RelayClient;
  /** An x402 paying fetch bound to that wallet, capped by the options. */
  payingFetchFor(w: AgentWallet, opts: PayingFetchOpts): Promise<typeof globalThis.fetch>;
  apiKey?: string | undefined;
  policy: SpendPolicy;
  ledger: PolicyLedgerStore;
  /**
   * Runs one money move (pay, withdraw, swap, claim) at a time for this wallet. The
   * policy gate reads the ledger, the money moves, and only then is the spend
   * recorded; two moves running together would both pass the gate on the same
   * reading and together exceed the daily cap. The hosted server passes a
   * per-user queue here; the local server takes a `.policy-lock` directory in
   * its home, which holds across processes. Only the move and its ledger
   * record run inside: what follows a settled move (the Lighthouse check, the
   * merchant's response body) is read after it returns.
   */
  serialize?: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Offer `pay`'s `asset` parameter (pay in CC or USDCx) and the USDCx line in
   * get_balance. The local server always does; the hosted one only with
   * MCP_REMOTE_USDCX on, so with it off the tool schemas stay as they were.
   */
  usdcx?: boolean;
  /**
   * Register the Tradecraft queued-mode tools (tradecraft_queued_*). The local
   * server does; the hosted one does not, so its tool list stays as it was.
   */
  tradecraftQueued?: boolean;
  /**
   * withdraw's and swap's safety checks (a swap venue refused, the cover and
   * cap checks before a ticket fee, a failed call's CC booked) apply with or
   * without newTools: they only refuse earlier or count CC that really left.
   *
   * The additions behind MCP_REMOTE_NEW_TOOLS (always on in the local server):
   * get_guide, find_paid_apis (with `catalog`), swap_quote, the extra get_balance lines,
   * and pay's max_cc / max_response_chars. Absent = the tools exactly as in mcp
   * 2.3.0. `maxResponseChars` is the most of a paid body `pay` will return.
   */
  newTools?: { maxResponseChars: number } | undefined;
  /** The facilitator's catalogue: with newTools, find_paid_apis is listed.
   *  (Plan E also reads it to enforce catalogue-only payments.) */
  catalog?: CatalogCache | undefined;
  /** The facilitator's instrument symbols, for find_paid_apis prices. */
  instrumentSymbols?: InstrumentSymbols | undefined;
  /** The owner's money moves, newest first (the hosted server's store). With
   *  it, get_history is listed; the local server has none. */
  history?: ((limit: number) => Promise<HistoryRow[]>) | undefined;
  /** Feedback to the team (the hosted server): with it, send_feedback is listed. */
  feedback?: FeedbackSink | undefined;
  /** The wallets' network, for swap_quote's Cantex quote (Cantex names CC by
   *  its DSO). swap_quote creates no wallet, so it cannot read it from one. */
  network?: string | undefined;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const errText = (s: string) => ({
  content: [{ type: "text" as const, text: s }],
  isError: true,
});

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const toNum = (cc: string): number => {
  const n = Number(cc);
  return Number.isFinite(n) ? n : 0;
};

/** Map a thrown wallet/relay error to a clean tool error (never leak key bytes,
 *  never throw out of a handler — return isError instead). */
function toolError(where: string, err: unknown): ReturnType<typeof errText> {
  if (err instanceof PolicyError) return errText(`blocked by spend policy: ${err.message}`);
  const msg = err instanceof Error ? err.message : String(err);
  const cause =
    err instanceof Error && err.cause instanceof Error && err.cause.message !== msg
      ? ` (${err.cause.message})`
      : "";
  return errText(`${where} failed: ${msg}${cause}`);
}

/** The swap endpoint's live ticket fee, in CC. Only for checking a swap is
 *  covered before the fee is paid; the endpoint's 402 sets the real price. */
const SWAP_TICKET_FEE_CC = "0.01";

/** A ledger decimal in atomic units (scale 10, CC and every token), or
 *  undefined when it is not one. */
const atomicOf = (d: string): bigint | undefined => {
  try {
    return BigInt(decimalToAtomicCC(d));
  } catch {
    return undefined;
  }
};
const decimalOf = (a: bigint): string => trimDecimal(atomicToDecimalCC((a > 0n ? a : 0n).toString()));

/** How long the Lighthouse cross-check may take. It runs after the money-move
 *  queue is released, but a Lighthouse that never answers must not hold the
 *  call, and the agent waiting on it, either. */
const LIGHTHOUSE_TIMEOUT_MS = 10_000;

/** How long pay reads a paid response body. The payment settled before the
 *  headers arrived and the queue is already released, but a merchant that
 *  trickles its body must not hold the call. */
const BODY_READ_TIMEOUT_MS = 30_000;

/** What `readBodyPrefix` got: the whole body (`end`), its first `maxChars + 1`
 *  characters (`more`: there is more, unread), or what arrived before the
 *  deadline or a failed read (`stopped`). */
interface BodyRead {
  text: string;
  ended: "end" | "more" | "stopped";
}

/** Reads a response body as a stream, at most `maxChars + 1` characters of it
 *  (one more than can be shown, to tell a cut body from a whole one) and for at
 *  most BODY_READ_TIMEOUT_MS. Then the download is cancelled. Never throws. */
async function readBodyPrefix(res: Response, maxChars: number): Promise<BodyRead> {
  if (!res.body) return { text: "", ended: "end" };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const deadline = AbortSignal.timeout(BODY_READ_TIMEOUT_MS);
  const timedOut = new Promise<undefined>((resolve) => {
    if (deadline.aborted) resolve(undefined);
    deadline.addEventListener("abort", () => resolve(undefined), { once: true });
  });
  let got = "";
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), timedOut]);
      if (chunk === undefined) return { text: got, ended: "stopped" };
      if (chunk.done) return { text: got + decoder.decode(), ended: "end" };
      got += decoder.decode(chunk.value, { stream: true });
      if (got.length > maxChars) return { text: got.slice(0, maxChars + 1), ended: "more" };
    }
  } catch {
    return { text: got, ended: "stopped" };
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** Lighthouse cross-check: success iff verdict==accepted AND send==Success.
 *  Best-effort + read-only; never throws (balance is the authoritative truth).
 *  No answer within LIGHTHOUSE_TIMEOUT_MS is null: not confirmed. */
async function lighthouseVerify(
  updateId: string
): Promise<{ ok: boolean; verdict?: string | undefined; send?: string | undefined } | null> {
  try {
    const res = await fetch(
      `https://lighthouse.cantonloop.com/api/transactions/${encodeURIComponent(updateId)}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(LIGHTHOUSE_TIMEOUT_MS) }
    );
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    const blob = JSON.stringify(j);
    const verdict = /"verdict_result"\s*:\s*"([^"]+)"/.exec(blob)?.[1];
    const send = /"TransferCommandResult(\w+)"/.exec(blob)?.[0];
    const ok = verdict === "accepted" && send === "TransferCommandResultSuccess";
    return { ok, verdict, send };
  } catch {
    return null;
  }
}

/** Best-effort updateId from an x402 payment response header (PAYMENT-RESPONSE /
 *  X-PAYMENT-RESPONSE = base64 JSON carrying `transaction`). Balance remains the
 *  source of truth if this is absent. */
function updateIdFromResponse(res: Response): string | undefined {
  const raw =
    res.headers.get("payment-response") ??
    res.headers.get("x-payment-response") ??
    res.headers.get("payment-response-canton");
  if (!raw) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as {
      transaction?: string;
      updateId?: string;
    };
    return decoded.transaction ?? decoded.updateId;
  } catch {
    return undefined;
  }
}

/** A JSON body goes out as JSON unless the agent set a content type: fetch
 *  labels a string body text/plain, and an API that reads JSON refuses that
 *  after the payment has settled. */
export function withJsonContentType(
  headers: Record<string, string> | undefined,
  body: string | undefined
): Record<string, string> | undefined {
  if (body === undefined) return headers;
  if (headers && Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) return headers;
  try {
    const v: unknown = JSON.parse(body);
    if (typeof v !== "object" || v === null) return headers;
  } catch {
    return headers;
  }
  return { ...headers, "content-type": "application/json" };
}

export function buildFundingText(party: string, amount?: string): string {
  const amt = amount && amount.trim() ? `${amount} Canton Coin (CC)` : "some Canton Coin (CC) (0.05–1 CC is plenty to start)";
  return (
    `My Canton wallet is ready. Party id:\n  ${party}\n\n` +
    `Please send ${amt} to that party id on MainNet. ` +
    `Once you've sent it, tell me and I'll claim it.`
  );
}

/** Why a swap failed, for the owner's history that get_history shows an agent
 *  later: this package's own wording, never text a venue or endpoint sent back
 *  (an error can carry up to 200 characters of a response body). */
export function swapFailureText(err: unknown): string {
  if (err instanceof PolicyError) return err.message.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 120);
  const first = (err instanceof Error ? err.message : String(err)).replace(/^swap: /, "").split("\n")[0]!;
  const own = !/\(HTTP \d{3}\)|response|[{}"`<>\\]|::/.test(first) && /^[A-Za-z0-9 .,:;()%+_/-]{1,120}$/.test(first);
  if (own) return first;
  const coarse = venueReason(err);
  return coarse === "the venue could not quote" ? "it failed or was refused; the reply at the time said why" : coarse;
}

export function registerWalletTools(server: McpServer, deps: WalletToolDeps): void {
  const {
    getWallet,
    relayFor,
    payingFetchFor,
    apiKey,
    policy,
    ledger,
    newTools,
    catalog,
    instrumentSymbols,
    history,
    feedback,
  } = deps;
  const serialize = deps.serialize ?? (<T,>(fn: () => Promise<T>): Promise<T> => fn());
  const recordOp = async (op: OperationRecord): Promise<void> => {
    try {
      await ledger.recordOperation?.(op, Date.now());
    } catch {
      // History is for the owner; it never fails the move it describes.
    }
  };

  /** The lines under get_balance's first line (newTools only). Each read stands
   *  on its own: one failing never hides the others or the balance. */
  const balanceExtras = async (w: AgentWallet): Promise<string[]> => {
    const lines: string[] = [];
    try {
      lines.push(...holdingsLines(await relayFor(w).holdings(w.party, undefined, { slice: true, registryOnly: true })));
    } catch {
      lines.push("tokens: could not be read right now");
    }
    try {
      lines.push(...limitLines(policy, await ledger.read(Date.now()), { usdcx: deps.usdcx === true }));
    } catch {
      // A convenience line; the caps themselves still hold on pay.
    }
    return lines;
  };

  /** Plan C's catalogue, for the catalogue-only check in `pay`. `undefined`
   *  when there is none or it never loaded; a throw counts as that too. */
  const readCatalog = async () => {
    try {
      return await deps.catalog?.get();
    } catch {
      return undefined;
    }
  };

  // ── read-only (auto-allow) ────────────────────────────────────────────────
  server.registerTool(
    "get_address",
    {
      title: "Get wallet address",
      description:
        "Return this agent's Canton party id (its wallet address). Creates the wallet on first use, which accepts the Terms of Service (https://ftp-tech.mintlify.site/terms). Read-only.",
      inputSchema: {},
      annotations: { title: "Get address", readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const w = await getWallet();
        return text(w.party);
      } catch (err) {
        return toolError("get_address", err);
      }
    }
  );

  server.registerTool(
    "get_balance",
    {
      title: "Get wallet balance",
      description:
        "Return the agent's on-ledger Canton Coin (CC) balance and holdings. Read-only, authoritative.",
      inputSchema: {},
      annotations: { title: "Get balance", readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const w = await getWallet();
        let b: BalanceResult;
        try {
          b = await relayFor(w).balance(w.party);
        } catch (err) {
          // Too many amulets for one read (413): today's error stays the first
          // line, and with newTools the tokens and limits can still be read.
          if (!newTools || !isHoldingsExceedNodeLimitError(err)) throw err;
          const first = toolError("get_balance", err).content[0]!.text;
          return errText([first, ...(await balanceExtras(w))].join("\n"));
        }
        // Incoming transfers are not balance until accepted; say they are
        // there, or an agent reads 0 while a transfer sits waiting for `claim`.
        // Only what `claim` would accept: an expired offer or a token with no
        // trust anchor here would keep the hint up and send the agent back and
        // forth between get_balance and a claim that skips it.
        let incoming = "";
        try {
          const { pending } = await relayFor(w).pending(w.party);
          const trustedDso = resolveTrustedDsoParty(process.env, w.network);
          const now = Date.now();
          const live = pending.filter(
            (p) => classifyPending(p, trustedDso, now).kind === "claimable"
          ).length;
          if (live > 0) {
            incoming = `; ${live} incoming transfer${live === 1 ? "" : "s"} waiting — call \`claim\` to accept`;
          }
        } catch {
          /* best-effort: the balance above stands on its own */
        }
        const first = `${b.cc} CC (${b.amulet} amulet${b.amulet === 1 ? "" : "s"}) for ${w.party}${incoming}`;
        // On the hosted server the owner sets the limits; say what they are now
        // and where they change, so a user who asks gets both in one answer.
        const lines = [first, ...(newTools ? await balanceExtras(w) : [])];
        // With newTools the "limits:" line already gives the numbers, so it
        // only gains the page: the answer states the limits once.
        const limitsLine = lines.findIndex((l) => l.startsWith("limits: "));
        if (policy.limitsUrl && limitsLine > 0) {
          lines[limitsLine] += `. The owner changes them on ${policy.limitsUrl}.`;
        } else if (policy.limitsUrl) {
          const cc = (n: number | undefined) => (n === undefined ? "no limit" : `${n} CC`);
          let spentToday = "";
          try {
            spentToday = ` (${(await ledger.read(Date.now())).spentTodayCC} CC spent today)`;
          } catch {
            /* best-effort */
          }
          lines.push(
            `Limits: ${cc(policy.maxPerTx)} per payment, ${cc(policy.dailyCap)} per day${spentToday}. ` +
              `The owner changes them on ${policy.limitsUrl}.`
          );
        }
        return text(lines.join("\n"));
      } catch (err) {
        return toolError("get_balance", err);
      }
    }
  );

  server.registerTool(
    "request_funding",
    {
      title: "Request funding from the owner",
      description:
        "Return the agent's party id plus a ready-to-paste message asking the human owner to send CC. Moves nothing; funds appear after the owner sends and the agent calls `claim`.",
      inputSchema: { amount: z.string().optional().describe("Suggested CC amount, e.g. \"0.5\"") },
      annotations: { title: "Request funding", readOnlyHint: true, openWorldHint: false },
    },
    async ({ amount }) => {
      try {
        const w = await getWallet();
        return text(buildFundingText(w.party, amount));
      } catch (err) {
        return toolError("request_funding", err);
      }
    }
  );

  // ── read-only additions (newTools) ────────────────────────────────────────
  // Registered only with newTools, so a server without it lists exactly the
  // 2.3.0 tools. None of them creates a wallet.
  if (newTools) {
    server.registerTool(
      "get_guide",
      {
        title: "Get the wallet guide",
        description:
          "Return a short guide to this wallet: the first calls to make, how paying works and when not to retry, funding, limits and where the owner manages them. Read-only; creates no wallet.",
        inputSchema: {},
        annotations: { title: "Get guide", readOnlyHint: true, openWorldHint: false },
      },
      async () => text(GUIDE)
    );
  }

  if (newTools && catalog) {
    server.registerTool(
      "find_paid_apis",
      {
        title: "Find paid APIs",
        description:
          "List the paid APIs in the facilitator's catalogue that `pay` can pay for: what each one does, its URL and method, and its price per call. Narrow it with `query` (words in the name, description or URL) or `type`. Read-only; creates no wallet and moves nothing.",
        inputSchema: {
          query: z.string().max(200).optional().describe('Words to look for, e.g. "indexer" or "completions"'),
          type: z.string().max(40).optional().describe('Resource type, e.g. "http"'),
        },
        annotations: { title: "Find paid APIs", readOnlyHint: true, openWorldHint: false },
      },
      async ({ query, type }) => {
        try {
          const entries = await catalog.get();
          if (entries === undefined) {
            return errText(
              "find_paid_apis: the catalogue could not be loaded from the facilitator; try again in a minute."
            );
          }
          const symbols = await instrumentSymbols?.get();
          return text(formatCatalog(entries, { query, type, symbols }));
        } catch (err) {
          return toolError("find_paid_apis", err);
        }
      }
    );
  }

  if (newTools) {
    server.registerTool(
      "swap_quote",
      {
        title: "Swap pools and free quotes",
        description:
          "Read-only and free: moves nothing, pays no fee, creates no wallet. With no arguments, lists the Tradecraft pools: each pair, its reserves and price, and whether `swap` can trade it. `in` alone shows only the pools with that token. With `in`, `out` and `amount`, quotes that swap on each venue `swap` would ask and names the venue it would use.",
        inputSchema: {
          in: z.string().max(20).optional().describe("Token to sell; alone, show only the pools with this token"),
          out: z.string().max(20).optional().describe("Token to buy"),
          amount: z.string().max(40).optional().describe('Amount of `in` to quote, e.g. "100"'),
        },
        annotations: { title: "Swap quote", readOnlyHint: true, openWorldHint: true },
      },
      async ({ in: inSym, out: outSym, amount }, extra) => {
        try {
          if (amount === undefined) {
            const capsSet = policy.maxPerTx !== undefined || policy.dailyCap !== undefined;
            return text(formatPools(await fetchPoolRows({ signal: extra.signal }), { in: inSym, out: outSym, capsSet }));
          }
          if (inSym === undefined || outSym === undefined) {
            return errText("swap_quote: a quote needs in, out and amount; without amount it lists the pools.");
          }
          if (!(toNum(amount) > 0)) {
            return errText(`swap_quote: amount must be a positive number (got ${JSON.stringify(amount)})`);
          }
          let intent;
          try {
            intent = resolveSwapIntent(inSym, outSym);
          } catch (err) {
            const why = (err instanceof Error ? err.message : String(err)).replace(/^swap: /, "");
            const unknownToken = /not a known instrument/.test(why);
            return errText(
              `swap_quote: ${why}` +
                (unknownToken ? " Without amount, swap_quote lists every Tradecraft pool, these tokens too." : "")
            );
          }
          const inputIsCC = intent.inInstrument === null;
          const outputIsCC = intent.outInstrument === null;
          const q = await quoteSwap({
            intent,
            amount,
            dsoParty: resolveTrustedDsoParty(process.env, deps.network),
            signal: extra.signal,
            // swap's own gate, on the figure swap would check: the amount for a
            // CC input, the venue's quote for token -> CC, none for token -> token.
            refusal: async (picked) => {
              // swap decides a token -> CC swap without a numeric quote on the
              // ticket it buys, so nothing can be said here yet.
              if (!inputIsCC && outputIsCC && !Number.isFinite(Number(picked.quote))) return undefined;
              try {
                assertSwapAllowed(policy, await ledger.read(Date.now()), {
                  ccValue: inputIsCC ? toNum(amount) : outputIsCC ? Number(picked.quote) : NaN,
                  inputIsCC,
                });
                return undefined;
              } catch (err) {
                if (err instanceof PolicyError) return err.message;
                throw err;
              }
            },
          });
          return q.ok ? text(q.text) : errText(q.text);
        } catch (err) {
          return toolError("swap_quote", err);
        }
      }
    );
  }

  if (history) {
    server.registerTool(
      "get_history",
      {
        title: "Get wallet history",
        description: `Return this wallet's latest money moves (pay, withdraw, swap, claim), newest first: time, kind, amount, result, the host paid or what the move was (pair, destination, why a swap was not done) and the updateId. At most ${HISTORY_MAX}. Read-only; the same history the owner sees on the account page.`,
        inputSchema: {
          limit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(`How many, newest first (default and most ${HISTORY_MAX})`),
        },
        annotations: { title: "Get history", readOnlyHint: true, openWorldHint: false },
      },
      async ({ limit }) => {
        try {
          return text(formatHistory(await history(Math.min(limit ?? HISTORY_MAX, HISTORY_MAX))));
        } catch (err) {
          return toolError("get_history", err);
        }
      }
    );
  }

  // ── inbound state-change (auto-ok: can only pull funds IN) ─────────────────
  server.registerTool(
    "claim",
    {
      title: "Claim incoming funding",
      description:
        "Accept all pending incoming transfers into this wallet (funds IN only — cannot send funds out). Run after the owner has sent CC. " +
          "It also takes back this wallet's own token offers that the receiver never took once they have expired (e.g. a token sell a swap venue left untaken).",
      inputSchema: {},
      annotations: { title: "Claim funding", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    // In the user's queue: two claims at once would each prepare and execute an
    // accept for the same pending transfers.
    async () => serialize(async () => {
      try {
        const w = await getWallet();
        const r = await claimAll(relayFor(w), w);
        // Then take back what this wallet SENT that the receiver never took and
        // can no longer take: until withdrawn, such an offer keeps its input
        // locked. The claims above stand whatever happens here.
        let reclaimLines: string[] = [];
        // A verify refusal is evidence about the relay, never a footnote: it
        // turns the answer into an error, as the same refusal does in claimAll.
        let reclaimRefused: Error | undefined;
        try {
          const rc = await reclaimExpiredOffers(relayFor(w), w);
          const what = (xs: Array<{ amount?: string; instrument: string }>) =>
            xs.map((x) => `${x.amount ?? "?"} ${x.instrument}`).join(", ");
          if (rc.reclaimed.length) {
            await recordOp({ kind: "claim", detail: `returned ${rc.reclaimed.length} expired offer(s): ${what(rc.reclaimed)}`, ok: true });
          }
          reclaimLines = [
            rc.reclaimed.length ? `took back ${rc.reclaimed.length} expired offer(s) the receiver never took: ${what(rc.reclaimed)}` : "",
            rc.waiting.length
              ? `${rc.waiting.length} offer(s) still waiting on the receiver: ${what(rc.waiting)} ` +
                `(until ${rc.waiting.map((x) => x.executeBefore ?? "?").join(", ")}; claim after that takes back any it does not take)`
              : "",
            rc.failed.length
              ? `${rc.failed.length} withdraw(s) failed: ${rc.failed.map((f) => `${f.cid.slice(0, 12)}… ${f.error}`).join("; ")}`
              : "",
            rc.skippedUntrusted.length
              ? `${rc.skippedUntrusted.length} expired offer(s) of an untrusted-registrar token left locked ` +
                `(${[...new Set(rc.skippedUntrusted.map((x) => x.admin))].join(", ")})`
              : "",
          ].filter(Boolean);
        } catch (err) {
          if (
            err instanceof PreparedTransferMismatchError ||
            err instanceof PreparedDecodeError ||
            err instanceof PreparedHashUnavailableError
          ) {
            reclaimRefused = err;
          } else {
            reclaimLines = [`taking back expired offers failed: ${err instanceof Error ? err.message : String(err)}`];
          }
        }
        // Raise the funded ceiling to the post-claim high-water (balance + what
        // has already gone out) so the agent may spend up to what was funded in.
        const bal = await relayFor(w).balance(w.party);
        const led = (await ledger.read(Date.now()));
        await ledger.recordClaimedHighWater(toNum(bal.cc) + led.lifetimeOutCC, Date.now());
        // Report every outcome, not only the claimed count: an agent that reads
        // "nothing to claim" while three offers sit expired and one failed has
        // been told something false. Expired ones are skipped by design (the
        // ledger refuses their accept); failed ones are named by cid.
        const extras = [
          r.skippedExpired ? `${r.skippedExpired} expired (skipped)` : "",
          r.skippedUntrusted.length
            ? `${r.skippedUntrusted.length} offer(s) of an untrusted-registrar token skipped (${[...new Set(r.skippedUntrusted.map((s) => s.admin))].join(", ")})`
            : "",
          r.failed.length
            ? `${r.failed.length} failed: ${r.failed.map((f) => `${f.cid.slice(0, 12)}… ${f.error}`).join("; ")}`
            : "",
          ...reclaimLines,
        ].filter(Boolean);
        const tail = extras.length ? ` — ${extras.join("; ")}` : "";
        if (r.claimed > 0) await recordOp({ kind: "claim", detail: `${r.claimed} incoming transfer(s)`, ok: true });
        if (reclaimRefused) {
          return errText(
            `claim: taking back an expired offer was REFUSED before signing: the relay returned a transaction that is not ` +
              `the withdraw asked for (${reclaimRefused.message}). Nothing was signed for it. Incoming: ` +
              (r.claimed > 0 ? `claimed ${r.claimed} transfer(s)` : "nothing to claim") +
              `; balance ${bal.cc} CC${tail}`
          );
        }
        if (r.claimed === 0 && r.failed.length > 0) {
          return errText(`claim: every attempted accept failed — nothing was claimed${tail}`);
        }
        return text(
          (r.claimed > 0
            ? `claimed ${r.claimed} transfer(s); balance now ${bal.cc} CC`
            : `nothing to claim; balance ${bal.cc} CC`) + tail
        );
      } catch (err) {
        return toolError("claim", err);
      }
    })
  );

  // ── money OUT (ask / cap) ─────────────────────────────────────────────────
  const payShape = {
    url: z.string().url().describe("The 402-gated URL to pay for"),
    method: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
      .optional()
      .describe("HTTP method (default GET); use POST for APIs that take a request body"),
    headers: z
      .record(z.string())
      .optional()
      .describe('Request headers, e.g. {"content-type":"application/json"}'),
    body: z
      .string()
      .optional()
      .describe("Raw request body for POST/PUT/PATCH (e.g. a JSON string)"),
  };
  // The two new params exist only with newTools. Without it the schema is
  // exactly 2.3.0's, and an unknown key is stripped before the handler runs.
  const payNewShape = {
    ...payShape,
    max_cc: z
      .number()
      .positive()
      .optional()
      .describe(
        "The most this pay call may spend, in CC. With it the call pays at most once: a seller that keeps answering 402 " +
          "is not paid again. It can only lower the owner's limits, never raise them."
      ),
    max_response_chars: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        `How many characters of the response body to return (default ${DEFAULT_RESPONSE_CHARS}, ` +
          `at most ${newTools?.maxResponseChars ?? DEFAULT_RESPONSE_CHARS}; a larger value is cut to that).`
      ),
  };
  // `asset` is its own switch (MCP_REMOTE_USDCX on the hosted server), apart
  // from newTools: with it off, the schema is what newTools alone gives.
  const payAssetShape = {
    asset: z
      .enum(["CC", "USDCx"])
      .optional()
      .describe(
        (newTools
          ? "Pay in this asset when the 402 offers several. Omit to pay in CC when the API offers it. "
          : "Pay in this asset when the 402 offers several. Omit to pay the first entry the API lists. ") +
          "USDCx has its own per-payment and daily caps, set by the owner."
      ),
  };
  /** What the queued part of pay hands back: the answer, when the call ends
   *  there (refused, cancelled, failed), or a settled payment whose response
   *  is still to be read. */
  type PayStep = ToolResult | { paid: { res: Response; head: string; updateId: string | undefined; moved: boolean } };

  /** The rest of a pay call, after the queue is released: the Lighthouse check
   *  and the merchant's body. The payment has settled by the time the headers
   *  arrive, so a merchant that trickles its body holds only this call, not
   *  every other pay, withdraw, swap and claim on the wallet. */
  const afterPay = async (step: PayStep, maxResponseChars: number | undefined): Promise<ToolResult> => {
    if (!("paid" in step)) return step;
    const { res, head, updateId, moved } = step.paid;
    const verify = updateId ? await lighthouseVerify(updateId) : null;
    const verifyLine = verify
      ? verify.ok
        ? ` verified (accepted/${verify.send})`
        : ` WARNING unverified (verdict=${verify.verdict ?? "?"}, send=${verify.send ?? "?"}) — check balance`
      : "";
    // Without newTools: today's fixed 4000 and no marker. With it: what the
    // agent asked for, clamped to the server's ceiling, and a cut is said.
    // Nothing past the ceiling is read, so a longer body is "more than" it.
    const readMax = newTools ? newTools.maxResponseChars : DEFAULT_RESPONSE_CHARS;
    const limit = newTools ? Math.min(maxResponseChars ?? DEFAULT_RESPONSE_CHARS, readMax) : DEFAULT_RESPONSE_CHARS;
    const body = await readBodyPrefix(res, readMax);
    const shown = body.text.slice(0, limit);
    const cut = !newTools
      ? ""
      : body.ended === "more"
        ? limit < readMax
          ? `\n[truncated: ${shown.length} of more than ${readMax}]`
          : `\n[truncated: ${shown.length} of more than ${readMax}, the most this server returns; paying again returns the same part]`
        : body.ended === "stopped"
          ? `\n[truncated: ${shown.length} shown; the rest of the body could not be read within ${BODY_READ_TIMEOUT_MS / 1000} s]`
          : body.text.length > shown.length
            ? `\n[truncated: ${shown.length} of ${body.text.length}]`
            : "";
    // An error the API answered after taking the payment: say what that means
    // for the next call, which is where an agent pays twice.
    const next =
      !newTools || !moved || res.status < 400 || res.status === 402
        ? ""
        : res.status < 500
          ? `\nThe API kept the payment and refused the request as sent (HTTP ${res.status}). ` +
            "Fix the request (the body above says what is wrong) before paying again: the same request pays again for the same answer."
          : `\nThe API kept the payment and failed (HTTP ${res.status}). Paying again pays again; tell the user before retrying.`;
    return text(
      `HTTP ${res.status}; ${head}` +
        (updateId ? `; updateId ${updateId}` : "") +
        verifyLine +
        `\n--- response body ---\n${shown}${cut}${next}`
    );
  };

  server.registerTool(
    "pay",
    {
      title: "Pay an x402-gated URL",
      description:
        "MOVES FUNDS OUT. Pay for an HTTP 402 / x402-gated resource and return its response. Supports GET and POST (pass method/headers/body to pay a POST API such as an LLM completions endpoint). Bounded by the spend policy (allowed domains, per-tx cap, daily cap, funded ceiling) set by the owner at startup. Calls the URL exactly once — do NOT wrap in a retry loop (the first payment can take ~60-90s; that is normal, not a failure).",
      inputSchema: {
        ...(newTools ? payNewShape : payShape),
        ...(deps.usdcx ? payAssetShape : {}),
      } as typeof payNewShape & typeof payAssetShape,
      annotations: { title: "Pay (moves funds OUT)", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ url, method, headers, body: reqBody, max_cc, max_response_chars, asset }, extra) => afterPay(await serialize(async (): Promise<PayStep> => {
      // A queued call runs only when the money moves before it are done, which
      // can take minutes. If the client stopped waiting meanwhile (an MCP client
      // gives up after about 60 s), the agent may already be retrying: paying
      // for this call too would pay twice for one answer nobody reads.
      if (extra.signal.aborted) {
        return errText("pay cancelled before paying: the client stopped waiting; nothing was paid. Call get_balance.");
      }
      // The spend ledger must be written from what the BALANCE did, not from
      // whether this call returned. A paying fetch can settle several real
      // payments and then throw — the client says so itself — and the
      // accounting used to sit after the fetch inside the same try, so a throw
      // skipped it entirely. `spentTodayCC` stayed 0, and --daily-cap, whose
      // only input is that counter, could never fire: a merchant that keeps
      // answering 402 after settling drains the wallet while the breaker reads
      // zero. Whatever happens, if the balance went down we owe the ledger an
      // entry.
      let w: Awaited<ReturnType<typeof getWallet>> | undefined;
      let before: number | undefined;
      let spent = 0;
      // Which of the owner's limits set the signer's ceiling, if one did.
      let capLimit: { which: string; field: "maxPerTx" | "dailyCap"; spentToday: number } | undefined;
      // Canton Coin is counted the same way as USDCx below: the larger of
      // what the balance shows gone and what the signer signed. A signed
      // transfer can be settled by anyone until its executeBefore, so a
      // merchant that answers first and settles a few seconds later is not in
      // the balance read right after the call, and without the signed amount
      // the daily cap and the funded ceiling would never see it.
      let movedCC = 0;
      let afterCC: number | undefined;
      let signedCC = 0;
      /** Signed CC the balance does not show (yet, or it could not be read). */
      const unseenCC = (): number => (signedCC - movedCC > 1e-10 ? signedCC - movedCC : 0);
      // Set only for asset "USDCx": the most the signer may sign in USDCx.
      let usdcxCeiling: number | undefined;
      // A USDCx payment is counted as the larger of what the balance shows
      // gone and what the signer signed in this call: a payment the
      // facilitator has not settled yet is not in the balance, and it is still
      // money the merchant can collect. When either balance read fails or is
      // incomplete, the whole ceiling the signer was given is counted, but
      // only when a payment may exist: something was signed, or the merchant
      // answered. A call that failed with nothing signed paid nothing (the
      // signer reports every signature it hands out), so it counts nothing.
      let beforeU: number | undefined;
      let afterU: number | undefined;
      let signedU = 0;
      let spentU = 0;
      const recordWhatLeft = async (responded: boolean): Promise<void> => {
        if (!w || before === undefined) return;
        try {
          afterCC = toNum((await relayFor(w).balance(w.party)).cc);
          movedCC = Math.max(0, before - afterCC);
        } catch {
          // The balance read itself failed: only what was signed is known.
        }
        spent = Math.max(movedCC, signedCC);
        try {
          if (spent > 0) await ledger.recordOutbound(spent, Date.now());
        } catch {
          // Throwing here would replace the caller's real error with ours.
        }
        if (usdcxCeiling === undefined) return;
        afterU = await readUsdcxHolding(relayFor(w), w.party);
        spentU =
          beforeU !== undefined && afterU !== undefined
            ? Math.max(0, beforeU - afterU, signedU)
            : signedU > 0 || responded
              ? Math.max(usdcxCeiling, signedU)
              : 0;
        try {
          if (spentU > 0) await ledger.recordOutboundUSDCx?.(spentU, Date.now());
        } catch {
          // As above: the caller's own error matters more than ours.
        }
      };
      /** The USDCx the balance shows gone, when both reads worked. */
      const usdcxMoved = (): number =>
        beforeU !== undefined && afterU !== undefined ? Math.max(0, beforeU - afterU) : 0;
      try {
        w = await getWallet();
        const led = await ledger.read(Date.now());
        // `asset` omitted (newTools): Canton Coin when the 402 offers it, else
        // its first entry; no consent to a token, no token cap. Taking the
        // first entry as such refused every API that lists a token before CC.
        // Without newTools, 2.3.0's path exactly: the first entry.
        let assetOpts: PayingFetchOpts = newTools ? { defaultAsset: "CC" } : {};
        if (asset === "USDCx" && max_cc !== undefined) {
          throw new PolicyError('max_cc caps Canton Coin; it cannot be combined with asset "USDCx", which has its own caps.');
        }
        if (asset === "USDCx" && !ledger.recordOutboundUSDCx) {
          throw new PolicyError("pay in USDCx is not available here: this server cannot count USDCx spending.");
        }
        // A USDCx payment spends no CC, so the CC budget's "already used up"
        // checks (daily cap, funded ceiling) do not apply to it; the payee
        // checks do. Its own budget is checked right after.
        const gatePolicy: SpendPolicy =
          asset === "USDCx" ? { ...policy, dailyCap: undefined, fundedCeiling: false } : policy;
        // Catalogue-only (the owner's choice, or --allow-domains catalog): the
        // URL must be a catalogue service, for CC and USDCx alike. The catalogue
        // is read only here, so every other wallet is untouched when it is down.
        // The request may not be redirected, so the URL that gets paid is the
        // URL that was checked; the init reaches the probe and the paid request
        // alike. D's gatePolicy keeps allowDomains and payScope; for USDCx it
        // only drops the CC day and the funded ceiling.
        const catalogOnly = isCatalogOnly(gatePolicy);
        assertPayAllowed(gatePolicy, led, url, catalogOnly ? await readCatalog() : undefined);
        assertNotRelay(url, w.relayUrl);
        if (asset === "USDCx") {
          usdcxCeiling = assertUsdcxPayAllowed(policy, led);
          assetOpts = {
            preferAsset: "USDCx",
            payableInstruments: [USDCX_INSTRUMENT_KEY],
            // Never passed for CC: a non-empty instrument map makes the signer
            // refuse Canton Coin when no CC ceiling is set.
            maxPaymentValueByInstrument: { [USDCX_INSTRUMENT_KEY]: capDecimal10(usdcxCeiling, policy.usdcxDailyCap) },
            // One signature per call: each re-pay would get the same ceiling,
            // and five of them could pass the daily USDCx cap in one call.
            maxPaymentRetries: 0,
          };
        } else if (asset === "CC") {
          assetOpts = { preferAsset: "CC" };
        }
        before = toNum((await relayFor(w).balance(w.party)).cc);
        if (usdcxCeiling !== undefined) beforeU = await readUsdcxHolding(relayFor(w), w.party);
        // THE PER-TX CAP HAS TO REACH THE ONE PLACE THAT KNOWS THE AMOUNT.
        //
        // `pay` cannot pre-check the charge the way `withdraw` does — the
        // amount only exists once the merchant answers 402. So --max-per-tx was
        // enforced on withdraw and silently ignored here, and the daily cap
        // only ever blocked STARTING a payment once already exhausted: a single
        // over-quoting merchant could take the whole wallet in one call and
        // still be inside policy. The signer already implements exactly this
        // ceiling (relay-signer enforceSpendLimits, fail-closed before any
        // relay call, and used by pay-proxy); it was simply never handed the
        // number. Same unit on both sides: CC, as the 402 quotes it.
        //
        // And not only the per-tx cap: the rest of today's budget and of the
        // funded ceiling too, whichever is smallest. The gate above can only
        // refuse a payment once the cap is ALREADY spent, so with 19.9 of 20 CC
        // spent a 5 CC payment used to go through and leave the day at 24.9.
        const policyCeiling = payValueCeiling(policy, led);
        // max_cc (newTools only) can lower the ceiling, never raise it.
        const ceiling =
          max_cc === undefined
            ? policyCeiling
            : policyCeiling === undefined
              ? max_cc
              : Math.min(policyCeiling, max_cc);
        // A refusal at this ceiling comes from the signer, not the policy, so
        // say here which of the owner's limits set it and where they raise it.
        // Not for max_cc (the agent's own cap), the funded ceiling (it rises by
        // claiming funds) or a USDCx payment (its caps are its own).
        if (ceiling !== undefined && ceiling === policyCeiling && usdcxCeiling === undefined && policy.limitsUrl) {
          const leftToday =
            policy.dailyCap === undefined ? undefined : Math.max(0, policy.dailyCap - led.spentTodayCC);
          if (ceiling === policy.maxPerTx) {
            capLimit = { which: `the per-payment limit of ${policy.maxPerTx} CC`, field: "maxPerTx", spentToday: led.spentTodayCC };
          } else if (ceiling === leftToday) {
            capLimit = {
              which: `what is left today of the daily limit of ${policy.dailyCap} CC`,
              field: "dailyCap",
              spentToday: led.spentTodayCC,
            };
          }
        }
        // The ceiling is checked on each signed payment, and a server that
        // re-pays a merchant still answering 402 could sign several in this
        // call. max_cc is the agent's cap on the CALL, so with it: no re-pays.
        const payingFetch = await payingFetchFor(w, {
          ...(ceiling === undefined
            ? {}
            : { maxPaymentValue: ceiling === policy.maxPerTx ? String(policy.maxPerTx) : decimal10(ceiling) }),
          ...(max_cc !== undefined ? { maxPaymentRetries: 0 } : {}),
          // Every pay counts what was signed, CC and USDCx alike.
          onSigned: (signed) => {
            if (signed.instrument === USDCX_INSTRUMENT_KEY) signedU += toNum(signed.amount);
            else if (signed.instrument.endsWith("|Amulet")) signedCC += toNum(signed.amount);
          },
          ...assetOpts,
        });
        let res;
        try {
          // newTools only: without it the request is exactly 2.3.0's.
          const sendHeaders = newTools ? withJsonContentType(headers, reqBody) : headers;
          res = await payingFetch(url, {
            ...(method ? { method } : {}),
            ...(sendHeaders ? { headers: sendHeaders } : {}),
            ...(reqBody !== undefined ? { body: reqBody } : {}),
            ...(catalogOnly ? { redirect: "error" as const } : {}),
          }); // EXACTLY ONCE — no outer retry (double-pay risk)
        } catch (payErr) {
          await recordWhatLeft(false);
          throw payErr;
        }
        await recordWhatLeft(true);
        const after = afterCC ?? before;
        const updateId = updateIdFromResponse(res);
        await recordOp({
          kind: "pay",
          ...(usdcxCeiling === undefined
            ? { amountCC: spent }
            : { asset: "USDCx", amount: spentU, ...(spent > 0 ? { amountCC: spent } : {}) }),
          detail: `${new URL(url).host} (HTTP ${res.status})`,
          updateId,
          ok: res.ok,
        });
        // CC that fell during a USDCx call (dust, a fee) counts against the CC
        // day, so the agent is told about it too.
        const alsoCC = spent > 0 ? `; also ${spent.toFixed(10)} CC` : "";
        const head =
          usdcxCeiling === undefined
            ? unseenCC() > 0
              ? `counted ${spent.toFixed(10)} CC; signed ${signedCC.toFixed(10)} CC that ` +
                `${afterCC === undefined ? "the balance could not be read to confirm" : "the balance does not show yet"}: ` +
                `the merchant can still collect it, so funds may still move. Do NOT call pay again for this request; ` +
                `balance ${afterCC === undefined ? "unknown" : `${afterCC.toFixed(10)} CC`}`
              : `spent ${spent.toFixed(10)} CC; balance ${after.toFixed(10)} CC`
            : beforeU !== undefined && afterU !== undefined
              ? `spent ${spentU.toFixed(10)} USDCx; balance ${afterU.toFixed(10)} USDCx${alsoCC}`
              : `counted ${spentU.toFixed(10)} USDCx, not necessarily spent (the USDCx balance could not be read, ` +
                `so the full ceiling was counted against today's USDCx cap); signed ${signedU.toFixed(10)} USDCx; ` +
                `balance ${afterU === undefined ? "unknown" : `${afterU.toFixed(10)} USDCx`}${alsoCC}`;
        // The Lighthouse check and the body: afterPay, once the queue is free.
        // "The API kept the payment" needs evidence it settled: the balance
        // fell, or the API sent a settlement (PAYMENT-RESPONSE). A transfer
        // signed but not seen is in `head` already ("may still be collected").
        const moved = movedCC > 0 || usdcxMoved() > 0 || (updateId !== undefined && updateId !== "");
        return { paid: { res, head, updateId, moved } };
      } catch (err) {
        // FUNDS MAY ALREADY HAVE MOVED, AND THE AGENT IS THE ONE WHO DECIDES
        // WHETHER TO RETRY.
        //
        // `recordWhatLeft` above measured the balance delta — it has to, or the
        // daily cap could never fire. But the number was then discarded here,
        // so "the merchant never got paid, retry" and "you paid and got
        // nothing, do NOT retry" reached the caller as the same sentence. A
        // human might check; an agent retries, and pays twice.
        //
        // Still `isError`: the call DID fail. Dressing it as success would be a
        // worse lie than the one this fixes.
        // The signer names the amount it refused; the link fills in the limit
        // that would have let it through.
        const refusal =
          capLimit && policy.limitsUrl && err instanceof Error
            ? /payment amount (\S+) exceeds the max payment value/.exec(err.message)
            : null;
        let base = toolError("pay", err);
        // Nothing was signed: the API asks for a token this wallet may not
        // spend. Say that in the agent's terms, not the signer's env var. Only
        // with newTools: there the default entry is CC whenever the 402 offers
        // it, so reaching this refusal means it does not; without it the first
        // entry was taken and CC may well have been offered.
        const token =
          newTools && err instanceof Error ? /not configured to spend \S+\|([A-Za-z0-9._-]+)\./.exec(err.message) : null;
        if (token) {
          base = errText(
            `pay: this API does not take CC; it asks for ${token[1]}.` +
              (deps.usdcx && token[1] === "USDCx" && asset !== "USDCx" ? ' Pass asset "USDCx" to pay in USDCx.' : " This wallet cannot pay it.") +
              " Nothing was paid."
          );
        }
        if (refusal && capLimit && policy.limitsUrl) {
          const amount = Number(refusal[1]);
          const need = capLimit.field === "maxPerTx" ? amount : capLimit.spentToday + amount;
          base = errText(
            `${base.content[0]!.text} The payment is capped at ${capLimit.which}; the owner can raise it on ` +
              `${limitsLink(policy.limitsUrl, capLimit.field, need)}.`
          );
        }
        if (usdcxCeiling === undefined) {
          if (spent > 0) {
            // The host only, like a successful payment: the query can carry keys.
            await recordOp({ kind: "pay", amountCC: spent, detail: `${new URL(url).host} (failed after paying)`, ok: false });
          }
        } else if (spentU > 0 || spent > 0) {
          await recordOp({
            kind: "pay",
            asset: "USDCx",
            amount: spentU,
            ...(spent > 0 ? { amountCC: spent } : {}),
            detail: `${new URL(url).host} (failed after paying)`,
            ok: false,
          });
        }
        const warns: string[] = [];
        if (movedCC > 0) {
          warns.push(
            `WARNING: the wallet balance fell by ${movedCC.toFixed(10)} CC during ` +
              `this call — funds MOVED. Do NOT call pay again for this request; ` +
              `confirm with get_balance and check whether the merchant delivered.`
          );
        }
        if (unseenCC() > 0) {
          // Whatever the error says (a 402 "rejected" included), a signed
          // transfer stays collectable until it expires.
          const unseen = afterCC === undefined ? "the balance could not be read" : "the balance does not show it yet";
          warns.push(
            `WARNING: a payment of ${signedCC.toFixed(10)} CC was signed during this call and ${unseen}; ` +
              `whatever the error below says, the merchant can still collect it, so funds may still move. ` +
              `Do NOT call pay again for this request; confirm with get_balance and check whether the merchant delivered.`
          );
        }
        const movedU = usdcxMoved();
        if (movedU > 0) {
          warns.push(
            `WARNING: the wallet's USDCx balance fell by ${movedU.toFixed(10)} USDCx during ` +
              `this call — funds MOVED. Do NOT call pay again for this request; ` +
              `confirm with get_balance and check whether the merchant delivered.`
          );
        } else if (signedU > 0) {
          // A signed transfer the balance does not show (yet, or because it
          // could not be read) is still money the merchant can collect.
          const usable = beforeU !== undefined && afterU !== undefined;
          const unseen = usable ? "the balance does not show it yet" : "the USDCx balance could not be read";
          warns.push(
            `WARNING: a payment of ${signedU.toFixed(10)} USDCx was signed during this call and ${unseen}; ` +
              `the merchant can still collect it, so funds MOVED. Do NOT call pay again for this request; ` +
              `confirm with get_balance and check whether the merchant delivered.` +
              (usable
                ? ""
                : ` ${spentU.toFixed(10)} USDCx (the full ceiling) was counted against today's USDCx cap, not necessarily spent.`)
          );
        }
        if (warns.length > 0) {
          return {
            ...base,
            content: [...warns.map((t) => ({ type: "text" as const, text: t })), ...base.content],
          };
        }
        return base;
      }
    }), max_response_chars)
  );

  /** As in pay, the queue holds the gate, the transfer and its record; the
   *  Lighthouse check runs after it is released. */
  const afterWithdraw = async (
    step: ToolResult | { sent: { to: string; amount: string; updateId: string; landed: boolean | null } }
  ): Promise<ToolResult> => {
    if (!("sent" in step)) return step;
    const { to, amount, updateId, landed } = step.sent;
    const verify = await lighthouseVerify(updateId);
    // Without a CC preapproval the receiver gets an offer, not the coins: an
    // agent told "withdrew" reports a delivery that may never happen.
    const how =
      landed === false
        ? ` It went as an offer: ${to} has no CC preapproval, so it reaches them only when they accept it in their wallet. ` +
          "Until then the CC is locked and not in this wallet's balance, and this wallet cannot take it back."
        : landed === null
          ? " (Whether it landed directly or waits for the receiver to accept could not be checked.)"
          : "";
    return text(
      `withdrew ${amount} CC to ${to}; updateId ${updateId}` +
        (verify ? (verify.ok ? ` (verified)` : ` (WARNING unverified: ${verify.verdict}/${verify.send})`) : "") +
        how
    );
  };

  /** A swap venue's own party: a plain send there is not a swap and can lose
   *  what it would buy (the venue delivers only to a wallet set up for it). */
  const isSwapVenue = (party: string): boolean =>
    party.startsWith("tc-swp_") || party === CANTEX_CONNECT_PARTY;

  server.registerTool(
    "withdraw",
    {
      title: "Withdraw CC to another party",
      description:
        "MOVES FUNDS OUT. Send CC from this wallet to another Canton party (CC only; tokens cannot be sent). Bounded by the spend policy. If a per-tx cap is set, an explicit amount is required (no silent full-balance sweep). A receiver without a CC preapproval gets an offer it must accept, and the CC stays locked until it does; the reply says so. Never send to a swap venue: use swap.",
      inputSchema: {
        to: z.string().describe("Recipient Canton party id"),
        amount: z.string().optional().describe("CC amount; omit to send the full balance (rejected if a per-tx cap is set)"),
      },
      annotations: { title: "Withdraw (moves funds OUT)", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ to, amount }, extra) => afterWithdraw(await serialize(async () => {
      // As in pay: a queued call whose client stopped waiting sends nothing.
      if (extra.signal.aborted) {
        return errText("withdraw cancelled before sending: the client stopped waiting; nothing was sent. Call get_balance.");
      }
      if (isSwapVenue(to.trim())) {
        return errText(
          "withdraw refused: that is a swap venue. Use swap: it sets up the delivery of what you buy, and a plain send to a venue can lose it. Nothing was sent."
        );
      }
      try {
        const w = await getWallet();
        // Resolve the effective amount up front so caps apply to the REAL number.
        let effective: number;
        if (amount && amount.trim()) {
          effective = toNum(amount);
        } else if (policy.maxPerTx !== undefined) {
          return errText(
            "withdraw blocked: a per-tx cap is set, so an explicit amount is required (refusing a full-balance sweep)."
          );
        } else {
          effective = toNum((await relayFor(w).balance(w.party)).cc);
        }
        assertWithdrawAllowed(policy, (await ledger.read(Date.now())), effective, to);
        const wopts: { to: string; amount?: string; apiKey?: string } = { to };
        const amt = amount?.trim();
        if (amt) wopts.amount = amt;
        if (apiKey) wopts.apiKey = apiKey;
        const r = await withdraw({ ...wopts, wallet: w, relay: relayFor(w) });
        await ledger.recordOutbound(toNum(r.amount), Date.now());
        await recordOp({ kind: "withdraw", amountCC: toNum(r.amount), detail: `to ${to}`, updateId: r.updateId, ok: true });
        return { sent: { to, amount: r.amount, updateId: r.updateId, landed: r.landed } };
      } catch (err) {
        return toolError("withdraw", err);
      }
    }))
  );

  server.registerTool(
    "swap",
    {
      title: "Swap CC and tokens on a venue",
      description:
        "MOVES FUNDS OUT to a swap venue and brings the counter-asset back. Swaps `amount` of `in` for `out` — Canton Coin (CC) or a known token (" +
        Object.keys(KNOWN_INSTRUMENTS).join(", ") +
        ") — on Cantex Connect (the default for a CC input; 50 CC minimum; fills at ITS rate when it executes, there is no on-ledger floor) or the Tradecraft AMM (venue `tradecraft`, the default for a token input; enforces the slippage floor when a memo key is configured), or `auto` (compares free quotes, takes the better output). " +
        "The input only ever goes to the pinned venue parties, never to an address from a quote. Bounded by the spend policy: a CC input is checked against the per-tx cap, daily cap and funded ceiling BEFORE anything moves; a token input against the per-tx cap, on the venue's quoted CC value, before any ticket fee. " +
        "The ticket normally comes from the x402 swap endpoint for a small CC fee (0.01 CC live, capped at " +
        SWAP_MAX_FEE_CC +
        "); `direct: true` quotes the venue itself for free. " +
        "Waits until the output lands (up to ~2 minutes; that is normal). Call it ONCE per swap — never retry on a timeout or error without checking get_balance first: the input may already have been sent.",
      inputSchema: {
        in: z.string().describe("Symbol to sell: CC or a known token (" + Object.keys(KNOWN_INSTRUMENTS).join(", ") + ")"),
        out: z.string().describe("Symbol to buy (same set)"),
        amount: z.string().describe('Amount of `in` to swap, as a decimal string, e.g. "60"'),
        venue: z
          .enum(["cantex", "tradecraft", "auto"])
          .optional()
          .describe(
            "Venue. Default: cantex for a CC input, tradecraft for a token input (Cantex has left token sells unaccepted). When NOT named, a CC input under 50 CC or a Cantex quote failure routes to tradecraft. Named explicitly, those are errors instead."
          ),
        slippage: z
          .number()
          .optional()
          .describe(
            "Slippage percent (default 1). Tradecraft: the on-ledger floor. Cantex: only the delivery threshold this tool reports against."
          ),
        direct: z
          .boolean()
          .optional()
          .describe("Quote the venue directly (free) instead of the x402 swap endpoint (small fee)"),
        wait: z
          .boolean()
          .optional()
          .describe(
            "Wait for the output to land (default true). false returns as soon as the input is sent; then call `claim` / get_balance later."
          ),
      },
      annotations: { title: "Swap (moves funds OUT)", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ in: inSym, out: outSym, amount, venue, slippage, direct, wait }, extra) => serialize(async () => {
      // As in pay: a queued call whose client stopped waiting sends nothing.
      if (extra.signal.aborted) {
        return errText("swap cancelled before swapping: the client stopped waiting; nothing was sent. Call get_balance.");
      }
      // Two things can leave the wallet here, at two different moments: the
      // ticket FEE (a real x402 payment to the swap endpoint, before any ticket
      // is validated) and the swap INPUT (sent to the venue). Both are gated
      // before they move and recorded right after, separately — a swap that
      // pays the fee and then fails to send still cost the fee, and the ledger
      // must say so.
      let w: AgentWallet | undefined;
      let ccBefore: number | undefined;
      let sentUpdateId: string | undefined;
      // CC this call has written to the spend ledger: the fee, then the input.
      let bookedCC = 0;
      try {
        w = await getWallet();
        const intent = resolveSwapIntent(inSym, outSym);
        const slippagePct = parseSlippagePct(slippage);
        const venueChoice = parseSwapVenue(venue);
        const amountNum = toNum(amount);
        if (!(amountNum > 0)) {
          return errText(`swap: amount must be a positive number (got ${JSON.stringify(amount)})`);
        }
        const inputIsCC = intent.inInstrument === null;
        const outputIsCC = intent.outInstrument === null;
        const inLabel = intent.inCanon;
        const outLabel = intent.outCanon;

        // POLICY, CC INPUT: the amount is known now, so the full gate runs here,
        // before the fee (itself a payment) and before any quote.
        if (inputIsCC) {
          assertSwapAllowed(policy, (await ledger.read(Date.now())), {
            ccValue: amountNum,
            inputIsCC: true,
          });
        }
        // WHAT THE WALLET CAN SPEND, BEFORE ANY QUOTE OR FEE: a swap it cannot
        // cover fails after the ticket fee is paid. Exact ledger decimals, as
        // the send compares them. A token counts from a complete read only (a
        // partial one gives lower bounds); a failed or unreadable read leaves
        // the check to the send, as before.
        if (!inputIsCC && intent.inInstrument) {
          const inst = intent.inInstrument;
          try {
            const h = await relayFor(w).holdings(w.party, inst, { slice: true });
            const rows = h.instruments.find((i) => i.admin === inst.admin && i.id === inst.id)?.holdings ?? [];
            const free = atomicOf(sumLedgerDecimals(rows.filter((x) => !x.locked).map((x) => x.amount)));
            const want = atomicOf(amount);
            if (h.complete && free !== undefined && want !== undefined && want > free) {
              const locked = atomicOf(sumLedgerDecimals(rows.filter((x) => x.locked).map((x) => x.amount))) ?? 0n;
              return errText(
                `swap: the wallet can spend ${decimalOf(free)} ${inLabel}, less than ${amount}` +
                  (locked > 0n ? ` (${decimalOf(locked)} more is locked, in an offer or an allocation)` : "") +
                  ". Nothing was paid."
              );
            }
          } catch {
            // The send checks the balance itself.
          }
        }
        // POLICY, TOKEN INPUT, BEFORE THE FEE: a ticket bought for a swap the
        // gate then refuses is a fee paid for nothing. With a cap set, a swap
        // with no CC leg is refused whatever it quotes, and token -> CC is
        // checked first against a free direct quote, held to swap_quote's
        // deadline so a hung venue cannot hold this wallet's queue. The bought
        // ticket's quote is checked again below; without a free quote, it
        // alone decides.
        const capsSet = policy.maxPerTx !== undefined || policy.dailyCap !== undefined;
        if (!inputIsCC && capsSet && direct !== true) {
          let ccValue = NaN;
          if (outputIsCC) {
            try {
              const free = await resolveSwapTicket({
                intent,
                amount,
                slippagePct,
                venue: venueChoice,
                venueExplicit: venue !== undefined,
                direct: true,
                dsoParty: resolveTrustedDsoParty(process.env, w.network),
                deps: timedQuoteDeps(extra.signal),
              });
              ccValue = Number(free.ticket.quote);
            } catch {
              // No free quote: the bought ticket's quote decides, as before.
            }
          }
          if (!outputIsCC || Number.isFinite(ccValue)) {
            assertSwapAllowed(policy, (await ledger.read(Date.now())), { ccValue, inputIsCC: false });
          }
        }
        // The checks above can take seconds: a client that stopped waiting
        // meanwhile may be retrying, so nothing is paid for it.
        if (extra.signal.aborted) {
          return errText("swap cancelled before buying a ticket: the client stopped waiting; nothing was paid. Call get_balance.");
        }
        const ccBeforeRaw = (await relayFor(w).balance(w.party)).cc;
        ccBefore = toNum(ccBeforeRaw);
        // A CC input the wallet cannot cover, with the live ticket fee when
        // one is bought (not with direct or auto), fails after the fee.
        if (inputIsCC) {
          const fee = direct === true || venueChoice === "auto" ? 0n : (atomicOf(SWAP_TICKET_FEE_CC) ?? 0n);
          const have = atomicOf(ccBeforeRaw);
          const want = atomicOf(amount);
          if (have !== undefined && want !== undefined && want + fee > have) {
            return errText(
              `swap: the wallet has ${decimalOf(have)} CC, less than ${amount} CC` +
                (fee > 0n ? ` plus the ${SWAP_TICKET_FEE_CC} CC ticket fee` : "") +
                `. Swap at most ${decimalOf(have - fee)} CC. Nothing was paid.`
            );
          }
        }

        // The fee ceiling never exceeds the per-tx cap: the endpoint auto-settles
        // whatever 402 it answers, and the signer's maxPaymentValue is the only
        // thing standing between a hijacked endpoint and the balance.
        const feeCap =
          policy.maxPerTx !== undefined && policy.maxPerTx < Number(SWAP_MAX_FEE_CC)
            ? String(policy.maxPerTx)
            : SWAP_MAX_FEE_CC;
        const swapMerchant = process.env.CANTON_AGENT_SWAP_MERCHANT;
        const wallet = w;
        const { ticket, notes } = await resolveSwapTicket({
          intent,
          amount,
          slippagePct,
          venue: venueChoice,
          venueExplicit: venue !== undefined,
          direct: direct === true,
          dsoParty: resolveTrustedDsoParty(process.env, wallet.network),
          payingFetch: () =>
            payingFetchFor(wallet, {
              maxPaymentValue: feeCap,
              ...(swapMerchant ? { expectedPayTo: swapMerchant } : {}),
            }),
        });
        // Whatever the quote cost is already gone: record it now, not after the
        // send, so a swap that fails between here and the send still books it.
        const ccAfterTicket = toNum((await relayFor(w).balance(w.party)).cc);
        const fee = Math.max(0, ccBefore - ccAfterTicket);
        if (fee > 0) {
          await ledger.recordOutbound(fee, Date.now());
          bookedCC += fee;
        }

        // POLICY, TOKEN INPUT: the CC figure only exists once the venue has
        // quoted. NaN when neither leg is CC — the gate decides what that means.
        if (!inputIsCC) {
          assertSwapAllowed(policy, (await ledger.read(Date.now())), {
            ccValue: outputIsCC ? Number(ticket.quote) : NaN,
            inputIsCC: false,
          });
        }

        const waiting = wait !== false;
        const sr = await executeSwap({
          amount,
          ticket,
          apiKey,
          waitForOutput: waiting,
          wallet: w,
          relay: relayFor(w),
        });
        sentUpdateId = sr.sentUpdateId;
        if (inputIsCC) {
          await ledger.recordOutbound(amountNum, Date.now());
          bookedCC += amountNum;
        }

        const bal = toNum((await relayFor(w).balance(w.party)).cc);
        // A CC input the venue would not fill (Tradecraft, below its minimum)
        // comes BACK as CC — directly, when this wallet holds a CC preapproval.
        // executeSwap watches for that from its second tick; the end-balance
        // check here also catches a return that landed after the window (or a
        // first-tick return the loop deliberately does not trust). Seen live on
        // MainNet: 0.2 CC to the CC/USDCx pool, back within the window.
        const inputReturned =
          sr.inputReturned ||
          (inputIsCC &&
            sr.delivered === undefined &&
            bal >= ccAfterTicket - amountNum + amountNum * 0.99);
        if ((outputIsCC && sr.delivered !== undefined) || inputReturned) {
          // CC came IN — the venue's output, or the input handed back. Funding
          // for the ceiling's purposes: the same high-water `claim` sets. The
          // outbound entry stays (it did leave); the daily counter keeps it,
          // conservatively.
          const led = (await ledger.read(Date.now()));
          await ledger.recordClaimedHighWater(bal + led.lifetimeOutCC, Date.now());
        }

        const lines: string[] = [];
        lines.push(
          `swap ${amount} ${inLabel} -> ${outLabel} on ${ticket.venue}: input sent, updateId ${sr.sentUpdateId}`
        );
        if (!waiting) {
          lines.push(
            `not waiting for the return — call \`claim\` shortly (or check get_balance) to pick up the ${outLabel}`
          );
        } else if (sr.delivered !== undefined) {
          lines.push(`received ${sr.delivered} ${outLabel}`);
        } else if (inputReturned) {
          lines.push(
            `the input was RETURNED — nothing was swapped: the CC balance is back at ${bal.toFixed(10)} CC ` +
              `(the venue hands back a trade it will not fill, e.g. below its minimum). ` +
              `Only the ticket fee was spent.`
          );
        } else {
          lines.push(
            `${outLabel} NOT received yet. It may still settle (check get_balance in a minute). ` +
              `Do NOT swap again before checking.` +
              (!inputIsCC
                ? ` The ${inLabel} went to the venue as an offer: if the venue does not take it, it stays locked in that ` +
                  `offer until the offer expires (about 10 minutes after sending), and \`claim\` after that takes it back.`
                : ticket.venue === "tradecraft"
                  ? ` The CC went to the pool as an offer: if the pool does not take it, it stays locked until the offer ` +
                    `expires (about 10 minutes after sending), and then the network hands it back by itself.`
                  : "") +
              (sr.partialRise !== undefined
                ? ` ${outLabel} balance rose ${sr.partialRise}, below the ticket minimum ${ticket.minOutput} — possibly an unrelated inbound, not this swap's fill.`
                : "") +
              (sr.claimed > 0
                ? ` Claimed ${sr.claimed} incoming transfer(s): ${sr.claimedUpdateIds.join(", ")}.`
                : "") +
              (sr.pollErrors > 0
                ? ` ${sr.pollErrors} poll error(s) while waiting — the relay was flaky, but the input WAS sent.`
                : "")
          );
        }
        lines.push(`quote ~${ticket.quote} ${outLabel} (venue party ${ticket.poolParty})`);
        for (const n of [...notes, ...swapFloorNotes(ticket, slippagePct, outLabel, direct !== true && venueChoice !== "auto")]) {
          lines.push(n.level === "warn" ? `! ${n.text}` : n.text);
        }
        lines.push(
          fee > 0 ? `ticket fee ${fee.toFixed(10)} CC (swap endpoint)` : "ticket fee 0 CC"
        );
        lines.push(`balance now ${bal.toFixed(10)} CC`);
        await recordOp({
          kind: "swap",
          ...(inputIsCC ? { amountCC: amountNum } : {}),
          detail: `${amount} ${inLabel} -> ${outLabel} on ${ticket.venue}`,
          updateId: sr.sentUpdateId,
          ok: true,
        });
        return text(lines.join("\n"));
      } catch (err) {
        // The agent decides whether to retry, so it must know what already
        // moved. Once the input is sent nothing here throws (executeSwap's wait
        // is best-effort), so an error with `sentUpdateId` set is rare — but a
        // lost relay response on the send itself can still leave funds moved
        // with no updateId in hand; the balance delta is the honest tell.
        const base = toolError("swap", err);
        let warn = "";
        let dropped = 0;
        if (sentUpdateId) {
          warn =
            `WARNING: the swap input WAS sent (updateId ${sentUpdateId}) before this error. ` +
            `Do NOT call swap again for it; call \`claim\` and get_balance to see what arrived.`;
        } else if (w && ccBefore !== undefined) {
          try {
            const now = toNum((await relayFor(w).balance(w.party)).cc);
            dropped = Math.max(0, ccBefore - now);
            if (dropped > 0) {
              warn =
                `WARNING: the wallet's CC balance fell by ${dropped.toFixed(10)} CC during this call — ` +
                `funds MOVED (the ticket fee, or the swap input). Check get_balance and \`claim\` before calling swap again.`;
            }
          } catch {
            // A failed balance read is no reason to hide the real error.
          }
        }
        // What left the wallet in this call and is not in the spend ledger yet
        // (a fee paid before the ticket failed, an input sent whose updateId
        // was lost) is booked now, or the daily cap and the funded ceiling
        // would never see it.
        if (!sentUpdateId && dropped - bookedCC > 1e-10) {
          try {
            await ledger.recordOutbound(dropped - bookedCC, Date.now());
          } catch {
            // The agent's error matters more than the bookkeeping's.
          }
        }
        // The owner's history shows a swap that did not go through as well,
        // with what the call cost, not only the ones that did.
        if (!sentUpdateId) {
          await recordOp({
            kind: "swap",
            ...(dropped > 0 ? { amountCC: dropped } : {}),
            detail: `${amount} ${inSym} -> ${outSym} not done: ${swapFailureText(err)}`,
            ok: false,
          });
        }
        return warn
          ? { ...base, content: [{ type: "text" as const, text: warn }, ...base.content] }
          : base;
      }
    })
  );

  // ── Tradecraft queued mode ────────────────────────────────────────────────
  if (deps.tradecraftQueued === true) registerTradecraftQueuedTools();
  function registerTradecraftQueuedTools(): void {
  // Committed allocations + batched orders (agent-wallet tradecraft-queued.ts),
  // the alternative to a pool-address swap. Funding an allocation is where
  // funds leave the spendable wallet, so that is where the spend policy runs.
  const tcCtx = (w: AgentWallet): TcContext => ({ relay: relayFor(w), wallet: w });
  const pairSchema = z
    .string()
    .describe('The pool as two symbols, e.g. "CC/CBTC" (CC or a known token: ' + Object.keys(KNOWN_INSTRUMENTS).join(", ") + ")");
  const splitPair = (pair: string): [string, string] => {
    const p = pair.split("/").map((x) => x.trim());
    if (p.length !== 2 || !p[0] || !p[1]) throw new Error(`pair must look like "CC/CBTC" (got ${JSON.stringify(pair)})`);
    return [p[0], p[1]];
  };
  /** The pool's own spelling of `sym` (CC also answers to amulet/canton-coin). */
  const poolSymbol = (instruments: Record<string, unknown>, sym: string): string | undefined => {
    const t = sym.trim().toLowerCase();
    return Object.keys(instruments).find(
      (s) => s.toLowerCase() === t || (s === "CC" && (t === "amulet" || t === "canton-coin"))
    );
  };

  server.registerTool(
    "tradecraft_queued_setup",
    {
      title: "Set up Tradecraft queued trading on a pool",
      description:
        "LOCKS FUNDS for trading on the Tradecraft AMM in queued mode (the alternative to `swap`). Creates, once per pool, an order batcher and one committed allocation per pool instrument. " +
        "`fund` puts that much of an instrument into its allocation — the one you intend to SELL; the other starts empty and receives the proceeds. " +
        "Funded allocations stay yours but only the Tradecraft venue can settle or release them; get funds back with tradecraft_queued_withdraw (whole allocation, asynchronous). " +
        "Idempotent: existing allocations are kept, and `fund` on an existing one tops it up. Funding is checked against the spend policy before anything moves.",
      inputSchema: {
        pair: pairSchema,
        fund: z
          .record(z.string(), z.string())
          .optional()
          .describe('Amount to lock per symbol, e.g. {"CC": "20"}. Omit to create empty allocations only.'),
      },
      annotations: { title: "Tradecraft setup (locks funds)", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ pair, fund }) => serialize(async () => {
      try {
        const w = await getWallet();
        const ctx = tcCtx(w);
        const [a, b] = splitPair(pair);
        const pool = await loadTcPool(ctx, a, b);
        const canonFund: Record<string, string> = {};
        for (const [sym, amt] of Object.entries(fund ?? {})) {
          const canon = poolSymbol(pool.instruments, sym);
          if (!canon) return errText(`tradecraft_queued_setup: ${sym} is not an instrument of ${pool.ammId}`);
          canonFund[canon] = amt;
        }
        // POLICY: what leaves the spendable wallet. CC at face value; a token at
        // the venue's quoted CC value, exactly as `swap` gates a token input.
        let ccOut = 0;
        for (const [sym, amt] of Object.entries(canonFund)) {
          const n = toNum(amt);
          if (!(n > 0)) return errText(`tradecraft_queued_setup: fund ${sym} must be a positive amount (got ${JSON.stringify(amt)})`);
          const isCC = sym === "CC";
          const ccValue = isCC ? n : await tcQuote(ctx, sym, "CC", amt).catch(() => Number.NaN);
          assertSwapAllowed(policy, await ledger.read(Date.now()), { ccValue, inputIsCC: isCC });
          if (isCC) ccOut += n;
        }
        const r = await tcSetup(ctx, pool, canonFund);
        if (ccOut > 0) await ledger.recordOutbound(ccOut, Date.now());
        for (const [sym, amt] of Object.entries(canonFund)) {
          await recordOp({
            kind: "swap",
            ...(sym === "CC" ? { amountCC: toNum(amt) } : { asset: sym, amount: toNum(amt) }),
            detail: `lock ${amt} ${sym} in a Tradecraft allocation (${pool.ammId})`,
            ok: true,
          });
        }
        const lines = [`pool ${pool.ammId}`, `batcher: ${r.batcher.created ? "created" : "exists"}`];
        for (const [sym, al] of Object.entries(r.allocations)) {
          lines.push(`${sym} allocation: ${al.created ? "created" : al.toppedUp ? "topped up" : "exists"}, funding ${al.funding}`);
        }
        return text(lines.join("\n"));
      } catch (err) {
        return toolError("tradecraft_queued_setup", err);
      }
    })
  );

  server.registerTool(
    "tradecraft_queued_orders",
    {
      title: "Queue Tradecraft orders",
      description:
        "Trades funds already locked in a Tradecraft allocation (see tradecraft_queued_setup): queues exact-input orders selling `sell` on the pool, all in one transaction. " +
        "Each order gets a minimum output of its live quote (after the orders before it) less `slippage`; an order that cannot meet it is cancelled by the venue and its input stays in the allocation. " +
        "Nothing leaves the wallet here; proceeds land in the other allocation within seconds — check with tradecraft_queued_status. Call it ONCE per batch; never retry without checking status first.",
      inputSchema: {
        pair: pairSchema,
        sell: z.string().describe("Symbol every order sells (one of the pair)"),
        amounts: z.array(z.string()).min(1).max(50).describe('Per-order input amounts, e.g. ["6","6"]'),
        slippage: z.number().optional().describe("Slippage percent for each order's minimum (default 1)"),
      },
      annotations: { title: "Tradecraft orders (trades locked funds)", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ pair, sell, amounts, slippage }) => serialize(async () => {
      try {
        const w = await getWallet();
        const ctx = tcCtx(w);
        const [a, b] = splitPair(pair);
        const pool = await loadTcPool(ctx, a, b);
        const sellCanon = poolSymbol(pool.instruments, sell);
        if (!sellCanon) return errText(`tradecraft_queued_orders: ${sell} is not an instrument of ${pool.ammId}`);
        const r = await tcOrders(ctx, pool, sellCanon, amounts, parseSlippagePct(slippage));
        await recordOp({
          kind: "swap",
          detail: `queued ${r.orders.length} order(s) selling ${amounts.join("+")} ${sellCanon} on ${pool.ammId}`,
          updateId: r.updateId,
          ok: true,
        });
        const lines = [`queued ${r.orders.length} order(s) on ${pool.ammId} (updateId ${r.updateId})`];
        for (const o of r.orders) lines.push(`sell ${o.amount} ${sellCanon}: quote ${o.quote}, minimum ${o.minOut}`);
        lines.push("proceeds settle into your allocation; check tradecraft_queued_status");
        return text(lines.join("\n"));
      } catch (err) {
        return toolError("tradecraft_queued_orders", err);
      }
    })
  );

  server.registerTool(
    "tradecraft_queued_status",
    {
      title: "Tradecraft queued status",
      description: "Reads your Tradecraft queued-mode state on a pool: the batcher, each allocation's available funding, how many orders are still open, and how many filled orders wait for their settlement. Moves nothing.",
      inputSchema: { pair: pairSchema },
      annotations: { title: "Tradecraft status", readOnlyHint: true, openWorldHint: true },
    },
    async ({ pair }) => {
      try {
        const w = await getWallet();
        const ctx = tcCtx(w);
        const [a, b] = splitPair(pair);
        const pool = await loadTcPool(ctx, a, b);
        const st = await tcStatus(ctx, pool);
        const lines = [`pool ${st.ammId}`, `batcher: ${st.batcher ? "yes" : "none (run tradecraft_queued_setup)"}`];
        for (const sym of Object.keys(pool.instruments)) {
          lines.push(`${sym} allocation: ${st.allocations[sym] ? st.allocations[sym].funding : "none"}`);
        }
        lines.push(`open orders: ${st.openOrders}`);
        lines.push(
          st.awaitingSettlement !== undefined
            ? `filled, awaiting settlement: ${st.awaitingSettlement}${st.awaitingSettlement > 0 ? " (tradecraft_queued_fills shows which)" : ""}`
            : `filled, awaiting settlement: unknown (${st.fillsError ?? "the relay cannot read the history"})`
        );
        return text(lines.join("\n"));
      } catch (err) {
        return toolError("tradecraft_queued_status", err);
      }
    }
  );

  server.registerTool(
    "tradecraft_queued_fills",
    {
      title: "Tradecraft fills and settlements",
      description:
        "Lists your Tradecraft queued orders on a pool and what became of them: open, filled, cancelled with the venue's reason, withdrawn or expired, plus your withdrawal requests. A filled order shows what its settlement paid out, or that the settlement is still pending: the venue fills first and moves the funds later, sometimes hours later. Shows open orders and pending fills in full and the 20 latest others. Moves nothing.",
      inputSchema: { pair: pairSchema },
      annotations: { title: "Tradecraft fills", readOnlyHint: true, openWorldHint: true },
    },
    async ({ pair }) => {
      try {
        const w = await getWallet();
        const ctx = tcCtx(w);
        const [a, b] = splitPair(pair);
        const pool = await loadTcPool(ctx, a, b);
        return text(formatTcFills(await tcFills(ctx, pool), { fullIds: true }).join("\n"));
      } catch (err) {
        return toolError("tradecraft_queued_fills", err);
      }
    }
  );

  server.registerTool(
    "tradecraft_queued_cancel",
    {
      title: "Cancel pending Tradecraft orders",
      description:
        "Abandons your still-pending Tradecraft queued orders on the pool (all, or one by `order`). A pending order has moved nothing, so its input simply stays in the allocation. Orders usually fill within seconds; one already filled or cancelled by the venue is reported as such. Moves nothing out of the wallet.",
      inputSchema: {
        pair: pairSchema,
        order: z.string().optional().describe("The order's contract id; omit to cancel every open order on the pool"),
      },
      annotations: { title: "Tradecraft cancel", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ pair, order }) => serialize(async () => {
      try {
        const w = await getWallet();
        const ctx = tcCtx(w);
        const [a, b] = splitPair(pair);
        const pool = await loadTcPool(ctx, a, b);
        const r = await tcCancel(ctx, pool, order);
        if (r.length === 0) return text(`no open orders on ${pool.ammId}`);
        return text(
          r.map((c) => (c.gone ? `order ${c.orderCid}: already filled or cancelled by the venue` : `order ${c.orderCid}: cancelled (updateId ${c.updateId})`)).join("\n")
        );
      } catch (err) {
        return toolError("tradecraft_queued_cancel", err);
      }
    })
  );

  server.registerTool(
    "tradecraft_queued_withdraw",
    {
      title: "Release a Tradecraft allocation",
      description:
        "Asks the Tradecraft venue to release your allocation of `instrument` on the pool back to your wallet — the whole allocation, asynchronously (usually within a minute). " +
        "The venue refuses while one of your fills is still settling (ask again a little later) and releases only a funded allocation — an empty one stays and is reused. Check with get_balance / tradecraft_queued_status.",
      inputSchema: {
        pair: pairSchema,
        instrument: z.string().describe("Symbol of the allocation to release (one of the pair)"),
      },
      annotations: { title: "Tradecraft withdraw", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ pair, instrument }) => serialize(async () => {
      try {
        const w = await getWallet();
        const ctx = tcCtx(w);
        const [a, b] = splitPair(pair);
        const pool = await loadTcPool(ctx, a, b);
        const sym = poolSymbol(pool.instruments, instrument);
        if (!sym) return errText(`tradecraft_queued_withdraw: ${instrument} is not an instrument of ${pool.ammId}`);
        const id = await tcWithdraw(ctx, pool, sym);
        await recordOp({ kind: "claim", detail: `release ${sym} Tradecraft allocation (${pool.ammId})`, updateId: id, ok: true });
        return text(`withdrawal of the ${sym} allocation on ${pool.ammId} requested (updateId ${id}); the venue releases it to your wallet shortly`);
      } catch (err) {
        return toolError("tradecraft_queued_withdraw", err);
      }
    })
  );

  }

  // ── to the team (hosted) ──────────────────────────────────────────────────
  if (feedback) {
    server.registerTool(
      "send_feedback",
      {
        title: "Send feedback to the wallet team",
        description:
          `Tell the team that runs this wallet about a bug, something confusing, or an idea, in plain words (at most ${FEEDBACK_MAX_CHARS} characters, ${FEEDBACK_PER_DAY} a day). People read it. Never include private keys, recovery codes, passwords, tokens or personal data. Moves nothing; no reply comes back through this tool.`,
        inputSchema: {
          kind: z.enum(FEEDBACK_KINDS).describe("bug, confusing or idea"),
          text: z.string().trim().min(1).max(FEEDBACK_MAX_CHARS).describe("What happened or what you suggest"),
        },
        annotations: { title: "Send feedback", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      async ({ kind, text: body }) => {
        try {
          if ((await feedback.countToday()) >= FEEDBACK_PER_DAY) {
            return errText(`send_feedback: the limit of ${FEEDBACK_PER_DAY} a day is reached; try again tomorrow.`);
          }
          await feedback.add(kind, body);
          return text("Sent. The team reads every message; nothing else happened.");
        } catch (err) {
          return toolError("send_feedback", err);
        }
      }
    );
  }
}
