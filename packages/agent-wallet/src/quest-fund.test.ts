import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { questFund, QuestFundError, fundViaQuest } from "./quest-fund.js";
import type { AgentWallet } from "./store.js";

const noSleep = async () => {};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("questFund (pay-proxy 2-step client)", () => {
  it("drives create→poll→pay→poll and returns the funded wallet + image", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/v1/quest/wallet/create"))
        return json({ walletJobId: "wj1", status: "pending" }, 202);
      if (url.includes("/v1/quest/wallet/result"))
        return json({
          status: "funded",
          secret: "-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----",
          walletToken: "tok1",
          party: "agent::1220m",
          network: "canton:mainnet",
        });
      if (url.endsWith("/v1/quest/wallet/pay"))
        return json({ payJobId: "pj1", status: "pending" }, 202);
      if (url.includes("/v1/quest/wallet/pay-result"))
        return json({
          status: "done",
          party: "agent::1220m",
          updateId: "u-transa",
          balanceCc: "0.05",
          image: "https://img.example/x.png",
        });
      return json({ error: "not found" }, 404);
    });

    const r = await questFund({
      payProxyUrl: "https://pay.example/",
      fetchImpl: fetchImpl as never,
      sleep: noSleep,
      prompt: "a lighthouse",
    });
    expect(r.party).toBe("agent::1220m");
    expect(r.secret).toContain("PRIVATE KEY");
    expect(r.balanceCc).toBe("0.05");
    expect(r.updateId).toBe("u-transa");
    expect(r.image).toBe("https://img.example/x.png");
    // trailing slash trimmed; the four legs fired in order.
    expect(calls[0]).toBe("POST https://pay.example/v1/quest/wallet/create");
    // the pay POST carried the walletToken + prompt.
    const payCall = fetchImpl.mock.calls.find((c) =>
      String(c[0]).endsWith("/v1/quest/wallet/pay")
    );
    expect(JSON.parse((payCall![1] as RequestInit).body as string)).toEqual({
      walletToken: "tok1",
      prompt: "a lighthouse",
    });
  });

  it("STEP 1 failure → QuestFundError (never a partial import)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/create")) return json({ walletJobId: "wj" }, 202);
      if (url.includes("/result"))
        return json({ status: "failed", error: "faucet_unavailable" });
      return json({}, 404);
    });
    await expect(
      questFund({ payProxyUrl: "https://pay.example", fetchImpl: fetchImpl as never, sleep: noSleep })
    ).rejects.toThrow(QuestFundError);
  });

  it("STEP 2 failure → QuestFundError", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/create")) return json({ walletJobId: "wj" }, 202);
      if (url.includes("/wallet/result"))
        return json({ status: "funded", secret: "K", walletToken: "t", party: "p", network: "n" });
      if (url.endsWith("/pay")) return json({ payJobId: "pj" }, 202);
      if (url.includes("/pay-result"))
        return json({ status: "failed", error: "upstream_error" });
      return json({}, 404);
    });
    await expect(
      questFund({ payProxyUrl: "https://pay.example", fetchImpl: fetchImpl as never, sleep: noSleep })
    ).rejects.toThrow(/STEP 2 failed/);
  });

  it("a non-202 create is a QuestFundError", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "nope" }, 503));
    await expect(
      questFund({ payProxyUrl: "https://pay.example", fetchImpl: fetchImpl as never, sleep: noSleep })
    ).rejects.toThrow(/create returned 503/);
  });
});

