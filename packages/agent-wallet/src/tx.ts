/**
 * Transfer primitives for the agent's self-custody wallet, all routed through
 * the relay: resolve the factory / accept context (the agent has no Scan
 * access), build the choice, sign the prepared-tx hash LOCALLY with the agent's
 * key, execute via the relay. The relay only prepares + forwards; it can never
 * sign, so it can never move the agent's funds.
 */
import { signHashB64 } from "./keys.js";
import { resolveHashBinding } from "./hash-binding.js";
import type { RelayClient } from "./relay-client.js";
import type { AgentWallet } from "./store.js";
import {
  assertHashBinding,
  assertPreparedTransferMatches,
  assertPreparedSelfPreapproval,
  assertPreparedRegistrySelfPreapproval,
  PreparedTransferMismatchError,
  assertPreparedAcceptMatches,
  type HashBindingOptions,
  type PreparedTransferExpectation,
  type PreparedAcceptExpectation,
  PreparedDecodeError,
  PreparedHashUnavailableError,
} from "./verify-prepared.js";
import { isTrustedRegistryAdmin, resolveTrustedRegistryParties } from "./registry-parties.js";
import { resolveTrustedDsoParty } from "./trusted-dso.js";

const TI_IFACE =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";

/**
 * The instrument id the agent's self-custody wallet pays in: Canton Coin is the
 * Splice "Amulet" instrument. This is CALLER INTENT — a fixed value the agent
 * knows independently of the relay — so it can be used as a trust anchor when
 * verifying the relay-prepared transfer. We deliberately do NOT anchor on the
 * relay-resolved instrument ADMIN (the DSO party), because trusting a
 * relay-supplied party as a whitelist is exactly the trust-boundary inversion a
 * compromised relay would exploit. The recipient is pinned to caller intent and
 * the instrument id to this constant; the admin is validated only positionally.
 */
const EXPECTED_INSTRUMENT_ID = "Amulet";

function rid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * verify-before-sign spec for `prepareSignExecute`: a discriminated union so the
 * SAME prepare→sign→execute helper structurally validates the token-standard
 * `TransferFactory_Transfer` AND the `TransferInstruction_Accept` (claim)
 * prepared bytes — each with its own rigorous, fail-closed assertion. EVERY path
 * supplies a spec: even the claim path (funds-in) must structurally prove the
 * prepared transaction is an inbound accept (not a relay-injected outbound drain)
 * and bind the signed hash to those bytes, so a malicious relay can never get the
 * agent to blind-sign.
 */
type VerifySpec =
  | { kind: "cip56"; expect: PreparedTransferExpectation }
  | { kind: "accept"; expect: PreparedAcceptExpectation };

/**
 * prepare (relay) → VERIFY → sign hash (local key) → execute (relay) → updateId.
 *
 * When `verify` is supplied (any command that MOVES the agent's funds), the
 * EXACT `preparedTransaction` bytes that will be submitted to `execute` are
 * structurally decoded and checked to encode exactly the intended
 * sender/receiver/amount/(instrument|delegate) BEFORE the agent signs its hash,
 * and the hash is bound to those same bytes. This is the self-custody guarantee:
 * a compromised relay cannot get the agent to sign a command it did not author —
 * any tamper either fails structural validation here, or (since the participant
 * recomputes the hash from the submitted bytes on execute) produces a signature
 * that the participant rejects. We fail closed: if validation or hash binding
 * does not pass, we never sign. See `verify-prepared.ts`.
 *
 * SECURITY: `verify` is REQUIRED for EVERY path — no caller can reach
 * `signHashB64` without a structural gate. The claim path (accepting incoming
 * transfers) is NOT exempt: it passes `kind: "accept"`, which structurally
 * proves the prepared transaction is a single `TransferInstruction_Accept`
 * submitted by the agent and NOT a relay-injected outbound drain. `hashBinding`
 * is likewise threaded on every path and enforced fail-closed.
 */
