import { describe, it, expect, vi, afterEach } from "vitest";
import { verify } from "node:crypto";
import { RelayClient, READ_PROOF_ROUTES } from "./relay-client.js";
import { generateAgentKey, loadPublicKey, readSignerFromWallet, verifyHashB64 } from "./keys.js";
import * as keysModule from "./keys.js";
import * as indexModule from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const PARTY = "agent::1220aabb";
const OTHER = "other::1220ccdd";
const key = generateAgentKey();
const signer = readSignerFromWallet({ party: PARTY, privateKeyPkcs8Pem: key.privateKeyPkcs8Pem });

function capture() {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ party: "p", amulet: 0, cc: "0", holdings: [], instruments: [] }), {
        status: 200,
      });
    })
  );
  return calls;
}
const client = (readSigner?: typeof signer, relayUrl = "http://relay") => new RelayClient({ relayUrl, readSigner });

describe("RelayClient read proofs", () => {
  it("signs a read of its own party, exactly as the relay specifies", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const calls = capture();
    await client(signer).balance(PARTY);
    const header = calls[0]!.headers["x-canton-read-proof"]!;
    const [v, ts, sig] = header.split(".");
    expect(v).toBe("v1");
    expect(ts).toBe("1800000000000");
    const message = Buffer.from(
      `canton-x402 relay read v1\nGET\nrelay\n/v1/wallet/${PARTY}/balance\n\n${PARTY}\n1800000000000`,
      "utf8"
    );
    const raw = Buffer.from(sig!, "base64url");
    expect(raw.length).toBe(64);
    expect(verify(null, message, loadPublicKey(key.publicKeySpkiB64), raw)).toBe(true);
    // never the length of a transaction hash or its multihash form
    expect([32, 34]).not.toContain(message.length);
  });

  it("signs the raw query string", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const calls = capture();
    await client(signer).pending(PARTY);
    expect(calls[0]!.url).toContain("?registry=1");
    const sig = Buffer.from(calls[0]!.headers["x-canton-read-proof"]!.split(".")[2]!, "base64url");
    const message = Buffer.from(
      `canton-x402 relay read v1\nGET\nrelay\n/v1/wallet/${PARTY}/pending\nregistry=1\n${PARTY}\n1800000000000`
    );
    expect(verify(null, message, loadPublicKey(key.publicKeySpkiB64), sig)).toBe(true);
  });

  it("sends no proof for another party", async () => {
    const calls = capture();
    await client(signer).balance(OTHER);
    expect(calls[0]!.headers["x-canton-read-proof"]).toBeUndefined();
  });

  it("sends no proof for a route that is not a per-party read", async () => {
    const calls = capture();
    await client(signer).supported().catch(() => undefined);
    await client(signer).preapprovalStatus(PARTY, "dso::1").catch(() => undefined);
    for (const c of calls) expect(c.headers["x-canton-read-proof"]).toBeUndefined();
  });

  it("sends no proof without a signer", async () => {
    const calls = capture();
    await client().balance(PARTY);
    expect(calls[0]!.headers["x-canton-read-proof"]).toBeUndefined();
  });

  it("signs the host it connects to, lowercased, port included", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const calls = capture();
    await client(signer, "https://Relay.Example:8443/").balance(PARTY);
    const sig = Buffer.from(calls[0]!.headers["x-canton-read-proof"]!.split(".")[2]!, "base64url");
    const message = Buffer.from(
      `canton-x402 relay read v1\nGET\nrelay.example:8443\n/v1/wallet/${PARTY}/balance\n\n${PARTY}\n1800000000000`
    );
    expect(verify(null, message, loadPublicKey(key.publicKeySpkiB64), sig)).toBe(true);
  });

  it("signs exactly what goes on the wire: fetch re-encodes ' in the query", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const calls = capture();
    await client(signer).txAmulets(PARTY, "ab'cd").catch(() => undefined);
    const wire = new URL(calls[0]!.url);
    // what the stub got is what fetch will serialize
    expect(wire.search).toBe("?updateId=ab%27cd");
    const sig = Buffer.from(calls[0]!.headers["x-canton-read-proof"]!.split(".")[2]!, "base64url");
    const message = Buffer.from(
      `canton-x402 relay read v1\nGET\nrelay\n/v1/wallet/${PARTY}/tx-amulets\n${wire.search.slice(1)}\n${PARTY}\n1800000000000`
    );
    expect(verify(null, message, loadPublicKey(key.publicKeySpkiB64), sig)).toBe(true);
  });

  it("the signer signs only the read-proof message: no raw-message signer is exported", () => {
    expect("signMessage" in keysModule).toBe(false);
    expect("signMessage" in indexModule).toBe(false);
    // Whatever it is handed, the bytes signed start with the domain line, so the
    // result never verifies as a signature over a transaction hash.
    const hash32 = Buffer.alloc(32, 7).toString("base64");
    const sig = Buffer.from(
      signer.sign({ method: hash32, host: "h", pathname: "/", query: "", timestampMs: 1 })
    ).toString("base64");
    expect(verifyHashB64(hash32, sig, key.publicKeySpkiB64)).toBe(false);
  });

  it("has the route list the relay serves", () => {
    expect([...READ_PROOF_ROUTES].sort()).toEqual(
      ["balance", "contracts", "holdings", "holdings-scan", "outgoing", "pending", "tradecraft-updates", "tx-amulets"]
    );
  });
});
