import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { getSite } from "../../shared/page-publisher/firestore.mts";

// POST /api/page-publisher-get-site {siteId} — feeds §6d's internal-linking
// intake UI (built 2026-07-23): the parent/hub picker, sibling suggestions,
// and outbound-link validation all need the site's known page list
// (siteGraph.pageIndex, already populated at connect/refresh time — Stage
// 1 work). No new backend computation here, just exposing what's already
// stored so the intake form doesn't need to re-derive it.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const { siteId } = body;
  if (!siteId) return json({ error: "siteId is required" }, 400);

  const site = await getSite(siteId);
  if (!site) return json({ error: "No site found for that siteId" }, 404);

  return json({ ok: true, pageIndex: site.siteGraph?.pageIndex || {} });
};

export const config: Config = { path: "/api/page-publisher-get-site" };
