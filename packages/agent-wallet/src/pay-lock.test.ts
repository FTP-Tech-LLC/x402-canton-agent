import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, existsSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withHomeLock, withPayLock } from "./pay-lock.js";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "paylock-"));
}

describe("withPayLock", () => {
  it("serializes two concurrent sections (no interleaving)", async () => {
    const home = freshHome();
    const events: string[] = [];
    const section = (name: string) => () =>
      withPayLock(
        home,
        async () => {
          events.push(`${name}:start`);
          await new Promise((r) => setTimeout(r, 60));
          events.push(`${name}:end`);
        },
        { pollMs: 10 }
      );
    await Promise.all([section("a")(), section("b")()]);
    rmSync(home, { recursive: true, force: true });
    // Whichever ran first must fully finish before the other starts.
    const first = events[0]?.split(":")[0];
    const second = first === "a" ? "b" : "a";
    expect(events).toEqual([
      `${first}:start`,
      `${first}:end`,
      `${second}:start`,
      `${second}:end`,
    ]);
  });

  it("releases the lock when fn throws (next caller proceeds)", async () => {
    const home = freshHome();
    await expect(
      withPayLock(home, async () => {
        throw new Error("payment failed");
      })
    ).rejects.toThrow("payment failed");
    // Lock must be gone → an immediate re-acquire succeeds without waiting.
    const r = await withPayLock(home, async () => "ok", { pollMs: 10 });
    expect(r).toBe("ok");
    expect(existsSync(join(home, ".pay-lock"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it("reclaims a stale lock left by a crashed holder", async () => {
    const home = freshHome();
    const lockDir = join(home, ".pay-lock");
    mkdirSync(lockDir); // simulate a crashed holder
    const old = new Date(Date.now() - 10 * 60_000); // 10 min ago
    utimesSync(lockDir, old, old);
    const r = await withPayLock(home, async () => "reclaimed", {
      staleMs: 60_000,
      pollMs: 10,
    });
    expect(r).toBe("reclaimed");
    rmSync(home, { recursive: true, force: true });
  });

  it("times out (with a clear message) when the lock is held and fresh", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".pay-lock")); // fresh holder, never released
    await expect(
      withPayLock(home, async () => "never", {
        staleMs: 60_000,
        timeoutMs: 80,
        pollMs: 20,
      })
    ).rejects.toThrow(/pay lock timeout/);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("withHomeLock", () => {
  it("creates a missing home (0700), runs fn, and leaves no lock behind", async () => {
    const home = join(freshHome(), "new-home");
    expect(await withHomeLock(home, ".policy-lock", async () => "ran", { pollMs: 10 })).toBe("ran");
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(existsSync(join(home, ".policy-lock"))).toBe(false);
  });

  it("serializes holders of the same name", async () => {
    const home = freshHome();
    const events: string[] = [];
    const section = (name: string) =>
      withHomeLock(
        home,
        ".policy-lock",
        async () => {
          events.push(`${name}:start`);
          await new Promise((r) => setTimeout(r, 60));
          events.push(`${name}:end`);
        },
        { pollMs: 10 }
      );
    await Promise.all([section("a"), section("b")]);
    const first = events[0]?.split(":")[0];
    const second = first === "a" ? "b" : "a";
    expect(events).toEqual([`${first}:start`, `${first}:end`, `${second}:start`, `${second}:end`]);
  });

  it("different names are separate locks: the pay lock inside the policy lock does not wait on itself", async () => {
    const home = freshHome();
    const r = await withHomeLock(
      home,
      ".policy-lock",
      () => withPayLock(home, async () => "nested", { pollMs: 10, timeoutMs: 500 }),
      { pollMs: 10 }
    );
    expect(r).toBe("nested");
  });

  it("refuses a name that is not one plain directory name", async () => {
    for (const bad of ["", ".", "..", "../x", "a/b"]) {
      await expect(withHomeLock(freshHome(), bad, async () => 1)).rejects.toThrow(/invalid lock name/);
    }
  });

  it("names its lock in the timeout", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".policy-lock"));
    await expect(
      withHomeLock(home, ".policy-lock", async () => "never", { staleMs: 60_000, timeoutMs: 80, pollMs: 20 })
    ).rejects.toThrow(/policy lock timeout/);
  });

  // An agent reads this message, and an agent with a shell acts on it.
  // Deleting the directory while another client still holds it lets a third
  // money move in beside that one, past the daily cap. The advice to remove a
  // stuck lock by hand is the owner's, in the README.
  it("the policy lock's timeout tells the agent to wait, not to delete the lock", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".policy-lock"));
    const msg = await withHomeLock(home, ".policy-lock", async () => "never", {
      staleMs: 60_000,
      timeoutMs: 80,
      pollMs: 20,
    }).then(
      () => "",
      (e: Error) => e.message
    );
    expect(msg).toBe(
      "policy lock timeout: another pay, withdraw, swap or claim on this wallet is still running; nothing was moved; try again shortly."
    );
    expect(msg).not.toMatch(/delete|remove|rm /i);
    expect(existsSync(join(home, ".policy-lock"))).toBe(true);
  });

  it("the pay lock's timeout still names the directory for the CLI user", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".pay-lock"));
    await expect(
      withHomeLock(home, ".pay-lock", async () => "never", { staleMs: 60_000, timeoutMs: 80, pollMs: 20 })
    ).rejects.toThrow(/pay lock timeout: .* If nothing else is using this wallet, delete that directory\./);
  });

  // A laptop sleeps while one client holds the lock and another waits. On
  // wake the waiter can run before the holder's heartbeat: the lock looks
  // stale and the waiter's own deadline has passed. Reclaiming it then, only
  // to give up, removes a live holder's lock and lets a third caller in.
  it("a waiter whose deadline has passed leaves even a stale-looking lock alone", async () => {
    const home = freshHome();
    const lock = join(home, ".policy-lock");
    mkdirSync(lock); // a live holder, fresh when the waiter first looks
    const waiting = withHomeLock(home, ".policy-lock", async () => "taken", {
      staleMs: 60_000,
      timeoutMs: 100,
      pollMs: 250,
    }).then(
      (v) => v,
      (e: Error) => e.message
    );
    // While the waiter sleeps past its deadline, the lock comes to look stale.
    await new Promise((r) => setTimeout(r, 50));
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);
    expect(await waiting).toMatch(/policy lock timeout/);
    expect(existsSync(lock)).toBe(true);
  });

  it("a waiter with time left still takes over a stale lock", async () => {
    const home = freshHome();
    const lock = join(home, ".policy-lock");
    mkdirSync(lock);
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);
    expect(
      await withHomeLock(home, ".policy-lock", async () => "taken", { staleMs: 60_000, timeoutMs: 1000, pollMs: 10 })
    ).toBe("taken");
  });

  describe("a lock that cannot be taken never freezes the process", () => {
    /** Runs one lock attempt next to a 100 ms timer. A synchronous retry loop
     *  starves the timer and never settles at all. */
    async function attempt(home: string) {
      let firedAt: number | undefined;
      const timer = new Promise<void>((r) =>
        setTimeout(() => {
          firedAt = Date.now();
          r();
        }, 100)
      );
      const t0 = Date.now();
      const outcome = await withHomeLock(home, ".policy-lock", async () => "taken", {
        staleMs: 60_000,
        timeoutMs: 300,
        pollMs: 50,
      }).then(
        (v) => `resolved ${v}`,
        (e: Error) => e.message
      );
      const settledAt = Date.now();
      await timer;
      return { outcome, ms: settledAt - t0, timerFiredFirst: firedAt !== undefined && firedAt <= settledAt };
    }
    const makeStale = (p: string) => {
      const old = new Date(Date.now() - 10 * 60_000);
      utimesSync(p, old, old);
    };

    it("a stale lock directory that is not empty: waits, then times out", async () => {
      const home = freshHome();
      const lock = join(home, ".policy-lock");
      mkdirSync(lock);
      writeFileSync(join(lock, "left-behind"), "x");
      makeStale(lock);
      const r = await attempt(home);
      expect(r.outcome).toMatch(/policy lock timeout/);
      expect(r.outcome).toMatch(/stale but could not be removed \(ENOTEMPTY\)/);
      expect(r.ms).toBeLessThan(1000);
      expect(r.timerFiredFirst).toBe(true);
      expect(existsSync(join(lock, "left-behind"))).toBe(true);
    });

    it("a dangling symlink in place of the lock: refused at once, with a clear error", async () => {
      const home = freshHome();
      symlinkSync(join(home, "nowhere"), join(home, ".policy-lock"));
      const r = await attempt(home);
      expect(r.outcome).toMatch(/\.policy-lock is not a directory/);
      expect(r.ms).toBeLessThan(1000);
    });

    it("a symlink to a stale directory is refused too, not followed", async () => {
      const home = freshHome();
      const elsewhere = join(home, "elsewhere");
      mkdirSync(elsewhere);
      makeStale(elsewhere);
      symlinkSync(elsewhere, join(home, ".policy-lock"));
      const r = await attempt(home);
      expect(r.outcome).toMatch(/\.policy-lock is not a directory/);
      expect(r.ms).toBeLessThan(1000);
      expect(existsSync(elsewhere)).toBe(true);
    });

    it("a stale regular file in place of the lock: refused at once, with a clear error", async () => {
      const home = freshHome();
      const lock = join(home, ".policy-lock");
      writeFileSync(lock, "not a lock");
      makeStale(lock);
      const r = await attempt(home);
      expect(r.outcome).toMatch(/\.policy-lock is not a directory/);
      expect(r.ms).toBeLessThan(1000);
      expect(existsSync(lock)).toBe(true);
    });
  });

  it("is exported from the package entry", async () => {
    const pkg = await import("./index.js");
    expect(typeof pkg.withHomeLock).toBe("function");
    expect(pkg.withHomeLock).toBe(withHomeLock);
  });
});
