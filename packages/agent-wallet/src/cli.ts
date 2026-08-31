#!/usr/bin/env node
/**
 * canton-agent-wallet CLI — the surface an agent (or its human) drives.
 *
 *   create  [--relay-url <url>]  generate + onboard a self-custody wallet (idempotent)
 *   address                      print the party id (fund this)
 *   balance                      print every instrument the wallet holds (CC + registry tokens)
 *   claim                        accept incoming transfers (e.g. the initial funding)
 *   merge [--target <n>] [--batch <n>] [--max-rounds <n>] [--dry-run] [--yes] [--admin <registrar> --id <instrument>]
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
 *   pay [--relay-url <url>] [--asset <symbol>] <url>  fetch a URL, auto-paying any
 *                                x402 402 challenge; --asset prefers that
 *                                instrument (e.g. USDCx) when the 402 offers
 *                                several, else the first compatible entry
 *   withdraw --to <p>            send CC back out (--amount <cc> for a partial amount)
 *   swap --in <SYM> --out <SYM> --amount <n> [--slippage <pct>] [--direct] [--no-wait]
 *                                swap on Tradecraft: pre-approve the output, send
 *                                the input to the pool, and WAIT until the output
 *                                lands (no manual claim). By DEFAULT the ticket (pool,
 *                                minimum, amm_cid) comes from our x402 swap endpoint (a
 *                                small CC fee for always-current data;
 *                                CANTON_AGENT_SWAP_URL overrides it). --direct resolves
 *                                the ticket locally from Tradecraft with no fee (a
 *                                best-effort snapshot). --no-wait returns as soon as the
 *                                input is sent (fire-and-forget; claim it yourself).
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
  selfProvisionRegistryPreapproval,
} from "./tx.js";
import {
  isTrustedRegistryAdmin,
  resolveSwapSymbol,
  KNOWN_INSTRUMENTS,
} from "./registry-parties.js";
import { mergeHoldings } from "./merge.js";
import { withdraw } from "./withdraw.js";
import {
  buildLocalTicket,
  fetchTicketFromEndpoint,
  executeSwap,
  tradecraftMinInput,
} from "./swap.js";
import { fundViaQuest } from "./quest-fund.js";
import { installProxyFromEnv } from "./proxy.js";
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
} from "./cli-args.js";
import { resolveTrustedDsoParty } from "./trusted-dso.js";

/** Ceiling on the swap-ticket fee the endpoint may charge, in CC. The live fee is
 *  0.01 CC, so this leaves a wide margin while still bounding a hijacked endpoint
 *  to a trivial loss instead of the agent's balance. Override with --max-fee. */
