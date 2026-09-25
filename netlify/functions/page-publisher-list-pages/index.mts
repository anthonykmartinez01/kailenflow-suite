import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { listPagesBySite } from "../../shared/page-publisher/firestore.mts";

// POST /api/page-publisher-list-pages {siteId} — minimal list view for the
// intake UI's "Pages" panel. Full page records (htmlBody, schemaJsonLd
// etc.) are fetched individually where needed (generate-paste-package,
// verify-paste) — this only returns what a list row needs.

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

  const pages = await listPagesBySite(siteId);
  return json({
    ok: true,
    pages: pages
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((p) => ({ id: p.id, title: p.title, slug: p.slug, status: p.status, pageType: p.pageType, updatedAt: p.updatedAt, createdAt: p.createdAt, parentUrl: p.parentUrl, parentAcknowledgedMissing: p.parentAcknowledgedMissing, inboundLinkCount: (p.inboundLinkTasks || []).length })),
  });
};

export const config: Config = { path: "/api/page-publisher-list-pages" };
