/**
 * Per-wallet payment lock.
 *
 * Serializes payments from one wallet when the paying fetch cannot tell which
 * transfer method a 402 asks for (see makePayingFetchForWallet: a recognised
 * transfer-factory payment is no-nonce and skips the lock). It was built for the
 * retired nonce-serialized method, where two concurrent pays from one wallet
 * could never both settle; it stays as the fail-safe for a challenge it cannot
 * classify.
 *
 * The wallet identity IS its home directory (wallet.json), so the lock is a
 * directory-based mutex in that same home — `mkdir` is atomic on every
 * platform/filesystem we care about, works ACROSS PROCESSES, and needs no
 * dependencies. A crashed holder is reclaimed via mtime staleness.
 */
import { mkdirSync, rmdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";

export interface PayLockOpts {
  /** A holder older than this is presumed crashed and is reclaimed. Must
   *  comfortably exceed the longest legitimate payment (first-payment
   *  dead-zone + re-pay backoffs ≈ 2–3 min). Default 5 min. */
  staleMs?: number;
  /** How long to wait for the lock before giving up. Default 10 min
   *  (several queued payments at worst-case duration). */
  timeoutMs?: number;
  /** Poll interval while waiting. Default 400ms. */
  pollMs?: number;
}

/** Serialize `fn` against every other payment from the same wallet home.
 *  Always releases — including when `fn` throws. */
export async function withPayLock<T>(
  homeDir: string,
  fn: () => Promise<T>,
  opts: PayLockOpts = {}
): Promise<T> {
  const staleMs = opts.staleMs ?? 300_000;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const pollMs = opts.pollMs ?? 400;
  const lockDir = join(homeDir, ".pay-lock");
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      mkdirSync(lockDir, { recursive: false });
      break; // acquired
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Held by someone. Reclaim if the holder looks dead (stale mtime).
      try {
        const st = statSync(lockDir);
        if (Date.now() - st.mtimeMs > staleMs) {
          try {
            rmdirSync(lockDir);
          } catch {
            // Another waiter reclaimed it first — fine, re-loop.
          }
          continue;
        }
      } catch {
        // Holder released between our mkdir and stat — retry immediately.
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          "pay lock timeout: another payment from this wallet has held the " +
            `lock for over ${Math.round(timeoutMs / 1000)}s (${lockDir}). ` +
            "If no other payment is running, delete that directory."
        );
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  // Heartbeat the mtime so a LEGITIMATELY long payment (first-payment
  // dead-zone + retries) is not reclaimed-from-under-us by a waiter's
  // staleness check.
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
