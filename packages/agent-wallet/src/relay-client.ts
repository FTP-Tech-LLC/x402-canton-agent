/**
 * HTTP client for the facilitator's agent-wallet relay. The agent talks ONLY to
 * this — plain HTTP, no Canton auth. The relay bridges to the participant using
 * the validator token (onboarding + interactive submission) and proxies the
 * public Scan registry resolves (the agent has no Scan access).
 */
import { connectionNeverEstablished } from "@ftptech/x402-canton-core";
import type { ReadProofParts } from "./keys.js";

export interface RelayPublicKey {
  format: string;
  keyData: string;
  keySpec: string;
}
export interface RelaySignature {
  format: string;
  signature: string;
  signingAlgorithmSpec: string;
  signedBy: string;
}
export interface OnboardPrepareResult {
  party: string;
  publicKeyFingerprint: string;
  onboardingTransactions: string[];
  hashToSign: string;
}
export interface HoldingsResult {
  party: string;
  /** False when the relay answered a BOUNDED read (`slice`) that may not list
   *  every holding of the class asked for (one instrument, the registry tokens,
   *  or everything): totals are then lower bounds, not balances. A current relay
   *  narrows the read to that class, so Canton Coin dust no longer makes a
   *  token read incomplete; an older one answers for the wallet as a whole.
   *  True for a complete read (and for a relay that predates slicing, which
   *  only ever answers complete or 413). Always a boolean here: holdings()
   *  normalizes it, so callers test it as is. */
  complete: boolean;
  instruments: Array<{
    admin: string;
    id: string;
    /** Ledger Decimal string, 10 places. */
    total: string;
    holdings: Array<{ cid: string; amount: string; locked: boolean }>;
  }>;
}
export interface ResolveAllocationFactoryResult {
  factoryId: string;
  choiceContextData: unknown;
  disclosedContracts: unknown[];
}
export interface ContractsResult {
  party: string;
  complete: boolean;
  contracts: Array<{
    contractId: string;
    templateId: string;
    signatories: string[];
    createArgument: Record<string, unknown>;
    interfaceViews?: Array<{ interfaceId: string; viewValue: Record<string, unknown> }>;
  }>;
}
/** One transaction of a party's Tradecraft history, reduced by the relay to the
 *  party's own orders, settlement legs and withdrawal requests. */
export interface TradecraftUpdate {
  offset: number;
  updateId: string;
  recordTime?: string;
  orders: Array<{
    /** `archived`: closed by a choice the relay does not interpret (see `choice`). */
    kind: "created" | "filled" | "cancelled" | "withdrawn" | "expired" | "archived";
    orderCid: string;
    choice?: string;
    ammId?: string;
    sell?: { instrument: { admin: string; id: string }; amount: string };
    minOut?: string | null;
    createdAt?: string;
    reason?: string;
  }>;
  allocations: Array<{
    allocationCid: string;
    previousAllocationCid?: string;
    ammId: string;
    instrument: { admin: string; id: string };
    fundingAfter: Record<string, string>;
    legs: Array<{ side: "receive" | "send"; amount: string; instrumentId: string; counterparty?: string }>;
  }>;
  withdrawals: Array<{
    kind: "requested" | "fulfilled" | "rejected" | "cancelled" | "archived";
    requestCid: string;
    choice?: string;
    ammId?: string;
    instrument?: { admin: string; id: string };
    reason?: unknown;
  }>;
  /** The party's records in this transaction the relay could not read. */
  anomalies?: Array<{ ammId?: string; detail: string }>;
}
export interface TradecraftUpdatesResult {
  party: string;
  /** Which participant the offsets belong to; restart from 0 when it changes. */
  participant?: string;
  /** False when the relay does not read withdrawal requests. */
  withdrawalsRead?: boolean;
  after: number;
  /** Pass back as `after` to continue. */
  next: number;
  ledgerEnd: number;
  /** True when this page reached the ledger end the relay read against. */
  complete: boolean;
  updates: TradecraftUpdate[];
}
export interface BalanceResult {
  party: string;
  amulet: number;
  cc: string;
  holdings: Array<{ cid: string; amount: string }>;
}
/** Amulet holdings enumerated from the PUBLIC SV Scan ACS snapshot (paginated,
 *  no participant node cap). The WHALE path for `merge`: used when /balance 413s
 *  (holdings_exceed_node_limit). `recordTime` is the snapshot time — it LAGS the
 *  ledger by hours, which is fine for merge (an idle wallet's amulets don't move
 *  and each cid is consumed at most once). `complete` is false when the relay
 *  page-capped and the list is only a prefix. */