async function prepareSignExecute(
  relay: RelayClient,
  wallet: AgentWallet,
  commands: unknown[],
  disclosedContracts: unknown[],
  verify: VerifySpec,
  hashBinding?: HashBindingOptions,
  /** Caller-intent synchronizer id to PREPARE on. When supplied we send it in
   *  the prepare body so the relay cannot silently fill its own — and the verify
   *  arm pins the SIGNED Metadata.synchronizer_id to it. Omitted for the claim
   *  (funds-in) path, whose accept carries no caller-intent domain. */
  synchronizerId?: string
): Promise<string> {
  const prep = await relay.submitPrepare({
    userId: "agent", // relay overrides with the participant (m2m) user
    commandId: rid("agent"),
    actAs: [wallet.party],
    commands,
    disclosedContracts,
    packageIdSelectionPreference: [],
    verboseHashing: false,
    // Pin the synchronizer to caller intent so the relay cannot prepare on (and
    // sign the agent onto) a domain of its choosing. The verify arm additionally
    // asserts the SIGNED Metadata.synchronizer_id equals this.
    ...(synchronizerId !== undefined ? { synchronizerId } : {}),
  });
  // Bind to the EXACT bytes we will submit (single source `prep`, no TOCTOU).
  const preparedTransaction = prep.preparedTransaction;
  // VERIFY-BEFORE-SIGN: never sign a relay-prepared command we didn't author.
  // `verify` is required on EVERY path (transfer/accept), so there is no branch
  // that reaches signHashB64 ungated.
  if (verify.kind === "cip56") {
    assertPreparedTransferMatches(preparedTransaction, verify.expect);
  } else {
    // claim path: structurally prove the prepared tx is a single inbound
    // TransferInstruction_Accept by the agent, not an outbound drain.
    assertPreparedAcceptMatches(preparedTransaction, verify.expect);
  }
  // Hash binding: prove the hash we are about to sign is the hash OF THE BYTES
  // we just validated, not an opaque relay-chosen value. Without this a
  // compromised relay can return honest bytes + the hash of a tampered tx and
  // swap the bytes on the way to the participant. Fail closed: if the binding
  // cannot be established (no recompute available and no explicit opt-in to
  // trust the relay hash) we never sign. See verify-prepared.ts.
  await assertHashBinding(preparedTransaction, prep.hash, hashBinding ?? {});
  const signature = signHashB64(prep.hash, wallet.privateKeyPkcs8Pem);
  const exec = await relay.submitExecute({
    submissionId: rid("agent-exec"),
    preparedTransaction,
    hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
    partySignatures: {
      signatures: [
        {
          party: wallet.party,
          signatures: [
            {
              format: "SIGNATURE_FORMAT_CONCAT",
              signature,
              signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519",
              signedBy: wallet.publicKeyFingerprint,
            },
          ],
        },
      ],
    },
    deduplicationPeriod: { Empty: {} },
  });
  return exec.updateId;
}

/**
 * Send CC from the agent to `receiver`. Returns the ledger updateId.
 *
 * `opts.expectInstrumentId` overrides the asset the verifier pins the prepared
 * transfer to (defaults to Canton Coin / "Amulet"). It is CALLER INTENT, never
 * taken from the relay.
 */
