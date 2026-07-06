import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPayLock } from "./pay-lock.js";

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
