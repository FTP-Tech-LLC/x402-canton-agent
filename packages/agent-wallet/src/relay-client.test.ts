import { describe, it, expect, vi, afterEach } from "vitest";
import {
  RelayClient,
  RelayHttpError,
  isHoldingsExceedNodeLimitError,
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

  it("faucetClaim POSTs {party} to /v1/wallet/faucet/claim and returns the parsed body", async () => {
    const cap = captureFetch(() =>
      new Response(
        JSON.stringify({ updateId: "u-fc", amount: "0.02", party: "agent::1220abcd" }),
        { status: 200 }
      )
    );
    const r = await new RelayClient({ relayUrl: "http://relay" }).faucetClaim("agent::1220abcd");
    expect(cap.calls[0]!.url).toBe("http://relay/v1/wallet/faucet/claim");
    expect(cap.calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(cap.calls[0]!.init.body as string)).toEqual({ party: "agent::1220abcd" });
    expect(r).toEqual({ updateId: "u-fc", amount: "0.02", party: "agent::1220abcd" });
  });

  it("faucetClaim surfaces a relay 503 (faucet disabled / over budget) as a descriptive Error", async () => {
    captureFetch(() => new Response(JSON.stringify({ error: "faucet disabled" }), { status: 503 }));
    await expect(
      new RelayClient({ relayUrl: "http://relay" }).faucetClaim("agent::1")
    ).rejects.toThrow(/relay POST .*faucet\/claim -> 503/);
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
