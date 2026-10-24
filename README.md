# x402-canton-agent

Pay x402 endpoints on Canton from a script, a backend or an AI agent. The code of each package matches its npm release.

| Package | Version | What |
| --- | --- | --- |
| [`@ftptech/canton-agent-wallet`](packages/agent-wallet/README.md) | 2.4.0 | Self-custody wallet: CLI and `makePayingFetch` |
| [`@ftptech/canton-x402-mcp`](packages/mcp/README.md) | 2.3.0 | The wallet as a local MCP server, with a spend policy |
| [`@ftptech/x402-canton-client`](packages/client/README.md) | 1.2.2 | `fetch` wrapper for your own signer |

## Quickstart

```bash
npm i -g @ftptech/canton-agent-wallet
canton-agent-wallet create --relay-url https://facilitator.ftptech.xyz
canton-agent-wallet pay --max 0.5 https://api.example.com/resource
```

The FTP relay settles on Canton MainNet. A new wallet gets a 0.2 CC starter grant; for more, send CC to `canton-agent-wallet address` and run `claim`.

**AI agents:** run the [local MCP server](packages/mcp/README.md), or connect the hosted one at `https://pay.ftptech.xyz/mcp` in Claude, ChatGPT or Perplexity (custodial, passkey sign-in).

Guide: [x402-docs.ftptech.xyz/x402-agent](https://x402-docs.ftptech.xyz/x402-agent). Creating a wallet accepts the [Terms of Service](https://ftp-tech.mintlify.site/terms).

## Related

- [x402-canton-merchant](https://github.com/FTP-Tech-LLC/x402-canton-merchant): accept payments (Express, Next.js)
- [x402-canton-core](https://github.com/FTP-Tech-LLC/x402-canton-core): shared types and ledger client
- [x402-canton-facilitator](https://github.com/FTP-Tech-LLC/x402-canton-facilitator): the facilitator

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