export interface HoldingsScanResult {
  party: string;
  source: string;
  recordTime: string;
  holdings: Array<{ cid: string; amount: string }>;
  complete: boolean;
}
export interface ResolveFactoryResult {
  factoryId: string;
  transferKind: string;
  transferFactoryTemplateId: string;
  instrumentId: { admin: string; id: string };
  choiceContextData: unknown;
  disclosedContracts: unknown[];
}
export interface ResolveAcceptResult {
  choiceContextData: unknown;
  disclosedContracts: unknown[];
}
export interface PendingResult {
  party: string;
  pending: Array<{
    cid: string;
    amount?: string;
    sender?: string;
    /** Set for a registry (CIP-56) instruction; absent on older relays / Amulet. */
    instrumentId?: { admin: string; id: string };
    /** ISO instant after which the ledger refuses the accept; absent on older relays. */
    executeBefore?: string;
  }>;
}
/** The party's own pending registry offers — what it SENT that the receiver has
 *  not taken — for reclaim (`GET /v1/wallet/:party/outgoing`). */
export interface OutgoingResult {
  party: string;
  outgoing: Array<{
    cid: string;
    amount?: string;
    receiver?: string;
    instrumentId: { admin: string; id: string };
    /** ISO instant after which the receiver can no longer accept. */
    executeBefore?: string;
    /** The instruction's status tag, e.g. TransferPendingReceiverAcceptance. */
    status?: string;
  }>;
}
/** The Amulet OUTPUT holdings a transfer transaction created for the party, read
 *  off that transaction by updateId (whale-merge output discovery). Each entry is
 *  an Amulet contract OWNED BY the party the tx produced (the self-transfer's
 *  change/output amulets). The merge chain phase feeds these back in as the next
 *  round's inputs, so convergence never waits on the daily Scan snapshot. */
export interface TxAmuletsResult {
  party: string;
  updateId: string;
  amulets: Array<{ cid: string; amount: string }>;
}

/**
 * A non-2xx relay response. Carries the HTTP `status` and the PARSED JSON `body`
 * (when the body was JSON) alongside the human-readable message, so callers can
 * branch on a discriminated relay error WITHOUT regexing the message string. The
 * `merge` path relies on this to recognize a /balance 413
 * `{code:"holdings_exceed_node_limit"}` and fall back to the Scan-snapshot
 * enumeration. The message format is unchanged from the previous plain Error
 * (`relay <METHOD> <path> -> <status> <body-snippet>`), so existing message
 * assertions keep passing.
 */
/**
 * Plain-language translation of the participant failures a payer would otherwise
 * misread as "the facilitator rejected my payment".
 *
 * The motivating outage: a merchant's `TransferPreapproval` lapsed, so every
 * `TransferFactory_Transfer` to them failed deep inside interpretation with
 * `deadline-exceeded`. What reached the payer was a bare HTTP 400 whose body was
 * truncated before the deadline name and timestamp, so three different agents
 * concluded the RELAY was broken and went hunting through allowlists, balances
 * and wallets — none of which was the cause, and none of which they could fix,
 * because the expired preapproval belongs to the RECEIVER.
 *
 * Only failures with a specific, actionable remedy are translated; anything else
 * returns undefined and the raw body stands on its own.
 */
