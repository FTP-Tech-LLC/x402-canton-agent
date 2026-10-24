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
  RelayClient,
  makePayingFetchForWallet,
  type AgentWallet,
} from "@ftptech/canton-agent-wallet";
import type { McpConfig } from "./config.js";
import { createFilePolicyLedgerStore } from "./policy.js";
import { registerWalletTools } from "./tools.js";

export { buildFundingText } from "./tools.js";

// serverInfo.version must track the package version (clients display it); a
// hardcoded literal drifted (0.3.0 shipped announcing "0.1.2").
const PKG_VERSION = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

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
          const bal = Number((await new RelayClient({ relayUrl: w.relayUrl, apiKey }).balance(w.party)).cc);
          const led = await ledger.read(Date.now());
          if (Number.isFinite(bal)) await ledger.recordClaimedHighWater(bal + led.lifetimeOutCC, Date.now());
        })().catch(() => {
          /* best-effort: a later `claim` raises the ceiling the same way */
        });
      },
    });

  registerWalletTools(server, {
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
    relayFor: (w) => new RelayClient({ relayUrl: w.relayUrl, apiKey }),
    // The home is the per-wallet pay lock, exactly as makePayingFetch uses it.
    payingFetchFor: (w, opts) =>
      makePayingFetchForWallet(w, { apiKey, ...opts }, walletDir()),
    apiKey,
    policy: config.policy,
    ledger,
  });

  return server;
}
