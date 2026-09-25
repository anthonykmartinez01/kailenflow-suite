import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { readAppData } from "../../shared/firestore-admin.mts";
import { savePage, getSiteByClientId, listPagesBySite } from "../../shared/page-publisher/firestore.mts";

// Same server-to-server pattern as submit-indexing.mts — this is a one-time
// operational migration, not a frontend-triggered action, so it has no
// signed-in "suite user" to authenticate as.
function isAutomationRequest(req: Request): boolean {
  const key = req.headers.get("x-automation-key");
  const expected = Netlify.env.get("AUTOMATION_API_KEY");
  return !!key && !!expected && key === expected;
}

// POST /api/page-publisher-migrate-scheduled-pages {dryRun?:boolean} —
// page-publisher-build-spec.md §9 Stage 1's ScheduledPages retirement.
// Confirmed in the live code that data.scheduledPages[]'s own auto-publish
// was never built ("TEMPORARY manual status toggle... before the auto-
// publish robot (FUTURE STEP 1) is built" — see ScheduledPages' toggleStatus
// in public/index.html) — it's an intake queue with no working back half,
// absorbed and replaced by Page Publisher rather than run alongside it.
//
// Returns the RAW data.scheduledPages[] array in the response (for the
// caller to write to a backup file BEFORE anything else touches it — per
// Anthony's explicit request, this function does not write that backup
// itself; it has no reason to hold repo-write access to kailenflow-suite's
// own hosting repo, unlike the client-repo GIT_STATIC work elsewhere) plus
// exactly what migrated (count + titles) for a real eyeball check.
//
// Idempotent: an entry already migrated (a pagePublisherPages doc exists
// with migratedFromScheduledPageId matching its id) is skipped, not
// duplicated, on a second run. dryRun:true previews without writing anything.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req)) && !isAutomationRequest(req)) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is fine, defaults to a real (non-dry) run */ }
  const dryRun = body.dryRun === true;

  const data = await readAppData();
  const scheduledPages: any[] = data.scheduledPages || [];
  const clients: any[] = data.clients || [];

  const results: { id: string; title: string; clientName: string; status: "migrated" | "already_migrated" | "skipped_no_client" | "skipped_no_site" }[] = [];

  for (const sp of scheduledPages) {
    const client = clients.find((c: any) => c.id === sp.clientId);
    if (!client) { results.push({ id: sp.id, title: sp.title, clientName: "(client removed)", status: "skipped_no_client" }); continue; }

    // A pagePublisherSites doc isn't required to exist yet for this specific
    // migration step (draft pages can sit unassigned to a site until Stage 2
    // connects one) — siteId is attached when a site is connected, not a
    // precondition for migrating the draft content itself. Left null if none.
    const site = await getSiteByClientId(client.id).catch(() => null);

    if (!dryRun) {
      const existing = await listPagesBySite(site?.id || "__unassigned__").catch(() => []);
      if (existing.some((p) => p.migratedFromScheduledPageId === sp.id)) {
        results.push({ id: sp.id, title: sp.title, clientName: client.name, status: "already_migrated" });
        continue;
      }
      const now = Date.now();
      await savePage({
        siteId: site?.id || "__unassigned__",
        clientId: client.id,
        title: sp.title || "(untitled)",
        slug: (sp.fileName || "").replace(/\.[^.]+$/, "") || "",
        htmlBody: sp.contentType === "link" ? "" : (sp.content || ""),
        metaDescription: "",
        canonicalUrl: null,
        schemaJsonLd: null,
        ogTags: {},
        pageType: "other",
        status: "draft",
        scheduledFor: sp.goLiveDate || null,
        publishedAt: null,
        publishedUrl: null,
        commitSha: null,
        parentUrl: null,
        parentAcknowledgedMissing: false,
        internalLinks: [],
        inboundLinkTasks: [],
        createdAt: sp.createdAt ? Date.parse(sp.createdAt) || now : now,
        updatedAt: now,
        migratedFromScheduledPageId: sp.id,
      });
      results.push({ id: sp.id, title: sp.title, clientName: client.name, status: "migrated" });
    } else {
      results.push({ id: sp.id, title: sp.title, clientName: client.name, status: site ? "migrated" : "skipped_no_site" });
    }
  }

  return json({
    ok: true,
    dryRun,
    totalSource: scheduledPages.length,
    migratedCount: results.filter((r) => r.status === "migrated").length,
    alreadyMigratedCount: results.filter((r) => r.status === "already_migrated").length,
    results,
    // Raw source data — the caller writes this to a backup file before any
    // later step touches/removes the ScheduledPages component or array.
    scheduledPagesRaw: scheduledPages,
  });
};

export const config: Config = { path: "/api/page-publisher-migrate-scheduled-pages" };
