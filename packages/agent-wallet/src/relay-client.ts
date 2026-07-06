/**
 * HTTP client for the facilitator's agent-wallet relay. The agent talks ONLY to
 * this — plain HTTP, no Canton auth. The relay bridges to the participant using
 * the validator token (onboarding + interactive submission) and proxies the
 * public Scan registry resolves (the agent has no Scan access).
 */
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
  pending: Array<{ cid: string; amount?: string; sender?: string }>;
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
export class RelayHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The parsed JSON response body, or undefined when it was not JSON. */
    readonly body: unknown
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

export class RelayClient {
  constructor(
    private readonly opts: { relayUrl: string; apiKey?: string | undefined }
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiKey) h["x-agent-key"] = this.opts.apiKey;
    return h;
  }

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const url = this.opts.relayUrl.replace(/\/$/, "") + path;
    const r = await fetch(url, {
      method,
      headers: { ...this.headers(), ...(extraHeaders ?? {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      /* leave undefined */
    }
    if (!r.ok) {
      // Same message as before (message-based assertions unchanged) but now a
      // typed error carrying the status + parsed body for discriminated handling.
      throw new RelayHttpError(
        `relay ${method} ${path} -> ${r.status} ${text.slice(0, 200)}`,
        r.status,
        json
      );
    }
    return json as T;
  }

  onboardPrepare(b: { publicKey: RelayPublicKey; partyHint: string }) {
    return this.req<OnboardPrepareResult>("POST", "/v1/wallet/onboard/prepare", b);
  }
  onboardFinalize(b: {
    onboardingTransactions: string[];
    multiHashSignatures: RelaySignature[];
  }) {
    return this.req<{ party: string }>("POST", "/v1/wallet/onboard/finalize", b);
  }
  submitPrepare(b: unknown) {
    return this.req<{ preparedTransaction: string; hash: string }>(
      "POST",
      "/v1/wallet/submit/prepare",
      b
    );
  }
  submitExecute(b: unknown) {
    return this.req<{ updateId: string }>("POST", "/v1/wallet/submit/execute", b);
  }
  /** transfer-factory ("V3") pay step 1: the relay BUILDS + interactive-prepares
   *  the TransferFactory_Transfer and stashes it, returning the prepared bytes +
   *  hash for the client's verify-before-sign and the small `submissionRef` the
   *  x402 payload carries. */
  payPrepare(b: {
    party: string;
    receiver: string;
    amount: string;
    executeBeforeSeconds?: number;
  }) {
    return this.req<{
      submissionRef: string;
      preparedTransaction: string;
      txHash: string;
      executeBefore: string;
      sender: string;
      receiver: string;
      amount: string;
      instrumentId: { admin: string; id: string };
    }>("POST", "/v1/wallet/pay/prepare", b);
  }
  /** transfer-factory pay step 2: attach the payer's signing bundle to the
   *  stashed submission (NO execution — /settle relays it later). */
  payCommit(b: {
    party: string;
    submissionRef: string;
    hashingSchemeVersion: "HASHING_SCHEME_VERSION_V1" | "HASHING_SCHEME_VERSION_V2";
    partySignatures: {
      signatures: Array<{
        party: string;
        signatures: Array<Record<string, unknown>>;
      }>;
    };
  }) {
    return this.req<{ committed: boolean; submissionRef: string; executeBefore: string }>(
      "POST",
      "/v1/wallet/pay/commit",
      b
    );
  }
  balance(party: string) {
    return this.req<BalanceResult>(
      "GET",
      `/v1/wallet/${encodeURIComponent(party)}/balance`
    );
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
      hasPreapproval: boolean | null;
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
  pending(party: string) {
    return this.req<PendingResult>(
      "GET",
      `/v1/wallet/${encodeURIComponent(party)}/pending`
    );
  }
  /** Request a one-time faucet seed for `party` (out-of-box e2e funding). The
   *  facilitator sends a tiny CC grant FROM ITS OWN party; it lands as a pending
   *  TransferInstruction the agent then accepts via `claimAll`. Throws (relay
   *  error) when the faucet is disabled / already claimed / over budget — the MCP
   *  `auto_fund` tool maps that to the manual-funding fallback. */
  faucetClaim(party: string) {
    return this.req<{ updateId: string; amount: string; party: string }>(
      "POST",
      "/v1/wallet/faucet/claim",
      { party }
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
  }) {
    return this.req<ResolveFactoryResult>(
      "POST",
      "/v1/wallet/resolve/transfer-factory",
      b
    );
  }
  resolveAccept(b: { instructionCid: string }) {
    return this.req<ResolveAcceptResult>("POST", "/v1/wallet/resolve/accept", b);
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
}
