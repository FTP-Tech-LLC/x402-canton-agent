#!/usr/bin/env node
/**
 * canton-agent-wallet CLI — the surface an agent (or its human) drives.
 *
 *   create  [--relay-url <url>]  generate + onboard a self-custody wallet (idempotent)
 *   address                      print the party id (fund this)
 *   balance                      print CC balance
 *   claim                        accept incoming transfers (e.g. the initial funding)
 *   merge [--target <n>] [--batch <n>] [--max-rounds <n>] [--dry-run] [--yes]
 *                                consolidate dust amulets (self-transfer in batches)
 *                                so a wallet with thousands of holdings can be
 *                                enumerated + spent again. --dry-run prints the plan;
 *                                --yes is REQUIRED for a large whale pass (>20
 *                                batches) whose Global-Synchronizer traffic is
 *                                costly (~1-1.5 USD per 90-input tx on MainNet).
 *   preapproval [--status] [--admin <DSO>] [--days <n>] [--expires-at <iso>]
 *                                merchant TransferPreapproval setup for the
 *                                transfer-factory path — SELF-provisions the
 *                                merchant's own preapproval so x402 CC payments
 *                                settle in one round-trip. --status just checks.
 *   pay [--relay-url <url>] <url> fetch a URL, auto-paying any x402 402 challenge
 *   withdraw --to <p>            send CC back out (--amount <cc> for a partial amount)
 *   export                       print the private key (backup; guard it)
 *   import [--relay-url <url>] [--key-file <p>]  restore a wallet from a backed-up
 *                                key (stdin or --key-file); inverse of export
 *
 * The relay (facilitator) URL is REQUIRED for the commands that talk to a
 * relay (`create`, `pay`, `import`). There is intentionally no built-in default — a
 * wrong/stale default would silently send an agent's payments to a dead host.
 * Supply it via `--relay-url <url>` or the `CANTON_AGENT_RELAY_URL` env var.
 * The current FTP facilitator is `https://facilitator.ftptech.xyz`. `address`,
 * `balance`, `claim`, `withdraw` and `export` reuse the relay stored in the
 * wallet at `create` time and do not need the flag.
 *
 * Behind a proxy? Node's fetch ignores HTTP(S)_PROXY by default; this CLI wires
 * an undici ProxyAgent when HTTPS_PROXY/HTTP_PROXY/ALL_PROXY is set (see proxy.ts).
 *
 * Config via env: CANTON_AGENT_RELAY_URL, CANTON_AGENT_NETWORK,
 * CANTON_AGENT_API_KEY. Wallet lives at ~/.canton-agent/wallet.json (0600).
 */
/* eslint-disable no-console -- CLI entrypoint: stdout is its result channel */
import { readFileSync } from "node:fs";
import { ensureWallet } from "./onboard.js";
import { loadWallet } from "./store.js";
import { agentKeyFromPrivatePem } from "./keys.js";
import { makePayingFetch } from "./pay.js";
import { RelayClient, isHoldingsExceedNodeLimitError } from "./relay-client.js";
import {
  claimAll,
  selfProvisionPreapproval,
} from "./tx.js";
import { mergeHoldings } from "./merge.js";
import { withdraw } from "./withdraw.js";
import { installProxyFromEnv } from "./proxy.js";
import {
  flag,
  boolFlag,
  intFlag,
  positionals,
  resolveNetwork,
  resolveRelayUrl,
  MISSING_RELAY_HELP,
} from "./cli-args.js";
import { resolveTrustedDsoParty } from "./trusted-dso.js";

const API_KEY = process.env.CANTON_AGENT_API_KEY;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Resolve the relay URL or fail fast (never returns undefined). */
function requireRelay(args: string[]): string {
  return resolveRelayUrl(args) ?? fail(MISSING_RELAY_HELP);
}

