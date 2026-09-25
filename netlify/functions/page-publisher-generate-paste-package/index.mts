import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { getPage, getSite, listImagesForPage, patchPageStatus } from "../../shared/page-publisher/firestore.mts";
import { buildPastePackage } from "../../shared/page-publisher/paste-package.mts";

// POST /api/page-publisher-generate-paste-package {pageId} — Stage 2's
// first piece (page-publisher-build-spec.md §9, revised 2026-07-23):
// builds the operator-facing paste package for a page on a MANUAL (or
// eventually Wix real-page) site. Platform-agnostic — works for any site
// whose adapter can't publish/edit directly (capabilities.autoPublish ===
// false); the schema block's applicable/notApplicableReason comes from the
// site's naGateItems (platform-limitations.mts), set once at connect time.
//
// Marks the page 'ready_to_paste' once a package has been generated —
// never regresses an already-'paste_confirmed'/'published' page back to an
// earlier status just because someone re-generates its package.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

const TERMINAL_STATUSES = new Set(["paste_confirmed", "published"]);

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const { pageId } = body;
  if (!pageId) return json({ error: "pageId is required" }, 400);

  const page = await getPage(pageId);
  if (!page) return json({ error: "No page found for that pageId" }, 404);

  const site = await getSite(page.siteId);
  if (!site) return json({ error: `Page ${pageId} references siteId ${page.siteId}, which no longer exists` }, 404);

  const images = await listImagesForPage(pageId);
  const pkg = buildPastePackage(page, images, site);

  if (!TERMINAL_STATUSES.has(page.status)) {
    // No updatedAt — same reasoning as run-gate. Generating a package is
    // inspection + bookkeeping, not a content change, and must not
    // invalidate a gate pass (per Anthony's rule that inspection stays free).
    await patchPageStatus(pageId, { status: "ready_to_paste" });
  }

  return json({ ok: true, package: pkg });
};

export const config: Config = { path: "/api/page-publisher-generate-paste-package" };
