import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { KNOWN_INSTRUMENTS } from "@ftptech/canton-agent-wallet";
import type * as AgentWalletModule from "@ftptech/canton-agent-wallet";
import type { CatalogCache, CatalogEntry } from "./catalog.js";
import type { SpendPolicy } from "./config.js";
import type { WalletToolDeps } from "./tools.js";

const swaps = { executed: 0 };

// The swap legs would reach a venue, so they are stubs. `pay` uses only what
// each test injects through the deps below.
vi.mock("@ftptech/canton-agent-wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentWalletModule>();
  return {
    ...actual,
    resolveTrustedDsoParty: () => "DSO::1220dso",
    resolveSwapTicket: async () => ({
      ticket: {
        venue: "cantex",
        poolParty: actual.CANTEX_CONNECT_PARTY,
        minOutput: "0.53",
        memoKey: actual.CANTEX_MEMO_KEY,
        memoValue: "USDCx",
        quote: "0.5412",
        inInstrument: null,
        outInstrument: actual.KNOWN_INSTRUMENTS["USDCx"],
      },
      notes: [],
    }),
    executeSwap: async () => {
      swaps.executed += 1;
      return { sentUpdateId: "1220sent", claimed: 0, claimedUpdateIds: [], delivered: "0.54", timedOut: false, pollErrors: 0 };
    },
  };
});

const { registerWalletTools } = await import("./tools.js");

const WALLET = { party: "agent::1220aaa", relayUrl: "https://relay.test", network: "canton:mainnet" };
const ENTRY = "https://api.example.com/v1/agent";
const CATALOG: CatalogEntry[] = [{ resource: ENTRY, accepts: [{ scheme: "exact", network: "canton:mainnet", amount: "1000000" }] }];
const ACCOUNT = "https://pay.ftptech.xyz/account";
const anyUser: SpendPolicy = { allowDomains: "*", maxPerTx: 5, dailyCap: 20, fundedCeiling: false };
const catalogUser: SpendPolicy = { ...anyUser, payScope: "catalog", payScopeUrl: ACCOUNT };
const loaded = (): CatalogCache => ({ get: async () => CATALOG });

interface Run {
  text: string;
  isError: boolean;
  payingFetches: number;
  inits: Array<RequestInit | undefined>;
  catalogReads: number;
}

/** One tool call on a fresh server built from `registerWalletTools`. `more`
 *  replaces deps (plan D's `usdcx`, a relay and ledger that know USDCx). */
