/**
 * Directory locks in a wallet home.
 *
 * `withHomeLock(home, name, fn)` runs `fn` while holding `<home>/<name>`, a
 * directory used as a mutex: `mkdir` is atomic on every platform/filesystem we
 * care about, works ACROSS PROCESSES (two MCP clients, or a CLI and an MCP
 * server, on one home), and needs no dependencies. A crashed holder is
 * reclaimed via mtime staleness; a live holder heartbeats the mtime.
 *
 * Different names are independent locks. That is what lets the local MCP hold
 * `.policy-lock` around a whole money move while the paying fetch inside it
 * takes `.pay-lock`: the same lock taken twice would wait on itself, because
 * these locks are not re-entrant.
 *
 * `withPayLock` is the per-wallet payment lock. It serializes payments when the
 * paying fetch cannot tell which transfer method a 402 asks for (see
 * makePayingFetchForWallet: a recognised transfer-factory payment is no-nonce
 * and skips the lock). It was built for the retired nonce-serialized method,
 * where two concurrent pays from one wallet could never both settle; it stays
 * as the fail-safe for a challenge it cannot classify.
 */
import { lstatSync, mkdirSync, rmdirSync, utimesSync, type Stats } from "node:fs";
import { join } from "node:path";

export interface PayLockOpts {
  /** A holder older than this is presumed crashed and is reclaimed. Must
   *  comfortably exceed the longest gap between two heartbeats (staleMs / 4).
   *  Default 5 min. */
  staleMs?: number;
  /** How long to wait for the lock before giving up. Default 10 min
   *  (several queued payments at worst-case duration). */
  timeoutMs?: number;
  /** Poll interval while waiting. Default 400ms. */
  pollMs?: number;
}

/** A lock is one plain directory name inside the home. */
const LOCK_NAME = /^\.?[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The local MCP's money-move lock: its timeout is read by an agent. */
const POLICY_LOCK = ".policy-lock";

/** Serialize `fn` against every other holder of `<home>/<name>`, in any
 *  process. Creates the home (0700) when it is missing. Always releases,
 *  including when `fn` throws. */
export async function withHomeLock<T>(
  home: string,
  name: string,
  fn: () => Promise<T>,
  opts: PayLockOpts = {}
): Promise<T> {
  if (!LOCK_NAME.test(name)) {
    throw new Error(`invalid lock name ${JSON.stringify(name)}: it must be one plain directory name`);
  }
  const staleMs = opts.staleMs ?? 300_000;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const pollMs = opts.pollMs ?? 400;
  // A new local wallet's first money move can come before its home exists.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lockDir = join(home, name);
  const label = name.replace(/^\./, "").replace(/-lock$/, "");
  const deadline = Date.now() + timeoutMs;
  // Why the last attempt to reclaim a stale lock failed, for the timeout.
  let reclaimFailed = "";
  const timedOut = (): Error =>
    new Error(
      name === POLICY_LOCK
        ? // An agent reads this one, and an agent with a shell would act on
          // advice to delete the directory while another client still holds
          // it. Removing a stuck lock by hand is the owner's call (README).
          `${label} lock timeout: another pay, withdraw, swap or claim on this wallet is still running; ` +
            `nothing was moved; try again shortly.${reclaimFailed}`
        : `${label} lock timeout: another holder has kept ${lockDir} for over ` +
            `${Math.round(timeoutMs / 1000)}s.${reclaimFailed} If nothing else is using this wallet, delete that directory.`
    );

  // Every way round this loop waits pollMs and checks the deadline. A retry
  // without the wait spins synchronously and freezes the whole process when
  // the lock can never be taken (a stale directory that is not empty).
  for (;;) {
    try {
      mkdirSync(lockDir, { recursive: false });
      break; // acquired
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    // Something holds the name. lstat, not stat: a symlink is never followed.
    let st: Stats | undefined;
    try {
      st = lstatSync(lockDir);
    } catch {
      // The holder released between our mkdir and this look: try again.
    }
    if (st && !st.isDirectory()) {
      // Only this code makes the lock, and always as a directory. A file or a
      // symlink here can never be taken or reclaimed, so waiting is pointless.
      throw new Error(
        `${label} lock: ${lockDir} is not a directory (a file or a symlink). ` +
          `If nothing else is using this wallet, delete it.`
      );
    }
    // The deadline before any reclaim. A waiter that is out of time leaves the
    // lock alone, even one that looks stale: after a laptop sleep the holder
    // may be alive and about to heartbeat, and reclaiming its lock only to
    // give up would let a third caller in beside it.
    if (Date.now() >= deadline) throw timedOut();
    if (st && Date.now() - st.mtimeMs > staleMs) {
      // The holder looks dead (stale mtime): reclaim.
      try {
        rmdirSync(lockDir);
        reclaimFailed = "";
      } catch (err) {
        // Another waiter reclaimed it first (ENOENT), or it is not empty.
        const code = (err as NodeJS.ErrnoException).code;
        reclaimFailed = code === "ENOENT" ? "" : ` It is stale but could not be removed (${code ?? "error"}).`;
      }
    } else {
      reclaimFailed = "";
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  // Heartbeat the mtime so a LEGITIMATELY long holder (a first payment, a swap
  // waiting for its output) is not reclaimed from under it by a waiter.
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(lockDir, now, now);
    } catch {
      // Lock dir vanished (manual cleanup) — nothing to heartbeat.
    }
  }, Math.max(1000, Math.floor(staleMs / 4)));
  // Never keep the process alive just for the heartbeat.
  heartbeat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    try {
      rmdirSync(lockDir);
    } catch {
      // Already gone (stale-reclaimed or manually removed) — nothing to do.
    }
  }
}

/** Serialize `fn` against every other payment from the same wallet home. */
export async function withPayLock<T>(
  homeDir: string,
  fn: () => Promise<T>,
  opts: PayLockOpts = {}
): Promise<T> {
  return withHomeLock(homeDir, ".pay-lock", fn, opts);
}
