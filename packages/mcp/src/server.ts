/**
 * @ftptech/canton-x402-mcp — MCP server exposing a self-custody Canton x402
 * wallet as tools. THIN wrapper over @ftptech/canton-agent-wallet: all crypto,
 * relay, and verify-before-sign live there and are reused verbatim.
 *
 * Delivery model (see the redesign brief): a HUMAN connects this server
 * out-of-band (`claude mcp add ...`). The agent then calls TOOLS — it never
 * runs an install, never sees the private key (it stays in the server's home),
 * and money-moving tools (pay/withdraw) are ask/cap. Read tools auto-allow.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRequire } from "node:module";
import { z } from "zod";

// serverInfo.version must track the package version (clients display it); a
// hardcoded literal drifted (0.3.0 shipped announcing "0.1.2").
const PKG_VERSION = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;
import {
  ensureWallet,
  loadWallet,
  RelayClient,
  claimAll,
  withdraw,
  makePayingFetch,
  type AgentWallet,
} from "@ftptech/canton-agent-wallet";
import type { McpConfig } from "./config.js";
import {
  PolicyError,
  readLedger,
  assertPayAllowed,
  assertWithdrawAllowed,
  recordOutbound,
  recordClaimedHighWater,
} from "./policy.js";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const errText = (s: string) => ({
  content: [{ type: "text" as const, text: s }],
  isError: true,
});

const toNum = (cc: string): number => {
  const n = Number(cc);
  return Number.isFinite(n) ? n : 0;
};

/** Map a thrown wallet/relay error to a clean tool error (never leak key bytes,
 *  never throw out of a handler — return isError instead). */
function toolError(where: string, err: unknown): ReturnType<typeof errText> {
  if (err instanceof PolicyError) return errText(`blocked by spend policy: ${err.message}`);
  const msg = err instanceof Error ? err.message : String(err);
  return errText(`${where} failed: ${msg}`);
}

/** Lighthouse cross-check: success iff verdict==accepted AND send==Success.
 *  Best-effort + read-only; never throws (balance is the authoritative truth). */
async function lighthouseVerify(
  updateId: string
): Promise<{ ok: boolean; verdict?: string | undefined; send?: string | undefined } | null> {
  try {
    const res = await fetch(
      `https://lighthouse.cantonloop.com/api/transactions/${encodeURIComponent(updateId)}`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    const blob = JSON.stringify(j);
    const verdict = /"verdict_result"\s*:\s*"([^"]+)"/.exec(blob)?.[1];
    const send = /"TransferCommandResult(\w+)"/.exec(blob)?.[0];
    const ok = verdict === "accepted" && send === "TransferCommandResultSuccess";
    return { ok, verdict, send };
  } catch {
    return null;
  }
}

/** Best-effort updateId from an x402 payment response header (PAYMENT-RESPONSE /
 *  X-PAYMENT-RESPONSE = base64 JSON carrying `transaction`). Balance remains the
 *  source of truth if this is absent. */
function updateIdFromResponse(res: Response): string | undefined {
  const raw =
    res.headers.get("payment-response") ??
    res.headers.get("x-payment-response") ??
    res.headers.get("payment-response-canton");
  if (!raw) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as {
      transaction?: string;
      updateId?: string;
    };
    return decoded.transaction ?? decoded.updateId;
  } catch {
    return undefined;
  }
}

export function buildFundingText(party: string, amount?: string): string {
  const amt = amount && amount.trim() ? `${amount} Canton Coin (CC)` : "some Canton Coin (CC) (0.05–1 CC is plenty to start)";
  return (
    `My Canton wallet is ready. Party id:\n  ${party}\n\n` +
    `Please send ${amt} to that party id on MainNet. ` +
    `Once you've sent it, tell me and I'll claim it.`
  );
}

/**
 * `auto_fund` flow, extracted for unit testing: pull a one-time faucet seed from
 * the facilitator, accept it (claimAll — the seed lands as a pending
 * TransferInstruction), and report the new balance. If the faucet is unavailable
 * (disabled / already claimed / over budget → the relay throws) fall back to the
 * manual-funding ask instead of erroring, so the agent always gets an actionable
 * next step. `claimAll` is injected so this is testable without a real relay.
 */
