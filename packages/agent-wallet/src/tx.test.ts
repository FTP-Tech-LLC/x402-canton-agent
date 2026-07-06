import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { transfer, claimAll } from "./tx.js";
import { RelayClient } from "./relay-client.js";
import { generateAgentKey, verifyHashB64 } from "./keys.js";
import { PreparedTransferMismatchError, type HashBindingOptions } from "./verify-prepared.js";
import type { AgentWallet } from "./store.js";
// Faithful Canton PreparedTransaction builder (real Ledger API field numbers).
import { buildPrepared, buildPreparedAccept } from "./_prepared-fixture.js";

/** Deterministic stand-in for Canton's V2 hash (plain sha256 of the bytes).
 *  Lets these tests exercise the real recompute-and-compare BINDING; the
 *  production recompute must be participant-conformant (see verify-prepared.ts). */
function RECOMPUTE(b64: string): string {
  return createHash("sha256").update(Buffer.from(b64, "base64")).digest("base64");
}
/** The binding a well-configured agent passes for value-moving transfers. */
const BOUND: HashBindingOptions = { recomputeHash: RECOMPUTE };

function wallet(): AgentWallet {
  const k = generateAgentKey();
  return {
    network: "canton:testnet",
    relayUrl: "http://relay",
    party: "agent::1220abcd",
    publicKeySpkiB64: k.publicKeySpkiB64,
    privateKeyPkcs8Pem: k.privateKeyPkcs8Pem,
    publicKeyFingerprint: "agentfp",
    createdAt: "t",
  };
}

const DSO = "DSO::1220cafe";
// Dotted hint — a legal Canton party id the OLD regex verifier could not handle.
const MERCHANT = "merchant.payments::1220beef";

interface RelayScript {
  /** What preparedTransaction the relay returns (default: honest). `contractId`
   *  is the resolved factory cid the command targets — an honest builder echoes
   *  it into Exercise.contract_id (the agent pins it; see C2). */
  prepared?: (
    req: { sender: string; receiver: string; amount: string },
    contractId: string
  ) => string;
  /** Override the relay-returned hash (default a non-empty placeholder). */
  hash?: string;
  onExecute?: (body: Record<string, unknown>) => void;
}

/** Stub a relay over fetch. Captures whether execute was reached. */
function stubRelay(script: RelayScript = {}): { executed: () => boolean; seen: string[] } {
  const seen: string[] = [];
  let executed = false;
  const w = wallet();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body?: string } = {}) => {
      seen.push(url);
      if (url.endsWith("/balance")) {
        return new Response(
          JSON.stringify({
            party: w.party,
            amulet: 1,
            cc: "10.0",
            holdings: [{ cid: "h1", amount: "10.0" }],
          }),
          { status: 200 }
        );
      }
      if (url.endsWith("/v1/wallet/resolve/transfer-factory")) {
        const b = JSON.parse(init.body ?? "{}");
        return new Response(
          JSON.stringify({
            factoryId: "fc1",
            transferKind: "direct",
            transferFactoryTemplateId: "#pkg:Mod:TransferFactory",
            instrumentId: { admin: DSO, id: "Amulet" },
            choiceContextData: { values: {} },
            disclosedContracts: [],
            _echo: b,
          }),
          { status: 200 }
        );
      }
      if (url.endsWith("/v1/wallet/submit/prepare")) {
        const b = JSON.parse(init.body ?? "{}");
        const cmd = b.commands[0].ExerciseCommand;
        const ex = cmd.choiceArgument.transfer;
        // claimAll exercises TransferInstruction_Accept (no `transfer` field).
        // The HONEST relay returns a real Accept prepared tx — the agent now
        // structurally verifies (kind: "accept") that the prepared tx is a single
        // inbound accept by the agent, so the mock must return that shape. An
        // honest relay also prepares the exercise against the SAME contract the
        // command targets, so we echo `cmd.contractId` into Exercise.contract_id
        // (the agent now pins it; see C2 / expectedContractId).
        const prepared = ex
          ? script.prepared
            ? script.prepared(
                { sender: ex.sender, receiver: ex.receiver, amount: ex.amount },
                cmd.contractId
              )
            : buildHonest(
                { sender: ex.sender, receiver: ex.receiver, amount: ex.amount },
                { contractId: cmd.contractId }
              )
          : buildPreparedAccept({ selfParty: "agent::1220abcd" });
        return new Response(
          JSON.stringify({
            preparedTransaction: prepared,
            // Default: an HONEST relay returns the hash OF the prepared bytes.
            // Tests can override `script.hash` to simulate a tampered/empty hash.
            hash: script.hash ?? RECOMPUTE(prepared),
          }),
          { status: 200 }
        );
      }
      if (url.endsWith("/v1/wallet/submit/execute")) {
        executed = true;
        script.onExecute?.(JSON.parse(init.body ?? "{}"));
        return new Response(JSON.stringify({ updateId: "u1" }), { status: 200 });
      }
      if (url.endsWith("/pending")) {
        return new Response(
          JSON.stringify({ party: w.party, pending: [{ cid: "ti1", amount: "5.0" }] }),
          { status: 200 }
        );
      }
      if (url.endsWith("/v1/wallet/resolve/accept")) {
        return new Response(
          JSON.stringify({ choiceContextData: { values: {} }, disclosedContracts: [] }),
          { status: 200 }
        );
      }
      return new Response("not found", { status: 404 });
    })
  );
  return { executed: () => executed, seen };
}