export function explainRelayFailure(body: string): string | undefined {
  // `deadline 'TransferPreapproval.expiresAt' at <ISO>` — the payee's preapproval
  // has lapsed. Nothing was charged: this fails at PREPARE, before any signature.
  // The payer's holdings are too many, or too fragmented, for one transfer —
  // its funds may well be there. The relay names the exact merge to run.
  if (/holdings_merge_required/.test(body)) {
    const cmd = /(canton-agent-wallet merge[^"\\]*)/.exec(body)?.[1]?.trim();
    return (
      `this wallet's holdings must be consolidated before it can pay this amount ` +
      `(spread over more holdings than one transfer can spend). Run: ` +
      `${cmd ?? "canton-agent-wallet merge"} — then retry. Nothing was charged.`
    );
  }
  const expired = /deadline\s+'TransferPreapproval\.expiresAt'\s+at\s+([0-9T:.+-]+Z)/.exec(body);
  if (expired) {
    return (
      `the PAYEE's TransferPreapproval expired at ${expired[1]} — every payment to ` +
      `them fails until they renew it (\`canton-agent-wallet preapproval\` on THEIR ` +
      `wallet). This is the receiver's to fix, not the payer's: your balance, wallet ` +
      `and allowlist are not involved, and nothing was charged (it fails before signing).`
    );
  }
  // The submission's completion was a rejection: the transaction did not
  // commit, so running it again is safe. INACTIVE and
  // LOCKED contracts mean something it spends changed meanwhile (MainNet,
  // 2026-11-04: a Tradecraft settlement recreated the allocation a top-up was
  // spending).
  const verdict = PARTICIPANT_REJECTED.exec(body);
  if (verdict) {
    // Only this transaction is known not to have committed: a command of
    // several steps keeps the ones it finished, and a LOCKED input belongs to
    // another transaction still in flight, which may be this command's own
    // earlier run.
    if (/LOCKED_CONTRACTS/.test(verdict[1]!)) {
      return (
        `the participant rejected the transaction (${verdict[1]}): another pending transaction holds an ` +
        "input of this one. Wait for it, then check `balance` before running this again."
      );
    }
    return (
      `the participant rejected the transaction (${verdict[1]})` +
      (/INACTIVE_CONTRACTS/.test(verdict[1]!) ? ": a contract it spends changed meanwhile" : "") +
      ". This transaction did not commit and charged nothing. Steps this command finished before it stand: " +
      "check `balance` (and `tc status`) before running it again."
    );
  }
  return undefined;
}

/** A relay answer that carries a rejected completion: the relay read the
 *  submission's completion and its status was a rejection (ledger client's
 *  pollCompletionUpdateId), so the transaction did not commit. */
const PARTICIPANT_REJECTED = /interactive submission rejected: ([A-Z][A-Z0-9_]+)/;

/**
 * The relay routes a PAYMENT and a CLAIM travel, as this client calls them. The
 * methods below use these strings and the object is exported, so a caller that
 * has to know "does this facilitator still serve what this wallet will call"
 * (anything that must not act unless the pay path will work) probes the same strings the
 * calls use — a renamed route cannot leave the probe checking the old name.
 *
 * POST only, on purpose: each answers an empty body with a validation 400
 * before any ledger work, so probing one costs nothing. The GET reads take a
 * party in the path and go to the ledger even for a junk one.
 */
export const PAY_AND_CLAIM_RELAY_ROUTES = {
  payPrepare: "/v1/wallet/pay/prepare",
  resolveAccept: "/v1/wallet/resolve/accept",
  submitPrepare: "/v1/wallet/submit/prepare",
  submitExecute: "/v1/wallet/submit/execute",
} as const;

/** Relay calls that SUBMIT to the ledger. A timeout, dropped connection or 5xx
 *  on one of these is not a failure: the submission may still commit, so it
 *  must not read as "retry". Onboarding is left out: nothing can be paid twice
 *  there, and a re-run makes a new party. */
const SUBMITTING_ROUTES: readonly RegExp[] = [
  /^\/v1\/wallet\/submit\/execute$/,
  /^\/v1\/wallet\/preapproval\/self\/commit$/,
  /^\/v1\/merchants\/[^/]+\/preapproval$/,
];

/** Default per-request relay timeout. Generous on purpose — a prepare against a
 *  busy participant takes seconds — but finite, so a hung relay fails the
 *  command instead of hanging it forever. Override: CANTON_AGENT_RELAY_TIMEOUT_MS. */
export const DEFAULT_RELAY_TIMEOUT_MS = 120_000;

/** The relay did not answer in time. `outcomeUnknown` is set for a call that
 *  submits to the ledger: the submission may still commit, so the caller must
 *  check state (balance) before doing it again — a blind retry can pay twice. */
export class RelayTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly timeoutMs: number,
    readonly outcomeUnknown: boolean
  ) {
    super(
      `relay ${method} ${path} did not answer within ${Math.round(timeoutMs / 1000)}s` +
        (outcomeUnknown
          ? ` — the submission may still commit: check \`canton-agent-wallet balance\` ` +
            `before retrying, or you may pay twice`
          : ` — the relay is unreachable or overloaded; retry later ` +
            `(raise CANTON_AGENT_RELAY_TIMEOUT_MS if it is just slow)`)
    );
    this.name = "RelayTimeoutError";
  }
}

const MAY_STILL_COMMIT =
  "the submission may still commit. Check `canton-agent-wallet balance` " +
  "before retrying, or you may pay twice";