describe("fundViaQuest (bootstrap + install, no-clobber)", () => {
  const funded = {
    secret: "-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----",
    party: "agent::1220minted",
    network: "canton:mainnet",
    balanceCc: "0.05",
    updateId: "u1",
    image: "https://img/x.png",
  };

  it("no existing wallet → runs the quest and installs the funded key", async () => {
    const questFundImpl = vi.fn().mockResolvedValue(funded);
    const installKey = vi
      .fn()
      .mockResolvedValue({ party: "agent::1220minted", network: "canton:mainnet" } as AgentWallet);
    const r = await fundViaQuest({
      payProxyUrl: "https://pay.example",
      relayUrl: "https://facilitator.example",
      questFundImpl: questFundImpl as never,
      loadWalletImpl: () => undefined,
      installKey,
    });
    expect(r.kind).toBe("funded");
    if (r.kind === "funded") {
      expect(r.wallet.party).toBe("agent::1220minted");
      expect(r.balanceCc).toBe("0.05");
      expect(r.image).toBe("https://img/x.png");
    }
    expect(installKey).toHaveBeenCalledWith(
      expect.stringContaining("PRIVATE KEY"),
      "https://facilitator.example",
      "canton:mainnet"
    );
  });

  it("NO-CLOBBER: an existing FUNDED wallet is returned untouched (no quest, no install)", async () => {
    const questFundImpl = vi.fn();
    const installKey = vi.fn();
    const r = await fundViaQuest({
      payProxyUrl: "https://pay.example",
      relayUrl: "https://facilitator.example",
      questFundImpl: questFundImpl as never,
      loadWalletImpl: () => ({ party: "agent::1220old" }) as AgentWallet,
      balanceOf: async () => "2.0",
      installKey,
    });
    expect(r.kind).toBe("already_funded");
    if (r.kind === "already_funded") {
      expect(r.party).toBe("agent::1220old");
      expect(r.balanceCc).toBe("2.0");
    }
    expect(questFundImpl).not.toHaveBeenCalled();
    expect(installKey).not.toHaveBeenCalled();
  });

  it("NO-CLOBBER: an UNREADABLE balance refuses rather than overwriting the key", async () => {
    // The guard is the only thing between an existing wallet and saveWallet,
    // and overwriting wallet.json destroys the private key — the one thing
    // here that cannot be undone. The old code caught the balance read into
    // cc = "0" and called that "treat as empty", so a relay blip or any 5xx
    // looked exactly like an empty wallet and the key of a wallet holding real
    // CC was replaced. Unreadable is not empty.
    const questFundImpl = vi.fn();
    const installKey = vi.fn();
    await expect(
      fundViaQuest({
        payProxyUrl: "https://pay.example",
        relayUrl: "https://facilitator.example",
        questFundImpl: questFundImpl as never,
        loadWalletImpl: () => ({ party: "agent::1220old" }) as AgentWallet,
        balanceOf: async () => {
          throw new Error("relay 503");
        },
        installKey,
      })
    ).rejects.toThrow(/refusing to overwrite/);
    expect(questFundImpl).not.toHaveBeenCalled();
    expect(installKey).not.toHaveBeenCalled();
  });

  it("an existing wallet that is PROVABLY empty is still bootstrapped", async () => {
    // The refusal must not seize up the honest case it was built around.
    const installKey = vi.fn();
    const r = await fundViaQuest({
      payProxyUrl: "https://pay.example",
      relayUrl: "https://facilitator.example",
      questFundImpl: (async () => ({
        party: "agent::1220minted",
        secret: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
        balanceCc: "0.05",
        updateId: "1220u",
        image: "https://img/x.png",
        network: "canton:mainnet",
      })) as never,
      loadWalletImpl: () => ({ party: "agent::1220old" }) as AgentWallet,
      balanceOf: async () => "0",
      pendingOf: async () => [],
      installKey: installKey.mockResolvedValue({
        party: "agent::1220minted",
      } as AgentWallet),
    });
    expect(r.kind).toBe("funded");
    expect(installKey).toHaveBeenCalled();
  });

  it("FAIL-LOUD: an install that keeps a DIFFERENT party is a QuestFundError (never a lying success)", async () => {
    // Regression for the live MCP canary: a load-first ensureWallet returned the
    // empty boot wallet, the funded key was dropped, and the report still named
    // the funded party. The guard makes that impossible.
    const questFundImpl = vi.fn().mockResolvedValue(funded);
    const installKey = vi
      .fn()
      .mockResolvedValue({ party: "agent::1220BOOTWALLET", network: "canton:mainnet" } as AgentWallet);
    await expect(
      fundViaQuest({
        payProxyUrl: "https://pay.example",
        relayUrl: "https://facilitator.example",
        questFundImpl: questFundImpl as never,
        loadWalletImpl: () => undefined,
        installKey,
      })
    ).rejects.toThrow(/NOT persisted/);
  });

  it("an existing EMPTY wallet is bootstrapped over (balance 0 → quest runs)", async () => {
    const questFundImpl = vi.fn().mockResolvedValue(funded);
    const installKey = vi
      .fn()
      .mockResolvedValue({ party: "agent::1220minted", network: "canton:mainnet" } as AgentWallet);
    const r = await fundViaQuest({
      payProxyUrl: "https://pay.example",
      relayUrl: "https://facilitator.example",
      questFundImpl: questFundImpl as never,
      loadWalletImpl: () => ({ party: "agent::1220empty" }) as AgentWallet,
      balanceOf: async () => "0",
      pendingOf: async () => [],
      installKey,
    });
    expect(r.kind).toBe("funded");
    expect(questFundImpl).toHaveBeenCalledTimes(1);
  });
});