const SWAP_MAX_FEE_CC = "0.5";

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
        const relay = new RelayClient({ relayUrl: w.relayUrl, apiKey: API_KEY });
        const b = await relay.balance(w.party);
        console.log(`${b.cc} CC  (${b.amulet} holding${b.amulet === 1 ? "" : "s"})`);
        // Then every OTHER instrument, through the HoldingV1 read. Best-effort
        // and printed after CC on purpose: a relay that predates /holdings makes
        // this line throw, and a wallet must keep showing its Canton Coin on an
        // older relay rather than fail the whole command over a token listing.
        try {
          const h = await relay.holdings(w.party);
          for (const ins of h.instruments) {
            if (ins.id === "Amulet") continue; // already printed as CC above
            const locked = ins.holdings.filter((x) => x.locked).length;
            console.log(
              `${ins.total} ${ins.id}  (${ins.holdings.length} holding${ins.holdings.length === 1 ? "" : "s"}` +
                (locked ? `, ${locked} locked` : "") +
                `)  @ ${ins.admin}`
            );
          }
        } catch {
          /* older relay without /holdings — CC line above already shown */
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
      // --admin <registrar> --id <instrument> merges a registry token (e.g. USDCx)
      // instead of Canton Coin; same trust rule as `withdraw`.
      const mAdmin = flag(args, "--admin");
      const mId = flag(args, "--id");
      if ((mAdmin && !mId) || (!mAdmin && mId)) {
        return fail("merge: --admin <registrar> and --id <instrument> must be given together");
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
        const id = flag(args, "--id") || "USDCx";
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
        return fail("usage: canton-agent-wallet pay [--relay-url <url>] [--asset <symbol>] <url>");
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
      const f = await makePayingFetch({
        relayUrl,
        network: existing?.network ?? resolveNetwork(args),
        apiKey: API_KEY,
        ...(preferAsset ? { preferAsset } : {}),
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
        ...(amt.kind === "amount" ? { amount: amt.amount } : {}),
        ...(wAdmin && wId ? { instrumentAdmin: wAdmin, instrumentId: wId } : {}),
        apiKey: API_KEY,
      });
      console.log(`withdrew ${r.amount} ${wId ?? "CC"} to ${to}\n  updateId: ${r.updateId}`);
      break;
    }
    case "swap": {
      // Swap `--amount` of `--in` for `--out` on Tradecraft. The pool address,
      // slippage floor, and AMM meta-key are resolved into a ticket; then the
      // output is pre-approved, the input is sent to the pool with the floor in
      // meta, and the returning transfer is claimed. Symbols resolve to their
      // MainNet registrar via KNOWN_INSTRUMENTS (CC = omit an instrument).
      const inSym = flag(args, "--in");
      const outSym = flag(args, "--out");
      const amount = flag(args, "--amount");
      if (!inSym || !outSym || !amount) {
        return fail(
          "usage: canton-agent-wallet swap --in <SYMBOL> --out <SYMBOL> --amount <n> [--slippage <pct>] [--direct] [--no-wait]"
        );
      }
      const slippageRaw = flag(args, "--slippage");
      const slippagePct = slippageRaw === undefined ? 1 : Number(slippageRaw);
      if (!Number.isFinite(slippagePct) || slippagePct < 0 || slippagePct >= 100) {
        return fail("swap: --slippage must be a percentage in [0, 100)");
      }
      // Resolve each leg to a CANONICAL symbol, and FAIL CLOSED on an unrecognized
      // one. Without this an unknown symbol would fall back to native Canton Coin,
      // so a typo like `--in USDC` (for USDCx) would silently send real CC to a
      // `tc-swp_USDC-…` pool. We also use the canonical casing for the pool party
      // and the quote so `--in usdcx` targets the real `USDCx` pool, not a
      // case-mismatched non-existent one.
      const inLeg = resolveSwapSymbol(inSym);
      const outLeg = resolveSwapSymbol(outSym);
      for (const [flagName, sym, leg] of [
        ["--in", inSym, inLeg],
        ["--out", outSym, outLeg],
      ] as const) {
        if (leg.kind === "unknown") {
          return fail(
            `swap: ${flagName} ${JSON.stringify(sym)} is not a known instrument. ` +
              `Use CC or one of: ${Object.keys(KNOWN_INSTRUMENTS).join(", ")} ` +
              `(add others via CANTON_AGENT_REGISTRY_TRUSTED_PARTIES + code).`
          );
        }
      }
      if (inLeg.kind === "unknown" || outLeg.kind === "unknown") return; // unreachable: fail() above exits
      if (inLeg.kind === "cc" && outLeg.kind === "cc") {
        return fail("swap: --in and --out are both CC — nothing to swap");
      }
      const inCanon = inLeg.symbol;
      const outCanon = outLeg.symbol;
      const inInstrument = inLeg.kind === "registry" ? inLeg.instrument : null;
      const outInstrument = outLeg.kind === "registry" ? outLeg.instrument : null;
      // Advisory min-input warning (mirrors the Tradecraft web app; not a hard
      // limit — the pool returns the funds if a small trade will not fill).
      const minIn = tradecraftMinInput(inCanon);
      if (minIn !== undefined && Number(amount) < minIn) {
        console.error(
          `  ! ${amount} ${inCanon} is below Tradecraft's advertised minimum of ${minIn} ${inCanon} — ` +
            `the trade may be returned unfilled (no loss). Proceeding.`
        );
      }

      // The amm_cid is a CLIENT-TRUSTED constant (config, never the endpoint): the
      // pool party the funds are sent to must derive from it, so a compromised swap
      // endpoint cannot redirect the swap to an attacker party.
      const trustedAmmCid =
        process.env.CANTON_AGENT_TRADECRAFT_AMM_CID ??
        "122096fe076cc065af0cb38f94caa60e8ddfecbe8f0cfe10655ae7aa06fab99c66b7";
      // TWO ways to get the ticket (pool party, slippage minimum, quote):
      //  DEFAULT — our x402 swap endpoint: a small CC fee for a ticket that stays
      //  current with Tradecraft's pools/amm_cid/minimums (a bare Tradecraft
      //  snapshot goes stale silently). Discovered via CANTON_AGENT_SWAP_URL, or a
      //  baked default. The returned ticket is validated against the trusted amm_cid
      //  + the locally-resolved instruments (fetchTicketFromEndpoint), so the
      //  endpoint is trusted for the price only, never for where funds go.
      //  --direct — resolve the ticket locally straight from Tradecraft (no fee),
      //  for power users who accept the stale-snapshot risk.
      let ticket;
      if (boolFlag(args, "--direct")) {
        const memoKey = process.env.CANTON_AGENT_TRADECRAFT_MEMO_KEY;
        const tradecraftApi =
          process.env.CANTON_AGENT_TRADECRAFT_API ?? "https://api.tradecraft.fi";
        ticket = await buildLocalTicket({
          tradecraftApi,
          ammCid: trustedAmmCid,
          ...(memoKey ? { memoKey } : {}),
          inSymbol: inCanon,
          outSymbol: outCanon,
          amount,
          slippagePct,
          inInstrument,
          outInstrument,
        });
        if (!memoKey) {
          console.error(
            "  ! no slippage protection (CANTON_AGENT_TRADECRAFT_MEMO_KEY unset) — filling at market price"
          );
        }
      } else {
        const swapUrl = process.env.CANTON_AGENT_SWAP_URL ?? "https://swap.ftptech.xyz";
        const existing = loadWallet();
        const relayUrl =
          resolveRelayUrl(args) ?? existing?.relayUrl ?? fail(MISSING_RELAY_HELP);
        // The endpoint is UNTRUSTED for money safety (see assertTicketMatchesIntent),
        // and this call auto-settles whatever 402 it answers with BEFORE any ticket
        // validation runs. Without a ceiling that is a blank cheque: a hijacked
        // endpoint (or its DNS/TLS) could quote the agent's whole balance to a payee
        // of its choosing. Bound both: a ceiling that always applies, and — when the
        // operator names the merchant — an exact payee pin that reduces the exposure
        // to zero.
        const maxFee = flag(args, "--max-fee") ?? SWAP_MAX_FEE_CC;
        const swapMerchant =
          flag(args, "--swap-merchant") ?? process.env.CANTON_AGENT_SWAP_MERCHANT;
        const payingFetch = await makePayingFetch({
          relayUrl,
          network: existing?.network ?? resolveNetwork(args),
          apiKey: API_KEY,
          maxPaymentValue: maxFee,
          ...(swapMerchant ? { expectedPayTo: swapMerchant } : {}),
        });
        ticket = await fetchTicketFromEndpoint({
          swapUrl,
          inSymbol: inCanon,
          outSymbol: outCanon,
          amount,
          slippagePct,
          payingFetch,
          inInstrument,
          outInstrument,
          trustedAmmCid,
        });
      }
      console.log(
        `quote: ${amount} ${inCanon} -> ~${ticket.quote} ${outCanon}\n  pool: ${ticket.poolParty}`
      );
      if (ticket.memoKey) {
        console.log(`  min ${ticket.minOutput} enforced at ${slippagePct}% slippage`);
      } else {
        // Say it on BOTH paths. The floor rides in the transfer memo, so without
        // a memo key nothing constrains what the pool returns — the trade fills
        // at whatever the pool quotes when it executes, and --slippage did
        // nothing. The --direct branch already warns; a ticket from the endpoint
        // can be equally unprotected (the service leaves the key unset), and
        // silence there reads as "protected".
        console.error(
          "  ! no slippage protection on this ticket — filling at market price " +
            "(the swap endpoint set no memo key)"
        );
      }
      // A registry output is preapproved by default so the pool can deliver it
      // directly (it delivers only to a preapproved receiver); --no-preapprove
      // opts out (e.g. the preapproval already exists).
      // By default `swap` WAITS until the output lands (no manual claim after);
      // --no-wait returns as soon as the input is sent (fire-and-forget).
      const wait = !boolFlag(args, "--no-wait");
      const sr = await executeSwap({
        amount,
        ticket,
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
    case "fund": {
      // Bootstrap a funded self-custody wallet through the hosted quest (mint →
      // grant → a real CanTrust payment → small change), then install the key so
      // you own it. The bare faucet is not a farmable free-CC spigot, so this is
      // the out-of-box funding path. NO-CLOBBER: an already-funded wallet is left
      // untouched.
      const relayUrl = requireRelay(args);
      const payProxyUrl =
        flag(args, "--pay-proxy-url") ?? process.env.CANTON_AGENT_PAY_PROXY_URL;
      if (!payProxyUrl)
        return fail(
          "usage: canton-agent-wallet fund --pay-proxy-url <https://pay...> [--prompt <text>]\n" +
            "  (or set CANTON_AGENT_PAY_PROXY_URL). Funds via the quest, which binds the\n" +
            "  grant to a real payment so it cannot be farmed."
        );
      const prompt = flag(args, "--prompt");
      let r: Awaited<ReturnType<typeof fundViaQuest>>;
      try {
        r = await fundViaQuest({
          payProxyUrl,
          relayUrl,
          ...(prompt ? { prompt } : {}),
        });
      } catch (e) {
        return fail(
          `funding via the quest failed (${e instanceof Error ? e.message : String(e)}).\n` +
            "  ask your owner to send CC to your party, then run: canton-agent-wallet claim"
        );
      }
      if (r.kind === "already_funded") {
        console.log(
          `wallet already funded: ${r.balanceCc} CC for ${r.party}. No action taken.`
        );
      } else {
        const img = r.image ? `\n  demo image: ${r.image}` : "";
        console.log(
          `funded a self-custody wallet via the quest (${r.wallet.network})\n` +
            `  party:   ${r.wallet.party}\n` +
            `  balance: ${r.balanceCc ?? "?"} CC (grant minus the on-ledger payment)${img}`
        );
      }
      break;
    }
    default:
      console.error(
        "canton-agent-wallet: create | address | balance | claim | fund --pay-proxy-url <url> | merge [--target <n>] [--batch <n>] [--max-rounds <n>] [--dry-run] [--yes] [--admin <registrar> --id <instrument>] | preapproval [--status] [--admin <DSO>] [--operator-token <t>] [--days <n>] [--expires-at <iso>] | pay [--asset <symbol>] <url> | swap --in <SYM> --out <SYM> --amount <n> [--slippage <pct>] [--direct] [--no-wait] [--max-fee <cc>] [--swap-merchant <party>] [--no-preapprove] | withdraw --to <party> [--amount <n>] [--admin <registrar> --id <instrument>] | export | import\n" +
          "  relay required for create/pay/import/fund: --relay-url <url> or CANTON_AGENT_RELAY_URL\n" +
          "  fund = bootstrap a funded wallet via the hosted quest (--pay-proxy-url or CANTON_AGENT_PAY_PROXY_URL).\n" +
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