/** The connection failed on a call that submits to the ledger (reset, closed
 *  socket, unreadable answer). The relay may already hold the signed request,
 *  so like a timeout there the outcome is unknown: "could not reach the relay"
 *  would read as "nothing happened, retry", and a retry can pay twice. */
export class RelayOutcomeUnknownError extends Error {
  readonly outcomeUnknown = true;
  constructor(
    readonly method: string,
    readonly path: string,
    cause: unknown
  ) {
    const why = (cause as { cause?: { message?: unknown } } | null)?.cause?.message;
    super(
      `relay ${method} ${path} connection failed` +
        (typeof why === "string" && why ? ` (${why})` : "") +
        `: ${MAY_STILL_COMMIT}`,
      { cause }
    );
    this.name = "RelayOutcomeUnknownError";
  }
}

function resolveRelayTimeoutMs(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  const env = Number(process.env.CANTON_AGENT_RELAY_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_RELAY_TIMEOUT_MS;
}

export class RelayHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The parsed JSON response body, or undefined when it was not JSON. */
    readonly body: unknown,
    readonly outcomeUnknown = false,
    /** The relay's Retry-After in whole seconds, when it sent one as a number
     *  (a busy relay says how long to wait; an HTTP-date form is not read). */
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "RelayHttpError";
  }
}

/** True when `err` is a relay /balance 413 signalling the party holds more amulet
 *  contracts than the participant's JSON-API element cap can enumerate — the
 *  discriminated case that routes `merge` to the Scan-snapshot whale path. Matches
 *  on the structured {status:413, body.code} first (robust), with a message-string
 *  fallback for older/opaque errors. */
