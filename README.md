# canton-x402-agent

Payer-side tooling for the Canton x402 stack. Lets an autonomous agent
pay for an HTTP 402 resource on Canton: a client SDK for wrapping
`fetch`, a self-custody wallet CLI, and an MCP server that exposes that
wallet as tools.

## Packages

| Package | npm | Purpose |
| --- | --- | --- |
| `@ftptech/x402-canton-client` | [npm](https://www.npmjs.com/package/@ftptech/x402-canton-client) | Client SDK for the payer side: ExactCantonScheme plus signer abstractions for wrapping `fetch`. |
| `@ftptech/canton-agent-wallet` | [npm](https://www.npmjs.com/package/@ftptech/canton-agent-wallet) | Self-custody Canton wallet plus x402 autopay for AI agents. One CLI: create, pay, balance, withdraw, export, import. |
| `@ftptech/canton-x402-mcp` | [npm](https://www.npmjs.com/package/@ftptech/canton-x402-mcp) | MCP server exposing the agent wallet as tools; a thin wrapper over `@ftptech/canton-agent-wallet`. |

See each package README for usage:
[`packages/client`](packages/client/README.md),
[`packages/agent-wallet`](packages/agent-wallet/README.md),
[`packages/mcp`](packages/mcp/README.md).

## Install

```bash
# Client SDK
npm i @ftptech/x402-canton-client

# Wallet CLI
npm i -g @ftptech/canton-agent-wallet

# MCP server
npm i @ftptech/canton-x402-mcp
```

`client` depends on `@ftptech/x402-canton-core` and
`@ftptech/x402-canton-ledger` from
[canton-x402-core](https://github.com/sunstrike228/canton-x402-core).

## Part of the canton-x402 suite

- [canton-x402-core](https://github.com/sunstrike228/canton-x402-core): shared types + ledger primitives.
- [canton-x402-merchant](https://github.com/sunstrike228/canton-x402-merchant): Express and Next.js middleware to gate routes behind payment.
- [canton-x402-agent](https://github.com/sunstrike228/canton-x402-agent) (this repo): payer-side client SDK, agent wallet CLI, and MCP server.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
