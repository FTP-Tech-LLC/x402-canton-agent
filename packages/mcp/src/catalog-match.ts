/**
 * Does a URL `pay` was asked to pay fall under a service in the catalogue?
 *
 * Used when the wallet pays only catalogue services (`--allow-domains
 * catalog`, or the hosted owner's own choice). The allow-list match is by host
 * suffix; this one is stricter, because an agent misled by a web page must not
 * reach a stranger through a look-alike of a catalogued address:
 *
 *  - both URLs are parsed with `new URL()`; one that does not parse never
 *    matches;
 *  - https only, on both sides;
 *  - the host is compared after `new URL()` lowercased it and turned an
 *    internationalised name into punycode, so `bücher.example` and
 *    `xn--bcher-kva.example` are one host, and `host.` (trailing dot) is
 *    another host;
 *  - the port must be the same (none = 443);
 *  - the path must be the entry's path or go below it at a `/`: an entry
 *    `/v1/agent` covers `/v1/agent` and `/v1/agent/run`, not `/v1/agentx`.
 *    `new URL()` has already resolved `..` and `%2e%2e` segments;
 *  - query and fragment do not matter;
 *  - a target with a user name or password in it never matches.
 */
import type { CatalogEntry } from "./catalog.js";

function parse(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/** Only called on https URLs: `new URL()` drops the default port. */
const portOf = (u: URL): string => u.port || "443";

export function matchesCatalog(target: string, entries: CatalogEntry[]): boolean {
  const t = parse(target);
  if (!t || t.protocol !== "https:" || t.username !== "" || t.password !== "") return false;
  return entries.some((entry) => {
    const e = parse(entry.resource);
    if (!e || e.protocol !== "https:") return false;
    if (e.hostname !== t.hostname || portOf(e) !== portOf(t)) return false;
    if (t.pathname === e.pathname) return true;
    const below = e.pathname.endsWith("/") ? e.pathname : `${e.pathname}/`;
    return t.pathname.startsWith(below);
  });
}
