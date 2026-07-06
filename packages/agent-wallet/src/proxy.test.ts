import { describe, it, expect, vi } from "vitest";
import {
  resolveProxyUrl,
  redactProxyUrl,
  installProxyFromEnv,
} from "./proxy.js";

describe("resolveProxyUrl", () => {
  it("returns undefined when no proxy env is set", () => {
    expect(resolveProxyUrl({})).toBeUndefined();
  });

  it("prefers HTTPS_PROXY over HTTP_PROXY and ALL_PROXY", () => {
    expect(
      resolveProxyUrl({
        HTTPS_PROXY: "http://https.example:1",
        HTTP_PROXY: "http://http.example:2",
        ALL_PROXY: "http://all.example:3",
      })
    ).toBe("http://https.example:1");
  });

  it("falls back to HTTP_PROXY then ALL_PROXY", () => {
    expect(resolveProxyUrl({ HTTP_PROXY: "http://h.example:2" })).toBe(
      "http://h.example:2"
    );
    expect(resolveProxyUrl({ ALL_PROXY: "http://a.example:3" })).toBe(
      "http://a.example:3"
    );
  });

  it("accepts lowercase variants", () => {
    expect(resolveProxyUrl({ https_proxy: "http://lc.example:4" })).toBe(
      "http://lc.example:4"
    );
  });

  it("ignores empty / whitespace-only values and trims", () => {
    expect(resolveProxyUrl({ HTTPS_PROXY: "   " })).toBeUndefined();
    expect(resolveProxyUrl({ HTTPS_PROXY: "  http://x:5  " })).toBe(
      "http://x:5"
    );
  });
});

describe("redactProxyUrl", () => {
  it("masks user:pass credentials", () => {
    const out = redactProxyUrl("http://EUWE8SF9:X0UZ0BZ4@212.134.67.44:40593");
    expect(out).not.toContain("X0UZ0BZ4");
    expect(out).not.toContain("EUWE8SF9");
    expect(out).toContain("212.134.67.44:40593");
  });

  it("leaves a credential-free URL intact", () => {
    expect(redactProxyUrl("http://proxy.example:8080/")).toBe(
      "http://proxy.example:8080/"
    );
  });

  it("falls back to regex redaction for an unparseable URL", () => {
    expect(redactProxyUrl("//user:pass@host:1")).toBe("//***@host:1");
  });
});

describe("installProxyFromEnv", () => {
  it("is a no-op and returns undefined when no proxy env is present", () => {
    const setDispatcher = vi.fn();
    const makeAgent = vi.fn();
    expect(installProxyFromEnv({}, { setDispatcher, makeAgent })).toBeUndefined();
    expect(makeAgent).not.toHaveBeenCalled();
    expect(setDispatcher).not.toHaveBeenCalled();
  });

  it("installs a dispatcher built from the proxy URL and returns the redacted URL", () => {
    const agent = { mock: "agent" } as never;
    const makeAgent = vi.fn().mockReturnValue(agent);
    const setDispatcher = vi.fn();
    const out = installProxyFromEnv(
      { HTTPS_PROXY: "http://u:p@proxy.example:3128" },
      { makeAgent, setDispatcher }
    );
    expect(makeAgent).toHaveBeenCalledWith("http://u:p@proxy.example:3128");
    expect(setDispatcher).toHaveBeenCalledWith(agent);
    // URL.toString() normalizes to include the root path; creds are masked.
    expect(out).toBe("http://***@proxy.example:3128/");
  });
});
