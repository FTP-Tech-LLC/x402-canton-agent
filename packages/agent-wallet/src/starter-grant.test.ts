import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { faithfulOnboarding } from "./_topology-fixture.js";
import type * as Tx from "./tx.js";

const claimAll = vi.fn();
vi.mock("./tx.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Tx>()),
  claimAll: (...a: unknown[]) => claimAll(...a),
}));

const { acceptStarterGrant } = await import("./starter-grant.js");
const { ensureWallet } = await import("./onboard.js");

const WALLET = {
  network: "canton:mainnet",
  relayUrl: "http://relay",
  party: "agent::1220aa",
  publicKeySpkiB64: "pk",
  privateKeyPkcs8Pem: "pem",
  publicKeyFingerprint: "fp",
  createdAt: "2026-09-19T00:00:00.000Z",
};
const GRANT = { amountCc: "1" };
const FAST = { timeoutMs: 200, pollMs: 5 };
const offer = (over: Record<string, unknown> = {}) => ({
  cid: "00offer",
  amount: "1.0000000000",
  instrumentId: { admin: "DSO::1220", id: "Amulet" },
  executeBefore: new Date(Date.now() + 3_600_000).toISOString(),
  ...over,
});
const claimed = (updateIds = ["u-accept"]) => ({
  claimed: updateIds.length,
  updateIds,
  skippedExpired: 0,
  failed: [],
  skippedUntrusted: [],
});

