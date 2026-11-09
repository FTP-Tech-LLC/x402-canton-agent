/**
 * get_history's text: the owner's money moves as the hosted server stores them
 * (mcp_operations, the same rows /account shows).
 */
import type { OperationRecord } from "./policy.js";
import { trimDecimal } from "./amounts.js";

/** One stored operation and its time (epoch ms). */
export type HistoryRow = OperationRecord & { at: number };

/** The most rows get_history returns. */
export const HISTORY_MAX = 50;

/**
 * The host a payment went to. A pay row's detail is "<host> (HTTP <status>)".
 * Rows of a payment that failed after paying, written before the fix, carry
 * the full URL there with its query, so only the URL's host is shown.
 */
export function historyHost(row: HistoryRow): string | undefined {
  if (row.kind !== "pay") return undefined;
  const first = row.detail.split(" (")[0]?.trim() ?? "";
  if (/^https?:\/\//i.test(first)) {
    try {
      return new URL(first).host;
    } catch {
      return undefined;
    }
  }
  return /^[a-z0-9.-]+(:\d+)?$/i.test(first) ? first : undefined;
}

/** What a row says beyond its amount: for a payment its HTTP status (the rest
 *  of a pay row's detail can be a URL with keys in its query); for any other
 *  move the detail itself (the pair, the destination, why a swap was not
 *  done), on one line and cut. The owner's account page shows the same. */
function historyNote(row: HistoryRow): string | undefined {
  if (row.kind === "pay") {
    const http = /\(HTTP (\d{3})\)/.exec(row.detail);
    if (http) return `HTTP ${http[1]}`;
    return /\(failed after paying\)/.test(row.detail) ? "failed after paying" : undefined;
  }
  const d = row.detail.replace(/\s+/g, " ").trim();
  if (d === "") return undefined;
  return d.length > 160 ? `${d.slice(0, 159)}…` : d;
}

/** Fields: time, kind, amount and asset, result, host (pay only), what the
 *  row says, updateId. */
export function formatHistory(rows: readonly HistoryRow[]): string {
  if (rows.length === 0) return "No money moves yet.";
  const lines = [`${rows.length} latest operation${rows.length === 1 ? "" : "s"}, newest first:`];
  for (const r of rows) {
    const parts = [new Date(r.at).toISOString().replace(/\.\d{3}Z$/, "Z"), r.kind];
    // A payment in a token carries its own asset and amount, and the CC that
    // also moved during it, if any; a CC row has only the CC.
    const cc = r.amountCC !== undefined ? `${trimDecimal(r.amountCC.toFixed(10))} CC` : undefined;
    if (r.asset !== undefined && r.amount !== undefined) {
      parts.push(`${trimDecimal(r.amount.toFixed(10))} ${r.asset}${cc ? ` and ${cc}` : ""}`);
    } else if (cc) parts.push(cc);
    parts.push(r.ok ? "ok" : "failed");
    const host = historyHost(r);
    if (host) parts.push(`host ${host}`);
    const note = historyNote(r);
    if (note) parts.push(note);
    if (r.updateId) parts.push(`updateId ${r.updateId}`);
    lines.push(parts.join(" · "));
  }
  return lines.join("\n");
}