export async function transfer(
  relay: RelayClient,
  wallet: AgentWallet,
  opts: {
    receiver: string;
    amount: string;
    meta?: Record<string, string>;
    expectInstrumentId?: string;
    /** Optional, caller-intent synchronizer id to PREPARE on and to pin the
     *  SIGNED Metadata.synchronizer_id to. When supplied, the relay cannot land
     *  the agent's signature on a domain of its choosing. */
    expectSynchronizerId?: string;
    /** Optional, independently-trusted instrument admin (DSO) to pin. When
     *  supplied it closes the unpinned-admin neutralization fully (the admin can
     *  no longer be aliased to an attacker and smuggled in as a consequence
     *  recipient). Omitted by default — the agent has no out-of-band DSO. */
    expectInstrumentAdmin?: string;
    /**
     * How to bind the relay-returned hash to the validated bytes before signing.
     * Defaults (when omitted) to fail-closed: a value-moving transfer refuses to
     * sign unless a `recomputeHash` is supplied or `trustRelayHash` is explicitly
     * set. See HashBindingOptions / verify-prepared.ts.
     */
    hashBinding?: HashBindingOptions;
    /**
     * EXPLICIT set of input holding cids to spend (caller intent). When omitted
     * (the default, e.g. a normal pay/withdraw) the full balance is read from the
     * relay and used. Supplied by `merge`, which self-transfers a SPECIFIC batch
     * of dust amulets — and whose whale wallets cannot be balance-enumerated
     * (that read is exactly what 413s), so it MUST bypass the relay.balance() read
     * here. The receiver is still pinned to caller intent by verify-before-sign,
     * so this only narrows which of the agent's OWN holdings fund the transfer.
     */
    inputHoldingCids?: string[];
    /** OUT-OF-BAND-trusted registry infra parties (operator / bridge) for a
     *  non-Amulet registry token — admitted by the foreign-party backstop. See
     *  registry-parties.ts. Empty/undefined for Amulet. */
    trustedRegistryParties?: ReadonlySet<string>;
    /** NON-Amulet registry instrument: only then is `instrumentId {admin,id}`
     *  sent to the relay's resolve (which rejects a non-registry admin like the
     *  DSO). For Amulet leave false — the relay resolves the DSO itself, and
     *  `expectInstrumentAdmin` still pins it in verify-before-sign. */
    registryInstrument?: boolean;
    /** Opt into the registry two-step transfer-offer shape (receiver has no
     *  preapproval) — threaded to verify-before-sign. Only a caller that means to
     *  send a registry token to a non-preapproved receiver (a swap to a pool) sets
     *  this. See PreparedTransferExpectation.allowRegistryOffer. */
    allowRegistryOffer?: boolean;
  }
): Promise<string> {
  // `/balance` enumerates AMULET holdings only (its filter names
  // Splice.Amulet:Amulet), so the default below can only ever produce Canton
  // Coin contract ids. Handing those to a registry token's factory is the same
  // shape of mistake as sending it an empty list — the registry is asked to
  // spend inputs that are not its instrument — and it is worse than an error
  // because nothing here says so. This entry point is exported from the
  // published package, so a caller has no way to know.
  //
  // Selecting registry inputs is the relay's job (it reads the HoldingV1
  // interface view for the instrument); this helper cannot do it. So it refuses
  // rather than guesses: name the holdings explicitly, or use the pay path that
  // resolves them properly.
  if (opts.registryInstrument === true && opts.inputHoldingCids === undefined) {
    throw new Error(
      "transfer(): registryInstrument needs explicit inputHoldingCids — the " +
        "default comes from /balance, which enumerates Amulet holdings only, " +
        "so it would hand a registry factory Canton Coin contract ids"
    );
  }
  const inputHoldingCids =
    opts.inputHoldingCids ?? (await relay.balance(wallet.party)).holdings.map((h) => h.cid);
  const f = await relay.resolveTransferFactory({
    sender: wallet.party,
    receiver: opts.receiver,
    amount: opts.amount,
    // The registry needs to see the inputs to resolve the kind; the SV Scan
    // ignores them. Sent always: harmless for Amulet, required for a token.
    inputHoldingCids,
    ...(opts.meta ? { meta: opts.meta } : {}),
    // Non-Amulet CIP-56 ONLY: name the instrument so the relay resolves it on the
    // right registry. Amulet omits it (the relay rejects a non-registry admin like
    // the DSO); the DSO is still pinned in verify-before-sign via
    // `expectInstrumentAdmin`.
    ...(opts.registryInstrument &&
    opts.expectInstrumentId &&
    opts.expectInstrumentAdmin
      ? {
          instrumentId: {
            admin: opts.expectInstrumentAdmin,
            id: opts.expectInstrumentId,
          },
        }
      : {}),
  });
  const now = Date.now();
  const ex = {
    ExerciseCommand: {
      templateId: f.transferFactoryTemplateId,
      contractId: f.factoryId,
      choice: "TransferFactory_Transfer",
      choiceArgument: {
        expectedAdmin: f.instrumentId.admin,
        transfer: {
          sender: wallet.party,
          receiver: opts.receiver,
          amount: opts.amount,
          instrumentId: f.instrumentId,
          requestedAt: new Date(now - 2000).toISOString(),
          executeBefore: new Date(now + 600_000).toISOString(),
          inputHoldingCids,
          meta: { values: opts.meta ?? {} },
        },
        extraArgs: { context: f.choiceContextData, meta: { values: {} } },
      },
    },
  };
  return prepareSignExecute(
    relay,
    wallet,
    [ex],
    f.disclosedContracts,
    {
      kind: "cip56",
      expect: {
        // Trust anchors are CALLER INTENT only — never the relay's resolve response:
        sender: wallet.party,
        receiver: opts.receiver,
        amount: opts.amount,
        instrumentId: opts.expectInstrumentId ?? EXPECTED_INSTRUMENT_ID,
        // Pin the exercise's target to the SAME factory cid we built the command
        // against, so a relay cannot resolve one factory to us then prepare the
        // exercise against another (resolve→prepare TOCTOU). Defense-in-depth on
        // top of the all-nodes party backstop.
        expectedContractId: f.factoryId,
        // Optional caller-intent pins (off by default — the agent has no out-of-
        // band DSO/domain in the base CC flow): the SIGNED synchronizer_id and
        // the instrument admin (DSO). When supplied they close the relay-chosen-
        // domain and unpinned-admin neutralization fully; always sanity-bound the
        // SIGNED timing metadata via nowMs.
        ...(opts.expectSynchronizerId !== undefined
          ? { synchronizerId: opts.expectSynchronizerId }
          : {}),
        ...(opts.expectInstrumentAdmin !== undefined
          ? { instrumentAdmin: opts.expectInstrumentAdmin }
          : {}),
        ...(opts.trustedRegistryParties !== undefined
          ? { trustedRegistryParties: opts.trustedRegistryParties }
          : {}),
        ...(opts.allowRegistryOffer === true ? { allowRegistryOffer: true } : {}),
        nowMs: Date.now(),
      },
    },
    opts.hashBinding,
    opts.expectSynchronizerId
  );
}

/**
 * transfer-factory ("V3") pay: PREPARE + VERIFY-BEFORE-SIGN + SIGN a relay-built
 * `TransferFactory_Transfer` to the merchant, and return the signed bytes for the
 * INLINE carriage — the x402 payment payload carries them, so any facilitator can
 * relay them at /settle. The relay stores nothing.
 *
 * Same security recipe as `prepareSignExecute` — `assertPreparedTransferMatches`
 * pins the relay-built transfer to CALLER INTENT (sender = self, receiver =
 * payTo, amount, instrument), then `assertHashBinding` proves the signed hash is
 * the hash of those validated bytes. It does not execute: the facilitator (not
 * the payer) is the submitter, and it does so later from the inline payload.
 */
