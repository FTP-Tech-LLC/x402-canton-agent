#!/usr/bin/env node
/**
 * stdio entrypoint. The HUMAN wires this up out-of-band, e.g.:
 *
 *   claude mcp add canton-x402 -- npx -y @ftptech/canton-x402-mcp \
 *     --relay-url https://facilitator.ftptech.xyz \
 *     --home ~/.canton-x402-mcp/myagent \
 *     --allow-domains api.example.com --daily-cap 2 --max-per-tx 1
 *
 * Everything after `--` is the launch command the MCP client spawns; the flags
 * (the spend policy + relay + home) are the owner's out-of-band trust grant.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfig } from "./config.js";
import { createServer } from "./server.js";

const config = resolveConfig(process.argv.slice(2), process.env);
// Set the wallet home BEFORE the server (and thus the wallet lib) touches it.
process.env.CANTON_AGENT_HOME = config.home;

const server = createServer(config);
const transport = new StdioServerTransport();
await server.connect(transport);

// stderr only — stdout is the JSON-RPC channel and must stay clean.
console.error(
  `[canton-x402-mcp] up; relay=${config.relayUrl} home=${config.home} ` +
    `policy={maxPerTx=${config.policy.maxPerTx ?? "∞"}, daily=${config.policy.dailyCap ?? "∞"}, ` +
    `domains=${config.policy.allowDomains === "*" ? "*" : config.policy.allowDomains.join("|") || "(none)"}, ` +
    `fundedCeiling=${config.policy.fundedCeiling}}`
);
