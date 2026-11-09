/**
 * find_paid_apis's text: the catalogue filtered, with a price per call.
 * Catalogue text is the operator's, but it is still flattened to one line per
 * field and cut, so an entry cannot fake another entry or a new instruction.
 */
import { atomicToDecimalCC } from "@ftptech/x402-canton-core";
import type { CatalogEntry } from "./catalog.js";
import { trimDecimal } from "./amounts.js";

/** At most this many entries in one answer. */
export const MAX_LISTED = 25;

type Accept = CatalogEntry["accepts"][number];

const clean = (s: string, max: number): string => {
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function titleOf(e: CatalogEntry): string {
  return str(e.metadata?.title) ?? str(e.metadata?.name) ?? hostOf(e.resource);
}

function tagsOf(e: CatalogEntry): string[] {
  const tags = e.metadata?.tags;
  return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [];
}

/** CC for Canton Coin; for a token the symbol /supported gives it, or its id. */
function symbolOf(a: Accept, symbols?: ReadonlyMap<string, string>): string {
  const ins = a.extra?.instrumentId;
  if (ins && typeof ins.admin === "string" && typeof ins.id === "string") {
    if (ins.id === "Amulet") return "CC";
    return symbols?.get(`${ins.admin}|${ins.id}`) ?? ins.id;
  }
  if (a.asset === undefined || a.asset === "CC" || a.asset.endsWith("::Amulet")) return "CC";
  return a.asset.split("::").pop() ?? a.asset;
}

/** "0.25 CC" from an accepts entry (scale 10 for CC and every CIP-56 token);
 *  undefined when its amount is not an atomic integer. */
export function priceOf(a: Accept, symbols?: ReadonlyMap<string, string>): string | undefined {
  if (typeof a.amount !== "string") return undefined;
  try {
    return `${trimDecimal(atomicToDecimalCC(a.amount))} ${symbolOf(a, symbols)}`;
  } catch {
    return undefined;
  }
}

/**
 * How to call an entry, from the operator's `metadata.example` and
 * `metadata.inputSchema`. An API takes the payment before it reads the
 * request, so a call an agent gets wrong (no query, a body in the wrong shape)
 * is still paid; these lines are what it needs to get it right the first time.
 */
function callLines(e: CatalogEntry): string[] {
  const m = e.metadata ?? {};
  const ex = typeof m.example === "object" && m.example !== null ? (m.example as Record<string, unknown>) : {};
  const lines: string[] = [];
  // A query or body is shown whole or not at all: a cut one is not a request
  // an API accepts.
  if (typeof ex.query === "string" && ex.query.trim() !== "") {
    const q = clean(ex.query.replace(/^\?/, ""), 1000);
    lines.push(q.length <= 200 ? `   query: ?${q}` : "   query: too long to show here");
  }
  if (ex.body !== undefined) {
    const b = clean(JSON.stringify(ex.body), 1000);
    const keys = typeof ex.body === "object" && ex.body !== null && !Array.isArray(ex.body) ? Object.keys(ex.body) : [];
    lines.push(
      b.length <= 300
        ? `   body (JSON): ${b}`
        : `   body (JSON): too long to show here${keys.length ? `; its fields: ${clean(keys.join(", "), 200)}` : ""}`
    );
  }
  const fields = schemaFields(m.inputSchema);
  if (fields.length > 0) lines.push(`   fields: ${clean(fields.join("; "), 300)}`);
  if (typeof ex.note === "string" && ex.note.trim() !== "") lines.push(`   note: ${clean(ex.note, 200)}`);
  return lines;
}

/** The fields of an inputSchema: a JSON Schema's properties (type, required,
 *  description), or the catalogue's plain map of field to description. */
function schemaFields(schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return [];
  const o = schema as Record<string, unknown>;
  if (typeof o.properties === "object" && o.properties !== null && !Array.isArray(o.properties)) {
    const required = Array.isArray(o.required) ? o.required.filter((x): x is string => typeof x === "string") : [];
    return Object.entries(o.properties as Record<string, unknown>).map(([k, v]) => {
      const p = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
      const bits = [
        typeof p.type === "string" ? p.type : undefined,
        required.includes(k) ? "required" : undefined,
        typeof p.description === "string" ? p.description : undefined,
      ].filter((x): x is string => x !== undefined);
      return bits.length ? `${k} (${bits.join(", ")})` : k;
    });
  }
  return Object.entries(o)
    .filter((f): f is [string, string] => typeof f[1] === "string" && !f[0].startsWith("$"))
    .map(([k, v]) => `${k} (${v})`);
}

export interface CatalogFilter {
  /** Words that must all appear in the URL, title, description or tags. */
  query?: string | undefined;
  /** The resource type, e.g. "http" (an entry without one is "http"). */
  type?: string | undefined;
  symbols?: ReadonlyMap<string, string> | undefined;
}

export function formatCatalog(entries: readonly CatalogEntry[], f: CatalogFilter = {}): string {
  if (entries.length === 0) return "The catalogue is empty right now.";
  const words = (f.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const hits = entries.filter((e) => {
    if (f.type !== undefined && (e.type ?? "http") !== f.type) return false;
    const hay = [e.resource, titleOf(e), e.description ?? "", ...tagsOf(e)].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  if (hits.length === 0) {
    return (
      `No catalogue entry matches. ${entries.length} ${entries.length === 1 ? "entry is" : "entries are"} ` +
      "listed in total; call find_paid_apis without filters to see them."
    );
  }
  const lines = [
    `${hits.length} paid API${hits.length === 1 ? "" : "s"} in the catalogue. Prices are per call; ` +
      "the API's 402 answer sets the final price, and pay refuses anything above your limits. " +
      "Call each one as its lines below say: the API takes the payment before it reads the request, so a wrong call is still paid.",
  ];
  hits.slice(0, MAX_LISTED).forEach((e, i) => {
    const prices = [...new Set(e.accepts.map((a) => priceOf(a, f.symbols)).filter((p): p is string => p !== undefined))];
    // The catalogue flags an API whose price depends on the request (e.g. an
    // LLM priced by tokens): its listed amount is only where the price starts.
    const dyn = e.metadata?.priceDynamic === true;
    const method = e.method ? `${clean(e.method, 10).toUpperCase()} ` : "";
    lines.push(
      "",
      `${i + 1}. ${clean(titleOf(e), 120)}`,
      `   ${method}${clean(e.resource, 300)}`,
      `   price: ${
        prices.length
          ? dyn
            ? `from ${prices.join(" or ")} (depends on the request; the 402 sets it)`
            : prices.join(" or ")
          : "set by its 402 answer"
      }`
    );
    if (e.description) lines.push(`   ${clean(e.description, 300)}`);
    lines.push(...callLines(e));
  });
  if (hits.length > MAX_LISTED) lines.push("", `${hits.length - MAX_LISTED} more; narrow the list with query.`);
  return lines.join("\n");
}