export async function payViaTransferFactory(
  relay: RelayClient,
  wallet: AgentWallet,
  opts: {
    receiver: string;
    amount: string;
    executeBeforeSeconds?: number;
    /** Caller-intent instrument id to pin (default "Amulet"). */
    expectInstrumentId?: string;
    /** Optional independently-trusted instrument admin (DSO) to pin. */
    expectInstrumentAdmin?: string;
    hashBinding?: HashBindingOptions;
    /** Merchant-required memo (PaymentRequirements.extra.memo) to stamp into the
     *  relay-prepared transfer's `x402.memo` meta. Advisory / NOT money-critical:
     *  verify-before-sign deliberately does NOT pin the transfer meta (see the
     *  payPrepare call below), so a relay that alters/drops the memo can only make
     *  the merchant's /verify reject the payment — it can never redirect funds. */
    memo?: string;
    /** Venue-attribution meta to stamp into the relay-prepared transfer's meta
     *  alongside `x402.memo` (e.g. `{ "ftp/venue": "ftp/agentic-wallet" }`). Set by
     *  the signer for a registry-token payment when the wallet configures a venue
     *  tag; advisory, forwarded to the relay's pay/prepare. Omitted → no venue tag. */
    venueMeta?: Record<string, string>;
    /** OUT-OF-BAND-trusted registry infra parties (operator / bridge) for a
     *  non-Amulet registry token — admitted by the foreign-party backstop. See
     *  registry-parties.ts. Empty/undefined for Amulet. */
    trustedRegistryParties?: ReadonlySet<string>;
    /** Whether this is a NON-Amulet registry instrument. Only then is
     *  `instrumentId {admin,id}` sent to the relay's pay/prepare so it resolves on
     *  that registry — the relay rejects a supplied admin that is not a configured
     *  registry (Amulet's DSO admin is not one). For Amulet leave false/undefined:
     *  the relay resolves the DSO itself, and `expectInstrumentAdmin` still pins
     *  the DSO in verify-before-sign (the two uses are deliberately decoupled). */
    registryInstrument?: boolean;
  }
): Promise<{
  payerParty: string;
  txHash: string;
  /** `txHash` re-encoded as the scheme's hex wire form. */
  preparedTxHashHex: string;
  /** The signed prepared transaction bytes the payment payload carries inline. */
  preparedTransactionBytes: Uint8Array;
  signatureB64: string;
  hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2";
}> {
  const prep = await relay.payPrepare({
    party: wallet.party,
    receiver: opts.receiver,
    amount: opts.amount,
    ...(opts.executeBeforeSeconds !== undefined
      ? { executeBeforeSeconds: opts.executeBeforeSeconds }
      : {}),
    ...(opts.memo !== undefined ? { memo: opts.memo } : {}),
    ...(opts.venueMeta && Object.keys(opts.venueMeta).length > 0
      ? { venueMeta: opts.venueMeta }
      : {}),
    // Non-Amulet CIP-56 ONLY: name the instrument so the relay resolves it on the
    // token's registry (needs both halves). For Amulet this is omitted — the relay
    // rejects a supplied admin that is not a configured registry (the DSO is not
    // one), and the DSO is still pinned in verify-before-sign via
    // `expectInstrumentAdmin` below.
    ...(opts.registryInstrument &&
    opts.expectInstrumentId &&
    opts.expectInstrumentAdmin
      ? {
          instrumentId: {
            admin: opts.expectInstrumentAdmin,
            id: opts.expectInstrumentId,
          },
        }
      : {}),
  });
  const preparedTransaction = prep.preparedTransaction;
  // VERIFY-BEFORE-SIGN: never sign a relay-prepared transfer we didn't intend.
  assertPreparedTransferMatches(preparedTransaction, {
    sender: wallet.party,
    receiver: opts.receiver,
    amount: opts.amount,
    instrumentId: opts.expectInstrumentId ?? EXPECTED_INSTRUMENT_ID,
    ...(opts.expectInstrumentAdmin !== undefined
      ? { instrumentAdmin: opts.expectInstrumentAdmin }
      : {}),
    ...(opts.trustedRegistryParties !== undefined
      ? { trustedRegistryParties: opts.trustedRegistryParties }
      : {}),
    nowMs: Date.now(),
  });
  // Hash binding: the hash we sign MUST be the hash of the validated bytes.
  await assertHashBinding(preparedTransaction, prep.txHash, opts.hashBinding ?? {});
  const signature = signHashB64(prep.txHash, wallet.privateKeyPkcs8Pem);

  // Hand the caller the signed bytes. Nothing is sent back to the relay — it
  // stored nothing, and the payment payload carries the transaction. Both legs
  // of verify-before-sign already ran above, so what is returned here is bytes
  // this wallet validated and a signature over the hash OF those bytes.
  return {
    payerParty: wallet.party,
    txHash: prep.txHash,
    preparedTransactionBytes: Buffer.from(preparedTransaction, "base64"),
    // Canton hands us the hash BASE64; the scheme's wire form is hex. The
    // conversion is explicit here rather than guessed by the encoder, because
    // a value that is valid in both alphabets must never be auto-detected.
    preparedTxHashHex: Buffer.from(prep.txHash, "base64").toString("hex"),
    signatureB64: signature,
    hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
  };
}

