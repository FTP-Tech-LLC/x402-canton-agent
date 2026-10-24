import { describe, it, expect, vi, afterEach } from "vitest";
import {
  RelayClient,
  RelayHttpError,
  isHoldingsExceedNodeLimitError,
  PAY_AND_CLAIM_RELAY_ROUTES,
  RelayTimeoutError,
  DEFAULT_RELAY_TIMEOUT_MS,
} from "./relay-client.js";

afterEach(() => vi.unstubAllGlobals());

function captureFetch(
  responder: (url: string, init: RequestInit) => Response
): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return responder(url, init);
    })
  );
  return { calls };
}

describe("RelayClient", () => {
  it("sends content-type and omits x-agent-key when no apiKey", async () => {
    const cap = captureFetch(() => new Response(JSON.stringify({ party: "p", amulet: 0, cc: "0", holdings: [] }), { status: 200 }));
    const c = new RelayClient({ relayUrl: "http://relay/" });
    await c.balance("agent::1");
    const h = cap.calls[0]!.init.headers as Record<string, string>;
    expect(h["content-type"]).toBe("application/json");
    expect(h["x-agent-key"]).toBeUndefined();
  });

  it("attaches x-agent-key when apiKey is set", async () => {
    const cap = captureFetch(() => new Response(JSON.stringify({ party: "p", amulet: 0, cc: "0", holdings: [] }), { status: 200 }));
    await new RelayClient({ relayUrl: "http://relay", apiKey: "secret" }).balance("agent::1");
    const h = cap.calls[0]!.init.headers as Record<string, string>;
    expect(h["x-agent-key"]).toBe("secret");
  });

  it("strips a trailing slash from relayUrl (no double slash)", async () => {
    const cap = captureFetch(() => new Response(JSON.stringify({ party: "p", amulet: 0, cc: "0", holdings: [] }), { status: 200 }));
    await new RelayClient({ relayUrl: "http://relay/" }).balance("agent::1");
    expect(cap.calls[0]!.url).toBe("http://relay/v1/wallet/agent%3A%3A1/balance");
  });

  it("URL-encodes the party id in the path (':' → %3A)", async () => {
    const cap = captureFetch(() => new Response(JSON.stringify({ party: "p", pending: [] }), { status: 200 }));
    await new RelayClient({ relayUrl: "http://relay" }).pending("agent::1220abcd");
    expect(cap.calls[0]!.url).toContain("agent%3A%3A1220abcd");
    expect(cap.calls[0]!.url).not.toContain("agent::1220abcd");
  });

  it("maps a non-2xx response to a descriptive Error including status + body snippet", async () => {
    captureFetch(() => new Response("boom detail", { status: 502 }));
    await expect(
      new RelayClient({ relayUrl: "http://relay" }).balance("agent::1")
    ).rejects.toThrow(/relay GET .*balance -> 502 boom detail/);
  });

  it("POST bodies are JSON-serialized; GET sends no body", async () => {
    const cap = captureFetch((url) => {
      if (url.endsWith("/resolve/transfer-factory")) {
        return new Response(
          JSON.stringify({
            factoryId: "f",
            transferKind: "k",
            instrumentId: { admin: "DSO", id: "Amulet" },
            choiceContextData: {},
            disclosedContracts: [],
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ party: "p", amulet: 0, cc: "0", holdings: [] }), { status: 200 });
    });
    const c = new RelayClient({ relayUrl: "http://relay" });
    await c.resolveTransferFactory({ sender: "a", receiver: "b", amount: "1" });
    await c.balance("agent::1");
    const post = cap.calls[0]!;
    const get = cap.calls[1]!;
    expect(post.init.method).toBe("POST");
    expect(JSON.parse(post.init.body as string)).toEqual({ sender: "a", receiver: "b", amount: "1" });
    expect(get.init.method).toBe("GET");
    expect(get.init.body).toBeUndefined();
  });

  it("parses a JSON success body into the typed result", async () => {
    captureFetch(() => new Response(JSON.stringify({ party: "agent::1", amulet: 2, cc: "10.0000000000", holdings: [{ cid: "h", amount: "10.0" }] }), { status: 200 }));
    const r = await new RelayClient({ relayUrl: "http://relay" }).balance("agent::1");
    expect(r.cc).toBe("10.0000000000");
    expect(r.holdings[0]!.cid).toBe("h");
  });

  it("txAmulets GETs the tx-amulets route by updateId (URL-encoded party) and returns the typed result", async () => {
    const cap = captureFetch(() =>
      new Response(
        JSON.stringify({
          party: "agent::1220whale",
          updateId: "u-batch-1",
          amulets: [
            { cid: "00out1", amount: "1.5000000000" },
            { cid: "00out2", amount: "0.0000000001" },
          ],
        }),
        { status: 200 }
      )
    );
    const r = await new RelayClient({ relayUrl: "http://relay" }).txAmulets(
      "agent::1220whale",
      "u-batch-1"
    );
    expect(cap.calls[0]!.url).toBe(
      "http://relay/v1/wallet/agent%3A%3A1220whale/tx-amulets?updateId=u-batch-1"
    );
    expect(cap.calls[0]!.init.method).toBe("GET");
    expect(r.party).toBe("agent::1220whale");
    expect(r.updateId).toBe("u-batch-1");
    expect(r.amulets).toEqual([
      { cid: "00out1", amount: "1.5000000000" },
      { cid: "00out2", amount: "0.0000000001" },
    ]);
  });

  it("txAmulets surfaces a relay 502 (tx lookup failed) as a descriptive Error", async () => {
    captureFetch(() => new Response("tx boom", { status: 502 }));
    await expect(
      new RelayClient({ relayUrl: "http://relay" }).txAmulets("agent::1", "u-x")
    ).rejects.toThrow(/relay GET .*tx-amulets.* -> 502/);
  });

  it("holdingsScan GETs the scan-snapshot route (URL-encoded party) and returns the typed result", async () => {
    const cap = captureFetch(() =>
      new Response(
        JSON.stringify({
          party: "agent::1220whale",
          source: "scan-snapshot",
          recordTime: "2026-07-02T12:00:00Z",
          holdings: [{ cid: "00a1", amount: "0.0031370000" }],
          complete: true,
        }),
        { status: 200 }
      )
    );
    const r = await new RelayClient({ relayUrl: "http://relay" }).holdingsScan(
      "agent::1220whale"
    );
    expect(cap.calls[0]!.url).toBe(
      "http://relay/v1/wallet/agent%3A%3A1220whale/holdings-scan"
    );
    expect(cap.calls[0]!.init.method).toBe("GET");
    expect(r.source).toBe("scan-snapshot");
    expect(r.holdings[0]!.cid).toBe("00a1");
    expect(r.complete).toBe(true);
  });

  it("a non-2xx throws a RelayHttpError carrying the status + parsed JSON body", async () => {
    captureFetch(() =>
      new Response(
        JSON.stringify({ error: "wallet relay balance failed", code: "holdings_exceed_node_limit" }),
        { status: 413 }
      )
    );
    let caught: unknown;
    try {
      await new RelayClient({ relayUrl: "http://relay" }).balance("agent::1220whale");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RelayHttpError);
    const err = caught as RelayHttpError;
    expect(err.status).toBe(413);
    expect((err.body as { code?: string }).code).toBe("holdings_exceed_node_limit");
    // Message format unchanged (existing assertions elsewhere still hold).
    expect(err.message).toMatch(/relay GET .*balance -> 413/);
  });
});

describe("isHoldingsExceedNodeLimitError", () => {
  it("matches a structured RelayHttpError 413", () => {
    expect(
      isHoldingsExceedNodeLimitError(
        new RelayHttpError("x -> 413 y", 413, { code: "holdings_exceed_node_limit" })
      )
    ).toBe(true);
  });
  it("matches on body.code even if a non-413 status ever carried it", () => {
    expect(
      isHoldingsExceedNodeLimitError(
        new RelayHttpError("x", 500, { code: "holdings_exceed_node_limit" })
      )
    ).toBe(true);
  });
  it("falls back to the message string for a plain Error", () => {
    expect(
      isHoldingsExceedNodeLimitError(new Error("relay GET /x/balance -> 413 nope"))
    ).toBe(true);
    expect(
      isHoldingsExceedNodeLimitError(new Error("holdings_exceed_node_limit"))
    ).toBe(true);
  });
  it("does NOT match an unrelated error", () => {
    expect(isHoldingsExceedNodeLimitError(new RelayHttpError("x -> 502 y", 502, {}))).toBe(
      false
    );
    expect(isHoldingsExceedNodeLimitError(new Error("some other failure"))).toBe(false);
  });
});

describe("RelayClient preapproval (transfer-factory V3 merchant setup)", () => {
  it("preapprovalStatus GETs the status route with admin+id query", async () => {
    const cap = captureFetch(() =>
      new Response(
        JSON.stringify({
          merchant: "m::1220",
          instrumentId: { admin: "DSO::1220", id: "Amulet" },
          transferKind: "direct",
          hasPreapproval: true,
        }),
        { status: 200 }
      )
    );
    const r = await new RelayClient({ relayUrl: "http://relay" }).preapprovalStatus(
      "m::1220ab",
      "DSO::1220cd"
    );
    expect(r.hasPreapproval).toBe(true);
    expect(cap.calls[0]!.init.method).toBe("GET");
    expect(cap.calls[0]!.url).toContain("/v1/merchants/m%3A%3A1220ab/preapproval-status");
    expect(cap.calls[0]!.url).toContain("admin=DSO%3A%3A1220cd");
    expect(cap.calls[0]!.url).toContain("id=Amulet");
  });

  it("createPreapproval POSTs with the operator Bearer token", async () => {
    const cap = captureFetch(() =>
      new Response(
        JSON.stringify({
          updateId: "1220u",
          receiver: "m::1220",
          provider: "fac::1220",
          expiresAt: "2026-10-01T00:00:00Z",
        }),
        { status: 200 }
      )
    );
    const r = await new RelayClient({ relayUrl: "http://relay" }).createPreapproval(
      "m::1220ab",
      { operatorToken: "op-secret", expiresAt: "2026-10-01T00:00:00Z" }
    );
    expect(r.provider).toBe("fac::1220");
    const call = cap.calls[0]!;
    expect(call.init.method).toBe("POST");
    expect(call.url).toContain("/v1/merchants/m%3A%3A1220ab/preapproval");
    const h = call.init.headers as Record<string, string>;
    expect(h["authorization"]).toBe("Bearer op-secret");
    expect(JSON.parse(call.init.body as string)).toEqual({
      expiresAt: "2026-10-01T00:00:00Z",
    });
  });

  it("createPreapproval without expiresAt sends an empty body", async () => {
    const cap = captureFetch(() =>
      new Response(
        JSON.stringify({ updateId: "u", receiver: "m", provider: "f", expiresAt: "x" }),
        { status: 200 }
      )
    );
    await new RelayClient({ relayUrl: "http://relay" }).createPreapproval("m::1220", {
      operatorToken: "t",
    });
    expect(JSON.parse(cap.calls[0]!.init.body as string)).toEqual({});
  });
});

/**
 * A pay-proxy image bundling an old wallet called POST /v1/wallet/pay/commit for
 * weeks after the facilitator dropped it, and every quest funded a wallet first
 * and failed second. `missingRoutes` is how a caller asks before it funds.
 */
describe("RelayClient.missingRoutes", () => {
  const notFound = (path: string) =>
    new Response(
      JSON.stringify({ message: `Route POST:${path} not found`, error: "Not Found", statusCode: 404 }),
      { status: 404 }
    );

  it("names only the routes the relay answers with Fastify's route-not-found 404", async () => {
    const cap = captureFetch((url) => {
      if (url.endsWith("/v1/wallet/pay/commit")) return notFound("/v1/wallet/pay/commit");
      // A served route rejects the empty body before doing any work.
      return new Response(JSON.stringify({ error: "party, receiver, amount required" }), { status: 400 });
    });
    const missing = await new RelayClient({ relayUrl: "http://relay/" }).missingRoutes([
      "/v1/wallet/pay/prepare",
      "/v1/wallet/pay/commit",
    ]);
    expect(missing).toEqual(["/v1/wallet/pay/commit"]);
    // An empty JSON body, POSTed — nothing a served route could act on.
    expect(cap.calls.map((c) => [c.init.method, c.init.body])).toEqual([
      ["POST", "{}"],
      ["POST", "{}"],
    ]);
  });

  it("a 404 that is NOT the route-not-found answer means the route exists", async () => {
    captureFetch(() => new Response(JSON.stringify({ error: "instruction not found" }), { status: 404 }));
    expect(
      await new RelayClient({ relayUrl: "http://relay" }).missingRoutes(["/v1/wallet/resolve/accept"])
    ).toEqual([]);
  });

  it("a relay it cannot reach is an error, never 'nothing missing'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    await expect(
      new RelayClient({ relayUrl: "http://relay" }).missingRoutes(["/v1/wallet/pay/prepare"])
    ).rejects.toThrow(/fetch failed/);
  });

  it("the pay and claim calls use exactly the exported route strings", async () => {
    const cap = captureFetch(() => new Response(JSON.stringify({}), { status: 200 }));
    const c = new RelayClient({ relayUrl: "http://relay" });
    await c.payPrepare({} as never);
    await c.resolveAccept({} as never);
    await c.submitPrepare({});
    await c.submitExecute({});
    expect(cap.calls.map((x) => new URL(x.url).pathname)).toEqual([
      PAY_AND_CLAIM_RELAY_ROUTES.payPrepare,
      PAY_AND_CLAIM_RELAY_ROUTES.resolveAccept,
      PAY_AND_CLAIM_RELAY_ROUTES.submitPrepare,
      PAY_AND_CLAIM_RELAY_ROUTES.submitExecute,
    ]);
  });
});