export function isHoldingsExceedNodeLimitError(err: unknown): boolean {
  if (err instanceof RelayHttpError) {
    if (err.status === 413) return true;
    const code = (err.body as { code?: unknown } | undefined)?.code;
    if (code === "holdings_exceed_node_limit") return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /holdings_exceed_node_limit/.test(msg) || /-> 413\b/.test(msg);
}

/** True when `err`, or an error it wraps, is a relay submission whose outcome
 *  is unknown (timeout, dropped connection or 5xx on a submitting route). */
export function isOutcomeUnknownError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 6; depth++) {
    if ((cur as { outcomeUnknown?: unknown }).outcomeUnknown === true) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** Signs a relay read as one party (see `X-Canton-Read-Proof`). The signer
 *  builds the message from these parts itself; see `readSignerFromWallet`. */
export interface RelayReadSigner {
  party: string;
  sign(parts: ReadProofParts): Uint8Array;
}

const READ_PROOF_HEADER = "x-canton-read-proof";
/** The relay's per-party GETs that can carry a proof. The facilitator keeps the
 *  same list (READ_PROOF_ROUTES in routes/read-proof.ts); a test holds them equal. */
export const READ_PROOF_ROUTES = [
  "holdings",
  "balance",
  "holdings-scan",
  "contracts",
  "tradecraft-updates",
  "tx-amulets",
  "pending",
  "outgoing",
] as const;
const PROVABLE_READ = new RegExp(`^/v1/wallet/([^/]+)/(?:${READ_PROOF_ROUTES.join("|")})$`);

export class RelayClient {
  private readonly timeoutMs: number;

  constructor(
    private readonly opts: {
      relayUrl: string;
      apiKey?: string | undefined;
      /** Per-request timeout; default CANTON_AGENT_RELAY_TIMEOUT_MS or 120 s. */
      timeoutMs?: number;
      /** When set, reads of THIS party carry a signed proof the relay can check.
       *  Nothing else the client sends changes. */
      readSigner?: RelayReadSigner | undefined;
    }
  ) {
    this.timeoutMs = resolveRelayTimeoutMs(opts.timeoutMs);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiKey) h["x-agent-key"] = this.opts.apiKey;
    return h;
  }

  /**
   * `X-Canton-Read-Proof: v1.<timestampMs>.<signature base64url>` for a read of
   * the signer's own party; none for any other request. The signature covers
   * the method, the host the client connects to, the decoded path, the raw
   * query, the party and the timestamp (see `readSignerFromWallet`).
   */
  private readProof(method: string, path: string): Record<string, string> {
    const signer = this.opts.readSigner;
    if (!signer || method !== "GET") return {};
    const q = path.indexOf("?");
    const route = q === -1 ? path : path.slice(0, q);
    const m = PROVABLE_READ.exec(route);
    if (!m) return {};
    try {
      const party = decodeURIComponent(m[1]!);
      if (party !== signer.party) return {};
      // Sign what fetch puts on the wire: the URL parser re-encodes some
      // characters (a "'" in the query becomes %27), and the relay sees those.
      const wire = new URL(this.opts.relayUrl.replace(/\/$/, "") + path);
      const timestampMs = Date.now();
      const signature = Buffer.from(
        signer.sign({
          method,
          host: wire.host.toLowerCase(),
          pathname: decodeURIComponent(wire.pathname),
          query: wire.search.slice(1),
          timestampMs,
        })
      ).toString("base64url");
      return { [READ_PROOF_HEADER]: `v1.${timestampMs}.${signature}` };
    } catch {
      // A proof is optional while the relay only measures: a signer that
      // fails must not fail the read.
      return {};
    }
  }

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const url = this.opts.relayUrl.replace(/\/$/, "") + path;
    const route = path.split("?")[0]!;
    const submitting = SUBMITTING_ROUTES.some((re) => re.test(route));
    let r: Response;
    let text: string;
    try {
      r = await fetch(url, {
        method,
        headers: { ...this.headers(), ...this.readProof(method, path), ...(extraHeaders ?? {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await r.text();
    } catch (err) {
      if ((err as { name?: unknown } | null)?.name === "TimeoutError") {
        throw new RelayTimeoutError(method, route, this.timeoutMs, submitting);
      }
      // Unless the connection never opened, a failed submission may have landed.
      if (submitting && !connectionNeverEstablished(err)) {
        throw new RelayOutcomeUnknownError(method, route, err);
      }
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      /* leave undefined */
    }
    if (!r.ok) {
      // Same message as before (message-based assertions unchanged) but now a
      // typed error carrying the status + parsed body for discriminated handling.
      // A recognised participant failure is APPENDED in plain words: the raw body
      // is cut at 200 chars, which for the expiry case truncates mid-sentence
      // ("Ledger time is at or ...") and drops the only two facts the payer can
      // act on — which deadline lapsed, and when.
      const why = explainRelayFailure(text);
      // The relay answers 5xx when its own hop to the participant fails, which
      // can be after the participant took a submission: only a 4xx is a refusal.
      // A rejection verdict is the participant's answer, so not unknown.
      const outcomeUnknown = submitting && r.status >= 500 && !PARTICIPANT_REJECTED.test(text);
      const retryAfter = Number(r.headers?.get?.("retry-after") ?? NaN);
      throw new RelayHttpError(
        `relay ${method} ${path} -> ${r.status} ${text.slice(0, 200)}` +
          (why ? `\n  ${why}` : "") +
          (outcomeUnknown ? `\n  ${MAY_STILL_COMMIT}` : ""),
        r.status,
        json,
        outcomeUnknown,
        Number.isInteger(retryAfter) && retryAfter >= 0 ? retryAfter : undefined
      );
    }
    return json as T;
  }

  /**
   * Which of `paths` this relay does NOT serve. POSTs an empty body to each: a
   * served route answers a validation 400 before doing any work, while a route
   * the facilitator no longer has answers Fastify's `404 Route POST:<path> not
   * found` — and only that answer counts as missing. Any other status means the
   * route is there. A network failure throws: "could not ask" is not "all
   * present".
   */
  async missingRoutes(paths: readonly string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const path of paths) {
      try {
        await this.req("POST", path, {});
      } catch (err) {
        if (!(err instanceof RelayHttpError)) throw err;
        const message = (err.body as { message?: unknown } | undefined)?.message;
        if (
          err.status === 404 &&
          typeof message === "string" &&
          message.startsWith("Route POST:") &&
          message.endsWith(`${path} not found`)
        ) {
          missing.push(path);
        }
      }
    }
    return missing;
  }

  onboardPrepare(b: { publicKey: RelayPublicKey; partyHint: string }) {
    return this.req<OnboardPrepareResult>("POST", "/v1/wallet/onboard/prepare", b);
  }
  /** `starterGrant` is set when the relay pays every new wallet a grant (it
   *  arrives shortly after, as a pending transfer the wallet accepts). */
  onboardFinalize(b: {
    onboardingTransactions: string[];
    multiHashSignatures: RelaySignature[];
  }) {
    return this.req<{
      party: string;
      starterGrant?: { status?: string; amountCc?: string };
    }>("POST", "/v1/wallet/onboard/finalize", b);
  }
  submitPrepare(b: unknown) {
    return this.req<{ preparedTransaction: string; hash: string }>(
      "POST",
      PAY_AND_CLAIM_RELAY_ROUTES.submitPrepare,
      b
    );
  }
  submitExecute(b: unknown) {
    return this.req<{ updateId: string }>("POST", PAY_AND_CLAIM_RELAY_ROUTES.submitExecute, b);
  }
  /** transfer-factory ("V3") pay: the relay BUILDS + interactive-prepares the
   *  TransferFactory_Transfer and returns the prepared bytes + hash for the
   *  client's verify-before-sign. The client signs and carries the signed
   *  transaction INLINE in its x402 payment payload; the relay stores nothing. */
  payPrepare(b: {
    party: string;
    receiver: string;
    amount: string;
    executeBeforeSeconds?: number;
    /** Merchant-required memo (from PaymentRequirements.extra.memo) the relay
     *  stamps into the transfer's `x402.memo` meta. Optional — omitted when the
     *  merchant set none. Forwarded verbatim in the request body. */
    memo?: string;
    /** Venue-attribution meta (e.g. `{ "ftp/venue": "ftp/agentic-wallet" }`) the
     *  relay merges into the prepared transfer's meta alongside `x402.memo`, so a
     *  token issuer's incentive program can attribute this payment to the venue.
     *  Keys must end in `/venue`; the relay validates + bounds it. Optional. */
    venueMeta?: Record<string, string>;
    /** Non-Amulet CIP-56 instrument to pay in. Omit for Canton Coin. Its admin
     *  must be configured on the relay (CANTON_X402_TOKEN_REGISTRIES) or the
     *  relay 400s. */
    instrumentId?: { admin: string; id: string };
  }) {
    return this.req<{
      preparedTransaction: string;
      txHash: string;
      executeBefore: string;
      sender: string;
      receiver: string;
      amount: string;
      instrumentId: { admin: string; id: string };
    }>("POST", PAY_AND_CLAIM_RELAY_ROUTES.payPrepare, b);
  }
  balance(party: string) {
    return this.req<BalanceResult>(
      "GET",
      `/v1/wallet/${encodeURIComponent(party)}/balance`
    );
  }
  /** Every instrument the party holds, read through the HoldingV1 interface —
   *  the one read that sees Canton Coin AND any CIP-56 token. `/balance` only
   *  ever counted Amulet, so a wallet could PAY in USDCx and not SEE it.
   *  Pass `instrument` to narrow to one {admin,id}. */
  holdings(
    party: string,
    instrument?: { admin: string; id: string },
    /** `slice: true` asks for a BOUNDED read: a wallet with more holdings than
     *  the participant lists in one read gets part of them and
     *  `complete: false` instead of a 413. Use it where a prefix is enough to
     *  make progress (merge, picking inputs) — never as a balance.
     *
     *  `registryOnly: true` (no `instrument`) asks for every token except
     *  Canton Coin (`class=registry`), so `complete` is about the tokens alone.
     *  A relay that predates it ignores it and lists Canton Coin too, so a
     *  caller still skips Canton Coin rows itself. */
    opts: { slice?: boolean; registryOnly?: boolean } = {}
  ): Promise<HoldingsResult> {
    const params = new URLSearchParams();
    if (instrument) {
      params.set("admin", instrument.admin);
      params.set("id", instrument.id);
    } else if (opts.registryOnly) {
      params.set("class", "registry");
    }
    if (opts.slice) params.set("slice", "1");
    const q = params.size > 0 ? `?${params.toString()}` : "";
    return this.req<Omit<HoldingsResult, "complete"> & { complete?: boolean }>(
      "GET",
      `/v1/wallet/${encodeURIComponent(party)}/holdings${q}`
    ).then((h) => ({ ...h, complete: h.complete !== false }));
  }
  /** Merchant TransferPreapproval status (public read). `hasPreapproval:true`
   *  means CC transfers to this merchant complete in ONE tx (the transfer-factory
   *  "V3" precondition); `false` → 2-step Pending; `null` → could not resolve
   *  (validator Scan flavor / transient). */
  preapprovalStatus(party: string, admin: string, id = "Amulet") {
    const q = `admin=${encodeURIComponent(admin)}&id=${encodeURIComponent(id)}`;
    return this.req<{
      merchant: string;
      instrumentId: { admin: string; id: string };
      transferKind: string;
      /** EXPIRY-AWARE since facilitator e2f6b07: false once the preapproval has
       *  lapsed, even though the transfer kind stays `direct`. Older relays do
       *  not send `expiresAt` at all — see below. */
      hasPreapproval: boolean | null;
      /** ISO-8601 `TransferPreapproval.expiresAt`, read off the contract via
       *  Scan. ABSENT on a relay that predates the expiry fix, and absent when
       *  the merchant has no preapproval — callers must treat "missing" as
       *  "unknown", never as "valid". */
      expiresAt?: string;
      /** True when `expiresAt` is in the past. Absent = could not determine. */
      expired?: boolean;
      /** Set when Scan could not be read, meaning `hasPreapproval` reflects
       *  routing only and may be true for an expired preapproval. */
      expiryNote?: string;
      guidance?: string;
      note?: string;
    }>("GET", `/v1/merchants/${encodeURIComponent(party)}/preapproval-status?${q}`);
  }
  /** Facilitator-as-provider creation of a merchant TransferPreapproval
   *  (operator action — the facilitator pays the preapproval fee). Requires the
   *  facilitator OPERATOR token (Authorization: Bearer) AND the merchant to have
   *  delegated CanActAs to the facilitator's ledger user. Returns the created
   *  preapproval's updateId + expiry. */
  createPreapproval(
    party: string,
    opts: { operatorToken: string; expiresAt?: string }
  ) {
    return this.req<{
      updateId: string;
      receiver: string;
      provider: string;
      expiresAt: string;
    }>(
      "POST",
      `/v1/merchants/${encodeURIComponent(party)}/preapproval`,
      opts.expiresAt ? { expiresAt: opts.expiresAt } : {},
      { authorization: `Bearer ${opts.operatorToken}` }
    );
  }
  /** SELF-PROVIDER preapproval, step 1 — the relay builds + interactive-prepares
   *  an `AmuletRules_CreateTransferPreapproval` for `party` (provider==receiver==
   *  party). Returns the prepared transaction + hash the merchant signs with its
   *  OWN key (no operator token, no CanActAs delegation needed). */
  preapprovalSelfPrepare(party: string, expiresAt?: string) {
    return this.req<{
      preparedTransaction: string;
      txHash: string;
      synchronizerId: string;
      party: string;
      expiresAt: string;
    }>("POST", "/v1/wallet/preapproval/self/prepare", {
      party,
      ...(expiresAt ? { expiresAt } : {}),
    });
  }
  /** REGISTRY (non-Amulet, e.g. USDCx) self-preapproval, step 1 — the relay
   *  fetches the registry operator and builds the CreateCommand for the wallet's
   *  own `Utility.Registry.App.V0.Model.TransferPreapproval`. The wallet then
   *  verify-before-signs (assertPreparedRegistrySelfPreapproval) and commits via
   *  the SAME `preapprovalSelfCommit` route. */
  preapprovalRegistrySelfPrepare(party: string, instrumentId: { admin: string; id: string }) {
    return this.req<{
      preparedTransaction: string;
      hash: string;
      synchronizerId: string;
      party: string;
      operator: string;
    }>("POST", "/v1/wallet/preapproval/registry/self/prepare", {
      party,
      instrumentId,
    });
  }
  /** SELF-PROVIDER preapproval, step 2 — submit the merchant-signed prepared
   *  transaction; returns the created preapproval's updateId. */
  preapprovalSelfCommit(body: {
    party: string;
    preparedTransaction: string;
    hashingSchemeVersion: string;
    partySignatures: {
      signatures: Array<{
        party: string;
        signatures: Array<Record<string, unknown>>;
      }>;
    };
  }) {
    return this.req<{ updateId: string }>(
      "POST",
      "/v1/wallet/preapproval/self/commit",
      body
    );
  }
  /** Enumerate `party`'s Amulet holdings from the PUBLIC SV Scan ACS snapshot
   *  (paginated, no participant node cap). The WHALE fallback for `merge` when
   *  `balance()` throws the 413 holdings_exceed_node_limit case
   *  (`isHoldingsExceedNodeLimitError`). */
  holdingsScan(party: string) {
    return this.req<HoldingsScanResult>(
      "GET",
      `/v1/wallet/${encodeURIComponent(party)}/holdings-scan`
    );
  }
  /** `registry=1` opts in to registry-token rows (USDCx offers…); without it
   *  the relay answers Canton Coin instructions only, which is what a client
   *  that cannot route a registry accept must keep seeing. */
  pending(party: string) {
    return this.req<PendingResult>(
      "GET",
      `/v1/wallet/${encodeURIComponent(party)}/pending?registry=1`
    );
  }
  /** The facilitator's advertised x402 kinds. Used at onboarding to learn the
   *  AUTHORITATIVE Canton network the relay settles on (kinds[].network), so the
   *  persisted wallet.network is never a wrong client-side default — that default
   *  would otherwise break the network-keyed DSO pin on withdraw / cip56. */
  supported() {
    return this.req<{
      kinds?: Array<{ network?: string }>;
    }>("GET", "/supported");
  }
  resolveTransferFactory(b: {
    sender: string;
    receiver: string;
    amount: string;
    meta?: Record<string, string>;
    /** Non-Amulet CIP-56 instrument to resolve. Omit for Canton Coin — the
     *  relay then defaults admin=DSO, id="Amulet". */
    instrumentId?: { admin: string; id: string };
    /** Holdings the caller will spend; a registry resolve needs them. */
    inputHoldingCids?: string[];
  }) {
    return this.req<ResolveFactoryResult>(
      "POST",
      "/v1/wallet/resolve/transfer-factory",
      b
    );
  }
  resolveAccept(b: { instructionCid: string; instrumentAdmin?: string }) {
    return this.req<ResolveAcceptResult>("POST", PAY_AND_CLAIM_RELAY_ROUTES.resolveAccept, b);
  }
  /** The party's own pending registry offers, for reclaim. A relay that predates
   *  the route answers 404 (RelayHttpError.status). */
  outgoing(party: string) {
    return this.req<OutgoingResult>("GET", `/v1/wallet/${encodeURIComponent(party)}/outgoing`);
  }
  /** The registry's withdraw choice-context for the party's own offer. */
  resolveWithdraw(b: { instructionCid: string; instrumentAdmin: string }) {
    return this.req<ResolveAcceptResult>("POST", "/v1/wallet/resolve/withdraw", b);
  }
  /** Read the Amulet OUTPUT cids a transfer transaction created for `party`, by
   *  updateId (whale-merge output discovery — the agent is relay-only). The relay
   *  reads the tx (getTransactionById, bounded per-tx, immune to the ACS element
   *  cap) and returns the Amulet contracts OWNED BY `party` that it created. The
   *  `merge` chain phase uses this to feed a batch's own outputs into the next
   *  round, so consolidation converges in ONE run without the daily Scan snapshot. */
  txAmulets(party: string, updateId: string) {
    return this.req<TxAmuletsResult>(
      "GET",
      `/v1/wallet/${encodeURIComponent(party)}/tx-amulets?updateId=${encodeURIComponent(updateId)}`
    );
  }
  /** Token-standard V2 allocation factory + choice context for `instrumentId`,
   *  resolved by the relay from the instrument's registry (the agent has no
   *  Scan/registry access). Tradecraft queued mode. */
  resolveAllocationFactory(b: {
    instrumentId: { admin: string; id: string };
    choiceArguments: unknown;
  }) {
    return this.req<ResolveAllocationFactoryResult>("POST", "/v1/wallet/resolve/allocation-factory", b);
  }
  /** Token-standard V2 settlement factory + choice context for `instrumentId`
   *  (Tradecraft allocation top-up), resolved like the allocation factory. */
  resolveSettlementFactory(b: {
    instrumentId: { admin: string; id: string };
    choiceArguments: unknown;
  }) {
    return this.req<ResolveAllocationFactoryResult>("POST", "/v1/wallet/resolve/settlement-factory", b);
  }
  /** The party's contracts of ONE template or interface the relay allowlists
   *  (`templateId` / `interfaceId` as `#package-name:Module:Entity`).
   *  `complete: false` means the relay returned a bounded prefix. */
  contracts(party: string, q: { templateId: string } | { interfaceId: string }) {
    const [k, v] = "templateId" in q ? ["templateId", q.templateId] : ["interfaceId", q.interfaceId];
    return this.req<ContractsResult>(
      "GET",
      `/v1/wallet/${encodeURIComponent(party)}/contracts?${k}=${encodeURIComponent(v)}`
    );
  }
  /** One page of the party's Tradecraft history after ledger offset `after`:
   *  fills, cancellations, settlement legs. Continue from `next` until
   *  `complete`. Offsets belong to the participant hosting the party. */
  tradecraftUpdates(party: string, q: { after?: number; limit?: number } = {}) {
    const params = new URLSearchParams();
    if (q.after !== undefined) params.set("after", String(q.after));
    if (q.limit !== undefined) params.set("limit", String(q.limit));
    const qs = params.toString();
    return this.req<TradecraftUpdatesResult>(
      "GET",
      `/v1/wallet/${encodeURIComponent(party)}/tradecraft-updates${qs ? `?${qs}` : ""}`
    );
  }
}
