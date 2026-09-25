// THE publish precondition. Every enforcement point calls this — none
// reimplements it — so "gate must pass" can't drift between call sites.
//
// ─── FAIL-CLOSED, without exception ───
// Anthony's rule (2026-07-26): "if the gate can't run at an enforcement
// point — scan data missing, endpoint errors, whatever — that's a block,
// not a pass. An enforcement point that fails open is worse than none,
// because it looks safe."
//
// So EVERY path out of this function that isn't an explicit, verified pass
// returns allowed:false. There is no catch block that swallows an error into
// a permissive default, and no optional-chaining shortcut that turns missing
// data into a truthy pass. When in doubt: blocked.
//
// ─── NO OVERRIDE ───
// There is deliberately no force/skip/override parameter. If a page can't
// pass, the fix is to fix the page. Adding one later would silently undo
// every guarantee in this module — the whole reason site-scoped findings use
// per-page acknowledgment (which run-gate handles) rather than blocking is so
// an override never becomes tempting.
//
// ─── STALENESS ───
// A gate pass is only valid for the exact page content it evaluated:
// gateRun.runAt must be > page.updatedAt. patchPageContent bumps updatedAt
// on any gate-relevant edit (body, meta, slug, schema, images, alt text,
// links, parent); patchPageStatus deliberately does not (see firestore.mts).
import { getPage, latestGateRunForPage, type PagePublisherPage, type PagePublisherGateRun } from "./firestore.mts";

export interface GuardResult {
  allowed: boolean;
  reason: string;
  // Present only when a gate run was actually found — useful for logs and
  // for telling "never gated" apart from "gated and failed".
  gateRunAt?: number;
  pageUpdatedAt?: number;
  stale?: boolean;
}

const BLOCK = (reason: string, extra: Partial<GuardResult> = {}): GuardResult => ({ allowed: false, reason, ...extra });

export async function assertPublishAllowed(pageId: string): Promise<GuardResult> {
  let page: PagePublisherPage | null;
  try {
    page = await getPage(pageId);
  } catch (e: any) {
    // Read failure → blocked. Never assume a page is fine because we
    // couldn't look at it.
    return BLOCK(`Could not load the page to verify its gate status (${String(e?.message || e)}) — blocked rather than assumed safe.`);
  }
  if (!page) return BLOCK("No such page — nothing to publish.");

  let run: PagePublisherGateRun | null;
  try {
    run = await latestGateRunForPage(pageId);
  } catch (e: any) {
    return BLOCK(`Could not read this page's gate history (${String(e?.message || e)}) — blocked rather than assumed safe.`);
  }
  if (!run) return BLOCK("This page has never been through the SEO gate. Run the gate first.", { pageUpdatedAt: page.updatedAt });

  if (typeof run.runAt !== "number" || typeof page.updatedAt !== "number") {
    // Missing timestamps make staleness unknowable — which is a block, not
    // a shrug.
    return BLOCK("Gate run or page timestamps are missing, so staleness can't be verified — blocked.", { gateRunAt: run.runAt, pageUpdatedAt: page.updatedAt });
  }

  const stale = run.runAt <= page.updatedAt;
  if (stale) {
    return BLOCK(
      `This page was edited after its last gate run (gate ran ${new Date(run.runAt).toISOString()}, page changed ${new Date(page.updatedAt).toISOString()}). Re-run the gate — a pass only covers the exact content it evaluated.`,
      { gateRunAt: run.runAt, pageUpdatedAt: page.updatedAt, stale: true }
    );
  }

  if (run.overall !== "pass") {
    return BLOCK(
      `The latest gate run failed${run.blockingFailures?.length ? `: ${run.blockingFailures.join(", ")}` : "."} Fix the blocking items and re-run — there is no override.`,
      { gateRunAt: run.runAt, pageUpdatedAt: page.updatedAt, stale: false }
    );
  }

  // readyToPublish is stricter than overall:'pass' — it also requires every
  // site-scoped finding to be acknowledged. Absent on runs recorded before
  // this field existed, and absence must NOT read as true (fail-closed).
  if (run.readyToPublish !== true) {
    const pending = run.unacknowledgedItems?.length ? `: ${run.unacknowledgedItems.join(", ")}` : "";
    return BLOCK(
      run.readyToPublish === undefined
        ? "This page's gate run predates acknowledgment tracking — re-run the gate so acknowledgment can be verified."
        : `Site-level findings still need acknowledgment before this page can publish${pending}.`,
      { gateRunAt: run.runAt, pageUpdatedAt: page.updatedAt, stale: false }
    );
  }

  return { allowed: true, reason: "Latest gate run passed and covers the current page content.", gateRunAt: run.runAt, pageUpdatedAt: page.updatedAt, stale: false };
}