/**
 * Per-wallet in-process reservation of input-holding cids. The token-standard
 * transfer path has NO nonce, so concurrent pays from one wallet are allowed —
 * BUT two concurrent transfers must not pick the SAME Amulet holding: the first
 * to settle archives it, and the second's already-prepared tx then references an
 * archived contract → HTTP 400 at /v2/interactive-submission/prepare (or at
 * execute). To keep concurrent transfers disjoint we pick the SMALLEST single
 * free holding that covers the amount and reserve its cid for the duration of the
 * prepare→sign→execute dance; a sibling transfer then skips it and picks the next
 * one. Released in `finally` (success OR throw).
 *
 * LIMITATION (documented): this Map is in-memory, so it only de-conflicts
 * concurrency WITHIN one process. Two separate processes paying from the same
 * wallet can still pick the same holding — that loser fails closed (400) and the
 * client's bounded re-pay loop retries with a fresh balance read, by which point
 * the winner has released. No double-spend is possible: verify-before-sign + the
 * facilitator re-validate every settle, so a lost race only costs a retry.
 */
const reservedHoldings = new Map<string, Set<string>>();

/** @internal Exported for unit tests (disjoint selection + release). Not part of
 *  the public API. */
export function reserveHolding(
  party: string,
  holdings: Array<{ cid: string; amount: string }>,
  amount: string
): { cids: string[]; release: () => void } {
  const want = Number(amount);
  let set = reservedHoldings.get(party);
  if (!set) {
    set = new Set<string>();
    reservedHoldings.set(party, set);
  }
  const free = holdings.filter((h) => !set.has(h.cid));
  // Prefer the SMALLEST single free holding that covers the amount — leaving the
  // larger holdings free for sibling concurrent allocates.
  const single = free
    .filter((h) => Number(h.amount) >= want)
    .sort((a, b) => Number(a.amount) - Number(b.amount))[0];
  let chosen: Array<{ cid: string; amount: string }>;
  if (single) {
    chosen = [single];
  } else {
    // No single free holding covers it → accumulate free holdings largest-first
    // until they cover the amount.
    const byDesc = [...free].sort((a, b) => Number(b.amount) - Number(a.amount));
    chosen = [];
    let acc = 0;
    for (const h of byDesc) {
      chosen.push(h);
      acc += Number(h.amount);
      if (acc >= want) break;
    }
    // Nothing free at all (every holding reserved by a sibling) → fall back to the
    // full set (legacy behavior). A sibling may archive these first → the prepared
    // tx 400s → the client re-pay loop retries, by which point a sibling released.
    if (chosen.length === 0) chosen = holdings;
  }
  const cids = chosen.map((h) => h.cid);
  for (const c of cids) set.add(c);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    const s = reservedHoldings.get(party);
    if (!s) return;
    for (const c of cids) s.delete(c);
    if (s.size === 0) reservedHoldings.delete(party);
  };
  return { cids, release };
}

/**
 * True when a relay prepare/execute failure is a STALE input-holding rejection:
 * the participant reports the chosen input contract already archived
 * (`UNKNOWN_CONTRACT_SYNCHRONIZERS` / "have been archived") OR unresolvable
 * (`CONTRACT_NOT_FOUND` / "Contract could not be found"). This is TRANSIENT: the
 * caller's cid list (relay `/balance` ACS read, or a lagging Scan snapshot) named
 * a holding the ledger no longer has, e.g.
 *   - a prior allocate whose execute timed out but still committed (archived), or
 *   - a `merge` REPEAT run whose whale pass re-enumerates the SAME daily Scan
 *     snapshot (refreshed ~12:00Z) and so references cids a PREVIOUS run already
 *     consumed. Those cids resolve to nothing at
 *     `/v2/interactive-submission/prepare`, which the relay surfaces as a 502
 *     whose detail carries `HTTP 404 [CONTRACT_NOT_FOUND: Contract could not be
 *     found with id 005e…]`.
 * The caller re-reads/skips + continues rather than failing the whole run. Walks
 * the error + `cause` chain (the relay wraps the participant 4xx as a 502 with the
 * detail in the message/cause; RelayHttpError's message string carries it too).
 * @internal
 */
export function isStaleInputHoldingError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 6; depth++) {
    const e = cur as { message?: unknown; detail?: unknown; cause?: unknown };
    const hay = `${typeof e.message === "string" ? e.message : ""} ${
      typeof e.detail === "string" ? e.detail : ""
    }`;
    if (
      /UNKNOWN_CONTRACT_SYNCHRONIZERS|have been archived|CONTRACT_NOT_FOUND|Contract could not be found|INACTIVE_CONTRACTS|inactive contract/i.test(
        hay
      )
    )
      return true;
    cur = e.cause;
  }
  return false;
}

