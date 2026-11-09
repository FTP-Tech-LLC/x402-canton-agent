import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type * as AgentWallet from "@ftptech/canton-agent-wallet";
import { parseAllowDomains, resolveConfig } from "./config.js";

const RELAY_URL = "https://relay.test";
const RELAY = ["--relay-url", RELAY_URL];

/** The paying fetch each pay asked for, and the requests it was given. */
const paid: Array<{ url: string; init?: RequestInit }> = [];
let payingFetches = 0;

// The real module, with only the wallet, the relay and the paying fetch
// replaced: the catalogue cache createServer builds is the real one.
vi.mock("@ftptech/canton-agent-wallet", async (importOriginal) => {
  const real = await importOriginal<typeof AgentWallet>();
  return {
    ...real,
    loadWallet: () => ({ party: "agent::1220aaa", relayUrl: RELAY_URL, network: "canton:mainnet" }),
    RelayClient: class {
      async balance() {
        return { cc: "100", amulet: 1 };
      }
    },
    makePayingFetchForWallet: async () => {
      payingFetches += 1;
      return async (input: RequestInfo | URL, init?: RequestInit) => {
        paid.push({ url: String(input), init });
        return new Response("ok", { status: 200 });
      };
    },
  };
});

const { createServer } = await import("./server.js");

describe("--allow-domains", () => {
  it("keeps today's readings: '*', a host list, and empty = deny all", () => {
    expect(parseAllowDomains("*", "x")).toBe("*");
    expect(parseAllowDomains(" * ", "x")).toBe("*");
    expect(parseAllowDomains("Api.Example.com, b.test", "x")).toEqual(["api.example.com", "b.test"]);
    expect(parseAllowDomains("", "x")).toEqual([]);
    expect(resolveConfig(RELAY, {}).policy.allowDomains).toEqual([]);
  });

  it("a host that only contains the word is an ordinary host", () => {
    expect(parseAllowDomains("catalog.example.com", "x")).toEqual(["catalog.example.com"]);
    expect(parseAllowDomains("api.catalog, b.test", "x")).toEqual(["api.catalog", "b.test"]);
    expect(resolveConfig([...RELAY, "--allow-domains", "catalog.example.com"], {}).policy.allowDomains).toEqual([
      "catalog.example.com",
    ]);
  });

  it("'catalog' alone means only catalogue services, in every spelling of the flag", () => {
    expect(parseAllowDomains("catalog", "x")).toBe("catalog");
    expect(parseAllowDomains(" Catalog ", "x")).toBe("catalog");
    expect(resolveConfig([...RELAY, "--allow-domains", "catalog"], {}).policy.allowDomains).toBe("catalog");
    expect(resolveConfig([...RELAY, "--allow-domains=catalog"], {}).policy.allowDomains).toBe("catalog");
    expect(resolveConfig(RELAY, { CANTON_MCP_ALLOW_DOMAINS: "catalog" }).policy.allowDomains).toBe("catalog");
  });

  it("'catalog' next to anything else refuses to start", () => {
    expect(() => parseAllowDomains("catalog,api.example.com", "--allow-domains")).toThrow(
      /--allow-domains: "catalog" must be the whole value/
    );
    expect(() => resolveConfig([...RELAY, "--allow-domains", "api.example.com,catalog"], {})).toThrow(/whole value/);
    expect(() => resolveConfig(RELAY, { CANTON_MCP_ALLOW_DOMAINS: "*,catalog" })).toThrow(/whole value/);
  });
});

describe("local server: --allow-domains catalog", () => {
  const ENTRY = "https://api.example.com/v1/agent";
  const STRANGER = "https://stranger.example.net/v1/agent";
  /** Every URL the process fetched itself (the catalogue, and anything else). */
  let fetched: string[];

  beforeEach(() => {
    fetched = [];
    paid.length = 0;
    payingFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);
      if (new URL(url).pathname === "/discovery/resources") {
        return Response.json({
          items: [{ resource: ENTRY, accepts: [{ scheme: "exact", network: "canton:mainnet", amount: "1000000" }] }],
          pagination: { total: 1 },
        });
      }
      return new Response("not here", { status: 404 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const pay = async (url: string) => {
    const home = mkdtempSync(join(tmpdir(), "x402mcp-catalog-"));
    const config = resolveConfig(
      [...RELAY, "--home", home, "--allow-domains", "catalog", "--no-funded-ceiling"],
      {}
    );
    const server = createServer(config);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    const r = (await client.callTool({ name: "pay", arguments: { url } })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    return { isError: r.isError === true, text: r.content.map((c) => c.text).join("\n") };
  };

  it("refuses an address off the catalogue, and nothing is fetched from it", async () => {
    const r = await pay(STRANGER);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("is not in the catalogue of verified services");
    expect(r.text).toContain("--allow-domains catalog");
    expect(payingFetches).toBe(0);
    expect(paid).toEqual([]);
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((u) => new URL(u).origin === RELAY_URL)).toBe(true);
    expect(fetched.some((u) => u.includes("stranger.example.net"))).toBe(false);
  });

  it("pays a catalogue service, with redirects refused", async () => {
    const r = await pay(ENTRY);
    expect(r.isError, r.text).toBe(false);
    expect(payingFetches).toBe(1);
    expect(paid).toEqual([{ url: ENTRY, init: expect.objectContaining({ redirect: "error" }) }]);
  });
});