describe("RelayClient — bounded holdings reads", () => {
  it("holdings(…, {slice:true}) sends slice=1 and reports `complete` from the relay", async () => {
    const cap = captureFetch(() => new Response(JSON.stringify({ party: "p", instruments: [], complete: false }), { status: 200 }));
    const h = await new RelayClient({ relayUrl: "http://relay" }).holdings("agent::1", { admin: "a::1", id: "USDCx" }, { slice: true });
    const u = new URL(cap.calls[0]!.url);
    expect(u.searchParams.get("slice")).toBe("1");
    expect(u.searchParams.get("admin")).toBe("a::1");
    expect(u.searchParams.get("id")).toBe("USDCx");
    expect(h.complete).toBe(false);
  });

  it("holdings(…, {registryOnly}) asks for the registry tokens only (class=registry); an instrument read never sends it", async () => {
    const cap = captureFetch(() => new Response(JSON.stringify({ party: "p", instruments: [], complete: true }), { status: 200 }));
    const c = new RelayClient({ relayUrl: "http://relay" });
    await c.holdings("agent::1", undefined, { slice: true, registryOnly: true });
    const u = new URL(cap.calls[0]!.url);
    expect(u.searchParams.get("class")).toBe("registry");
    expect(u.searchParams.get("slice")).toBe("1");
    await c.holdings("agent::1", { admin: "a::1", id: "USDCx" }, { slice: true, registryOnly: true });
    expect(new URL(cap.calls[1]!.url).searchParams.has("class")).toBe(false);
  });

  it("a relay that predates slicing (no `complete` field) reads as complete", async () => {
    captureFetch(() => new Response(JSON.stringify({ party: "p", instruments: [] }), { status: 200 }));
    const h = await new RelayClient({ relayUrl: "http://relay" }).holdings("agent::1");
    expect(h.complete).toBe(true);
  });

  it("a holdings_merge_required refusal is explained with the exact merge to run", async () => {
    captureFetch(() => new Response(JSON.stringify({
      code: "holdings_merge_required",
      detail: "… Consolidate first: canton-agent-wallet merge --admin cbtc::1220 --id CBTC",
    }), { status: 413 }));
    const err = await new RelayClient({ relayUrl: "http://relay" })
      .payPrepare({ party: "p", receiver: "m", amount: "1" })
      .catch((e: unknown) => e as Error);
    expect(err.message).toMatch(/must be consolidated.*canton-agent-wallet merge --admin cbtc::1220 --id CBTC/s);
  });
});