/**
 * A balance of zero is not proof of an empty wallet. The relay's /balance counts
 * `Splice.Amulet:Amulet` contracts only, so CC the owner has SENT but the agent
 * has not accepted yet — a pending TransferInstruction — reads as zero.
 *
 * That is the ordinary state of an agent wallet between "owner sent funds" and
 * "agent ran claim", which is exactly the sequence the funding instructions ask
 * for. Overwriting the wallet there destroys the private key those funds are
 * addressed to and strands them on the ledger for good.
 */
describe("fundViaQuest — unclaimed is not empty either", () => {
  const existing = {
    party: "agent::1220holder",
    relayUrl: "http://relay.test",
    network: "canton:mainnet",
  } as never;

  it("refuses to overwrite a wallet with unaccepted incoming transfers", async () => {
    const questFundImpl = vi.fn();
    const installKey = vi.fn();
    await expect(
      fundViaQuest({
        relayUrl: "http://relay.test",
        payProxyUrl: "http://proxy.test",
        loadWalletImpl: () => existing,
        balanceOf: async () => "0.0000000000",
        pendingOf: async () => [
          { cid: "00p1", amount: "5.0000000000", sender: "owner::1220o" },
        ],
        questFundImpl: questFundImpl as never,
        installKey: installKey as never,
      })
    ).rejects.toThrow(/unaccepted incoming transfer/i);
    // Nothing was minted and — the point — nothing was written over the key.
    expect(questFundImpl).not.toHaveBeenCalled();
    expect(installKey).not.toHaveBeenCalled();
  });

  it("says how much is waiting and what to do about it", async () => {
    await expect(
      fundViaQuest({
        relayUrl: "http://relay.test",
        payProxyUrl: "http://proxy.test",
        loadWalletImpl: () => existing,
        balanceOf: async () => "0",
        pendingOf: async () => [
          { cid: "00p1", amount: "2.5000000000" },
          { cid: "00p2", amount: "1.2500000000" },
        ],
        questFundImpl: vi.fn() as never,
        installKey: vi.fn() as never,
      })
    ).rejects.toThrow(/2 unaccepted.*3\.7500000000 CC.*claim/is);
  });

  it("UNREADABLE pending is not empty pending", async () => {
    // Same rule the balance read already follows: we replace a wallet only when
    // we KNOW it is empty. A relay that cannot answer is not an answer.
    const installKey = vi.fn();
    await expect(
      fundViaQuest({
        relayUrl: "http://relay.test",
        payProxyUrl: "http://proxy.test",
        loadWalletImpl: () => existing,
        balanceOf: async () => "0",
        pendingOf: async () => {
          throw new Error("relay 502");
        },
        questFundImpl: vi.fn() as never,
        installKey: installKey as never,
      })
    ).rejects.toThrow(/pending incoming transfers could not be read/i);
    expect(installKey).not.toHaveBeenCalled();
  });

  it("a genuinely empty wallet is still bootstrapped — refusing everything is the other bug", async () => {
    // DISCRIMINATOR. The whole point of this path is to fund an empty wallet;
    // a guard that refuses when there is nothing waiting would break it.
    const installed = { party: "agent::1220minted" };
    const installKey = vi.fn().mockResolvedValue(installed);
    const res = await fundViaQuest({
      relayUrl: "http://relay.test",
      payProxyUrl: "http://proxy.test",
      loadWalletImpl: () => existing,
      balanceOf: async () => "0",
      pendingOf: async () => [],
      questFundImpl: (async () => ({
        secret: "-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----",
        party: "agent::1220minted",
        network: "canton:mainnet",
        balanceCc: "0.04",
        updateId: "1220u",
        image: undefined,
      })) as never,
      installKey: installKey as never,
    });
    expect(res.kind).toBe("funded");
    expect(installKey).toHaveBeenCalledTimes(1);
  });
});

