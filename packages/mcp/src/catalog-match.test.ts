import { describe, it, expect } from "vitest";
import type { CatalogEntry } from "./catalog.js";
import { matchesCatalog } from "./catalog-match.js";

const entry = (resource: string): CatalogEntry => ({ resource, accepts: [] });
const CATALOG = [entry("https://api.example.com/v1/agent"), entry("https://xn--bcher-kva.example/search")];
const hit = (url: string): boolean => matchesCatalog(url, CATALOG);

describe("matchesCatalog", () => {
  it("matches the entry and the paths below it; query and fragment do not matter", () => {
    expect(hit("https://api.example.com/v1/agent")).toBe(true);
    expect(hit("https://api.example.com/v1/agent/")).toBe(true);
    expect(hit("https://api.example.com/v1/agent/run")).toBe(true);
    expect(hit("https://api.example.com/v1/agent?model=x#top")).toBe(true);
  });

  it("stops at a path segment boundary, after resolving dot segments", () => {
    expect(hit("https://api.example.com/v1/agentx")).toBe(false);
    expect(hit("https://api.example.com/v1/agent-admin")).toBe(false);
    expect(hit("https://api.example.com/v1")).toBe(false);
    expect(hit("https://api.example.com/v1/agent/../admin")).toBe(false);
    expect(hit("https://api.example.com/v1/agent/%2e%2e/admin")).toBe(false);
    expect(hit("https://api.example.com/v1/agent%2Fadmin")).toBe(false);
  });

  it("needs https, the same port and the same host", () => {
    expect(hit("http://api.example.com/v1/agent")).toBe(false);
    expect(hit("https://api.example.com:8443/v1/agent")).toBe(false);
    expect(hit("https://api.example.com:443/v1/agent")).toBe(true);
    expect(hit("https://API.Example.COM/v1/agent")).toBe(true);
    expect(hit("https://evil.api.example.com/v1/agent")).toBe(false);
    expect(hit("https://api.example.com.evil.test/v1/agent")).toBe(false);
    expect(hit("https://api.example.com./v1/agent")).toBe(false);
  });

  it("compares internationalised hosts as punycode", () => {
    expect(hit("https://bücher.example/search")).toBe(true);
    expect(matchesCatalog("https://xn--bcher-kva.example/search", [entry("https://bücher.example/search")])).toBe(true);
  });

  it("never matches a target with credentials, or one that is not a URL", () => {
    expect(hit("https://user:pw@api.example.com/v1/agent")).toBe(false);
    expect(hit("not a url")).toBe(false);
  });

  it("skips entries it cannot use; an empty catalogue matches nothing", () => {
    expect(matchesCatalog("http://api.example.com/x", [entry("http://api.example.com/x")])).toBe(false);
    expect(matchesCatalog("https://api.example.com/v1/agent", [entry("::nope"), entry("https://api.example.com/v1/agent")])).toBe(true);
    expect(matchesCatalog("https://api.example.com/v1/agent", [])).toBe(false);
  });

  it("an entry at the root of a host covers the whole host, on that port only", () => {
    expect(matchesCatalog("https://svc.example/any/path", [entry("https://svc.example")])).toBe(true);
    expect(matchesCatalog("https://svc.example:444/any", [entry("https://svc.example/")])).toBe(false);
  });
});