describe("RelayClient — request timeout", () => {
  const hang = () =>
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit = {}) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(init.signal!.reason));
        })
      )
    );

  it("a hung read fails with RelayTimeoutError instead of hanging forever", async () => {
    hang();
    const err = await new RelayClient({ relayUrl: "http://relay", timeoutMs: 20 }).balance("agent::1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayTimeoutError);
    expect((err as RelayTimeoutError).outcomeUnknown).toBe(false);
  });

  it("a timed-out SUBMISSION is reported as outcome-unknown — check balance, do not retry blind", async () => {
    hang();
    const err = await new RelayClient({ relayUrl: "http://relay", timeoutMs: 20 }).submitExecute({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayTimeoutError);
    expect((err as RelayTimeoutError).outcomeUnknown).toBe(true);
    expect((err as Error).message).toMatch(/may still commit.*balance/);
  });

  it("CANTON_AGENT_RELAY_TIMEOUT_MS sets the default; an explicit timeoutMs wins", () => {
    process.env.CANTON_AGENT_RELAY_TIMEOUT_MS = "1234";
    try {
      expect((new RelayClient({ relayUrl: "http://r" }) as unknown as { timeoutMs: number }).timeoutMs).toBe(1234);
      expect((new RelayClient({ relayUrl: "http://r", timeoutMs: 5 }) as unknown as { timeoutMs: number }).timeoutMs).toBe(5);
    } finally {
      delete process.env.CANTON_AGENT_RELAY_TIMEOUT_MS;
    }
    expect((new RelayClient({ relayUrl: "http://r" }) as unknown as { timeoutMs: number }).timeoutMs).toBe(DEFAULT_RELAY_TIMEOUT_MS);
  });
});
