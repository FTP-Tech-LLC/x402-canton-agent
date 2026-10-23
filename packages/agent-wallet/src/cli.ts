#!/usr/bin/env node
/**
 * canton-agent-wallet CLI — the surface an agent (or its human) drives.
 *
 *   create  [--relay-url <url>]  generate + onboard a self-custody wallet (idempotent)
 *   address                      print the party id (fund this)
 *   balance                      print every instrument the wallet holds (CC + registry tokens)
 *   claim                        accept incoming transfers (e.g. the initial funding)
 *   merge [--target <n>] [--batch <n>] [--max-rounds <n>] [--dry-run] [--yes] [--admin <registrar> --id <instrument> | --all-tokens]
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
 *   pay [--relay-url <url>] [--asset <symbol>] [--max <amount>] [--pay-to <party>] <url>  fetch a URL, auto-paying any
 *                                x402 402 challenge; --asset prefers that
 *                                instrument (e.g. USDCx) when the 402 offers
 *                                several, else the first compatible entry
 *   withdraw --to <p>            send CC back out (--amount <cc> for a partial amount)
 *   swap --in <SYM> --out <SYM> --amount <n> [--venue cantex|tradecraft|auto] [--slippage <pct>] [--direct] [--no-wait]
 *                                swap on Cantex (default) or Tradecraft: pre-approve the output, send
 *                                the input to the pool, and WAIT until the output
 *                                lands (no manual claim). By DEFAULT the ticket (pool,
 *                                minimum, amm_cid) comes from our x402 swap endpoint (a
 *                                small CC fee for always-current data;
 *                                CANTON_AGENT_SWAP_URL overrides it). --direct resolves
 *                                the ticket locally from Tradecraft with no fee (a
 *                                best-effort snapshot). --no-wait returns as soon as the
 *                                input is sent (fire-and-forget; claim it yourself).
 *   tc setup|orders|status|withdraw --pair <A>/<B> …
 *                                Tradecraft QUEUED mode: committed allocations + batched
 *                                orders instead of a pool-address transfer. setup creates
 *                                the batcher and one allocation per pool instrument
 *                                (--fund <SYM>=<n> funds the one you sell, or tops up an
 *                                existing one); orders queues
 *                                exact-input orders (--sell, --amounts or --amount
 *                                [--count]); status shows allocation funding and open
 *                                orders; cancel abandons pending orders (input stays in the
 *                                allocation); withdraw --instrument asks the venue to release
 *                                an allocation back to the wallet (whole, asynchronous).
 *   export                       print the private key (backup; guard it)
 *   import [--relay-url <url>] [--key-file <p>]  restore a wallet from a backed-up
 *                                key (stdin or --key-file); inverse of export
 *   set-relay <url>              switch the relay saved in wallet.json (checks it
 *                                settles on this wallet's network first)
 *
 * The relay (facilitator) URL is REQUIRED for the commands that talk to a
 * relay (`create`, `pay`, `import`). There is intentionally no built-in default — a
 * wrong/stale default would silently send an agent's payments to a dead host.
 * Supply it via `--relay-url <url>` or the `CANTON_AGENT_RELAY_URL` env var.
 * The current FTP facilitator is `https://facilitator.ftptech.xyz`. Every other
 * command uses the relay saved in the wallet at `create` time, unless
 * `--relay-url` / CANTON_AGENT_RELAY_URL names another one for that run;
 * `set-relay` changes the saved one.
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
import type { StarterGrantResult } from "./starter-grant.js";
import { loadWallet, saveWallet, walletPath, type AgentWallet } from "./store.js";
import { agentKeyFromPrivatePem } from "./keys.js";
import { makePayingFetch } from "./pay.js";
import { RelayClient, isHoldingsExceedNodeLimitError } from "./relay-client.js";
import {
  claimAll,
  selfProvisionPreapproval,
  selfProvisionRegistryPreapproval,
} from "./tx.js";
import { isTrustedRegistryAdmin, resolveSwapSymbol } from "./registry-parties.js";
import { mergeHoldings, mergeAllRegistryHoldings } from "./merge.js";
import { withdraw } from "./withdraw.js";
import { executeSwap } from "./swap.js";
import {
  resolveSwapIntent,
  resolveSwapTicket,
  swapFloorNotes,
  parseSwapVenue,
  parseSlippagePct,
  SWAP_MAX_FEE_CC,
  type SwapNote,
} from "./swap-route.js";
import { installProxyFromEnv } from "./proxy.js";
import {
  loadTcPool,
  tcOrders,
  tcSetup,
  tcStatus,
  tcWithdraw,
  tcCancel,
  type TcContext,
} from "./tradecraft-queued.js";
import {
  flag,
  boolFlag,
  intFlag,
  positionals,
  resolveNetwork,
  resolveRelayUrl,
  MISSING_RELAY_HELP,
  withdrawAmount,
  preapprovalMode,
  payLimits,
  preapprovalInstrumentId,
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

  /** The relay this run talks to: `--relay-url` / CANTON_AGENT_RELAY_URL when
   *  given, else the one saved at `create`. A flag that was silently ignored
   *  pointed commands at the old relay after a cut-over; now it wins, and is
   *  never written back (`set-relay` does that on purpose). */
  const relayFor = (w: AgentWallet): AgentWallet => {
    const url = resolveRelayUrl(args);
    if (!url || url === w.relayUrl) return w;
    console.error(
      `(using relay ${url}; this wallet's saved relay is ${w.relayUrl} — ` +
        `\`canton-agent-wallet set-relay <url>\` changes it)`
    );
    return { ...w, relayUrl: url };
  };
  const requireWallet = (): AgentWallet => {
    const w = loadWallet();
    if (!w) return fail("no wallet yet — run: canton-agent-wallet create");
    return relayFor(w);
  };

  switch (cmd) {
    case "create": {
      const relayUrl = requireRelay(args);
      const existing = loadWallet();
      if (!existing) console.error("creating the wallet (takes about half a minute)…");
      else if (existing.relayUrl !== relayUrl) {
        console.error(
          `a wallet already exists; it keeps its saved relay ${existing.relayUrl}. ` +
            `To switch it to ${relayUrl}: canton-agent-wallet set-relay ${relayUrl}`
        );
      }
      // A relay that funds new wallets sends a starter grant; ensureWallet
      // waits for it and accepts it before returning.
      const grant: { r?: StarterGrantResult } = {};
      const w = await ensureWallet({
        relayUrl,
        network: resolveNetwork(args),
        apiKey: API_KEY,
        onStarterGrant: (r) => {
          grant.r = r;
        },
      });
      const g = grant.r;
      const starterLine = !g
        ? ""
        : g.status === "accepted"
          ? `  starter: ${g.amountCc} CC received — the wallet can pay right away\n`
          : g.status === "not_arrived"
            ? `  starter: ${g.amountCc} CC is on its way — run \`canton-agent-wallet claim\` in a minute\n`
            : `  starter: ${g.amountCc} CC arrived but accepting it failed (${g.error ?? "unknown error"}) — run \`canton-agent-wallet claim\`\n`;
      console.log(
        `wallet ready (${w.network})\n` +
          `  party:   ${w.party}\n` +
          starterLine +
          `  fund me: send CC to that party id, then run: canton-agent-wallet claim\n` +
          `  keyfile: ${walletPath()}  <- this IS your wallet; back it up\n` +
          `  By creating a wallet you accept the Terms of Service: https://ftp-tech.mintlify.site/terms`
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
      const w = requireWallet();
      try {
        const relay = new RelayClient({ relayUrl: w.relayUrl, apiKey: API_KEY });
        const b = await relay.balance(w.party);
        console.log(`${b.cc} CC  (${b.amulet} holding${b.amulet === 1 ? "" : "s"})`);
        // Then every OTHER instrument, through the HoldingV1 read. Best-effort
        // and printed after CC on purpose: a relay that predates /holdings makes
        // this line throw, and a wallet must keep showing its Canton Coin on an
        // older relay rather than fail the whole command over a token listing.
        //
        // Read BOUNDED: a wallet with more holdings than the participant lists in
        // one read gets part of them (complete:false). The totals are then
        // lower bounds, shown as "≥", with the command that makes them exact —
        // this line used to swallow that 413 and print nothing at all, so a
        // wallet full of USDCx looked like it held only Canton Coin. Only the
        // tokens are asked for (`registryOnly`): on a current relay Canton Coin
        // dust then no longer turns every token total into a lower bound.
        try {
          const h = await relay.holdings(w.party, undefined, { slice: true, registryOnly: true });
          const ge = h.complete ? "" : "≥ ";
          for (const ins of h.instruments) {
            if (ins.id === "Amulet") continue; // already printed as CC above
            const locked = ins.holdings.filter((x) => x.locked).length;
            console.log(
              `${ge}${ins.total} ${ins.id}  (${ge}${ins.holdings.length} holding${ins.holdings.length === 1 ? "" : "s"}` +
                (locked ? `, ${locked} locked` : "") +
                `)  @ ${ins.admin}`
            );
          }
          if (!h.complete) {
            console.log(
              "  (this wallet holds more than the participant lists in one read — token totals above " +
                "are lower bounds; consolidate with: canton-agent-wallet merge --all-tokens, " +
                "and plain `canton-agent-wallet merge` for Canton Coin dust)"
            );
          }
        } catch (err) {
          // An older relay without /holdings answers Fastify's route-not-found;
          // that stays quiet (the CC line above is the whole answer there). Any
          // other failure is said, not swallowed.
          const notServed = err instanceof Error && /-> 404 .*Route GET:/.test(err.message);
          if (!notServed) {
            console.error(
              `tokens: could not list (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`
            );
          }
        }
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
      const w = requireWallet();
      const target = intFlag(args, "--target");
      const batch = intFlag(args, "--batch");
      const maxRounds = intFlag(args, "--max-rounds");
      const dryRun = boolFlag(args, "--dry-run");
      // --yes acknowledges the Global-Synchronizer traffic cost of a LARGE whale
      // pass (>20 planned batches). Without it, mergeHoldings throws before
      // submitting anything; the catch below surfaces that as a clean error.
      const yes = boolFlag(args, "--yes");
      // --admin <registrar> --id <instrument> merges a registry token (e.g. USDCx)
      // instead of Canton Coin; same trust rule as `withdraw`.
      const mAdmin = flag(args, "--admin");
      const mId = flag(args, "--id");
      if ((mAdmin && !mId) || (!mAdmin && mId)) {
        return fail("merge: --admin <registrar> and --id <instrument> must be given together");
      }
      // --all-tokens: every token of a trusted registrar, whatever the mix — the
      // way through a wallet whose oldest holdings are another token's dust.
      if (boolFlag(args, "--all-tokens")) {
        if (mAdmin) return fail("merge: --all-tokens merges every trusted token — drop --admin/--id");
        const res = await mergeAllRegistryHoldings(
          new RelayClient({ relayUrl: w.relayUrl, apiKey: API_KEY }),
          w,
          {
            ...(batch !== undefined ? { batch } : {}),
            ...(maxRounds !== undefined ? { maxRounds } : {}),
            dryRun,
            yes,
            onProgress: (line) => console.log(line),
          }
        );
        if (!dryRun) {
          console.log(
            `merge complete: ${res.rounds} batch transfer(s), ${res.merged.length} token holding(s) consumed` +
              (res.skippedStale > 0 ? ` (${res.skippedStale} stale batch(es) skipped)` : "")
          );
        }
        break;
      }
      if (mAdmin && !isTrustedRegistryAdmin(mAdmin, process.env)) {
        return fail(
          `merge: ${mAdmin} is not a known registry admin — add it via ` +
            `CANTON_AGENT_REGISTRY_TRUSTED_PARTIES before merging its token`
        );
      }
      const relay = new RelayClient({ relayUrl: w.relayUrl, apiKey: API_KEY });
      const res = await mergeHoldings(relay, w, {
        ...(target !== undefined ? { target } : {}),
        ...(batch !== undefined ? { batch } : {}),
        ...(maxRounds !== undefined ? { maxRounds } : {}),
        ...(mAdmin && mId ? { instrumentAdmin: mAdmin, instrumentId: mId } : {}),
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
            `${res.merged.length} ${mId ? `${mId} holding(s)` : "amulet(s)"} consumed` +
            (extras.length ? ` (${extras.join(", ")})` : "") +
            (res.finalHoldings === null
              ? mId
                ? " — more remain than one read lists; see above"
                : " — remaining holdings predate this run; re-run `merge` after the next " +
                  "Scan snapshot (~12:00 UTC daily) to continue"
              : ` → ${res.finalHoldings} holding(s) remain`)
        );
      }
      break;
    }
    case "claim": {
      const w = requireWallet();
      const r = await claimAll(new RelayClient({ relayUrl: w.relayUrl, apiKey: API_KEY }), w);
      // Say what happened to EVERY pending row, not just the claimed ones. An
      // expired offer is skipped (the ledger would refuse its accept); a failed
      // one is reported by cid with the reason, and the others still land.
      const parts = [
        r.claimed ? `claimed ${r.claimed} incoming transfer(s)` : "nothing to claim",
        r.skippedExpired ? `skipped ${r.skippedExpired} expired` : "",
        r.skippedUntrusted.length
          ? `skipped ${r.skippedUntrusted.length} offer(s) of a token whose registrar this wallet does not trust ` +
            `(${[...new Set(r.skippedUntrusted.map((s) => s.admin))].join(", ")} — add it via CANTON_AGENT_REGISTRY_TRUSTED_PARTIES to claim them)`
          : "",
        r.failed.length ? `${r.failed.length} failed` : "",
      ].filter(Boolean);
      console.log(parts.join("; "));
      for (const f of r.failed) console.error(`  failed ${f.cid.slice(0, 18)}…: ${f.error}`);
      // A scripted `claim && pay` must not proceed unfunded: when every
      // attempted accept failed, say so with the exit code, not only on stderr.
      if (r.claimed === 0 && r.failed.length > 0) {
        return fail("claim: every attempted accept failed — nothing was claimed");
      }
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
      const w = requireWallet();
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
            (status.expiresAt ? `\n  expiresAt:      ${status.expiresAt}` : "") +
            (status.expired === true ? `\n  EXPIRED:        yes` : "") +
            (status.expiryNote ? `\n  ${status.expiryNote}` : "") +
            (status.guidance ? `\n  ${status.guidance}` : "") +
            (status.note ? `\n  ${status.note}` : "")
        );
        break;
      }
      // Renewal short-circuit. `hasPreapproval` alone is NOT enough: a relay
      // that predates the expiry fix reports `true` for an EXPIRED preapproval
      // (the transfer kind stays `direct`), which silently turned every renewal
      // into a no-op and left the merchant unable to receive payments at all.
      // Skip only when the contract is provably still live, and let --force
      // override for the case where the relay cannot tell us.
      const force = boolFlag(args, "--force");
      const provablyLive = status.hasPreapproval === true && status.expired !== true;
      if (provablyLive && !force) {
        const until = status.expiresAt ? ` (expires ${status.expiresAt})` : "";
        const blind = status.expiresAt
          ? ""
          : "\n  note: this relay does not report expiresAt, so liveness could not be" +
            " confirmed — re-run with --force to renew anyway";
        console.log(
          `merchant ${w.party} already has a live TransferPreapproval${until} — nothing to do (ready for transfer-factory payments)${blind}`
        );
        break;
      }
      if (status.expired === true) {
        console.log(
          `merchant ${w.party} has an EXPIRED TransferPreapproval (expired ${status.expiresAt}) — renewing`
        );
      } else if (force && status.hasPreapproval === true) {
        console.log(`--force: renewing ${w.party}'s TransferPreapproval anyway`);
      }
      // Resolve the expiry: --expires-at <ISO> wins; else --days N (default 30).
      const daysFlag = Number(flag(args, "--days"));
      const days = Number.isFinite(daysFlag) && daysFlag > 0 ? daysFlag : 30;
      const expiresAt =
        flag(args, "--expires-at") ||
        new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();

      // THE FLAG, AND ONLY THE FLAG, PICKS THE MODE.
      //
      // This used to OR in `process.env.CANTON_X402_OPERATOR_TOKEN`, and that
      // name belongs to a different component: everywhere else in this repo it
      // is the FACILITATOR SERVER's own secret, gating operator mutations on
      // the registry. Sourcing the facilitator's .env — the ordinary thing to
      // do on the facilitator host, where this repo's own ops flows run — then
      // silently changed which party becomes the preapproval provider and who
      // prepays the holding fee, with no flag, no prompt, and nothing in the
      // output before submission. The documented default is self-provision.
      //
      // An ambient value is not an instruction. Say it was ignored, and how to
      // ask for the legacy mode on purpose.
      const mode = preapprovalMode(args, process.env);
      if (mode.mode === "self" && mode.ambientIgnored) {
        console.error(
          "note: CANTON_X402_OPERATOR_TOKEN is set in this environment and was " +
            "IGNORED — that variable is the facilitator server's own secret, " +
            "not a mode switch. Self-provisioning with this wallet's key. Pass " +
            "--operator-token <t> if you meant the legacy facilitator-as-provider mode."
        );
      }
      const operatorToken = mode.mode === "legacy" ? mode.operatorToken : undefined;
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
      // NON-Amulet CIP-56 registry token (USDCx, …): a `--admin` that is a known/
      // configured registry gets a Utility.Registry preapproval created with the
      // wallet's OWN key (no fee, no operator token). `--id` names the instrument
      // (default USDCx for the USDCx registrar). Detected out-of-band via the
      // client's trusted-registry table/env, so an arbitrary --admin cannot be
      // blind-trusted.
      if (isTrustedRegistryAdmin(admin, process.env)) {
        const id = preapprovalInstrumentId(args, admin);
        if (id === undefined) {
          return fail(
            `preapproval: pass --id <instrument> — this wallet does not know which instrument ` +
              `${admin} issues, and provisioning the wrong one is not harmless`
          );
        }
        // ABSENCE MUST BE PROVEN BEFORE CREATING, because this create is not
        // idempotent: run it twice and the merchant ends up with two live
        // Utility.Registry TransferPreapproval contracts for the same
        // {receiver, instrumentAdmin}.
        //
        // The status check above is Amulet-shaped — it asks the SV Scan how a
        // transfer would route — so for a registry instrument it cannot answer
        // and honestly reports hasPreapproval: null. The bug was reading that
        // "I do not know" as "there is none" and creating anyway, which is the
        // exact inversion of the rule the status route documents for itself:
        // only ever tighten on data actually read.
        //
        // So: create when we can see there is none, refuse when we cannot tell,
        // and let --force be the operator saying it on purpose.
        if (status.hasPreapproval !== false && !force) {
          return fail(
            `cannot confirm whether ${w.party} already has a ${id} preapproval ` +
              `on ${admin} (status reported ${JSON.stringify(status.hasPreapproval)}), ` +
              `and creating a second one is not harmless — the merchant would ` +
              `carry duplicate live preapprovals. Re-run with --force to create ` +
              `it anyway, or check the registry directly.`
          );
        }
        try {
          const res = await selfProvisionRegistryPreapproval(relay, w, {
            instrumentId: { admin, id },
          });
          console.log(
            `Registry TransferPreapproval self-provisioned for ${w.party} (ready to receive ${id})\n` +
              `  instrument: ${id} @ ${admin}\n` +
              `  updateId:   ${res.updateId}`
          );
        } catch (e) {
          return fail(`registry self-provision failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }
      // DEFAULT: SELF-provision with the merchant's OWN key — no token, no
      // delegation. The merchant prepays the fee from its own CC.
      try {
        const res = await selfProvisionPreapproval(relay, w, { expiresAt, dso: admin });
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
        return fail(
          "usage: canton-agent-wallet pay [--relay-url <url>] [--asset <symbol>] [--max <amount>] [--pay-to <party>] <url>"
        );
      // Reuse the wallet's stored relay (like claim/balance) when neither
      // --relay-url nor CANTON_AGENT_RELAY_URL is given, so an already-created
      // agent can pay without re-specifying the relay each time.
      const existing = loadWallet();
      const relayUrl =
        resolveRelayUrl(args) ?? existing?.relayUrl ?? fail(MISSING_RELAY_HELP);
      // --asset <symbol> pays in that instrument when the 402 offers several
      // (case-insensitive; an asset the 402 does not offer fails closed with
      // the offered list). Omitted → the first compatible accepts[] entry.
      // Selection only; spending a registry token still needs
      // CANTON_AGENT_PAYABLE_INSTRUMENTS.
      const preferAsset = flag(args, "--asset");
      // --max caps what one payment may cost (in the paid asset's own unit);
      // --pay-to pins the only payee the wallet will sign for. Both refuse
      // BEFORE anything is signed; see payLimits.
      const limits = payLimits(args);
      if (limits.kind === "error") return fail(limits.message);
      const f = await makePayingFetch({
        relayUrl,
        network: existing?.network ?? resolveNetwork(args),
        apiKey: API_KEY,
        ...(preferAsset ? { preferAsset } : {}),
        ...(limits.maxPaymentValue !== undefined ? { maxPaymentValue: limits.maxPaymentValue } : {}),
        ...(limits.maxPaymentValueByInstrument !== undefined
          ? { maxPaymentValueByInstrument: limits.maxPaymentValueByInstrument }
          : {}),
        ...(limits.expectedPayTo !== undefined ? { expectedPayTo: limits.expectedPayTo } : {}),
      });
      const res = await f(url);
      console.log(`${res.status} ${res.statusText}`);
      console.log(await res.text());
      break;
    }
    case "withdraw": {
      const to = flag(args, "--to");
      if (!to) return fail("usage: canton-agent-wallet withdraw --to <party> [--amount <n>] [--admin <registrar> --id <instrument>]");
      // PRESENT-BUT-EMPTY IS NOT ABSENT, and here the difference is the whole
      // wallet. Omitting --amount means "send the full balance" (withdraw.ts),
      // and the old truthiness filter `amount ? {amount} : {}` treated
      // `--amount ""` and a trailing `--amount` with no value exactly like
      // omission — so `--amount "$AMT"` with AMT unset swept everything, with
      // no confirmation and only an after-the-fact log line. withdraw() would
      // itself have refused the empty string; the CLI's filter is what turned a
      // clean refusal into a sweep.
      //
      // This is the rule cli-args' own intFlag already states for value flags:
      // a present-but-invalid value fails fast rather than falling back.
      const amt = withdrawAmount(args);
      if (amt.kind === "error") return fail(amt.message);
      // --admin <registrar> --id <instrument> withdraws a registry token (e.g.
      // USDCx) instead of Canton Coin. Both halves together, or neither: half
      // an instrument cannot name one, and a withdraw that silently fell back
      // to CC would send the wrong asset to an external address.
      const wAdmin = flag(args, "--admin");
      const wId = flag(args, "--id");
      if ((wAdmin && !wId) || (!wAdmin && wId)) {
        return fail("withdraw: --admin <registrar> and --id <instrument> must be given together");
      }
      if (wAdmin && !isTrustedRegistryAdmin(wAdmin, process.env)) {
        return fail(
          `withdraw: ${wAdmin} is not a known registry admin — add it via ` +
            `CANTON_AGENT_REGISTRY_TRUSTED_PARTIES before withdrawing its token`
        );
      }
      const r = await withdraw({
        to,
        wallet: requireWallet(),
        ...(amt.kind === "amount" ? { amount: amt.amount } : {}),
        ...(wAdmin && wId ? { instrumentAdmin: wAdmin, instrumentId: wId } : {}),
        apiKey: API_KEY,
      });
      // Say whether it LANDED. Without a TransferPreapproval on the receiver the
      // transfer settles as an offer they must `claim` — the funds are on-ledger
      // but not yet theirs to spend, and a bare "withdrew X to Y" reads as done.
      // `landed === null` is the relay declining to say, so nothing is claimed.
      const settle =
        r.landed === true
          ? "\n  landed in the receiver's wallet (they hold a preapproval)"
          : r.landed === false
            ? `\n  ! NOT in their wallet yet — the receiver has no preapproval, so this is a` +
              ` pending offer they must accept with \`canton-agent-wallet claim\``
            : "";
      console.log(
        `withdrew ${r.amount} ${wId ?? "CC"} to ${to}\n  updateId: ${r.updateId}${settle}`
      );
      break;
    }
    case "swap": {
      // Swap `--amount` of `--in` for `--out` on a venue. Routing (venue choice,
      // fallbacks, minimums) lives in swap-route.ts and is shared with the MCP
      // `swap` tool; this case only parses flags and prints.
      const inSym = flag(args, "--in");
      const outSym = flag(args, "--out");
      const amount = flag(args, "--amount");
      if (!inSym || !outSym || !amount) {
        return fail(
          "usage: canton-agent-wallet swap --in <SYMBOL> --out <SYMBOL> --amount <n> [--venue cantex|tradecraft|auto] [--slippage <pct>] [--direct] [--no-wait]"
        );
      }
      const slippagePct = parseSlippagePct(flag(args, "--slippage"));
      // Venue selection. Default CANTEX (Cantex Connect works today and is keyless);
      // `tradecraft` uses pool addresses; `auto` compares free quotes from both
      // eligible venues and picks the better expected output.
      const venue = parseSwapVenue(flag(args, "--venue"));
      const intent = resolveSwapIntent(inSym, outSym, { in: "--in", out: "--out" });
      const { inCanon, outCanon } = intent;
      const direct = boolFlag(args, "--direct");
      const existing = loadWallet();
      const dsoParty = resolveTrustedDsoParty(
        process.env,
        existing?.network ?? resolveNetwork(args)
      );
      const printNote = (n: SwapNote): void => {
        if (n.level === "warn") console.error(`  ! ${n.text}`);
        else console.log(`  ${n.text}`);
      };
      const { ticket } = await resolveSwapTicket({
        intent,
        amount,
        slippagePct,
        venue,
        venueExplicit: flag(args, "--venue") !== undefined,
        direct,
        dsoParty,
        onNote: printNote,
        payingFetch: async () => {
          const relayUrl =
            resolveRelayUrl(args) ?? existing?.relayUrl ?? fail(MISSING_RELAY_HELP);
          // The endpoint auto-settles whatever 402 it answers BEFORE any ticket
          // validation, so bound the fee: a ceiling that always applies, plus an
          // optional exact payee pin.
          const maxFee = flag(args, "--max-fee") ?? SWAP_MAX_FEE_CC;
          const swapMerchant =
            flag(args, "--swap-merchant") ?? process.env.CANTON_AGENT_SWAP_MERCHANT;
          return makePayingFetch({
            relayUrl,
            network: existing?.network ?? resolveNetwork(args),
            apiKey: API_KEY,
            maxPaymentValue: maxFee,
            ...(swapMerchant ? { expectedPayTo: swapMerchant } : {}),
          });
        },
      });
      console.log(
        `quote: ${amount} ${inCanon} -> ~${ticket.quote} ${outCanon}\n  venue: ${ticket.venue}\n  pool: ${ticket.poolParty}`
      );
      for (const n of swapFloorNotes(ticket, slippagePct, outCanon)) printNote(n);
      // A registry output is preapproved by default so the pool can deliver it
      // directly (it delivers only to a preapproved receiver); --no-preapprove
      // opts out (e.g. the preapproval already exists).
      // By default `swap` WAITS until the output lands (no manual claim after);
      // --no-wait returns as soon as the input is sent (fire-and-forget).
      const wait = !boolFlag(args, "--no-wait");
      const sr = await executeSwap({
        amount,
        ticket,
        ...(existing ? { wallet: relayFor(existing) } : {}),
        apiKey: API_KEY,
        preapproveOutput: !boolFlag(args, "--no-preapprove"),
        waitForOutput: wait,
      });
      const head = `sent input to pool\n  updateId: ${sr.sentUpdateId}`;
      if (!wait) {
        console.log(
          `${head}\n  --no-wait: not waiting for the return — run \`canton-agent-wallet claim\`` +
            ` shortly (or check \`balance\`) to pick up the ${outCanon}`
        );
      } else if (sr.delivered !== undefined) {
        console.log(`${head}\n  received ${sr.delivered} ${outCanon}`);
      } else if (sr.inputReturned) {
        // The CC came back instead of the output: the venue would not fill the
        // trade (below its minimum) and handed the input back directly.
        console.log(
          `${head}\n  ! input RETURNED — nothing was swapped: the CC balance is back at its ` +
            `pre-send level (the venue hands back a trade it will not fill, e.g. below its minimum)`
        );
      } else if (sr.deliveryUnobservable) {
        // Reached only after the input was sent (sentUpdateId above), so "do not
        // resend" is true here. The wait claimed offers and watched for a
        // returned input; only the delivery itself could not be seen.
        console.log(
          `${head}\n  ! cannot confirm delivery: the relay cannot list every ${outCanon} holding of ` +
            `this wallet (more of that registry's holdings than the participant lists in one ` +
            `read), so the new one is out of view. The input WAS sent: do NOT resend. A trade ` +
            `the venue will not fill comes back as an offer — run \`canton-agent-wallet claim\` ` +
            `in a minute to pick it up. Run \`canton-agent-wallet merge --all-tokens\` (plain ` +
            `\`canton-agent-wallet merge\` first if Canton Coin dust fills the wallet), then ` +
            `check \`balance\`.` +
            (sr.partialRise !== undefined
              ? `\n  note: before that, the ${outCanon} balance rose ${sr.partialRise}, below the ` +
                `ticket minimum ${ticket.minOutput} — possibly an unrelated inbound, not this swap's fill`
              : "") +
            (sr.claimed > 0
              ? `\n  claimed ${sr.claimed} incoming transfer(s): ${sr.claimedUpdateIds.join(", ")}`
              : "") +
            (sr.pollErrors > 0
              ? `\n  ! ${sr.pollErrors} poll error(s) while waiting — the relay was flaky, but ` +
                "the input WAS sent (updateId above); do NOT resend, check `balance` first"
              : "")
        );
      } else {
        // Waited, no arrival: still settling, or a below-minimum trade whose input
        // was returned (the per-tick claim picks that return up — `claimed` shows
        // it). A sub-minimum balance rise is reported as such, never as a fill.
        console.log(
          `${head}\n  ! ${outCanon} not received yet — it may still be settling ` +
            "(run `canton-agent-wallet claim` / check `balance`), or the trade was below " +
            "the pool minimum and your input was returned" +
            (sr.partialRise !== undefined
              ? `\n  note: ${outCanon} balance rose ${sr.partialRise}, below the ticket minimum ` +
                `${ticket.minOutput} — possibly an unrelated inbound, not this swap's fill`
              : "") +
            (sr.claimed > 0
              ? `\n  claimed ${sr.claimed} incoming transfer(s): ${sr.claimedUpdateIds.join(", ")}`
              : "") +
            (sr.pollErrors > 0
              ? `\n  ! ${sr.pollErrors} poll error(s) while waiting — the relay was flaky, but ` +
                "the input WAS sent (updateId above); do NOT resend, check `balance` first"
              : "")
        );
      }
      break;
    }
    case "tc": {
      // Tradecraft QUEUED mode (committed allocations + batched orders); see
      // tradecraft-queued.ts. The pool is named by its two symbols.
      const sub = positionals(args)[0];
      const usage =
        "usage: canton-agent-wallet tc setup --pair <A>/<B> [--fund <SYM>=<n>[,<SYM>=<n>]] | " +
        "tc orders --pair <A>/<B> --sell <SYM> (--amounts <n>[,<n>…] | --amount <n> [--count <k>]) [--slippage <pct>] | " +
        "tc status --pair <A>/<B> | tc cancel --pair <A>/<B> [--order <cid>] | tc withdraw --pair <A>/<B> --instrument <SYM>";
      const pair = (flag(args, "--pair") ?? "").split("/");
      if (!sub || pair.length !== 2 || !pair[0] || !pair[1]) return fail(usage);
      const w = requireWallet();
      const ctx: TcContext = { relay: new RelayClient({ relayUrl: w.relayUrl, apiKey: API_KEY }), wallet: w };
      const pool = await loadTcPool(ctx, pair[0], pair[1]);
      const canon = (sym: string): string => {
        const leg = resolveSwapSymbol(sym);
        return leg.kind === "cc" ? "CC" : leg.kind === "registry" ? leg.symbol : sym;
      };
      if (sub === "setup") {
        const fund: Record<string, string> = {};
        for (const part of (flag(args, "--fund") ?? "").split(",").filter((x) => x.trim() !== "")) {
          const [sym, amt] = part.split("=");
          if (!sym || !amt) return fail(`tc setup: --fund takes <SYM>=<amount>, got ${JSON.stringify(part)}`);
          fund[canon(sym.trim())] = amt.trim();
        }
        const r = await tcSetup(ctx, pool, fund);
        console.log(`pool ${pool.ammId}`);
        console.log(`  batcher: ${r.batcher.created ? "created" : "exists"} ${r.batcher.contractId ?? ""}`.trimEnd());
        for (const [sym, a] of Object.entries(r.allocations)) {
          console.log(`  ${sym} allocation: ${a.created ? "created" : a.toppedUp ? "topped up" : "exists"}, funding ${a.funding}`);
        }
      } else if (sub === "orders") {
        const sell = flag(args, "--sell");
        if (!sell) return fail(usage);
        let amounts: string[];
        const list = flag(args, "--amounts");
        if (list) {
          amounts = list.split(",").map((x) => x.trim()).filter((x) => x !== "");
        } else {
          const one = flag(args, "--amount");
          if (!one) return fail(usage);
          const count = intFlag(args, "--count") ?? 1;
          if (count < 1 || count > 50) return fail("tc orders: --count must be 1..50");
          amounts = Array.from({ length: count }, () => one);
        }
        const r = await tcOrders(ctx, pool, canon(sell), amounts, parseSlippagePct(flag(args, "--slippage")));
        console.log(`queued ${r.orders.length} order(s) on ${pool.ammId}\n  updateId: ${r.updateId}`);
        for (const o of r.orders) console.log(`  sell ${o.amount} ${canon(sell)}  quote ${o.quote}  min ${o.minOut}`);
        console.log("  fills settle into your allocations — check with: canton-agent-wallet tc status --pair " + pair.join("/"));
      } else if (sub === "status") {
        const st = await tcStatus(ctx, pool);
        console.log(`pool ${st.ammId}`);
        console.log(`  batcher: ${st.batcher ?? "none (run tc setup)"}`);
        for (const sym of Object.keys(pool.instruments)) {
          const a = st.allocations[sym];
          console.log(`  ${sym} allocation: ${a ? a.funding : "none"}`);
        }
        console.log(`  open orders: ${st.openOrders}`);
      } else if (sub === "cancel") {
        const r = await tcCancel(ctx, pool, flag(args, "--order"));
        if (r.length === 0) console.log(`no open orders on ${pool.ammId}`);
        for (const c of r) {
          console.log(c.gone ? `order ${c.orderCid}: already filled or cancelled by the venue` : `order ${c.orderCid}: cancelled (updateId ${c.updateId})`);
        }
      } else if (sub === "withdraw") {
        const ins = flag(args, "--instrument");
        if (!ins) return fail(usage);
        const id = await tcWithdraw(ctx, pool, canon(ins));
        console.log(
          `withdrawal of the ${canon(ins)} allocation on ${pool.ammId} requested\n  updateId: ${id}\n` +
            "  the venue releases it to your wallet shortly (refused while a fill is unsettled — then request again)"
        );
      } else {
        return fail(usage);
      }
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
    case "set-relay": {
      // Change the relay SAVED in wallet.json — the one every command uses when
      // no --relay-url is given. Refuses a relay that settles on a different
      // network: the wallet's DSO pin and parties are network-specific.
      const url = positionals(args)[0];
      if (!url) return fail("usage: canton-agent-wallet set-relay <url>");
      const w = loadWallet();
      if (!w) return fail("no wallet yet — run: canton-agent-wallet create");
      let net: string | undefined;
      try {
        const sup = await new RelayClient({ relayUrl: url, apiKey: API_KEY }).supported();
        net = sup?.kinds?.find((k) => typeof k?.network === "string" && k.network.length > 0)?.network;
      } catch (err) {
        return fail(`set-relay: could not reach ${url} (${err instanceof Error ? err.message : String(err)})`);
      }
      if (!net) return fail(`set-relay: ${url} does not say which network it settles on — not switching`);
      if (net !== w.network) {
        return fail(`set-relay: ${url} settles on ${net}, but this wallet is on ${w.network} — not switching`);
      }
      saveWallet({ ...w, relayUrl: url });
      console.log(`relay set: ${w.relayUrl} → ${url} (${net})`);
      break;
    }
    default:
      console.error(
        "canton-agent-wallet: create | address | balance | claim | merge [--target <n>] [--batch <n>] [--max-rounds <n>] [--dry-run] [--yes] [--admin <registrar> --id <instrument> | --all-tokens] | preapproval [--status] [--admin <DSO|registrar>] [--id <instrument>] [--operator-token <t>] [--days <n>] [--expires-at <iso>] | pay [--asset <symbol>] [--max <amount>] [--pay-to <party>] <url> | swap --in <SYM> --out <SYM> --amount <n> [--venue cantex|tradecraft|auto] [--slippage <pct>] [--direct] [--no-wait] [--max-fee <cc>] [--swap-merchant <party>] [--no-preapprove] | withdraw --to <party> [--amount <n>] [--admin <registrar> --id <instrument>] | tc setup|orders|status|cancel|withdraw --pair <A>/<B> [...] | export | import | set-relay <url>\n" +
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
