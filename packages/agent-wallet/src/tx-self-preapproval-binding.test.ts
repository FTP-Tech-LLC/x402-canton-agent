/**
 * The merchant self-provision path signs with the merchant's OWN key and no
 * facilitator delegation stands between it and the ledger, so it is the path
 * where a lying relay has the most to gain — and it was the ONE signing path
 * in this package with no hash binding.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const assertPreparedSelfPreapproval = vi.fn();
const assertHashBinding = vi.fn(async () => {});
vi.mock("./verify-prepared.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  assertPreparedSelfPreapproval: (...a: unknown[]) =>
    assertPreparedSelfPreapproval(...a),
  assertHashBinding: (...a: unknown[]) => assertHashBinding(...a),
}));

const { selfProvisionPreapproval } = await import("./tx.js");

const BYTES = "cHJlcGFyZWQtYnl0ZXM=";
const HASH = "aGFzaC1vZi10aG9zZS1ieXRlcw==";
const wallet = {
  party: "agent::1220aa",
  // A real PKCS8 Ed25519 key, so signHashB64 does not throw before we get to
  // assert anything.
  privateKeyPkcs8Pem:
    "-----BEGIN PRIVATE KEY-----\n" +
    "MC4CAQAwBQYDK2VwBCIEIJ1qOaJ0z1Vv0iSJ0uZ1uZ1uZ1uZ1uZ1uZ1uZ1uZ1uZ1\n" +
    "-----END PRIVATE KEY-----\n",
  publicKeyFingerprint: "1220bb",
  // mainnet: the DSO the structural assert is pinned to is resolved out of band.
  network: "canton:mainnet",
} as never;
const MAINNET_DSO =
  "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";

const EXPIRES = "2026-11-10T00:00:00Z";

beforeEach(() => {
  assertPreparedSelfPreapproval.mockReset();
  assertHashBinding.mockReset().mockResolvedValue(undefined);
});

function relay(commit = vi.fn(async () => ({ updateId: "1220-done" }))) {
  return {
    obj: {
      preapprovalSelfPrepare: vi.fn(async () => ({
        preparedTransaction: BYTES,
        txHash: HASH,
        // The relay STATES the horizon it built, and the caller passes that
        // statement back into the structural assert so the bytes are bound to
        // it. A fake without it would not exercise the real call shape.
        expiresAt: EXPIRES,
      })),
      preapprovalSelfCommit: commit,
    } as never,
    commit,
  };
}

describe("selfProvisionPreapproval binds the signed hash to the validated bytes", () => {
  it("calls assertHashBinding with THOSE bytes and THAT hash, before committing", async () => {
    // Validating the bytes and then signing the relay's hash are two
    // unconnected acts. A lying relay sends honest bytes — which pass the
    // structural assertion — with the hash of a completely different
    // transaction, and the merchant signs that other transaction with its own
    // key. Every other signing path in tx.ts binds the two; this one did not,
    // which made the structural check decorative exactly where it mattered
    // most.
    const r = relay();
    await selfProvisionPreapproval(r.obj, wallet).catch(() => undefined);
    expect(assertPreparedSelfPreapproval).toHaveBeenCalledWith(BYTES, {
      party: (wallet as { party: string }).party,
      dso: MAINNET_DSO,
      expectedExpiresAt: EXPIRES,
    });
    expect(assertHashBinding).toHaveBeenCalledTimes(1);
    expect(assertHashBinding.mock.calls[0]![0]).toBe(BYTES);
    expect(assertHashBinding.mock.calls[0]![1]).toBe(HASH);
  });

  it("with NO hashBinding option it still passes a REAL recompute, not an empty bag", async () => {
    // The two tests above mock assertHashBinding, so they prove only that the
    // assert is CALLED — never that it can succeed. That gap shipped a live
    // regression: the assert was wired with `?? {}`, which is right for the
    // inner helpers (their public wrappers resolve first) but wrong here,
    // because this IS the public entry point and every caller — the
    // `preapproval` CLI command, all the e2e drivers — passes no options. An
    // empty bag means "no recompute available", so the binding failed closed on
    // the HONEST path and the command threw for everyone.
    //
    // Asserting on the third argument is what discriminates: it is the only
    // observable that distinguishes "assert called" from "assert callable".
    const r = relay();
    await selfProvisionPreapproval(r.obj, wallet).catch(() => undefined);
    const passed = assertHashBinding.mock.calls[0]![2] as {
      recomputeHash?: unknown;
    };
    expect(typeof passed.recomputeHash).toBe("function");
  });

  it("an explicit hashBinding from the caller still wins over the default", async () => {
    const r = relay();
    const recomputeHash = vi.fn();
    await selfProvisionPreapproval(r.obj, wallet, {
      hashBinding: { recomputeHash } as never,
    }).catch(() => undefined);
    expect(assertHashBinding.mock.calls[0]![2]).toEqual({ recomputeHash });
  });

  it("a REFUSED binding stops the commit — nothing is signed onto the ledger", async () => {
    const r = relay();
    assertHashBinding.mockRejectedValue(new Error("hash does not match bytes"));
    await expect(selfProvisionPreapproval(r.obj, wallet)).rejects.toThrow(
      /hash does not match bytes/
    );
    expect(r.commit).not.toHaveBeenCalled();
  });

  it("without an out-of-band DSO nothing is prepared or signed", async () => {
    const r = relay();
    const noNet = { ...(wallet as object), network: "canton:unknown" } as never;
    await expect(selfProvisionPreapproval(r.obj, noNet)).rejects.toThrow(/no trusted DSO/);
    expect((r.obj as { preapprovalSelfPrepare: ReturnType<typeof vi.fn> }).preapprovalSelfPrepare).not.toHaveBeenCalled();
    expect(r.commit).not.toHaveBeenCalled();
  });
});
