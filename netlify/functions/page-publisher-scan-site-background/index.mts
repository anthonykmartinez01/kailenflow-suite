import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { isAuthed } from "../../shared/auth.mts";
import { getSite, patchSite, replaceSiteGraph } from "../../shared/page-publisher/firestore.mts";
import { scanSite, runLiveHostChecks } from "../../shared/page-publisher/site-scan.mts";

// Background function ("-background" suffix → Netlify runs it async with a
// 15-minute ceiling instead of the normal ~10s request limit), following the
// exact convention already used by call-coach-analyze-background. That's
// what makes scanning a real multi-hundred-page site possible at all; a
// synchronous function would time out and — worse — could leave a partial
// graph behind, which is precisely what this design forbids.
//
// Progress/result is written to Netlify Blobs and polled via
// /api/page-publisher-scan-status?siteId=... (same store-and-poll shape as
// the call-coach flow).
//
// ATOMICITY (page-publisher-build-spec.md §5a, Anthony's explicit
// constraint): siteGraph.linkGraph/schemaGraph are ONLY written when the
// scan completes with zero skipped pages. An incomplete scan updates the
// status blob so the operator can see what happened, and leaves the
// previously-good graph untouched rather than degrading it.
//
// liveHostChecks are written independently of graph completeness — they're
// separate facts about the host, not derived from the page set, so a failed
// content scan shouldn't discard perfectly good host results.

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return; // 202 was already returned to the caller

  const body = await req.json().catch(() => ({} as any));
  const siteId = (body.siteId || "").toString();
  if (!siteId) return;

  const store = getStore("pagepublisher-scans");
  const key = `scan:${siteId}`;

  try {
    await store.setJSON(key, { status: "running", startedAt: Date.now() });

    const site = await getSite(siteId);
    if (!site) {
      await store.setJSON(key, { status: "error", error: "Site not found", at: Date.now() });
      return;
    }

    const [scan, hostChecks] = await Promise.all([
      scanSite(site),
      runLiveHostChecks(site.domain).catch((e) => ({ error: String(e?.message || e) } as any)),
    ]);

    if (!hostChecks.error) {
      await patchSite(siteId, { liveHostChecks: hostChecks });
    }

    if (scan.complete) {
      // Write REAL page titles back into pageIndex. Connect/refresh can only
      // guess a title from the file path (titleFromPath is explicitly a
      // placeholder — "we know this URL exists, not what it says"), which
      // made every index.astro come out as "Index" and produced a bogus
      // duplicate-title finding on Rankin Waste. The scan has each page's
      // actual <title>/frontmatter title, so it's the right place to
      // correct them.
      const pageIndex = { ...(site.siteGraph?.pageIndex || {}) };
      for (const r of scan.results) {
        if (r.linkStatus === "skipped" || !r.title) continue;
        if (pageIndex[r.url]) pageIndex[r.url] = { ...pageIndex[r.url], title: r.title };
      }
      // replaceSiteGraph (not patchSite) so keys for pages that no longer
      // exist are actually dropped rather than deep-merged forever.
      await replaceSiteGraph(siteId, {
        ...(site.siteGraph || {}),
        updatedAt: scan.scannedAt,
        pageIndex,
        linkGraph: scan.linkGraph,
        schemaGraph: scan.schemaGraph,
      } as any);
    }

    await store.setJSON(key, {
      status: "done",
      at: Date.now(),
      // Deliberately explicit about whether the graph was actually
      // persisted — "scan finished" and "graph updated" are different facts
      // and conflating them is how a partial graph would sneak through.
      graphPersisted: scan.complete,
      scan: {
        complete: scan.complete,
        degraded: scan.degraded,
        incompleteReason: scan.incompleteReason || null,
        degradedReason: scan.degradedReason || null,
        scannedAt: scan.scannedAt,
        pagesTotal: scan.pagesTotal,
        pagesResolved: scan.pagesResolved,
        pagesUnverifiable: scan.pagesUnverifiable,
        pagesSkipped: scan.pagesSkipped,
        liveFetchAttempts: scan.liveFetchAttempts,
        liveFetchFailures: scan.liveFetchFailures,
        // Definitive orphans only — empty when degraded, by design.
        orphans: scan.orphans,
        // Never conflated with real orphans: zero inbound, but something
        // else in the scan was unverifiable so this can't be trusted.
        unverifiableOrphans: scan.unverifiableOrphans,
        orphanStatus: scan.orphanStatus,
        inboundCounts: scan.inboundCounts,
        unresolvedHrefTotal: scan.unresolvedHrefTotal,
        notResolved: scan.results
          .filter((r) => r.linkStatus !== "resolved")
          .map((r) => ({ url: r.url, linkStatus: r.linkStatus, reason: r.statusReason })),
        liveResolvedPages: scan.results.filter((r) => r.liveResolved).map((r) => r.url),
        // Site-level head sample — the gate reads this for lang/viewport/
        // favicon/SPA/OG checks without any per-gate-run network calls.
        siteHead: scan.siteHead,
        schemaTypesByPage: Object.fromEntries(scan.results.filter((r) => r.linkStatus !== "skipped").map((r) => [r.url, r.schemaTypes])),
        allSchemaIds: [...new Set(scan.results.flatMap((r) => r.schemaIds))],
      },
      liveHostChecks: hostChecks.error ? { error: hostChecks.error } : hostChecks,
    });
  } catch (e: any) {
    await store.setJSON(key, { status: "error", error: "Scan failed: " + String(e?.message ?? e), at: Date.now() });
  }
};