/**
 * Accept every pending incoming transfer (e.g. the agent's initial funding).
 *
 * SECURITY: even though this path is funds-IN, it is NOT exempt from
 * verify-before-sign. A malicious relay returning an OUTBOUND drain
 * (CreateTransferCommand / TransferFactory_Transfer sending the agent's balance
 * to an attacker) instead of the accept the agent built would otherwise be
 * blind-signed. We pass `kind: "accept"`, which structurally proves the prepared
 * transaction is a single `TransferInstruction_Accept` submitted by the agent —
 * any outbound leg is rejected — and we bind the signed hash to those bytes
 * (fail-closed by default, exactly like the other paths). `opts.hashBinding`
 * lets a programmatic caller supply a participant-conformant recompute; the CLI
 * resolves it from the environment (default fail-closed).
 */
export async function claimAll(
  relay: RelayClient,
  wallet: AgentWallet,
  opts: { hashBinding?: HashBindingOptions } = {}
): Promise<{
  claimed: number;
  updateIds: string[];
  /** Instructions left alone because their executeBefore has passed; the
   *  ledger would refuse the accept, so attempting it only burns a prepare. */
  skippedExpired: number;
  /** Instructions whose accept failed; the others were still attempted. */
  failed: Array<{ cid: string; error: string }>;
  /** Offers of a token whose registrar this wallet has no trust anchor for
   *  (KNOWN_REGISTRY_TRUSTED_PARTIES / CANTON_AGENT_REGISTRY_TRUSTED_PARTIES).
   *  The agent cannot refuse to be SENT a token, but it refuses to ACT on one
   *  it cannot verify: such a row is left alone, named here, and never
   *  reaches prepare — so an honest-but-unanchored offer cannot trip
   *  verify-before-sign and stop the Canton Coin rows behind it. */
  skippedUntrusted: Array<{ cid: string; admin: string }>;
}> {
  const hashBinding = opts.hashBinding ?? resolveHashBinding();
  const { pending } = await relay.pending(wallet.party);
  const updateIds: string[] = [];
  const failed: Array<{ cid: string; error: string }> = [];
  const skippedUntrusted: Array<{ cid: string; admin: string }> = [];
  const trustedDso = resolveTrustedDsoParty(process.env, wallet.network);
  let skippedExpired = 0;
  const nowMs = Date.now();
  for (const p of pending) {
    // ONE BAD INSTRUCTION MUST NOT BLOCK THE REST. This loop used to throw on
    // the first failure, and pending is ordered oldest-first — so a single
    // expired offer (the ledger answers deadline-exceeded to its accept) made
    // every newer, perfectly claimable one unreachable. Measured live: three
    // expired USDCx offers ahead of one live one, claim failed, balance stayed
    // 0. Expired ones are skipped up front when the relay reports
    // executeBefore; anything else that fails is recorded and the loop goes on.
    if (p.executeBefore !== undefined && Date.parse(p.executeBefore) <= nowMs) {
      skippedExpired += 1;
      continue;
    }
    // A registry instruction's accept context lives on ITS registry, not the
    // SV Scan. /pending names the instrument on EVERY row (the
    // TransferInstructionV1 view always carries one — for Canton Coin it is the
    // DSO + "Amulet"), so the admin is forwarded only for a registry token; an
    // Amulet row keeps the SV Scan path it always had.
    // Canton Coin is recognised by the LOCAL DSO anchor, not by the row's own
    // label: a registrar that names a token "Amulet" is still a registrar.
    // Without a known DSO for this network the id is all there is to go on.
    const isCantonCoin =
      p.instrumentId === undefined ||
      (p.instrumentId.id === "Amulet" &&
        (trustedDso === undefined || p.instrumentId.admin === trustedDso));
    const registryAdmin = isCantonCoin ? undefined : p.instrumentId!.admin;
    // The trust anchor for a registry claim is LOCAL (the baked-in table or
    // the operator's env), never the relay's row. A registrar this wallet has
    // no anchor for cannot be verified — the honest accept names the registry
    // operator and bridge, which verify would rightly call foreign — so the
    // row is skipped here instead of being prepared and refused (a refusal is
    // treated as evidence about the relay and stops the loop).
    if (registryAdmin !== undefined && !isTrustedRegistryAdmin(registryAdmin, process.env)) {
      skippedUntrusted.push({ cid: p.cid, admin: registryAdmin });
      continue;
    }
    try {
    const ctx = await relay.resolveAccept({
      instructionCid: p.cid,
      ...(registryAdmin !== undefined ? { instrumentAdmin: registryAdmin } : {}),
    });
    const ex = {
      ExerciseCommand: {
        templateId: TI_IFACE,
        contractId: p.cid,
        choice: "TransferInstruction_Accept",
        choiceArgument: {
          extraArgs: { context: ctx.choiceContextData, meta: { values: {} } },
        },
      },
    };
    updateIds.push(
      await prepareSignExecute(
        relay,
        wallet,
        [ex],
        ctx.disclosedContracts,
        // VERIFY-before-sign: the prepared tx MUST be a single inbound accept by
        // the agent — never a relay-injected outbound drain.
        {
          kind: "accept",
          expect: {
            selfParty: wallet.party,
            nowMs: Date.now(),
            // A registry claim DECLARES its token: that is what admits the
            // registry two-step accept node, and the created holding is then
            // held to {agent, registrar, trusted registry parties}. A Canton
            // Coin claim declares nothing and keeps the Amulet-only whitelist.
            ...(registryAdmin !== undefined
              ? {
                  instrumentAdmin: registryAdmin,
                  trustedRegistryParties: resolveTrustedRegistryParties(registryAdmin, process.env),
                }
              : {}),
          },
        },
        hashBinding
      )
    );
    } catch (err) {
      // NOT EVERY FAILURE IS ONE ROW'S PROBLEM. prepareSignExecute runs
      // submitPrepare → verify-before-sign → hash-binding → sign → execute.
      // A refusal from the VERIFY step means the relay handed back bytes that
      // are not the accept we asked for — a drain, a tampered hash, an
      // unbindable binding. That is evidence about the RELAY, not about this
      // instruction, and the next row would be prepared by the same relay. It
      // must stop the whole claim, exactly as before; the security suites pin
      // that ("REJECTS an OUTBOUND DRAIN", "REFUSES with NO binding"). Only a
      // failure AFTER an honest transaction was signed — the ledger refusing
      // it, a transport error — is isolated to its row.
      if (
        err instanceof PreparedTransferMismatchError ||
        err instanceof PreparedDecodeError ||
        err instanceof PreparedHashUnavailableError
      ) {
        throw err;
      }
      failed.push({ cid: p.cid, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // `claimed` is what actually landed, not what was pending — the old value
  // reported every row as claimed even when the call had thrown.
  return { claimed: updateIds.length, updateIds, skippedExpired, failed, skippedUntrusted };
}

/**
 * SELF-PROVISION a merchant TransferPreapproval so this wallet's incoming
 * transfer-factory ("V3") payments settle DIRECT (1-tx) instead of Pending.
 * The merchant is BOTH provider and receiver (single controller), so it signs
 * with its OWN key — no facilitator CanActAs delegation, no operator token.
 *
 * The wallet must already hold a little CC (the choice burns a small fee from
 * the merchant's own Amulet). VERIFY-BEFORE-SIGN: the relay-prepared transaction
 * is refused unless it is exactly a single-root self-preapproval (see
 * assertPreparedSelfPreapproval).
 */
/** Backoff for the self-provision stale-input retry (same shape as the pay
 *  path's withStaleInputRetry). Bounded — bubbles up after the last attempt. */
const SELF_PREAPPROVAL_STALE_BACKOFF_MS = [1000, 2000, 4000, 8000, 12000];

export async function selfProvisionPreapproval(
  relay: RelayClient,
  wallet: AgentWallet,
  opts?: { expiresAt?: string; hashBinding?: HashBindingOptions },
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms))
): Promise<{ updateId: string }> {
  // ONE attempt: relay builds the CreateTransferPreapproval over the merchant's
  // CURRENT fee-input Amulet cids (prepare), the merchant signs, the relay
  // executes (commit).
  const attempt = async (): Promise<{ updateId: string }> => {
    const prep = await relay.preapprovalSelfPrepare(wallet.party, opts?.expiresAt);
    // Never sign a relay tx that does anything other than create OUR preapproval.
    // `prep.expiresAt` is the relay's OWN statement of the horizon it built.
    // Passing it back binds the bytes to that statement: a relay that says 90
    // days and encodes ten years is caught, and a caller who asked for a
    // specific date gets it checked below.
    assertPreparedSelfPreapproval(
      prep.preparedTransaction,
      wallet.party,
      prep.expiresAt
    );
    if (opts?.expiresAt !== undefined && prep.expiresAt !== opts.expiresAt) {
      throw new PreparedTransferMismatchError(
        `self-preapproval: asked for expiresAt ${JSON.stringify(opts.expiresAt)} but the relay ` +
          `built ${JSON.stringify(prep.expiresAt)} — refusing to sign`
      );
    }
    // ...and never sign a hash that is not the hash OF THOSE BYTES.
    //
    // Validating the bytes and then signing the relay's `txHash` is two
    // unconnected acts: a lying relay sends honest bytes — which pass the
    // assertion above — together with the hash of a completely different
    // transaction, and the wallet signs that other transaction. Every other
    // signing path in this file binds the two (lines 120 and 336); this was
    // the one that did not, which made the structural check above decorative
    // on exactly the path where the wallet signs with its own key and no
    // facilitator delegation stands in the way.
    // `?? resolveHashBinding()`, NOT `?? {}`. The `{}` form is correct only for
    // the INNER helpers (prepareSignExecute, the transfer-factory pay path),
    // whose public entry points — claimAll, makeRelaySigner, withdraw — have
    // already resolved a real recompute before calling down. This function IS a
    // public entry point: every caller (the `preapproval` CLI command and all
    // the e2e drivers) passes no hashBinding, so `{}` here means "no recompute
    // available" and the binding assert fails closed on the honest path —
    // turning a silent blind-sign into a hard-broken command. resolveHashBinding
    // supplies the participant-conformant V2 recompute by default.
    await assertHashBinding(
      prep.preparedTransaction,
      prep.txHash,
      opts?.hashBinding ?? resolveHashBinding()
    );
    const signature = signHashB64(prep.txHash, wallet.privateKeyPkcs8Pem);
    return relay.preapprovalSelfCommit({
      party: wallet.party,
      preparedTransaction: prep.preparedTransaction,
      hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
      partySignatures: {
        signatures: [
          {
            party: wallet.party,
            signatures: [
              {
                format: "SIGNATURE_FORMAT_CONCAT",
                signature,
                signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519",
                signedBy: wallet.publicKeyFingerprint,
              },
            ],
          },
        ],
      },
    });
  };
  // Re-prepare + re-sign + re-commit on a stale-input rejection: the relay pins
  // the fee-input Amulet cids at PREPARE time, and a mining-round roll (or a
  // concurrent claim) in the prepare→commit window archives them, giving
  // LOCAL_VERDICT_INACTIVE_CONTRACTS at execute. Each retry re-reads fresh
  // holdings. Mirrors the pay path's withStaleInputRetry.
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (
        i < SELF_PREAPPROVAL_STALE_BACKOFF_MS.length &&
        isStaleInputHoldingError(err)
      ) {
        await sleep(SELF_PREAPPROVAL_STALE_BACKOFF_MS[i]!);
        continue;
      }
      throw err;
    }
  }
}

