import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { getPage, patchPageStatus, upsertPageRef, getSite } from "../../shared/page-publisher/firestore.mts";
import { assertPublishAllowed } from "../../shared/page-publisher/publish-guard.mts";

// POST /api/page-publisher-schedule-page {pageId, scheduledFor}
// — ENFORCEMENT POINT #1 (page-publisher-build-spec.md §5/§11).
//
// Refuses to set scheduledFor unless assertPublishAllowed() says the latest
// gate run passed, is acknowledged, and is NOT stale. Fail-closed: every
// non-pass path from the guard blocks, including "couldn't evaluate".
//
// scheduledFor is written with patchPageStatus (NOT patchPageContent) —
// scheduling is bookkeeping, not content, so it must not bump updatedAt and
// thereby invalidate the very gate pass that authorized it.
//
// No override parameter. Deliberately.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const { pageId, scheduledFor } = body;
  if (!pageId || !scheduledFor) return json({ error: "pageId and scheduledFor are required" }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(scheduledFor))) return json({ error: "scheduledFor must be YYYY-MM-DD" }, 400);

  // THE GATE. Everything below this line only runs on an explicit pass.
  const guard = await assertPublishAllowed(pageId);
  if (!guard.allowed) {
    return json({ ok: false, blocked: true, reason: guard.reason, gateRunAt: guard.gateRunAt, pageUpdatedAt: guard.pageUpdatedAt, stale: guard.stale }, 409);
  }

  const page = await getPage(pageId);
  if (!page) return json({ error: "No such page" }, 404);

  await patchPageStatus(pageId, { scheduledFor: String(scheduledFor), status: "scheduled" });

  // Keep the Calendar's light pointer in sync — this is the point at which a
  // page actually becomes visible on the calendar (it needs scheduledFor set).
  const site = await getSite(page.siteId).catch(() => null);
  if (site) {
    await upsertPageRef(site.clientId, { id: pageId, title: page.title, status: "scheduled", scheduledFor: String(scheduledFor), siteId: site.id });
  }

  return json({ ok: true, scheduledFor: String(scheduledFor), gateRunAt: guard.gateRunAt });
};

export const config: Config = { path: "/api/page-publisher-schedule-page" };
