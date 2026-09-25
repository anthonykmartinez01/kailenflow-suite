// Merging session-reported client data into Client Management records.
// Pure (no I/O) so scripts/test-client-ingest-merge.mjs can prove the matching
// and the replace-not-duplicate behaviour.
//
// Used by BOTH ingest paths:
//   • ops/client-ingest/*.json committed to the repo (no token needed), and
//   • POST /api/client-ingest (kept for anything that can't commit).

export type IngestRow = {
  clientId?: string;
  match?: string;                      // business name, when the id isn't known
  connected?: boolean;
  status?: string;
  work?: { at: string; text: string; url?: string; kind?: string }[];
  fields?: Record<string, any>;
};

export type ClientLite = { id: string; name?: string };

const MAX_WORK_PER_SOURCE = 200;
const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Exact id wins; then exact name; then a SINGLE partial match. Never a guess. */
export function matchClientId(row: IngestRow, clients: ClientLite[]): string | null {
  if (row.clientId && clients.some((c) => c.id === String(row.clientId))) return String(row.clientId);
  const m = norm(row.match || "");
  if (!m) return null;
  const exact = clients.find((c) => norm(c.name || "") === m);
  if (exact) return exact.id;
  const partial = clients.filter((c) => {
    const n = norm(c.name || "");
    return n.length > 4 && (n.includes(m) || m.includes(n));
  });
  // Two plausible matches means we don't know — report it instead of picking.
  return partial.length === 1 ? partial[0].id : null;
}

/**
 * Applies one source's rows onto the records map (mutates and returns it).
 * Re-running REPLACES that source's work for each client rather than appending,
 * so a nightly sync can't multiply the same items.
 */
export function applyIngest(
  records: Record<string, any>,
  clients: ClientLite[],
  source: string,
  rows: IngestRow[],
  nowMs = Date.now(),
) {
  const matched: string[] = [], unmatched: string[] = [];
  for (const row of rows || []) {
    const id = matchClientId(row || {}, clients);
    if (!id) { unmatched.push(String(row?.match || row?.clientId || "(unnamed)")); continue; }
    const rec = records[id] || {};
    rec.external = rec.external || {};
    rec.external[source] = {
      at: nowMs,
      connected: row.connected !== false,
      status: row.status ? String(row.status).slice(0, 300) : null,
      fields: row.fields && typeof row.fields === "object" ? row.fields : null,
    };
    if (Array.isArray(row.work)) {
      rec.externalWork = rec.externalWork || {};
      rec.externalWork[source] = row.work
        .filter((w) => w && w.at && w.text && Number.isFinite(Date.parse(w.at)))
        .slice(0, MAX_WORK_PER_SOURCE)
        .map((w) => ({ at: new Date(w.at).toISOString(), kind: String(w.kind || source), text: String(w.text).slice(0, 300), ...(w.url ? { url: String(w.url) } : {}) }));
    }
    if (row.connected !== false) rec.tools = { ...(rec.tools || {}), [source]: true };
    records[id] = rec;
    matched.push(id);
  }
  return { records, matched, unmatched };
}