/**
 * SELF-PROVISION a registry (non-Amulet CIP-56, e.g. USDCx) TransferPreapproval so
 * this wallet can RECEIVE that token one-shot (direct). The registry analogue of
 * {@link selfProvisionPreapproval}: the relay fetches the registry operator and
 * builds the plain CREATE of the wallet's own
 * `Utility.Registry.App.V0.Model.TransferPreapproval` (no fee, no mining rounds),
 * the wallet VERIFY-BEFORE-SIGNs it (assertPreparedRegistrySelfPreapproval — the
 * only parties allowed are the wallet, the instrument admin, and the out-of-band
 * trusted registry infra), signs with its OWN key, and commits via the shared
 * self/commit route. The instrument admin must be a configured registry on the
 * relay AND a known/configured trusted registry on the client (so the operator is
 * an out-of-band-trusted party, never blind-trusted from the relay).
 */
export async function selfProvisionRegistryPreapproval(
  relay: RelayClient,
  wallet: AgentWallet,
  opts: {
    instrumentId: { admin: string; id: string };
    hashBinding?: HashBindingOptions;
  }
): Promise<{ updateId: string }> {
  const { admin, id } = opts.instrumentId;
  const trustedRegistryParties = resolveTrustedRegistryParties(admin, process.env);
  if (trustedRegistryParties.size === 0) {
    throw new PreparedTransferMismatchError(
      `registry self-preapproval: instrument admin ${JSON.stringify(admin)} has no out-of-band ` +
        `trusted registry parties (set CANTON_AGENT_REGISTRY_TRUSTED_PARTIES or use a known ` +
        `registry) — refusing to sign a relay-built create with no trust anchor`
    );
  }
  const prep = await relay.preapprovalRegistrySelfPrepare(wallet.party, { admin, id });
  // Never sign a relay tx that does anything other than create OUR registry
  // preapproval, or that names any party beyond {us, admin, trusted registry infra}.
  assertPreparedRegistrySelfPreapproval(prep.preparedTransaction, {
    party: wallet.party,
    admin,
    trustedRegistryParties,
  });
  // ...and never sign a hash that is not the hash OF THOSE BYTES (real V2 recompute
  // by default; this is a public entry point, like selfProvisionPreapproval).
  await assertHashBinding(
    prep.preparedTransaction,
    prep.hash,
    opts.hashBinding ?? resolveHashBinding()
  );
  const signature = signHashB64(prep.hash, wallet.privateKeyPkcs8Pem);
  return relay.preapprovalSelfCommit({
    party: wallet.party,
    preparedTransaction: prep.preparedTransaction,
    hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
    partySignatures: {
      signatures: [
        {
          party: wallet.party,
          signatures: [
            {
              format: "SIGNATURE_FORMAT_CONCAT",
              signature,
              signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519",
              signedBy: wallet.publicKeyFingerprint,
            },
          ],
        },
      ],
    },
  });
}