async function call(
  tool: string,
  args: Record<string, unknown>,
  policy: SpendPolicy,
  catalog?: CatalogCache,
  fetchImpl?: typeof fetch,
  more: Partial<WalletToolDeps> = {}
): Promise<Run> {
  const run: Run = { text: "", isError: false, payingFetches: 0, inits: [], catalogReads: 0 };
  const deps = {
    getWallet: async () => WALLET as never,
    relayFor: () => ({ balance: async () => ({ cc: "100", amulet: 1 }) }) as never,
    payingFetchFor: async () => {
      run.payingFetches += 1;
      return async (input: RequestInfo | URL, init?: RequestInit) => {
        run.inits.push(init);
        return fetchImpl ? fetchImpl(input, init) : new Response("ok", { status: 200 });
      };
    },
    policy,
    ledger: {
      read: async () => ({ date: "2026-10-06", spentTodayCC: 0, lifetimeOutCC: 0, lifetimeClaimedCC: 0 }),
      recordOutbound: async () => undefined,
      recordClaimedHighWater: async () => undefined,
    },
    ...(catalog
      ? {
          catalog: {
            get: async () => {
              run.catalogReads += 1;
              return catalog.get();
            },
          },
        }
      : {}),
    ...more,
  } as WalletToolDeps;
  const server = new McpServer({ name: "t", version: "0" });
  registerWalletTools(server, deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  run.catalogReads = 0; // count only what the call itself reads
  const r = (await client.callTool({ name: tool, arguments: args })) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  run.text = r.content.map((c) => c.text).join("\n");
  run.isError = r.isError === true;
  return run;
}

describe("pay for a wallet that pays only catalogue services", () => {
  it("an existing wallet pays as before: no catalogue read, no redirect rule", async () => {
    const r = await call("pay", { url: "https://anything.test/x" }, anyUser, {
      get: async () => {
        throw new Error("catalogue down");
      },
    });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^HTTP 200;/);
    expect(r.catalogReads).toBe(0);
    expect(r.inits[0]).not.toHaveProperty("redirect");
  });

  it("pays a catalogued service, with redirects refused", async () => {
    const r = await call("pay", { url: `${ENTRY}/run?q=1` }, catalogUser, loaded());
    expect(r.isError).toBe(false);
    expect(r.catalogReads).toBe(1);
    expect(r.inits[0]).toMatchObject({ redirect: "error" });
  });

  it("refuses an address outside the catalogue before anything is signed", async () => {
    for (const url of [`${ENTRY}x`, "http://api.example.com/v1/agent", "https://api.example.com:8443/v1/agent", "https://evil.test/v1/agent"]) {
      const r = await call("pay", { url }, catalogUser, loaded());
      expect(r.isError, url).toBe(true);
      expect(r.text, url).toMatch(/blocked by spend policy: pay blocked: .* is not in the catalogue of verified services/);
      expect(r.text, url).toContain(`only the owner can allow any address, on ${ACCOUNT}. You cannot change this setting.`);
      expect(r.payingFetches, url).toBe(0);
    }
  });

  it("a catalogue that never loaded pays nothing, for this wallet only", async () => {
    const neverLoaded: Array<CatalogCache | undefined> = [
      { get: async () => undefined },
      {
        get: async () => {
          throw new Error("boom");
        },
      },
      undefined,
    ];
    for (const catalog of neverLoaded) {
      const r = await call("pay", { url: ENTRY }, catalogUser, catalog);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/the catalogue could not be loaded/);
      expect(r.payingFetches).toBe(0);
    }
    const other = await call("pay", { url: ENTRY }, anyUser, { get: async () => undefined });
    expect(other.isError).toBe(false);
  });

  it("--allow-domains catalog does the same for every payment of the server", async () => {
    const operator: SpendPolicy = { allowDomains: "catalog", fundedCeiling: false };
    const ok = await call("pay", { url: ENTRY }, operator, loaded());
    expect(ok.isError).toBe(false);
    expect(ok.inits[0]).toMatchObject({ redirect: "error" });
    const refused = await call("pay", { url: "https://evil.test/x" }, operator, loaded());
    expect(refused.text).toMatch(/--allow-domains catalog/);
  });

  describe("a catalogued address that answers with a redirect", () => {
    let listed: Server;
    let elsewhere: Server;
    let listedOrigin = "";
    let charged = 0;

    beforeAll(async () => {
      elsewhere = createHttpServer((_req, res) => {
        res.writeHead(402);
        res.end("payment required");
      });
      await new Promise<void>((r) => elsewhere.listen(0, "127.0.0.1", r));
      const elsewhereOrigin = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}`;
      listed = createHttpServer((_req, res) => {
        res.writeHead(302, { location: `${elsewhereOrigin}/charge` });
        res.end();
      });
      await new Promise<void>((r) => listed.listen(0, "127.0.0.1", r));
      listedOrigin = `http://127.0.0.1:${(listed.address() as AddressInfo).port}`;
    });
    afterAll(() => {
      listed.close();
      elsewhere.close();
    });

    // What the real paying fetch does before it signs: a plain fetch with the
    // tool's init (agent-wallet's probe, then the client's request). The
    // catalogued https address is served by `listed`; every 402 seen here is a
    // payment the real fetch would sign.
    const viaLocal = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const r = await fetch(String(input).replace("https://api.example.com", listedOrigin), init);
      if (r.status === 402) charged += 1;
      return r;
    };

    it("is refused, with nothing signed", async () => {
      charged = 0;
      const r = await call("pay", { url: ENTRY }, catalogUser, loaded(), viaLocal as typeof fetch);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/redirect/);
      expect(charged).toBe(0);
    });

    it("is followed for a wallet without the catalogue rule, as today", async () => {
      charged = 0;
      const r = await call("pay", { url: ENTRY }, anyUser, undefined, viaLocal as typeof fetch);
      expect(r.text).toMatch(/^HTTP 402;/);
      expect(charged).toBe(1);
    });
  });

  describe("asset USDCx (plan D): the catalogue rule applies, the CC day does not", () => {
    const U = KNOWN_INSTRUMENTS["USDCx"]!;
    const usdcxCatalogUser: SpendPolicy = { ...catalogUser, usdcxMaxPerTx: 1, usdcxDailyCap: 5 };
    // A server that offers `asset`, whose CC day is already used up (20 of 20).
    const usdcxServer: Partial<WalletToolDeps> = {
      usdcx: true,
      relayFor: () =>
        ({
          balance: async () => ({ cc: "100", amulet: 1 }),
          holdings: async () => ({
            party: WALLET.party,
            complete: true,
            instruments: [{ admin: U.admin, id: "USDCx", total: "3.0000000000", holdings: [] }],
          }),
        }) as never,
      ledger: {
        read: async () => ({ date: "2026-10-06", spentTodayCC: 20, lifetimeOutCC: 20, lifetimeClaimedCC: 0, spentTodayUSDCx: 0 }),
        recordOutbound: async () => undefined,
        recordOutboundUSDCx: async () => undefined,
        recordClaimedHighWater: async () => undefined,
      },
    };

    it("an address outside the catalogue is refused for USDCx too, before anything is signed", async () => {
      const r = await call("pay", { url: "https://evil.test/v1/agent", asset: "USDCx" }, usdcxCatalogUser, loaded(), undefined, usdcxServer);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/blocked by spend policy: pay blocked: .* is not in the catalogue of verified services/);
      expect(r.payingFetches).toBe(0);
    });

    it("a catalogued service is paid in USDCx with the CC day used up; the same payment in CC is refused", async () => {
      const r = await call("pay", { url: ENTRY, asset: "USDCx" }, usdcxCatalogUser, loaded(), undefined, usdcxServer);
      expect(r.isError).toBe(false);
      expect(r.text).toMatch(/^HTTP 200; spent [\d.]+ USDCx; /);
      expect(r.catalogReads).toBe(1);
      expect(r.inits[0]).toMatchObject({ redirect: "error" });
      const cc = await call("pay", { url: ENTRY }, usdcxCatalogUser, loaded(), undefined, usdcxServer);
      expect(cc.text).toMatch(/daily cap 20 CC already reached/);
      expect(cc.payingFetches).toBe(0);
    });
  });

  it("swap is not affected: the venue is the operator's choice, not the agent's", async () => {
    swaps.executed = 0;
    const r = await call(
      "swap",
      { in: "CC", out: "USDCx", amount: "60", direct: true },
      { allowDomains: "catalog", fundedCeiling: false, payScope: "catalog" },
      { get: async () => undefined }
    );
    expect(r.isError).toBe(false);
    expect(r.catalogReads).toBe(0);
    expect(swaps.executed).toBe(1);
  });
});