describe("a poll that cannot be read is not a verdict", () => {
  const SECRET = "-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----";
  const funded = {
    status: "funded",
    secret: SECRET,
    walletToken: "tok1",
    party: "agent::1220m",
    network: "canton:mainnet",
  };

  it("keeps polling through a proxy 502 and still finishes", async () => {
    // A reverse proxy answering a restart with an HTML 502 used to end the
    // quest on the first blip, with 39 polls of budget unused.
    let payPolls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/quest/wallet/create")) return json({ walletJobId: "wj" }, 202);
      if (url.includes("/v1/quest/wallet/result")) return json(funded);
      if (url.endsWith("/v1/quest/wallet/pay")) return json({ payJobId: "pj" }, 202);
      payPolls++;
      // Unparseable AND well-formed-JSON-with-a-bad-status, because they fail
      // through different halves of the guard: the second is what a real
      // rate-limiter or API gateway sends, and only the status check catches it.
      if (payPolls === 1) return new Response("<html>502 Bad Gateway</html>", { status: 502 });
      if (payPolls === 2) return json({ error: "rate limited", status: "failed" }, 429);
      return json({ status: "done", party: "agent::1220m", updateId: "u-ok" });
    });
    const r = await questFund({
      payProxyUrl: "https://pay.example",
      fetchImpl: fetchImpl as never,
      sleep: noSleep,
    });
    expect(r.updateId).toBe("u-ok");
    expect(payPolls).toBe(3);
  });

  it("still fails on a readable terminal body", async () => {
    // The discriminator: a real refusal must remain a refusal, not be polled
    // over until the budget runs out.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/quest/wallet/create")) return json({ walletJobId: "wj" }, 202);
      if (url.includes("/v1/quest/wallet/result")) return json(funded);
      if (url.endsWith("/v1/quest/wallet/pay")) return json({ payJobId: "pj" }, 202);
      return json({ status: "failed", error: "budget_exhausted" });
    });
    await expect(
      questFund({ payProxyUrl: "https://pay.example", fetchImpl: fetchImpl as never, sleep: noSleep })
    ).rejects.toThrow(/budget_exhausted/);
  });

  it("a STEP 2 failure carries the key it was already handed", async () => {
    // Step 2 faucets, accepts and spends, so by the time it can fail the party
    // may hold real CC. The exception used to carry the only copy of its key
    // away with it.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/quest/wallet/create")) return json({ walletJobId: "wj" }, 202);
      if (url.includes("/v1/quest/wallet/result")) return json(funded);
      if (url.endsWith("/v1/quest/wallet/pay")) return json({ payJobId: "pj" }, 202);
      return json({ status: "failed", error: "pay_failed" });
    });
    const err = await questFund({
      payProxyUrl: "https://pay.example",
      fetchImpl: fetchImpl as never,
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuestFundError);
    expect((err as QuestFundError).recoverable).toEqual({
      secret: SECRET,
      party: "agent::1220m",
      network: "canton:mainnet",
    });
  });

  it("a STEP 1 failure carries nothing — there was no key yet", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/quest/wallet/create")) return json({ walletJobId: "wj" }, 202);
      return json({ status: "failed", error: "mint_failed" });
    });
    const err = await questFund({
      payProxyUrl: "https://pay.example",
      fetchImpl: fetchImpl as never,
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect((err as QuestFundError).recoverable).toBeUndefined();
  });
});

