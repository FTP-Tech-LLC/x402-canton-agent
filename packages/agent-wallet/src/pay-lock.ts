/**
 * Per-wallet payment lock.
 *
 * v1 payments are nonce-serialized ON-LEDGER per sender: two payments from one
 * wallet signed against the same TransferCommandCounter value can never both
 * settle — the second is a doomed Send the facilitator refuses, and the client
 * must re-sign (a fresh ~$0.40 TransferCommand Create) and try again. So
 * CONCURRENT pays from the same wallet (parallel `canton-agent-wallet pay`
 * processes, or parallel calls through one makePayingFetch) only ever race each
 * other, burning Creates and losing rounds until the retry budget runs out.
 *
 * The cure is to serialize at the source: one payment dance per wallet at a
 * time. The wallet identity IS its home directory (wallet.json), so the lock is
 * a directory-based mutex in that same home — `mkdir` is atomic on every
 * platform/filesystem we care about, works ACROSS PROCESSES, and needs no
 * dependencies. A crashed holder is reclaimed via mtime staleness.
 *
 * Used by makePayingFetch only AFTER a request actually challenges with 402
 * (probe first, lock second) so unpaid traffic through the wrapped fetch never
 * queues behind a slow payment.
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