export async function runAutoFund(deps: {
  wallet: AgentWallet;
  relay: Pick<RelayClient, "faucetClaim" | "balance">;
  home: string;
  claimAll: (relay: RelayClient, wallet: AgentWallet) => Promise<unknown>;
}): Promise<string> {
  const { wallet, relay, home, claimAll } = deps;
  let seededNote = "";
  try {
    const r = await relay.faucetClaim(wallet.party);
    seededNote = `faucet sent ${r.amount} CC (updateId ${r.updateId}); `;
  } catch (e) {
    // Faucet unavailable → manual-funding fallback, NOT an error.
    return (
      `Faucet unavailable (${e instanceof Error ? e.message : String(e)}).\n` +
      buildFundingText(wallet.party)
    );
  }
  // Accept the incoming seed (no-op if it credited directly), then read balance.
  await claimAll(relay as RelayClient, wallet);
  const bal = await relay.balance(wallet.party);
  // Raise the funded ceiling to the post-claim high-water so the agent may spend
  // what was funded in (mirrors the `claim` tool).
  const led = readLedger(home, Date.now());
  recordClaimedHighWater(home, toNum(bal.cc) + led.lifetimeOutCC, Date.now());
  return `${seededNote}balance now ${bal.cc} CC for ${wallet.party}`;
}

