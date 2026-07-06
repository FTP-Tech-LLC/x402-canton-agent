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
  assertPreparedAcceptMatches,
  type HashBindingOptions,
  type PreparedTransferExpectation,
  type PreparedAcceptExpectation,
} from "./verify-prepared.js";

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
  }
): Promise<string> {
  const inputHoldingCids =
    opts.inputHoldingCids ?? (await relay.balance(wallet.party)).holdings.map((h) => h.cid);
  const f = await relay.resolveTransferFactory({
    sender: wallet.party,
    receiver: opts.receiver,
    amount: opts.amount,
    ...(opts.meta ? { meta: opts.meta } : {}),
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
        nowMs: Date.now(),
      },
    },
    opts.hashBinding,
    opts.expectSynchronizerId
  );
}

/**
 * transfer-factory ("V3") pay: PREPARE + VERIFY-BEFORE-SIGN + SIGN + COMMIT a
 * relay-built `TransferFactory_Transfer` to the merchant, leaving it STASHED on
 * the relay (the facilitator relays it later at /settle). Returns the small
 * `submissionRef` the x402 payload carries.
 *
 * Same security recipe as `prepareSignExecute` — `assertPreparedTransferMatches`
 * pins the relay-built transfer to CALLER INTENT (sender = self, receiver =
 * payTo, amount, instrument), then `assertHashBinding` proves the signed hash is
 * the hash of those validated bytes — but it COMMITS (attaches the signature to
 * the stash) instead of executing, because the facilitator (not the payer) is
 * the submitter on this path.
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
  }
): Promise<{ payerParty: string; submissionRef: string; txHash: string }> {
  const prep = await relay.payPrepare({
    party: wallet.party,
    receiver: opts.receiver,
    amount: opts.amount,
    ...(opts.executeBeforeSeconds !== undefined
      ? { executeBeforeSeconds: opts.executeBeforeSeconds }
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
    nowMs: Date.now(),
  });
  // Hash binding: the hash we sign MUST be the hash of the validated bytes.
  await assertHashBinding(preparedTransaction, prep.txHash, opts.hashBinding ?? {});
  const signature = signHashB64(prep.txHash, wallet.privateKeyPkcs8Pem);
  await relay.payCommit({
    party: wallet.party,
    submissionRef: prep.submissionRef,
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
  return {
    payerParty: wallet.party,
    submissionRef: prep.submissionRef,
    txHash: prep.txHash,
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
): Promise<{ claimed: number; updateIds: string[] }> {
  const hashBinding = opts.hashBinding ?? resolveHashBinding();
  const { pending } = await relay.pending(wallet.party);
  const updateIds: string[] = [];
  for (const p of pending) {
    const ctx = await relay.resolveAccept({ instructionCid: p.cid });
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
        { kind: "accept", expect: { selfParty: wallet.party, nowMs: Date.now() } },
        hashBinding
      )
    );
  }
  return { claimed: pending.length, updateIds };
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
  opts?: { expiresAt?: string },
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms))
): Promise<{ updateId: string }> {
  // ONE attempt: relay builds the CreateTransferPreapproval over the merchant's
  // CURRENT fee-input Amulet cids (prepare), the merchant signs, the relay
  // executes (commit).
  const attempt = async (): Promise<{ updateId: string }> => {
    const prep = await relay.preapprovalSelfPrepare(wallet.party, opts?.expiresAt);
    // Never sign a relay tx that does anything other than create OUR preapproval.
    assertPreparedSelfPreapproval(prep.preparedTransaction, wallet.party);
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