/** Read all of stdin as UTF-8 (used by `import` to accept a piped key). */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function main(): Promise<void> {
  // Route outbound fetch through HTTP(S)_PROXY when set — node's fetch does not
  // honor those env vars on its own, so an agent behind a proxy would otherwise
  // see every relay call fail with an opaque `fetch failed`.
  const proxy = installProxyFromEnv(process.env);
  if (proxy) console.error(`(using proxy ${proxy})`);

  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "create": {
      const relayUrl = requireRelay(args);
      const w = await ensureWallet({
        relayUrl,
        network: resolveNetwork(args),
        apiKey: API_KEY,
      });
      console.log(
        `wallet ready (${w.network})\n` +
          `  party:   ${w.party}\n` +
          `  fund me: send CC to that party id, then run: canton-agent-wallet claim\n` +
          `  keyfile: ~/.canton-agent/wallet.json  <- this IS your wallet; back it up`
      );
      break;
    }
    case "address": {
      const w = loadWallet();
      if (!w) return fail("no wallet yet — run: canton-agent-wallet create");
      console.log(w.party);
      break;
    }
    case "balance": {
      const w = loadWallet();
      if (!w) return fail("no wallet yet — run: canton-agent-wallet create");
      try {
        const b = await new RelayClient({ relayUrl: w.relayUrl, apiKey: API_KEY }).balance(w.party);
        console.log(`${b.cc} CC  (${b.amulet} holding${b.amulet === 1 ? "" : "s"})`);
      } catch (err) {
        // A whale wallet holds more amulet contracts than the participant's
        // JSON-API element cap can enumerate — balance 413s. Print an actionable
        // next step (consolidate) instead of a raw relay-error stack.
        if (isHoldingsExceedNodeLimitError(err)) {
          return fail(
            "balance unavailable: this wallet holds too many amulet contracts to " +
              "enumerate on-ledger (the participant's element cap). Consolidate them " +
              "first with:  canton-agent-wallet merge"
          );
        }
        throw err;
      }
      break;
    }
    case "merge": {
      // Consolidate dust amulets by self-transferring them in batches (receiver ==
      // this wallet, enforced by verify-before-sign). Restores `balance`/`pay` for
      // a wallet whose amulet count outgrew the participant's ACS element cap.
      const w = loadWallet();
      if (!w) return fail("no wallet yet — run: canton-agent-wallet create");
      const target = intFlag(args, "--target");
      const batch = intFlag(args, "--batch");
      const maxRounds = intFlag(args, "--max-rounds");
      const dryRun = boolFlag(args, "--dry-run");
      // --yes acknowledges the Global-Synchronizer traffic cost of a LARGE whale
      // pass (>20 planned batches). Without it, mergeHoldings throws before
      // submitting anything; the catch below surfaces that as a clean error.
      const yes = boolFlag(args, "--yes");
      const relay = new RelayClient({ relayUrl: w.relayUrl, apiKey: API_KEY });
      const res = await mergeHoldings(relay, w, {
        ...(target !== undefined ? { target } : {}),
        ...(batch !== undefined ? { batch } : {}),
        ...(maxRounds !== undefined ? { maxRounds } : {}),
        dryRun,
        yes,
        onProgress: (line) => console.log(line),
      });
      if (!dryRun) {
        const extras = [
          res.chainedRounds > 0 ? `${res.chainedRounds} chained` : "",
          res.skippedStale > 0 ? `${res.skippedStale} stale batch(es) skipped` : "",
        ].filter(Boolean);
        console.log(
          `merge complete: ${res.rounds} batch transfer(s), ` +
            `${res.merged.length} amulet(s) consumed` +
            (extras.length ? ` (${extras.join(", ")})` : "") +
            (res.finalHoldings === null
              ? " — remaining holdings predate this run; re-run `merge` after the next " +
                "Scan snapshot (~12:00 UTC daily) to continue"
              : ` → ${res.finalHoldings} holding(s) remain`)
        );
      }
      break;
    }
    case "claim": {
      const w = loadWallet();
      if (!w) return fail("no wallet yet — run: canton-agent-wallet create");
      const r = await claimAll(new RelayClient({ relayUrl: w.relayUrl, apiKey: API_KEY }), w);
      console.log(r.claimed ? `claimed ${r.claimed} incoming transfer(s)` : "nothing to claim");
      break;
    }
    case "preapproval": {
      // Merchant TransferPreapproval setup for the transfer-factory ("V3", 1-tx)
      // path. Without a live preapproval, x402 CC payments to this merchant
      // resolve to a two-step Pending and never settle in one round-trip.
      //
      //   --status         → print whether this merchant has a live preapproval.
      //   (default)        → SELF-provision: the merchant creates its OWN
      //                      TransferPreapproval with its OWN key (single
      //                      controller — NO operator token, NO CanActAs
      //                      delegation). Idempotent (checks first). The merchant
      //                      prepays the holding fee from its OWN CC, so the
      //                      wallet needs a little CC first.
      //   --days <N>       → preapproval lifetime (default 30); shorter prepays a
      //                      smaller fee. --expires-at <ISO> overrides.
      //   --operator-token → LEGACY facilitator-as-provider mode (facilitator
      //                      pays the fee) — ONLY works if the merchant delegated
      //                      CanActAs to the facilitator user; NOT for
      //                      self-custody merchants. Prefer the self default.
      const w = loadWallet();
      if (!w) return fail("no wallet yet — run: canton-agent-wallet create");
      const admin =
        flag(args, "--admin") ||
        resolveTrustedDsoParty(process.env, w.network) ||
        "";
      if (!admin)
        return fail(
          "cannot resolve the instrument admin (DSO) for this network — pass --admin <DSO party> or set CANTON_AGENT_DSO_PARTY"
        );
      const relay = new RelayClient({ relayUrl: w.relayUrl, apiKey: API_KEY });
      const status = await relay.preapprovalStatus(w.party, admin);
      if (boolFlag(args, "--status")) {
        console.log(
          `preapproval status for ${w.party}:\n` +
            `  hasPreapproval: ${status.hasPreapproval}\n` +
            `  transferKind:   ${status.transferKind}` +
            (status.guidance ? `\n  ${status.guidance}` : "") +
            (status.note ? `\n  ${status.note}` : "")
        );
        break;
      }
      if (status.hasPreapproval === true) {
        console.log(
          `merchant ${w.party} already has a live TransferPreapproval — nothing to do (ready for transfer-factory payments)`
        );
        break;
      }
      // Resolve the expiry: --expires-at <ISO> wins; else --days N (default 30).
      const daysFlag = Number(flag(args, "--days"));
      const days = Number.isFinite(daysFlag) && daysFlag > 0 ? daysFlag : 30;
      const expiresAt =
        flag(args, "--expires-at") ||
        new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();

      const operatorToken =
        flag(args, "--operator-token") || process.env.CANTON_X402_OPERATOR_TOKEN;
      if (operatorToken) {
        // LEGACY facilitator-as-provider (opt-in). Needs CanActAs delegation.
        const res = await relay.createPreapproval(w.party, { operatorToken, expiresAt });
        console.log(
          `TransferPreapproval created (facilitator-as-provider) for ${w.party}\n` +
            `  provider:  ${res.provider}\n` +
            `  expiresAt: ${res.expiresAt}\n` +
            `  updateId:  ${res.updateId}`
        );
        break;
      }
      // DEFAULT: SELF-provision with the merchant's OWN key — no token, no
      // delegation. The merchant prepays the fee from its own CC.
      try {
        const res = await selfProvisionPreapproval(relay, w, { expiresAt });
        console.log(
          `TransferPreapproval self-provisioned for ${w.party} (ready for transfer-factory payments)\n` +
            `  provider:  ${w.party} (self)\n` +
            `  expiresAt: ${expiresAt}\n` +
            `  updateId:  ${res.updateId}`
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/insufficient/i.test(msg)) {
          return fail(
            `self-provisioning needs a little CC in this wallet to prepay the ~${days}-day holding fee.\n` +
              "  fund it first (ask your owner, or the faucet if the relay offers one), then re-run.\n" +
              "  tip: a shorter --days N prepays a smaller fee.\n" +
              `  underlying: ${msg}`
          );
        }
        return fail(`self-provision failed: ${msg}`);
      }
      break;
    }
    case "pay": {
      const url = positionals(args)[0];
      if (!url)
        return fail("usage: canton-agent-wallet pay [--relay-url <url>] <url>");
      // Reuse the wallet's stored relay (like claim/balance) when neither
      // --relay-url nor CANTON_AGENT_RELAY_URL is given, so an already-created
      // agent can pay without re-specifying the relay each time.
      const existing = loadWallet();
      const relayUrl =
        resolveRelayUrl(args) ?? existing?.relayUrl ?? fail(MISSING_RELAY_HELP);
      const f = await makePayingFetch({
        relayUrl,
        network: existing?.network ?? resolveNetwork(args),
        apiKey: API_KEY,
      });
      const res = await f(url);
      console.log(`${res.status} ${res.statusText}`);
      console.log(await res.text());
      break;
    }
    case "withdraw": {
      const to = flag(args, "--to");
      if (!to) return fail("usage: canton-agent-wallet withdraw --to <party> [--amount <cc>]");
      const amount = flag(args, "--amount");
      const r = await withdraw({ to, ...(amount ? { amount } : {}), apiKey: API_KEY });
      console.log(`withdrew ${r.amount} CC to ${to}\n  updateId: ${r.updateId}`);
      break;
    }
    case "export": {
      const w = loadWallet();
      if (!w) return fail("no wallet yet — run: canton-agent-wallet create");
      console.error(
        "!  PRIVATE KEY below — anyone who has it controls your funds. Store it securely.\n"
      );
      console.log(w.privateKeyPkcs8Pem);
      break;
    }
    case "import": {
      // Restore a wallet from a backed-up private key (the inverse of `export`).
      // Refuse to clobber an existing wallet — restore goes into a FRESH home.
      if (loadWallet())
        return fail(
          "a wallet already exists in this home — import restores into a FRESH wallet dir.\n" +
            "  point CANTON_AGENT_HOME at an empty directory and re-run."
        );
      const relayUrl = requireRelay(args);
      const keyFile = flag(args, "--key-file");
      let pem: string;
      if (keyFile) pem = readFileSync(keyFile, "utf8");
      else if (!process.stdin.isTTY) pem = await readStdin();
      else
        return fail(
          "no private key — pipe `export` output via stdin or pass --key-file <path>.\n" +
            "  e.g.  canton-agent-wallet export > key.pem  &&  CANTON_AGENT_HOME=./restored \\\n" +
            "          canton-agent-wallet import --relay-url <url> --key-file key.pem"
        );
      const w = await ensureWallet({
        relayUrl,
        network: resolveNetwork(args),
        apiKey: API_KEY,
        key: agentKeyFromPrivatePem(pem),
        restore: true,
      });
      console.log(
        `wallet restored (${w.network})\n` +
          `  party:   ${w.party}\n` +
          `  run: canton-agent-wallet balance`
      );
      break;
    }
    default:
      console.error(
        "canton-agent-wallet: create | address | balance | claim | merge [--target <n>] [--batch <n>] [--max-rounds <n>] [--dry-run] [--yes] | preapproval [--status] [--admin <DSO>] [--operator-token <t>] [--expires-at <iso>] | pay <url> | withdraw --to <party> | export | import\n" +
          "  relay required for create/pay/import: --relay-url <url> or CANTON_AGENT_RELAY_URL\n" +
          "  preapproval = merchant TransferPreapproval setup for the transfer-factory (V3, 1-tx) path (--status to just check)."
      );
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  // Surface the underlying cause — node's `fetch failed` is opaque without it;
  // the cause carries the real reason (ENOTFOUND / ECONNREFUSED / proxy auth).
  const rawCause =
    e && typeof e === "object" && "cause" in e
      ? (e as { cause?: unknown }).cause
      : undefined;
  const causeMsg =
    rawCause instanceof Error
      ? rawCause.message
      : rawCause != null
        ? String(rawCause)
        : "";
  console.error("error:", causeMsg ? `${msg} (cause: ${causeMsg})` : msg);
  // Network-reachability hint: the most common real-world failure is a proxy /
  // blocked egress, which the env-proxy support above fixes once configured.
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR/i.test(`${msg} ${causeMsg}`)) {
    console.error(
      "  could not reach the relay. If you are behind a proxy, export HTTPS_PROXY " +
        "(e.g. HTTPS_PROXY=http://user:pass@host:port) — the CLI routes through it. " +
        "Otherwise verify the relay URL is reachable from this machine (try: curl <relay-url>/health)."
    );
  }
  process.exit(1);
});