export function createServer(config: McpConfig): McpServer {
  // store.ts resolves the wallet home from CANTON_AGENT_HOME at call time, so the
  // server's own home must be in the env before any wallet op. bin.ts sets this
  // too; setting it here as well keeps createServer self-contained for tests.
  process.env.CANTON_AGENT_HOME = config.home;
  const { relayUrl, network, apiKey } = config;

  const relay = (w: AgentWallet) => new RelayClient({ relayUrl: w.relayUrl, apiKey });

  // Lazily create-or-load the wallet once; the key is generated + persisted in
  // config.home and never returned by any tool.
  const getWallet = async (): Promise<AgentWallet> =>
    loadWallet() ?? (await ensureWallet({ relayUrl, network, apiKey }));

  const server = new McpServer({ name: "canton-x402", version: PKG_VERSION });

  // ── read-only (auto-allow) ────────────────────────────────────────────────
  server.registerTool(
    "get_address",
    {
      title: "Get wallet address",
      description:
        "Return this agent's Canton party id (its wallet address). Creates the wallet on first use. Read-only.",
      inputSchema: {},
      annotations: { title: "Get address", readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const w = await getWallet();
        return text(w.party);
      } catch (err) {
        return toolError("get_address", err);
      }
    }
  );

  server.registerTool(
    "get_balance",
    {
      title: "Get wallet balance",
      description:
        "Return the agent's on-ledger Canton Coin (CC) balance and holdings. Read-only, authoritative.",
      inputSchema: {},
      annotations: { title: "Get balance", readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const w = await getWallet();
        const b = await relay(w).balance(w.party);
        return text(
          `${b.cc} CC (${b.amulet} amulet${b.amulet === 1 ? "" : "s"}) for ${w.party}`
        );
      } catch (err) {
        return toolError("get_balance", err);
      }
    }
  );

  server.registerTool(
    "request_funding",
    {
      title: "Request funding from the owner",
      description:
        "Return the agent's party id plus a ready-to-paste message asking the human owner to send CC. Moves nothing; funds appear after the owner sends and the agent calls `claim`.",
      inputSchema: { amount: z.string().optional().describe("Suggested CC amount, e.g. \"0.5\"") },
      annotations: { title: "Request funding", readOnlyHint: true, openWorldHint: false },
    },
    async ({ amount }) => {
      try {
        const w = await getWallet();
        return text(buildFundingText(w.party, amount));
      } catch (err) {
        return toolError("request_funding", err);
      }
    }
  );

  // ── inbound state-change (auto-ok: can only pull funds IN) ─────────────────
  server.registerTool(
    "auto_fund",
    {
      title: "Auto-fund from the facilitator faucet",
      description:
        "Pull a tiny one-time CC seed from the facilitator faucet and accept it, so you can run a payment end-to-end with NO human funding step. Funds IN only. If the faucet is unavailable (disabled, already claimed, or over budget) this returns a ready-to-paste message asking your human to fund you manually instead — then call `claim`.",
      inputSchema: {},
      annotations: { title: "Auto-fund", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      try {
        const w = await getWallet();
        return text(
          await runAutoFund({ wallet: w, relay: relay(w), home: config.home, claimAll })
        );
      } catch (err) {
        return toolError("auto_fund", err);
      }
    }
  );

  server.registerTool(
    "claim",
    {
      title: "Claim incoming funding",
      description:
        "Accept all pending incoming transfers into this wallet (funds IN only — cannot send funds out). Run after the owner has sent CC.",
      inputSchema: {},
      annotations: { title: "Claim funding", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      try {
        const w = await getWallet();
        const r = await claimAll(relay(w), w);
        // Raise the funded ceiling to the post-claim high-water (balance + what
        // has already gone out) so the agent may spend up to what was funded in.
        const bal = await relay(w).balance(w.party);
        const led = readLedger(config.home, Date.now());
        recordClaimedHighWater(config.home, toNum(bal.cc) + led.lifetimeOutCC, Date.now());
        return text(
          r.claimed > 0
            ? `claimed ${r.claimed} transfer(s); balance now ${bal.cc} CC`
            : `nothing to claim; balance ${bal.cc} CC`
        );
      } catch (err) {
        return toolError("claim", err);
      }
    }
  );

  // ── money OUT (ask / cap) ─────────────────────────────────────────────────
  server.registerTool(
    "pay",
    {
      title: "Pay an x402-gated URL",
      description:
        "MOVES FUNDS OUT. Pay for an HTTP 402 / x402-gated resource and return its response. Supports GET and POST (pass method/headers/body to pay a POST API such as an LLM completions endpoint). Bounded by the spend policy (allowed domains, daily cap, funded ceiling) set by the owner at startup. Calls the URL exactly once — do NOT wrap in a retry loop (the first payment can take ~60-90s; that is normal, not a failure).",
      inputSchema: {
        url: z.string().url().describe("The 402-gated URL to pay for"),
        method: z
          .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
          .optional()
          .describe("HTTP method (default GET); use POST for APIs that take a request body"),
        headers: z
          .record(z.string())
          .optional()
          .describe('Request headers, e.g. {"content-type":"application/json"}'),
        body: z
          .string()
          .optional()
          .describe("Raw request body for POST/PUT/PATCH (e.g. a JSON string)"),
      },
      annotations: { title: "Pay (moves funds OUT)", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ url, method, headers, body: reqBody }) => {
      try {
        const w = await getWallet();
        assertPayAllowed(config.policy, readLedger(config.home, Date.now()), url);
        const before = toNum((await relay(w).balance(w.party)).cc);
        const payingFetch = await makePayingFetch({ relayUrl: w.relayUrl, network: w.network, apiKey });
        const res = await payingFetch(url, {
          ...(method ? { method } : {}),
          ...(headers ? { headers } : {}),
          ...(reqBody !== undefined ? { body: reqBody } : {}),
        }); // EXACTLY ONCE — no outer retry (double-pay risk)
        const after = toNum((await relay(w).balance(w.party)).cc);
        const spent = Math.max(0, before - after);
        if (spent > 0) recordOutbound(config.home, spent, Date.now());
        const updateId = updateIdFromResponse(res);
        const verify = updateId ? await lighthouseVerify(updateId) : null;
        const body = await res.text().catch(() => "");
        const verifyLine = verify
          ? verify.ok
            ? ` verified (accepted/${verify.send})`
            : ` WARNING unverified (verdict=${verify.verdict ?? "?"}, send=${verify.send ?? "?"}) — check balance`
          : "";
        return text(
          `HTTP ${res.status}; spent ${spent.toFixed(10)} CC; balance ${after.toFixed(10)} CC` +
            (updateId ? `; updateId ${updateId}` : "") +
            verifyLine +
            `\n--- response body ---\n${body.slice(0, 4000)}`
        );
      } catch (err) {
        return toolError("pay", err);
      }
    }
  );

  server.registerTool(
    "withdraw",
    {
      title: "Withdraw CC to another party",
      description:
        "MOVES FUNDS OUT. Send CC from this wallet to another Canton party. Bounded by the spend policy. If a per-tx cap is set, an explicit amount is required (no silent full-balance sweep).",
      inputSchema: {
        to: z.string().describe("Recipient Canton party id"),
        amount: z.string().optional().describe("CC amount; omit to send the full balance (rejected if a per-tx cap is set)"),
      },
      annotations: { title: "Withdraw (moves funds OUT)", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ to, amount }) => {
      try {
        const w = await getWallet();
        // Resolve the effective amount up front so caps apply to the REAL number.
        let effective: number;
        if (amount && amount.trim()) {
          effective = toNum(amount);
        } else if (config.policy.maxPerTx !== undefined) {
          return errText(
            "withdraw blocked: a per-tx cap is set, so an explicit amount is required (refusing a full-balance sweep)."
          );
        } else {
          effective = toNum((await relay(w).balance(w.party)).cc);
        }
        assertWithdrawAllowed(config.policy, readLedger(config.home, Date.now()), effective);
        const wopts: { to: string; amount?: string; apiKey?: string } = { to };
        const amt = amount?.trim();
        if (amt) wopts.amount = amt;
        if (apiKey) wopts.apiKey = apiKey;
        const r = await withdraw(wopts);
        recordOutbound(config.home, toNum(r.amount), Date.now());
        const verify = await lighthouseVerify(r.updateId);
        return text(
          `withdrew ${r.amount} CC to ${to}; updateId ${r.updateId}` +
            (verify ? (verify.ok ? ` (verified)` : ` (WARNING unverified: ${verify.verdict}/${verify.send})`) : "")
        );
      } catch (err) {
        return toolError("withdraw", err);
      }
    }
  );

  return server;
}