function buildHonest(
  req: { sender: string; receiver: string; amount: string },
  o: { contractId?: string } = {}
): string {
  return buildPrepared({
    sender: req.sender,
    receiver: req.receiver,
    amount: req.amount,
    admin: DSO,
    id: "Amulet",
    ...(o.contractId !== undefined ? { contractId: o.contractId } : {}),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("transfer (verify-before-sign)", () => {
  it("happy path: resolves, verifies, binds hash, signs, executes, returns updateId", async () => {
    const r = stubRelay();
    const relay = new RelayClient({ relayUrl: "http://relay" });
    const updateId = await transfer(relay, wallet(), {
      receiver: MERCHANT,
      amount: "1.0000000000",
      hashBinding: BOUND,
    });
    expect(updateId).toBe("u1");
    expect(r.executed()).toBe(true);
  });

  it("execute carries a real Ed25519 signature over the recomputed prepared hash", async () => {
    let signed: { hash: string; sig: string; signedBy: string } | undefined;
    const w = wallet();
    stubRelay({
      onExecute: (body) => {
        const b = body as never as {
          preparedTransaction: string;
          partySignatures: { signatures: Array<{ signatures: Array<{ signature: string; signedBy: string }> }> };
        };
        const ps = b.partySignatures.signatures[0].signatures[0];
        // The honest relay returned RECOMPUTE(prepared) as the hash; the agent
        // bound it (it equals the local recompute) and signed THAT.
        signed = { hash: RECOMPUTE(b.preparedTransaction), sig: ps.signature, signedBy: ps.signedBy };
      },
    });
    await transfer(new RelayClient({ relayUrl: "http://relay" }), w, {
      receiver: MERCHANT,
      amount: "1.0000000000",
      hashBinding: BOUND,
    });
    expect(signed).toBeDefined();
    expect(signed!.signedBy).toBe(w.publicKeyFingerprint);
    expect(verifyHashB64(signed!.hash, signed!.sig, w.publicKeySpkiB64)).toBe(true);
  });

  it("REJECTS a relay that prepares a transfer to a DIFFERENT receiver (no execute)", async () => {
    const r = stubRelay({
      prepared: (req, contractId) =>
        buildPrepared({
          sender: req.sender,
          receiver: "attacker::1220dead", // relay swapped the receiver
          amount: req.amount,
          admin: DSO,
          id: "Amulet",
          contractId, // honest target cid — the tamper is the receiver
        }),
    });
    await expect(
      transfer(new RelayClient({ relayUrl: "http://relay" }), wallet(), {
        receiver: MERCHANT,
        amount: "1.0000000000",
        hashBinding: BOUND,
      })
    ).rejects.toBeInstanceOf(PreparedTransferMismatchError);
    expect(r.executed()).toBe(false); // never signed/executed the tampered tx
  });

  it("REJECTS a relay that inflates the amount (no execute)", async () => {
    const r = stubRelay({
      prepared: (req, contractId) =>
        buildPrepared({
          sender: req.sender,
          receiver: req.receiver,
          amount: "9999.0000000000", // relay inflated the amount
          admin: DSO,
          id: "Amulet",
          contractId, // honest target cid — the tamper is the amount
        }),
    });
    await expect(
      transfer(new RelayClient({ relayUrl: "http://relay" }), wallet(), {
        receiver: MERCHANT,
        amount: "1.0000000000",
        hashBinding: BOUND,
      })
    ).rejects.toThrow(/amount/);
    expect(r.executed()).toBe(false);
  });

  it("BYPASS #2 e2e: REJECTS a relay that sets admin==receiver==attacker to self-whitelist (no execute)", async () => {
    const attacker = "att.acker::1220dead";
    const r = stubRelay({
      prepared: (req, contractId) =>
        buildPrepared({
          sender: req.sender,
          receiver: attacker, // funds redirected
          amount: req.amount,
          admin: attacker, // relay tries to whitelist itself via the instrument admin
          id: "Amulet",
          contractId, // honest target cid — the tamper is receiver/admin
        }),
    });
    await expect(
      transfer(new RelayClient({ relayUrl: "http://relay" }), wallet(), {
        receiver: MERCHANT,
        amount: "1.0000000000",
        hashBinding: BOUND,
      })
    ).rejects.toBeInstanceOf(PreparedTransferMismatchError);
    expect(r.executed()).toBe(false); // relay-supplied admin never widened the allowlist
  });

  it("BYPASS #2 e2e: REJECTS a relay that swaps the instrument id (no execute)", async () => {
    const r = stubRelay({
      prepared: (req, contractId) =>
        buildPrepared({
          sender: req.sender,
          receiver: req.receiver,
          amount: req.amount,
          admin: DSO,
          id: "Sketchcoin", // relay swapped the asset
          contractId, // honest target cid — the tamper is the instrument id
        }),
    });
    await expect(
      transfer(new RelayClient({ relayUrl: "http://relay" }), wallet(), {
        receiver: MERCHANT,
        amount: "1.0000000000",
        hashBinding: BOUND,
      })
    ).rejects.toThrow(/instrumentId\.id/);
    expect(r.executed()).toBe(false);
  });

  it("BYPASS #4 e2e: REJECTS (fail-closed) when the relay returns an EMPTY hash (no execute)", async () => {
    const r = stubRelay({ hash: "" }); // honest bytes, but no hash to bind/sign
    await expect(
      transfer(new RelayClient({ relayUrl: "http://relay" }), wallet(), {
        receiver: MERCHANT,
        amount: "1.0000000000",
        hashBinding: BOUND,
      })
    ).rejects.toBeInstanceOf(PreparedTransferMismatchError);
    expect(r.executed()).toBe(false); // never signed an unbound/empty hash
  });

  it("BYPASS B e2e: REJECTS honest bytes paired with the hash of a DIFFERENT tx (no execute)", async () => {
    // Compromised relay: returns honest PT_good but hash = RECOMPUTE(PT_evil),
    // intending to forward PT_evil (9999 → attacker) to the participant later.
    const evilHash = RECOMPUTE(
      buildPrepared({
        sender: "agent::1220abcd",
        receiver: "att.acker::1220dead",
        amount: "9999.0000000000",
        admin: DSO,
        id: "Amulet",
      })
    );
    const r = stubRelay({ hash: evilHash }); // prepared bytes stay honest
    await expect(
      transfer(new RelayClient({ relayUrl: "http://relay" }), wallet(), {
        receiver: MERCHANT,
        amount: "1.0000000000",
        hashBinding: BOUND, // agent recomputes the hash of the validated bytes
      })
    ).rejects.toBeInstanceOf(PreparedTransferMismatchError);
    expect(r.executed()).toBe(false); // recomputed hash != relay hash → never signed
  });

  it("BYPASS B e2e: REFUSES to sign a value-moving transfer when NO binding is configured (default fail-closed)", async () => {
    const r = stubRelay(); // honest relay, honest hash — but agent can't bind it
    await expect(
      transfer(new RelayClient({ relayUrl: "http://relay" }), wallet(), {
        receiver: MERCHANT,
        amount: "1.0000000000",
        // hashBinding omitted → default fail-closed (no recompute, no opt-in)
      })
    ).rejects.toBeInstanceOf(PreparedTransferMismatchError);
    expect(r.executed()).toBe(false);
  });

  it("allows an explicit trustRelayHash opt-in to sign (documented escape hatch)", async () => {
    const r = stubRelay(); // honest relay
    const updateId = await transfer(new RelayClient({ relayUrl: "http://relay" }), wallet(), {
      receiver: MERCHANT,
      amount: "1.0000000000",
      hashBinding: { trustRelayHash: true },
    });
    expect(updateId).toBe("u1");
    expect(r.executed()).toBe(true);
  });
});

describe("claimAll", () => {
  it("accepts each pending incoming transfer (verify-before-sign: accept arm + hash binding)", async () => {
    const r = stubRelay();
    const out = await claimAll(new RelayClient({ relayUrl: "http://relay" }), wallet(), {
      hashBinding: BOUND,
    });
    expect(out.claimed).toBe(1);
    expect(out.updateIds).toEqual(["u1"]);
    expect(r.executed()).toBe(true);
  });

  it("REFUSES to sign the accept when NO binding is configured (default fail-closed)", async () => {
    const r = stubRelay(); // honest accept bytes + honest hash, but agent can't bind it
    await expect(
      claimAll(new RelayClient({ relayUrl: "http://relay" }), wallet())
    ).rejects.toBeInstanceOf(PreparedTransferMismatchError);
    expect(r.executed()).toBe(false);
  });
});
