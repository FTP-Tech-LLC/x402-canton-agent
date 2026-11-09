import { describe, it, expect } from "vitest";
import { createCatalogCache, createInstrumentSymbols } from "./catalog.js";

const URL_ = "https://facilitator.example/discovery/resources";
const entry = (i: number) => ({
  resource: `https://api${i}.example/x`,
  type: "http",
  accepts: [{ scheme: "exact", amount: "100000000", asset: "CC" }],
});

/** A facilitator that pages like the real route (limit 1..100, offset). */
function facilitator(total: number) {
  const calls: URL[] = [];
  let mode: "ok" | "fail" | "hang" = "ok";
  const all = Array.from({ length: total }, (_, i) => entry(i));
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    calls.push(u);
    if (mode === "hang") {
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      );
    }
    if (mode === "fail") return new Response("bad gateway", { status: 502 });
    const limit = Number(u.searchParams.get("limit"));
    const offset = Number(u.searchParams.get("offset"));
    return Response.json({ x402Version: 2, items: all.slice(offset, offset + limit), pagination: { limit, offset, total } });
  }) as typeof globalThis.fetch;
  return { fetch, calls, setMode: (m: typeof mode) => (mode = m) };
}

describe("createCatalogCache", () => {
  it("asks 100 at a time and follows offset up to pagination.total", async () => {
    const f = facilitator(150);
    const cache = createCatalogCache({ url: URL_, fetch: f.fetch });
    expect(await cache.get()).toHaveLength(150);
    expect(f.calls.map((u) => u.search)).toEqual(["?limit=100&offset=0", "?limit=100&offset=100"]);
  });

  it("serves from memory for 5 minutes, then refreshes", async () => {
    const f = facilitator(3);
    let now = 1_000_000;
    const cache = createCatalogCache({ url: URL_, fetch: f.fetch, now: () => now });
    await cache.get();
    await cache.get();
    expect(f.calls).toHaveLength(1);
    now += 300_001;
    await cache.get();
    expect(f.calls).toHaveLength(2);
  });

  it("runs one refresh at a time", async () => {
    const f = facilitator(3);
    const cache = createCatalogCache({ url: URL_, fetch: f.fetch });
    await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(f.calls).toHaveLength(1);
  });

  it("a failed refresh serves the last good copy", async () => {
    const f = facilitator(3);
    let now = 1_000_000;
    const cache = createCatalogCache({ url: URL_, fetch: f.fetch, now: () => now });
    expect(await cache.get()).toHaveLength(3);
    f.setMode("fail");
    now += 300_001;
    expect(await cache.get()).toHaveLength(3);
  });

  it("a facilitator that hangs is given up on after the timeout, and the last good copy is served", async () => {
    const f = facilitator(3);
    let now = 1_000_000;
    const cache = createCatalogCache({ url: URL_, fetch: f.fetch, now: () => now, timeoutMs: 20 });
    await cache.get();
    f.setMode("hang");
    now += 300_001;
    expect(await cache.get()).toHaveLength(3);
  });

  it("never loaded is undefined, and a failure is not retried for 30 seconds", async () => {
    const f = facilitator(3);
    f.setMode("fail");
    let now = 1_000_000;
    const cache = createCatalogCache({ url: URL_, fetch: f.fetch, now: () => now });
    expect(await cache.get()).toBeUndefined();
    now += 10_000;
    expect(await cache.get()).toBeUndefined();
    expect(f.calls).toHaveLength(1);
    f.setMode("ok");
    now += 20_001;
    expect(await cache.get()).toHaveLength(3);
    expect(f.calls).toHaveLength(2);
  });

  it("tells onError about every failed refresh (an error answer or a hang) and still serves the last good copy", async () => {
    const f = facilitator(3);
    let now = 1_000_000;
    const errors: unknown[] = [];
    const cache = createCatalogCache({ url: URL_, fetch: f.fetch, now: () => now, timeoutMs: 20, onError: (e) => errors.push(e) });
    expect(await cache.get()).toHaveLength(3);
    expect(errors).toEqual([]);
    f.setMode("fail");
    now += 300_001;
    expect(await cache.get()).toHaveLength(3);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("HTTP 502");
    f.setMode("hang");
    now += 30_001;
    expect(await cache.get()).toHaveLength(3);
    expect(errors).toHaveLength(2);
  });

  it("an onError that throws changes nothing: the last good copy is served and the retry pause holds", async () => {
    const f = facilitator(3);
    let now = 1_000_000;
    const cache = createCatalogCache({
      url: URL_,
      fetch: f.fetch,
      now: () => now,
      onError: () => {
        throw new Error("the logger broke");
      },
    });
    expect(await cache.get()).toHaveLength(3);
    f.setMode("fail");
    now += 300_001;
    expect(await cache.get()).toHaveLength(3);
    now += 10_000;
    expect(await cache.get()).toHaveLength(3);
    expect(f.calls).toHaveLength(2);
  });

  it("skips malformed items, keeps the rest, and lifts description and method out of metadata", async () => {
    const fetch = (async () =>
      Response.json({
        items: [
          { resource: "https://a.example/x", accepts: [{ amount: "1" }, "junk"], metadata: { description: "A", method: "POST", title: "A api" } },
          { accepts: [] },
          { resource: "https://b.example/x", accepts: "nope" },
          null,
        ],
        pagination: { total: 4 },
      })) as typeof globalThis.fetch;
    const entries = await createCatalogCache({ url: URL_, fetch }).get();
    expect(entries).toEqual([
      {
        resource: "https://a.example/x",
        description: "A",
        method: "POST",
        accepts: [{ amount: "1" }],
        metadata: { description: "A", method: "POST", title: "A api" },
      },
    ]);
  });

  it("a relay URL ending in a slash still reaches /discovery/resources", async () => {
    const f = facilitator(1);
    await createCatalogCache({ url: "https://facilitator.example//discovery/resources", fetch: f.fetch }).get();
    expect(f.calls[0]!.pathname).toBe("/discovery/resources");
  });
});

describe("createInstrumentSymbols", () => {
  it("maps admin|id to the symbol /supported gives, skipping instruments without one", async () => {
    const fetch = (async () =>
      Response.json({
        kinds: [
          {
            extra: {
              instruments: [
                { admin: "usdc::1220", instrumentId: { admin: "usdc::1220", id: "USDCx" }, symbol: "USDCx" },
                { admin: "ember-gold::1220" },
              ],
            },
          },
        ],
      })) as typeof globalThis.fetch;
    const map = await createInstrumentSymbols({ url: "https://facilitator.example/supported", fetch }).get();
    expect(map?.get("usdc::1220|USDCx")).toBe("USDCx");
    expect(map?.size).toBe(1);
  });
});
