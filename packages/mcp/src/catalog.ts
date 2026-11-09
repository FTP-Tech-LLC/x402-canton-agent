/**
 * The facilitator's catalogue of paid APIs (`GET /discovery/resources`) and
 * the symbols of its instruments (`GET /supported`), each behind a per-process
 * cache.
 *
 * The hosted server builds a fresh McpServer for every request, so the caches
 * are made once per process (createApp, createServer): fresh for 5 minutes,
 * one refresh at a time, 5 seconds for the facilitator to answer. A failed
 * refresh keeps the last good copy and is retried after 30 seconds, not on
 * every call (and reported to `onError` when given). `undefined` means it
 * never loaded.
 */

/** One payable resource, as the facilitator lists it. */
export interface CatalogEntry {
  resource: string;
  type?: string;
  description?: string;
  method?: string;
  accepts: Array<{
    scheme?: string;
    network?: string;
    amount?: string;
    payTo?: string;
    asset?: string;
    extra?: { instrumentId?: { admin: string; id: string } } & Record<string, unknown>;
  }>;
  metadata?: Record<string, unknown>;
}

export interface CatalogCache {
  /** The catalogue; the last good copy when a refresh fails; undefined = never loaded. */
  get(): Promise<CatalogEntry[] | undefined>;
}

/** `<admin>|<id>` → the symbol the facilitator gives that instrument. */
export interface InstrumentSymbols {
  get(): Promise<ReadonlyMap<string, string> | undefined>;
}

export interface CacheOpts {
  url: string;
  fetch?: typeof globalThis.fetch;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  /** Told about every failed refresh (the last good copy is still served).
   *  For a log line; anything it throws is ignored. */
  onError?: (err: unknown) => void;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const RETRY_AFTER_FAILURE_MS = 30_000;
/** The facilitator's own maximum page size. */
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

function ttlCache<T>(load: (signal: AbortSignal) => Promise<T>, o: CacheOpts): { get(): Promise<T | undefined> } {
  const ttlMs = o.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = o.now ?? Date.now;
  let value: T | undefined;
  let freshUntil = -Infinity;
  let inflight: Promise<void> | undefined;
  const refresh = async (): Promise<void> => {
    try {
      value = await load(AbortSignal.timeout(timeoutMs));
      freshUntil = now() + ttlMs;
    } catch (err) {
      // Keep the last good copy; try again after a short pause.
      freshUntil = now() + Math.min(ttlMs, RETRY_AFTER_FAILURE_MS);
      try {
        o.onError?.(err);
      } catch {
        // A broken logger never breaks the cache.
      }
    }
  };
  return {
    async get() {
      if (now() < freshUntil) return value;
      inflight ??= refresh().finally(() => {
        inflight = undefined;
      });
      await inflight;
      return value;
    },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

/** The URL to ask, with doubled slashes in the path folded (a relay URL may
 *  end in "/"). */
function requestUrl(url: string, params: Record<string, string> = {}): string {
  const u = new URL(url);
  u.pathname = u.pathname.replace(/\/{2,}/g, "/");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.href;
}

async function getJson(doFetch: typeof globalThis.fetch, url: string, signal: AbortSignal): Promise<unknown> {
  const res = await doFetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function toEntry(item: unknown): CatalogEntry | undefined {
  if (!isRecord(item) || typeof item.resource !== "string" || !Array.isArray(item.accepts)) return undefined;
  const metadata = isRecord(item.metadata) ? item.metadata : undefined;
  const type = str(item.type);
  const description = str(item.description) ?? str(metadata?.description);
  const method = str(item.method) ?? str(metadata?.method);
  return {
    resource: item.resource,
    ...(type ? { type } : {}),
    ...(description ? { description } : {}),
    ...(method ? { method } : {}),
    accepts: item.accepts.filter(isRecord) as CatalogEntry["accepts"],
    ...(metadata ? { metadata } : {}),
  };
}

/** The catalogue at `opts.url` (`<relay>/discovery/resources`). */
export function createCatalogCache(opts: CacheOpts): CatalogCache {
  const doFetch: typeof globalThis.fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return ttlCache(async (signal) => {
    const entries: CatalogEntry[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await getJson(
        doFetch,
        requestUrl(opts.url, { limit: String(PAGE_SIZE), offset: String(offset) }),
        signal
      );
      if (!isRecord(body) || !Array.isArray(body.items)) throw new Error("catalogue: the answer has no items");
      for (const item of body.items) {
        const e = toEntry(item);
        if (e) entries.push(e);
      }
      offset += body.items.length;
      const total =
        isRecord(body.pagination) && typeof body.pagination.total === "number" ? body.pagination.total : offset;
      if (body.items.length === 0 || offset >= total) break;
    }
    return entries;
  }, opts);
}

/** The instrument symbols at `opts.url` (`<relay>/supported`). */
export function createInstrumentSymbols(opts: CacheOpts): InstrumentSymbols {
  const doFetch: typeof globalThis.fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return ttlCache(async (signal) => {
    const body = await getJson(doFetch, requestUrl(opts.url), signal);
    const map = new Map<string, string>();
    const kinds = isRecord(body) && Array.isArray(body.kinds) ? body.kinds : [];
    for (const k of kinds) {
      const list = isRecord(k) && isRecord(k.extra) && Array.isArray(k.extra.instruments) ? k.extra.instruments : [];
      for (const ins of list) {
        if (!isRecord(ins) || !isRecord(ins.instrumentId)) continue;
        const { admin, id } = ins.instrumentId;
        if (typeof admin === "string" && typeof id === "string" && typeof ins.symbol === "string") {
          map.set(`${admin}|${id}`, ins.symbol);
        }
      }
    }
    return map;
  }, opts);
}
