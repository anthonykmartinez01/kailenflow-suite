import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { readAppData } from "../../shared/firestore-admin.mts";
import { applyIngest } from "../../shared/client-ingest-merge.mts";

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

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}


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

  // Same merge logic as the repo-file path (shared/client-ingest-merge.mts).
  const { matched, unmatched } = applyIngest(records, clients.map((c: any) => ({ id: c.id, name: c.name })), source, incoming);

  await store.setJSON(RECORDS, records);
  const runs = ((await store.get(RUNS, { type: "json" }).catch(() => null)) || []) as any[];
  await store.setJSON(RUNS, [{ at: Date.now(), source, note: String(body.runNote || "").slice(0, 200), matched: matched.length, unmatched }, ...runs].slice(0, 50));

  return json({ ok: true, source, matched: matched.length, matchedNames: matched, unmatched });
};

export const config: Config = { path: "/api/client-ingest" };
