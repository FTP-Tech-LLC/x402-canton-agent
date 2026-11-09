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
import {
  ensureWallet,
  loadWallet,
  walletDir,
  withHomeLock,
  RelayClient,
  readSignerFromWallet,
  makePayingFetchForWallet,
  type AgentWallet,
} from "@ftptech/canton-agent-wallet";
import type { McpConfig } from "./config.js";
import { createFilePolicyLedgerStore } from "./policy.js";
import { registerWalletTools } from "./tools.js";
import { createCatalogCache, createInstrumentSymbols } from "./catalog.js";
import { INSTRUCTIONS_LEAD } from "./instructions.js";

export { buildFundingText } from "./tools.js";

// serverInfo.version must track the package version (clients display it); a
// hardcoded literal drifted (0.3.0 shipped announcing "0.1.2").
const PKG_VERSION = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

/**
 * Every money move (pay, withdraw, swap, claim) on this home runs one at a time, across
 * processes. Claude Desktop and Claude Code each start their own server on the
 * same home, and the policy gate reads the ledger before the money moves while
 * the spend is written after, so an in-process queue would not hold. Not the
 * pay lock: the paying fetch takes that one inside, and it is not re-entrant.
 * A holder that crashed is taken over after a minute (a live one heartbeats).
 */
const POLICY_LOCK = ".policy-lock";
// A queued call gives up after two minutes, not the pay lock's ten: an MCP
// client stops waiting after about a minute (see the abort checks in pay, withdraw and swap).
const POLICY_LOCK_OPTS = { staleMs: 60_000, timeoutMs: 120_000 };

/** The most of a paid response body `pay` returns locally when asked. */
const LOCAL_MAX_RESPONSE_CHARS = 20_000;

export function createServer(config: McpConfig): McpServer {
  // store.ts resolves the wallet home from CANTON_AGENT_HOME at call time, so the
  // server's own home must be in the env before any wallet op. bin.ts sets this
  // too; setting it here as well keeps createServer self-contained for tests.
  process.env.CANTON_AGENT_HOME = config.home;
  const { relayUrl, network, apiKey } = config;

  const server = new McpServer(
    { name: "canton-x402", version: PKG_VERSION },
    {
      // The CLI prints this on `create`; the MCP has no create step (the wallet
      // is made on first use), so the same acceptance rides on the server itself.
      instructions:
        INSTRUCTIONS_LEAD +
        "Self-custody Canton wallet for x402 payments. The wallet is created on " +
        "first use of any tool; by using it you accept the Terms of Service: " +
        "https://ftp-tech.mintlify.site/terms. A new wallet is sent a small " +
        "starter grant of Canton Coin, accepted automatically within about a minute.",
    }
  );

  const ledger = createFilePolicyLedgerStore(config.home);
  // One mint per process: two first calls racing would onboard two parties,
  // and the one saved second would strand whatever was sent to the first.
  let creating: Promise<AgentWallet> | undefined;
  const create = (): Promise<AgentWallet> =>
    ensureWallet({
      relayUrl,
      network,
      apiKey,
      // The first tool call is already waiting on the onboarding; the grant
      // is accepted after it returns.
      starterGrant: "background",
      onStarterGrant: (r) => {
        if (r.status !== "accepted") return;
        // What came in counts toward the funded ceiling, as a `claim` would.
        const w = loadWallet();
        if (!w) return;
        void (async () => {
          const bal = Number((await new RelayClient({ relayUrl: w.relayUrl, apiKey, readSigner: readSignerFromWallet(w) }).balance(w.party)).cc);
          const led = await ledger.read(Date.now());
          if (Number.isFinite(bal)) await ledger.recordClaimedHighWater(bal + led.lifetimeOutCC, Date.now());
        })().catch(() => {
          /* best-effort: a later `claim` raises the ceiling the same way */
        });
      },
    });

  registerWalletTools(server, {
    tradecraftQueued: true,
    network,
    // Lazily create-or-load the wallet; the key is generated + persisted in
    // config.home and never returned by any tool.
    getWallet: async (): Promise<AgentWallet> => {
      const existing = loadWallet();
      if (existing) return existing;
      creating ??= create().finally(() => {
        creating = undefined;
      });
      return creating;
    },
    relayFor: (w) => new RelayClient({ relayUrl: w.relayUrl, apiKey, readSigner: readSignerFromWallet(w) }),
    // The home is the per-wallet pay lock, exactly as makePayingFetch uses it.
    // --single-payment: one call, one payment (the hosted server's setting).
    // Without it, a call still pays at most once when pay asks for that
    // (maxPaymentRetries 0 in opts, whenever the agent set max_cc).
    payingFetchFor: (w, opts) =>
      makePayingFetchForWallet(
        w,
        { apiKey, ...opts, ...(config.singlePayment ? { maxPaymentRetries: 0 } : {}) },
        walletDir()
      ),
    apiKey,
    policy: config.policy,
    serialize: <T,>(fn: () => Promise<T>): Promise<T> =>
      withHomeLock(config.home, POLICY_LOCK, fn, POLICY_LOCK_OPTS),
    // The npm release is the local switch: everything new is on. The caches
    // are this process's; nothing is fetched until find_paid_apis is called.
    newTools: { maxResponseChars: LOCAL_MAX_RESPONSE_CHARS },
    catalog: createCatalogCache({ url: `${relayUrl}/discovery/resources` }),
    instrumentSymbols: createInstrumentSymbols({ url: `${relayUrl}/supported` }),
    ledger,
    // The local switch is the npm release: `pay` offers `asset`, and USDCx
    // payments run once the owner sets both USDCx caps.
    usdcx: true,
  });

  return server;
}
