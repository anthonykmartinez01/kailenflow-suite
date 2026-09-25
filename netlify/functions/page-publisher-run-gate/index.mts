import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { getPage, getSite, listImagesForPage, saveGateRun, patchPageStatus } from "../../shared/page-publisher/firestore.mts";
import { readAppData } from "../../shared/firestore-admin.mts";
import { runGate } from "../../shared/page-publisher/gate.mts";

// POST /api/page-publisher-run-gate {pageId, acknowledge?: string[]}
// — page-publisher-build-spec.md §5, Stage 3 items 5/6.
//
// Reads the cached whole-site scan (written by the scan background job)
// rather than rescanning: site-scoped facts are computed once and shared
// across every page's report (§5a), never recomputed per page.
//
// `acknowledge` carries the item IDs the operator has explicitly
// acknowledged for THIS page — that's how a site-scoped pre-existing
// problem stops standing in the way of an unrelated page without ever
// becoming an override of a real page-scoped blocker. Page-scoped
// 'blocks_page' failures cannot be acknowledged; they must be fixed.
//
// Persists a pagePublisherGateRuns doc every run (audit trail) and patches
// the page's status to 'gate_failed' / 'approved' so nothing downstream has
// to re-derive it.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const { pageId } = body;
  const acknowledge: string[] = Array.isArray(body.acknowledge) ? body.acknowledge : [];
  if (!pageId) return json({ error: "pageId is required" }, 400);

  const page = await getPage(pageId);
  if (!page) return json({ error: "No page found for that pageId" }, 404);
  const site = await getSite(page.siteId);
  if (!site) return json({ error: `Page ${pageId} references siteId ${page.siteId}, which no longer exists` }, 404);

  const images = await listImagesForPage(pageId);

  // Cached scan — may legitimately be absent (never scanned) or stale; the
  // gate reports that honestly rather than silently treating it as clean.
  let scan: any = null;
  try {
    const blob = (await getStore("pagepublisher-scans").get(`scan:${site.id}`, { type: "json" })) as any;
    if (blob?.status === "done") scan = blob.scan || null;
  } catch { /* no scan available — gate reports site items as unverifiable */ }

  // Client record supplies gscProperty for l1.crawl.gsc_verification —
  // reusing the existing GSC integration rather than building a second one.
  let clientRecord: any = null;
  try {
    const data = await readAppData();
    clientRecord = (data.clients || []).find((c: any) => c.id === site.clientId) || null;
  } catch { /* gate reports gsc_verification as failed rather than crashing */ }

  const result = runGate(page, images, site, scan, clientRecord);

  // Acknowledgment applies ONLY to site-scoped items. A page-scoped blocker
  // is never acknowledgeable — that's the no-override rule.
  const ackSet = new Set(acknowledge);
  const stillNeedingAck = result.acknowledgmentRequired.filter((o) => !ackSet.has(o.itemId));
  const acknowledged = result.acknowledgmentRequired.filter((o) => ackSet.has(o.itemId));

  // Publish-readiness = no page-scoped blockers AND every site-scoped
  // finding explicitly acknowledged for this page.
  const readyToPublish = result.blockingFailures.length === 0 && stillNeedingAck.length === 0;

  await saveGateRun({
    pageId,
    runAt: result.runAt,
    layer1Results: [...result.blockingFailures, ...result.acknowledgmentRequired, ...result.warnings, ...result.passed, ...result.unverifiable, ...result.notImplemented]
      .filter((o) => o.layer === 1)
      .map((o) => ({ itemId: o.itemId, result: o.result, evidence: o.evidence })),
    layer2Results: [...result.blockingFailures, ...result.acknowledgmentRequired, ...result.warnings, ...result.passed, ...result.unverifiable, ...result.notImplemented]
      .filter((o) => o.layer === 2)
      .map((o) => ({ itemId: o.itemId, result: o.result, evidence: o.evidence })),
    blockingFailures: result.blockingFailures.map((o) => o.itemId),
    warnings: result.warnings.map((o) => o.itemId),
    overall: result.overall,
    gateVersion: result.gateVersion,
    // Persisted so the publish guard can verify acknowledgment, not just
    // the absence of page-scoped blockers.
    readyToPublish,
    acknowledgedItems: acknowledged.map((o) => o.itemId),
    unacknowledgedItems: stillNeedingAck.map((o) => o.itemId),
  });

  // Only move a draft-ish page's status — never regress something already
  // published/confirmed just because a gate was re-run against it.
  const TERMINAL = new Set(["published", "paste_confirmed"]);
  if (!TERMINAL.has(page.status)) {
    // NO updatedAt here — deliberately. Bumping it would make every gate run
    // invalidate its own pass a few milliseconds later (runAt < updatedAt),
    // so no page could ever be schedulable. Caught live 2026-07-26 when the
    // first real schedule attempt was refused as stale by 91ms. Status is
    // bookkeeping; only content changes bump updatedAt (see firestore.mts's
    // patchPageContent vs patchPageStatus).
    await patchPageStatus(pageId, { status: readyToPublish ? "approved" : "gate_failed" });
  }

  return json({
    ok: true,
    readyToPublish,
    ...result,
    acknowledgedNow: acknowledged.map((o) => o.itemId),
    stillNeedingAcknowledgment: stillNeedingAck,
  });
};

export const config: Config = { path: "/api/page-publisher-run-gate" };
