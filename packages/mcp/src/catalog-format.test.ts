import { describe, it, expect } from "vitest";
import { formatCatalog, priceOf, MAX_LISTED } from "./catalog-format.js";
import type { CatalogEntry } from "./catalog.js";

const DSO = "DSO::1220dso";
const USDC_ADMIN = "decentralized-usdc-interchain-rep::1220usdc";

/** The live catalogue's shapes (06.10), with party ids shortened. */
const LIVE: CatalogEntry[] = [
  {
    resource: "https://api.cantrustai.xyz/v1/agent/completions",
    type: "http",
    method: "POST",
    description: "x402-gated AI agent/image completions on Canton MainNet.",
    accepts: [{ scheme: "exact", amount: "2500000000", asset: "CC", extra: { instrumentId: { admin: DSO, id: "Amulet" } } }],
    metadata: { name: "CanTrustAI Agent Completions", method: "POST" },
  },
  {
    resource: "https://cc-api.itrocket.space/x402/api/v1/stats",
    type: "http",
    description: "Canton indexer API — pay per request",
    accepts: [
      { amount: "254000000", asset: "CC", extra: { instrumentId: { admin: DSO, id: "Amulet" } } },
      { amount: "25000000", asset: `${USDC_ADMIN}::USDCx`, extra: { instrumentId: { admin: USDC_ADMIN, id: "USDCx" } } },
    ],
    metadata: { title: "IT Rocket Canton indexer (CC Space)" },
  },
  {
    resource: "https://api.transparentscan.xyz/v2/x402/state/ledger-end",
    type: "http",
    accepts: [{ amount: "300000000", asset: "CC", extra: { instrumentId: { admin: DSO, id: "Amulet" } } }],
    metadata: { title: "TransparentScan Canton on-chain data", description: "" },
  },
];

describe("priceOf", () => {
  it("atomic amounts at scale 10, Amulet as CC, a token by its /supported symbol or else its id", () => {
    expect(priceOf(LIVE[0]!.accepts[0]!)).toBe("0.25 CC");
    expect(priceOf(LIVE[1]!.accepts[1]!)).toBe("0.0025 USDCx");
    expect(priceOf(LIVE[1]!.accepts[1]!, new Map([[`${USDC_ADMIN}|USDCx`, "USDC.x"]]))).toBe("0.0025 USDC.x");
    expect(priceOf({ amount: "100000000", asset: "CC" })).toBe("0.01 CC");
    expect(priceOf({ amount: "not a number", asset: "CC" })).toBeUndefined();
  });
});

describe("formatCatalog", () => {
  it("lists every entry with title, method, URL, price and description", () => {
    const out = formatCatalog(LIVE);
    expect(out).toContain("3 paid APIs in the catalogue.");
    expect(out).toContain("1. CanTrustAI Agent Completions\n   POST https://api.cantrustai.xyz/v1/agent/completions\n   price: 0.25 CC");
    expect(out).toContain("   price: 0.0254 CC or 0.0025 USDCx");
    expect(out).toContain("3. TransparentScan Canton on-chain data\n   https://api.transparentscan.xyz/v2/x402/state/ledger-end\n   price: 0.03 CC");
  });

  it("filters by words (all must match) and by type", () => {
    const out = formatCatalog(LIVE, { query: "Canton INDEXER" });
    expect(out).toContain("1 paid API in the catalogue.");
    expect(out).toContain("IT Rocket");
    expect(out).not.toContain("CanTrustAI");
    expect(formatCatalog(LIVE, { type: "grpc" })).toMatch(/^No catalogue entry matches\. 3 entries are listed in total/);
  });

  it("says when the catalogue is empty", () => {
    expect(formatCatalog([])).toBe("The catalogue is empty right now.");
  });

  it("marks a price the entry flags as dynamic (metadata.priceDynamic) as a starting price", () => {
    const dynamic = { ...LIVE[0]!, metadata: { ...LIVE[0]!.metadata, priceDynamic: true } };
    expect(formatCatalog([dynamic])).toContain(
      "   price: from 0.25 CC (depends on the request; the 402 sets it)\n"
    );
    expect(formatCatalog([LIVE[0]!])).toContain("   price: 0.25 CC\n");
    expect(formatCatalog([{ ...LIVE[0]!, metadata: { priceDynamic: "yes" } }])).toContain("   price: 0.25 CC\n");
  });

  it("flattens text a catalogue line could use to fake a new entry", () => {
    const out = formatCatalog([{ ...LIVE[2]!, metadata: { title: "Real\n\n2. Fake entry" } }]);
    expect(out).toContain("1. Real 2. Fake entry");
  });

  it("shows how to call an entry: query, JSON body, fields and note, flattened", () => {
    const out = formatCatalog([
      {
        ...LIVE[0]!,
        metadata: {
          title: "Quote",
          example: { body: { fromToken: "CC", amountIn: "1000" } },
          inputSchema: { fromToken: "string, required, e.g. CC", amountIn: "string,\nrequired", n: 5 },
        },
      },
      { ...LIVE[2]!, metadata: { title: "Swap", example: { query: "?in=CC&out=USDCx&amount=60", note: "in, out and amount are required" } } },
      { ...LIVE[2]!, metadata: { title: "Plain", example: { note: "GET the URL as it is; no parameters." } } },
    ]);
    expect(out).toContain(
      '   body (JSON): {"fromToken":"CC","amountIn":"1000"}\n   fields: fromToken (string, required, e.g. CC); amountIn (string, required)'
    );
    expect(out).toContain("   query: ?in=CC&out=USDCx&amount=60\n   note: in, out and amount are required");
    expect(out).toContain("   note: GET the URL as it is; no parameters.");
    expect(out).toContain("a wrong call is still paid");
  });

  it("reads a JSON Schema inputSchema, never shows a cut body, and drops control characters", () => {
    const out = formatCatalog([
      {
        ...LIVE[0]!,
        metadata: {
          title: "Schema",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            required: ["q"],
            properties: { q: { type: "string", description: "the question" }, n: { type: "integer" } },
          },
          example: { body: { q: "x".repeat(400), n: 1 }, note: "ok\u001b[2Jcleared" },
        },
      },
    ]);
    expect(out).toContain("   fields: q (string, required, the question); n (integer)");
    expect(out).not.toContain("$schema");
    expect(out).toContain("   body (JSON): too long to show here; its fields: q, n");
    expect(out).toContain("   note: ok [2Jcleared");
    expect(out).not.toContain("\u001b");
  });

  it(`lists at most ${MAX_LISTED} and says how many more`, () => {
    const many = Array.from({ length: MAX_LISTED + 3 }, (_, i) => ({ ...LIVE[2]!, resource: `https://x${i}.example/` }));
    expect(formatCatalog(many)).toContain("3 more; narrow the list with query.");
  });
});
