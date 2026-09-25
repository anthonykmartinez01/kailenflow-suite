import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { getPage, getSite, listImagesForPage, patchPageStatus, upsertPageRef, appendLog } from "../../shared/page-publisher/firestore.mts";
import { assertPublishAllowed } from "../../shared/page-publisher/publish-guard.mts";
import { buildCommitPlan, commitPlan } from "../../shared/page-publisher/git-commit.mts";

// POST /api/page-publisher-commit-page {pageId, dryRun?: boolean}
// — ENFORCEMENT POINT #2. A commit IS a publish, so the same fail-closed
// guard that protects scheduling protects this.
//
// dryRun:true builds the ENTIRE plan — page file, schedule.ts diff, inbound
// link edits — and returns it WITHOUT touching the repo. That's the mode
// used to inspect a plan before the first real commit against a live client.
//
// ─── Order of operations (spec §1/§7) ───
//   1. Guard (skipped for dryRun — inspection must stay free, same rule as
//      the paste package; nothing is written in dry-run mode).
//   2. Idempotency check: if commitSha is already stored, STOP. A retry after
//      a partial success must not create a duplicate page or a second
//      schedule entry.
//   3. Build the plan (reads the real repo).
//   4. ONE atomic commit via the Git Trees API.
//   5. ONLY THEN mirror to Firestore. schedule.ts leads, Firestore follows —
//      never the reverse.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const { pageId } = body;
  const dryRun = body.dryRun === true;
  if (!pageId) return json({ error: "pageId is required" }, 400);

  const page = await getPage(pageId);
  if (!page) return json({ error: "No such page" }, 404);
  const site = await getSite(page.siteId);
  if (!site) return json({ error: "That page's site no longer exists" }, 404);
  if (site.platform !== "git_static") return json({ error: `Committing only applies to git_static sites (this one is "${site.platform}"). MANUAL sites use the paste package + verify-paste instead.` }, 400);

  // IDEMPOTENCY — before anything else that could duplicate work.
  if (page.commitSha && !dryRun) {
    return json({ ok: true, alreadyCommitted: true, commitSha: page.commitSha, note: "This page was already committed. Nothing re-committed — a retry must never create a duplicate page or a second schedule entry." });
  }

  // THE GATE — real commits only. Dry runs write nothing, so inspection
  // stays free (same principle as the paste package).
  if (!dryRun) {
    const guard = await assertPublishAllowed(pageId);
    if (!guard.allowed) {
      return json({ ok: false, blocked: true, reason: guard.reason, stale: guard.stale, gateRunAt: guard.gateRunAt, pageUpdatedAt: guard.pageUpdatedAt }, 409);
    }
  }

  const images = await listImagesForPage(pageId);
  const plan = await buildCommitPlan(page, images, site);
  if (!plan.ok) return json({ ok: false, error: plan.error, derived: plan.derived, warnings: plan.warnings }, 502);

  if (dryRun) {
    return json({
      ok: true, dryRun: true, committed: false,
      repo: plan.repo, branch: plan.branch,
      derived: plan.derived,
      warnings: plan.warnings,
      files: plan.files.map((f) => ({ path: f.path, kind: f.kind, note: f.note, bytes: f.content.length, content: f.content })),
      note: "NOTHING was written to the repo. This is exactly the tree a real commit would create.",
    });
  }

  const message = `Add ${page.title}${page.scheduledFor ? ` (scheduled ${page.scheduledFor})` : ""}\n\nvia KailenFlow Page Publisher`;
  const res = await commitPlan(plan, message);

  await appendLog({
    pageId, attemptedAt: Date.now(), adapter: "git_static",
    requestSummary: { files: plan.files.map((f) => f.path), branch: plan.branch, scheduledFor: page.scheduledFor },
    responseStatus: res.ok ? 200 : 502,
    responseBodyExcerpt: res.ok ? `commit ${res.commitSha}` : (res.error || null),
    outcome: res.ok ? "success" : "failure",
    errorMessage: res.ok ? null : (res.error || "unknown"),
  }).catch(() => {});

  if (!res.ok) {
    // Nothing landed — the Trees API commit is all-or-nothing by construction.
    await patchPageStatus(pageId, { status: "publish_failed" });
    return json({ ok: false, error: res.error, note: "Nothing was committed — the tree is created in one call, so a failure leaves the branch untouched." }, 502);
  }

  // Firestore mirrors AFTER the commit succeeds, never before.
  //
  // Inbound-link task statuses are persisted from the plan's per-task
  // outcomes — an edit that actually landed in this commit becomes
  // 'applied'; one that couldn't be auto-inserted becomes
  // 'manual_required' WITH the reason, so it stays visible as a real
  // outstanding task (gate actionableFindings + the paste-package reminder
  // both read status !== 'applied'). Without this the promise made at the
  // orphan gate would silently evaporate and the page would orphan anyway.
  const updatedTasks = (page.inboundLinkTasks || []).map((t) => {
    const o = plan.taskOutcomes.find((x) => x.sourceUrl === t.sourceUrl && x.anchorText === t.anchorText);
    if (!o) return t;
    return o.applied
      ? { ...t, status: "applied" as const }
      : { ...t, status: "manual_required" as const, note: o.reason || "Could not be applied automatically — add by hand.", repoPath: o.repoPath };
  });

  await patchPageStatus(pageId, { status: page.scheduledFor ? "scheduled" : "published", commitSha: res.commitSha, publishedAt: page.scheduledFor ? null : Date.now(), inboundLinkTasks: updatedTasks });
  await upsertPageRef(site.clientId, { id: pageId, title: page.title, status: page.scheduledFor ? "scheduled" : "published", scheduledFor: page.scheduledFor, siteId: site.id });

  const manualNeeded = plan.taskOutcomes.filter((o) => !o.applied);
  return json({
    ok: true, committed: true, commitSha: res.commitSha,
    files: plan.files.map((f) => f.path),
    warnings: plan.warnings,
    inboundLinksApplied: plan.taskOutcomes.filter((o) => o.applied).length,
    inboundLinksNeedingManualWork: manualNeeded,
    note: manualNeeded.length > 0
      ? `${manualNeeded.length} inbound link(s) could NOT be applied automatically and are now recorded as outstanding manual tasks on this page — add them by hand or the page stays effectively orphaned.`
      : "All inbound links were applied in the same commit.",
  });
};

export const config: Config = { path: "/api/page-publisher-commit-page" };