let tmp: string;
beforeEach(() => {
  claimAll.mockReset();
  tmp = mkdtempSync(join(tmpdir(), "caw-grant-"));
  process.env.CANTON_AGENT_HOME = tmp;
});
afterEach(() => {
  delete process.env.CANTON_AGENT_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe("acceptStarterGrant", () => {
  it("waits for the offer, then accepts it", async () => {
    const pending = vi
      .fn()
      .mockResolvedValueOnce({ party: WALLET.party, pending: [] })
      .mockResolvedValueOnce({ party: WALLET.party, pending: [] })
      .mockResolvedValue({ party: WALLET.party, pending: [offer()] });
    claimAll.mockResolvedValue(claimed());
    const r = await acceptStarterGrant({ pending } as never, WALLET, GRANT, FAST);
    expect(r).toEqual({ status: "accepted", amountCc: "1", updateIds: ["u-accept"] });
    expect(pending).toHaveBeenCalledTimes(3);
    expect(claimAll).toHaveBeenCalledTimes(1);
  });

  it("gives up quietly when no offer comes", async () => {
    const pending = vi.fn().mockResolvedValue({ party: WALLET.party, pending: [] });
    const r = await acceptStarterGrant({ pending } as never, WALLET, GRANT, FAST);
    expect(r.status).toBe("not_arrived");
    expect(claimAll).not.toHaveBeenCalled();
  });

  it("does not act on rows that cannot be the grant (another token, or expired)", async () => {
    const pending = vi.fn().mockResolvedValue({
      party: WALLET.party,
      pending: [
        offer({ instrumentId: { admin: "reg::1220", id: "USDCx" } }),
        offer({ executeBefore: new Date(Date.now() - 1000).toISOString() }),
      ],
    });
    const r = await acceptStarterGrant({ pending } as never, WALLET, GRANT, FAST);
    expect(r.status).toBe("not_arrived");
    expect(claimAll).not.toHaveBeenCalled();
  });

  it("retries a failed accept and reports the failure if it never goes through", async () => {
    const pending = vi.fn().mockResolvedValue({ party: WALLET.party, pending: [offer()] });
    claimAll.mockResolvedValue({ ...claimed([]), failed: [{ cid: "00offer", error: "scan 503" }] });
    const r = await acceptStarterGrant({ pending } as never, WALLET, GRANT, FAST);
    expect(r).toMatchObject({ status: "failed", error: "scan 503" });
    expect(claimAll.mock.calls.length).toBeGreaterThan(1);
  });

  it("rides out a relay hiccup while polling", async () => {
    const pending = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValue({ party: WALLET.party, pending: [offer()] });
    claimAll.mockResolvedValue(claimed());
    const r = await acceptStarterGrant({ pending } as never, WALLET, GRANT, FAST);
    expect(r.status).toBe("accepted");
  });

  it("never throws, even when accepting throws", async () => {
    const pending = vi.fn().mockResolvedValue({ party: WALLET.party, pending: [offer()] });
    claimAll.mockRejectedValue(new Error("verify-before-sign refused"));
    const r = await acceptStarterGrant({ pending } as never, WALLET, GRANT, FAST);
    expect(r).toMatchObject({ status: "failed", error: "verify-before-sign refused" });
  });
});

/** An honest relay (real topology for the agent's own key) whose finalize
 *  answer may announce a starter grant. */
function relayWithGrant(starterGrant?: { status: string; amountCc: string }) {
  let built: Awaited<ReturnType<typeof faithfulOnboarding>> | undefined;
  return {
    onboardPrepare: vi.fn().mockImplementation(async (b: { publicKey: { keyData: string } }) => {
      built = await faithfulOnboarding(b.publicKey.keyData);
      return {
        party: built.party,
        publicKeyFingerprint: built.publicKeyFingerprint,
        onboardingTransactions: built.onboardingTransactions,
        hashToSign: built.hashToSign,
      };
    }),
    onboardFinalize: vi
      .fn()
      .mockImplementation(async () => ({ party: built!.party, ...(starterGrant ? { starterGrant } : {}) })),
    supported: vi.fn().mockResolvedValue({ kinds: [{ network: "canton:mainnet" }] }),
    pending: vi.fn().mockResolvedValue({ party: "x", pending: [offer()] }),
  };
}
const SCHEDULED = { status: "scheduled", amountCc: "1" };
const base = { relayUrl: "http://relay", network: "canton:mainnet", starterGrantTimeoutMs: 200, starterGrantPollMs: 5 };

describe("ensureWallet and the starter grant", () => {
  it("by default accepts the grant before handing the new wallet back", async () => {
    const relay = relayWithGrant(SCHEDULED);
    claimAll.mockResolvedValue(claimed());
    const seen = vi.fn();
    const w = await ensureWallet({ ...base, relay: relay as never, onStarterGrant: seen });
    expect(claimAll).toHaveBeenCalledTimes(1);
    expect(claimAll.mock.calls[0]![1]).toMatchObject({ party: w.party });
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ status: "accepted", amountCc: "1" }));
  });

  it("background: returns first, accepts after, and reports it", async () => {
    const relay = relayWithGrant(SCHEDULED);
    let accept!: (v: unknown) => void;
    claimAll.mockReturnValue(new Promise((r) => (accept = r)));
    const seen = vi.fn();
    const w = await ensureWallet({ ...base, relay: relay as never, starterGrant: "background", onStarterGrant: seen });
    expect(w.party).toBeTruthy();
    expect(seen).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(claimAll).toHaveBeenCalled());
    accept(claimed());
    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith(expect.objectContaining({ status: "accepted" })));
  });

  it("leave: the offer stays pending for `claim`", async () => {
    const relay = relayWithGrant(SCHEDULED);
    await ensureWallet({ ...base, relay: relay as never, starterGrant: "leave" });
    expect(relay.pending).not.toHaveBeenCalled();
    expect(claimAll).not.toHaveBeenCalled();
  });

  it("does nothing when the relay announces no grant", async () => {
    const relay = relayWithGrant();
    await ensureWallet({ ...base, relay: relay as never });
    expect(relay.pending).not.toHaveBeenCalled();
    expect(claimAll).not.toHaveBeenCalled();
  });

  it("a grant that fails to arrive never fails the wallet", async () => {
    const relay = relayWithGrant(SCHEDULED);
    relay.pending.mockResolvedValue({ party: "x", pending: [] });
    const seen = vi.fn();
    const w = await ensureWallet({ ...base, relay: relay as never, onStarterGrant: seen });
    expect(w.party).toBeTruthy();
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ status: "not_arrived" }));
  });

  it("a throwing observer does not fail the wallet either", async () => {
    const relay = relayWithGrant(SCHEDULED);
    claimAll.mockResolvedValue(claimed());
    const w = await ensureWallet({
      ...base,
      relay: relay as never,
      onStarterGrant: () => {
        throw new Error("observer bug");
      },
    });
    expect(w.party).toBeTruthy();
  });
});
