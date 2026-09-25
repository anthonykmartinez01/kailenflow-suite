import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { readAppData } from "../../shared/firestore-admin.mts";

// INGEST — how a Claude Code session feeds Client Management.
//
// The app is the dashboard; the session is the engine. Tools that only expose
// an MCP server (Elara) or that we'd rather not wire natively can be read
// inside a Claude session, which then POSTs a summary here.
//
// POST /api/client-ingest
//   Authorization: Bearer <CLIENT_INGEST_TOKEN>
//   {
//     source: "elara",                  // which tool this came from
//     runNote?: "nightly sync",
//     clients: [{
//       clientId?: "abc",               // exact id wins
//       match?: "Anytime Heating",      // else matched on client name
//       connected?: true,               // shows as a connected tool
//       status?: "3 pages live",        // short status line in the dashboard
//       work?: [{ at: "2026-09-24T…", text: "Published: AC Repair" }],
//       fields?: { anything: "shown as-is" }
//     }]
//   }
//
// Auth is a shared token, NOT the app login, because a session has no browser
// sign-in. Set CLIENT_INGEST_TOKEN in Netlify; keep the same value in a local
// file the session reads at call time so it never gets pasted into a chat.
//
// Writes only to the client-crm Blobs store — never to client records, never
// to any external tool.

const STORE = "client-crm";
const RECORDS = "records";
const RUNS = "ingest-runs";
const MAX_WORK_PER_SOURCE = 200;

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

export default async (req: Request, _ctx: Context) => {
  const expected = Netlify.env.get("CLIENT_INGEST_TOKEN");
  if (!expected) return json({ error: "CLIENT_INGEST_TOKEN isn't set in Netlify." }, 500);
  const auth = req.headers.get("authorization") || "";
  const given = auth.replace(/^Bearer\s+/i, "").trim();
  // Constant-time-ish: compare lengths first, then whole strings.
  if (!given || given.length !== expected.length || given !== expected) return json({ error: "Unauthorized" }, 401);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
  const source = String(body.source || "").trim().slice(0, 40);
  if (!source) return json({ error: "source is required (e.g. \"elara\")" }, 400);
  const incoming = Array.isArray(body.clients) ? body.clients : null;
  if (!incoming) return json({ error: "clients must be an array" }, 400);

  const store = getStore(STORE);
  const records = ((await store.get(RECORDS, { type: "json" }).catch(() => null)) || {}) as Record<string, any>;
  const app = await readAppData();
  const clients: any[] = app.clients || [];

  const matched: string[] = [], unmatched: string[] = [];
  for (const row of incoming) {
    let client = row.clientId ? clients.find((c) => c.id === String(row.clientId)) : null;
    if (!client && row.match) {
      const m = norm(row.match);
      client = clients.find((c) => norm(c.name) === m)
        || clients.filter((c) => norm(c.name).length > 4 && (norm(c.name).includes(m) || m.includes(norm(c.name))))[0];
    }
    if (!client) { unmatched.push(String(row.match || row.clientId || "(unnamed)")); continue; }

    const rec = records[client.id] || {};
    rec.external = rec.external || {};
    rec.external[source] = {
      at: Date.now(),
      connected: row.connected !== false,
      status: row.status ? String(row.status).slice(0, 300) : null,
      fields: row.fields && typeof row.fields === "object" ? row.fields : null,
    };
    // Work reported by a session counts toward the activity flags, kept per
    // source so a re-run replaces that source's items instead of duplicating.
    if (Array.isArray(row.work)) {
      rec.externalWork = rec.externalWork || {};
      rec.externalWork[source] = row.work
        .filter((w: any) => w && w.at && w.text)
        .slice(0, MAX_WORK_PER_SOURCE)
        .map((w: any) => ({ at: String(w.at), kind: String(w.kind || source), text: String(w.text).slice(0, 300) }));
    }
    // A tool that reports in is, by definition, connected.
    if (row.connected !== false) rec.tools = { ...(rec.tools || {}), [source]: true };
    records[client.id] = rec;
    matched.push(client.name || client.id);
  }

  await store.setJSON(RECORDS, records);
  const runs = ((await store.get(RUNS, { type: "json" }).catch(() => null)) || []) as any[];
  await store.setJSON(RUNS, [{ at: Date.now(), source, note: String(body.runNote || "").slice(0, 200), matched: matched.length, unmatched }, ...runs].slice(0, 50));

  return json({ ok: true, source, matched: matched.length, matchedNames: matched, unmatched });
};

export const config: Config = { path: "/api/client-ingest" };
