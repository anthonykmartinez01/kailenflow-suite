import type { Context, Config } from "@netlify/functions";
import { readAppData, mutateAppData } from "../../shared/firestore-admin.mts";
import { checkPageIndexed } from "../../shared/indexing.mts";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

// The client Indexing tab's "Recheck now" button (public/index.html,
// ClientIndexingTab) — an on-demand version of check-indexed-status' daily
// sweep for a single page, split into its own function because Netlify
// forbids a scheduled function from also declaring a custom path. Bypasses
// the sweep's confirmed/MAX_CHECK_ATTEMPTS skip so a human asking
// explicitly always gets a fresh answer, not a cached skip reason.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const { clientId, path } = body;
  if (!clientId || !path) return json({ error: "clientId and path are required" }, 400);

  const data = await readAppData();
  const result = await checkPageIndexed(data, clientId, path);
  if (!result.ok) return json({ error: result.error }, 400);

  await mutateAppData((fresh: any) => {
    const c = (fresh.clients || []).find((x: any) => x.id === clientId);
    if (!c?.publishing?.indexHistory?.[path]) return false;
    c.publishing.indexHistory[path] = { ...c.publishing.indexHistory[path], ...result.patch };
  });
  return json({ ok: true, ...result.patch });
};

export const config: Config = { path: "/api/recheck-indexing" };