describe("fundViaQuest rescues the key of a quest that failed past step 1", () => {
  it("writes it out and names the file in the error", async () => {
    const written: Array<[string, string]> = [];
    const err = await fundViaQuest({
      payProxyUrl: "https://pay.example",
      relayUrl: "https://relay.example",
      loadWalletImpl: () => undefined,
      questFundImpl: (async () => {
        throw new QuestFundError("quest STEP 2 timed out", {
          secret: "SECRET-PEM",
          party: "agent::1220m",
          network: "canton:mainnet",
        });
      }) as never,
      rescueKeyImpl: (secret: string, party: string) => {
        written.push([party, secret]);
        return "/tmp/rescued-key-agent__1220m.pem";
      },
    }).catch((e: unknown) => e);

    expect(written).toEqual([["agent::1220m", "SECRET-PEM"]]);
    const msg = (err as Error).message;
    expect(msg).toContain("quest STEP 2 timed out");
    expect(msg).toContain("/tmp/rescued-key-agent__1220m.pem");
    expect(msg).toContain("import --key-file");
  });

  it("says so loudly when even the rescue write fails", async () => {
    const err = await fundViaQuest({
      payProxyUrl: "https://pay.example",
      relayUrl: "https://relay.example",
      loadWalletImpl: () => undefined,
      questFundImpl: (async () => {
        throw new QuestFundError("quest STEP 2 timed out", {
          secret: "SECRET-PEM",
          party: "agent::1220m",
          network: "canton:mainnet",
        });
      }) as never,
      rescueKeyImpl: () => {
        throw new Error("EROFS: read-only file system");
      },
    }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("could NOT be written");
    expect((err as QuestFundError).recoverable?.secret).toBe("SECRET-PEM");
  });

  it("does not attempt a rescue for a failure that never held a key", async () => {
    // The discriminator: no key, no file. A rescue file for a quest that minted
    // nothing would be a wallet-shaped piece of litter with no party behind it.
    let called = 0;
    await fundViaQuest({
      payProxyUrl: "https://pay.example",
      relayUrl: "https://relay.example",
      loadWalletImpl: () => undefined,
      questFundImpl: (async () => {
        throw new QuestFundError("quest STEP 1 timed out");
      }) as never,
      rescueKeyImpl: () => {
        called++;
        return "/tmp/x";
      },
    }).catch(() => undefined);
    expect(called).toBe(0);
  });
});

/**
 * The tests above drive the INJECTED rescue seam. The default implementation is
 * the one that actually runs in production, and it touches the one directory
 * that holds a private key — so it gets exercised on real disk.
 */
describe("the default rescue writer, on real disk", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "carescue-"));
    process.env.CANTON_AGENT_HOME = tmp;
  });
  afterEach(() => {
    delete process.env.CANTON_AGENT_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  const failQuest = (party: string) =>
    fundViaQuest({
      payProxyUrl: "https://pay.example",
      relayUrl: "https://relay.example",
      loadWalletImpl: () => undefined,
      questFundImpl: (async () => {
        throw new QuestFundError("quest STEP 2 timed out", {
          secret: "-----BEGIN PRIVATE KEY-----\nRESCUED\n-----END PRIVATE KEY-----",
          party,
          network: "canton:mainnet",
        });
      }) as never,
    }).catch((e: unknown) => e as Error);

  it("writes the key 0600 and names the file it wrote", async () => {
    const err = await failQuest("agent::1220m");
    const path = /saved to (\S+?\.pem)/.exec(err.message)?.[1];
    expect(path, err.message).toBeTruthy();
    expect(readFileSync(path!, "utf8")).toContain("RESCUED");
    // A private key on a shared box must not be world-readable.
    expect(statSync(path!).mode & 0o777).toBe(0o600);
  });

  it("never writes over wallet.json", async () => {
    // The rescue runs on an ERROR path. If it could overwrite the wallet it
    // would destroy the very kind of key it exists to preserve.
    const walletPath = join(tmp, "wallet.json");
    writeFileSync(walletPath, '{"party":"agent::1220other","privateKeyPkcs8Pem":"KEEP-ME"}');
    await failQuest("agent::1220m");
    expect(readFileSync(walletPath, "utf8")).toContain("KEEP-ME");
  });

  it("keeps a party id with path separators inside the wallet home", async () => {
    // The party is attacker-influenced in the sense that it comes back over the
    // wire; a `/` or `..` in it must not steer the write out of the directory.
    const err = await failQuest("agent::1220m/../../escaped");
    const path = /saved to (\S+?\.pem)/.exec(err.message)?.[1];
    expect(path!.startsWith(tmp)).toBe(true);
    expect(readdirSync(tmp).some((f) => f.endsWith(".pem"))).toBe(true);
  });
});

describe("the rescued key must not travel in an ordinary error log", () => {
  // The failure this pins is not a crash: it is a MainNet private key appearing
  // in someone else's log pipeline because they wrote `logger.error({ err })`.
  // Nothing about that line looks dangerous, which is exactly why the class has
  // to be safe by construction rather than by documentation.
  const KEY = "-----BEGIN PRIVATE KEY-----MIIEvQIBADANB-----END PRIVATE KEY-----";
  const rec = { secret: KEY, party: "agent::1220abc", network: "canton:mainnet" };

  it("JSON.stringify of the error does not contain the key", () => {
    const e = new QuestFundError("quest failed after funding", rec);
    expect(JSON.stringify(e)).not.toContain("PRIVATE KEY");
  });

  it("a pino-style serializer, which copies own ENUMERABLE props, does not either", () => {
    const e = new QuestFundError("quest failed after funding", rec);
    // Reproduces pino's std err serializer shape rather than importing pino:
    // the mechanism under test is enumerability, not pino.
    const serialized: Record<string, unknown> = {
      type: e.name,
      message: e.message,
      stack: e.stack,
    };
    for (const k of Object.keys(e)) if (!(k in serialized)) serialized[k] = (e as never)[k];
    expect(JSON.stringify(serialized)).not.toContain("PRIVATE KEY");
    expect(Object.keys(e)).not.toContain("recoverable");
  });

  it("but the rescue path still reads it — hidden from enumeration, not from callers", () => {
    // The discriminator against over-correcting into deletion: the field exists
    // so the CLI can hand the operator back custody of a funded party.
    const e = new QuestFundError("quest failed after funding", rec);
    expect(e.recoverable?.secret).toBe(KEY);
    expect(e.recoverable?.party).toBe("agent::1220abc");
  });
});
