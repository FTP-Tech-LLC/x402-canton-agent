/**
 * Proxy support for the CLI's outbound HTTP.
 *
 * Node's global `fetch` (undici) does NOT honor the conventional
 * HTTP_PROXY/HTTPS_PROXY environment variables on its own — unlike curl/git.
 * An agent running behind a corporate or regional proxy therefore sees every
 * relay call fail with an opaque `fetch failed`, even after exporting
 * HTTP_PROXY, because the request still goes out directly.
 *
 * We close that gap by installing an undici `ProxyAgent` as the global
 * dispatcher whenever a proxy env var is present, so `fetch` (and thus every
 * RelayClient call) is tunneled through it. No proxy env -> no-op, direct
 * connections are unaffected.
 */
import { ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";

/**
 * Pick the proxy URL from the conventional env vars, same precedence as curl:
 * explicit HTTPS_PROXY/HTTP_PROXY (either case) win over the catch-all
 * ALL_PROXY. Returns undefined when none is set.
 */
export function resolveProxyUrl(env: NodeJS.ProcessEnv): string | undefined {
  const pick = (...names: string[]): string | undefined => {
    for (const n of names) {
      const v = env[n];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
    return undefined;
  };
  return pick(
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy"
  );
}

/**
 * Mask any `user:pass@` credentials in a proxy URL so it is safe to log.
 * Falls back to a regex redaction if the URL does not parse.
 */
export function redactProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "***";
      u.password = "";
    }
    return u.toString();
  } catch {
    return url.replace(/\/\/[^/@]*@/, "//***@");
  }
}

/** Injectable seams so tests can assert behavior without mutating the
 *  process-global dispatcher. Production calls leave these unset. */
export interface InstallProxyDeps {
  makeAgent?: (url: string) => Dispatcher;
  setDispatcher?: (d: Dispatcher) => void;
}

/**
 * If a proxy env var is set, route all global `fetch` through it and return the
 * REDACTED proxy URL (for logging). Returns undefined and touches nothing when
 * no proxy env is present, so direct connections stay direct.
 */
export function installProxyFromEnv(
  env: NodeJS.ProcessEnv,
  deps: InstallProxyDeps = {}
): string | undefined {
  const url = resolveProxyUrl(env);
  if (!url) return undefined;
  const makeAgent = deps.makeAgent ?? ((u: string) => new ProxyAgent(u));
  const setDispatcher =
    deps.setDispatcher ?? ((d: Dispatcher) => setGlobalDispatcher(d));
  setDispatcher(makeAgent(url));
  return redactProxyUrl(url);
}
