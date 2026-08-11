import type { Context, Config } from "@netlify/functions";
import { readAppData, mutateAppData } from "../../shared/firestore-admin.mts";
import { ghHeaders, fetchSchedule, parseOwnerRepo, fetchLatestWorkflowRun } from "../../shared/github-schedule.mts";
import { submitBatchAndLog, buildPageUrl } from "../../shared/indexing.mts";
import { selectForSubmission } from "../../shared/index-queue.mts";

// Runs on Netlify's own cron (like run-scheduled-heatmaps) so a client's
// scheduled page going live gets handled EVEN IF no one has the Suite open
// — same reasoning as every other cron function in this app: nothing here
// depends on a human's browser being open at the right moment.
//
// What this does: for every client with a GitHub repo configured
// (client.publishing.repo), reads their schedule.ts (same shared parser
// scheduled-pages-status uses for the dashboard tiles) and finds entries
// whose go-live date has passed that haven't been processed yet. For each
// one:
//   - submits its full URL (client.website + path) to Google's Indexing
//     API and PrimeIndexer, same as the per-client "Enable Auto-Indexing"
//     GitHub Action step does — but here it's automatic for EVERY
//     connected client, no separate per-client opt-in required
//   - adds a Completed task ("New website page: {path}") to client.tasks
//   - adds an auto-generated activity ("Published new page: {path}",
//     noting whether indexing submission succeeded) to client.activities
//     — so it shows up in both the Tasks tab AND the client's Monthly SEO
//     Report's Activity list
// Then records the path in client.publishing.notifiedPaths so the task/
// activity is never logged twice on the next run.
//
// Deliberately independent of client.scheduledPages (the in-app
// paste-content-and-schedule pipeline) — this watches the client's ACTUAL
// repo, so a page published by hand (committed directly, never entered
// into the Suite's own scheduler) still gets picked up once its
// schedule.ts entry's date passes, same as one that went through the full
// pipeline.
//
// Retry gap fixed 2026-07-20: notifiedPaths used to double as "don't bother
// indexing this again" too, since it's the only per-path memory this
// function has. That meant a page whose indexing submission failed for ANY
// reason (rate limit, API outage, transient error) was marked notified on
// the very first pass and then silently skipped forever — nothing ever
// retried it, and the task/activity note ("indexing submission failed,
// retry manually") was the only trace, easy to miss. A real client page
// (Anytime Air Pros' air-conditioning-repair-service) went unindexed this
// way. Fix: retry any notified-but-not-fully-succeeded path automatically
// (no duplicate task/activity — just a silent resubmission).
//
// Second retry gap fixed same day: the first version of the fix above
// tracked success as ONE combined flag (client.publishing.indexedPaths,
// set the moment EITHER Google or PrimeIndexer succeeded) — so a page
// where PrimeIndexer succeeded but Google failed (e.g. while the shared
// Google token was expired) got marked "done" and PERMANENTLY stopped
// retrying Google specifically, even after the token was fixed. Real case:
// 360 IV's 5 pages all showed a frozen "Google token refresh failed"
// message from their original submission, because PrimeIndexer alone had
// already satisfied the old combined check. Fix: retry eligibility is now
// read straight off indexHistory's PER-SERVICE ok flags (no separate
// indexedPaths bookkeeping at all) — a page keeps retrying until BOTH
// google.ok and primeIndexer.ok are true, independently.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

// Mirrors the client's uid() (public/index.html) exactly, since activities
// there always use that string id format — no shared helper for it existed
// server-side before this function.
function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export default async (req: Request, _ctx: Context) => {
  const log: string[] = [];
  try {
    const data = await readAppData();
    const token = Netlify.env.get("GITHUB_TOKEN");
    if (!token) return json({ ok: false, error: "GITHUB_TOKEN not configured on the server" }, 500);
    const headers = ghHeaders(token);
    const now = Date.now();
    let taskIdCounter = 0; // guarantees unique task ids even for several pages logged in the same run
    // Deltas collected during the (slow) GitHub + indexing calls, applied
    // atomically to the FRESH document afterward via mutateAppData — the old
    // read → slow work → write-back-whole-doc pattern erased any browser
    // save that landed in between.
    const deltas: { clientId: string; tasks: any[]; activities: any[]; notifiedPaths: string[]; indexHistory: Record<string, any>; workflowHealth: any }[] = [];

    for (const client of data.clients || []) {
      const repo = client.publishing?.repo;
      if (!repo) continue;
      const parsed = parseOwnerRepo(repo);
      if (!parsed) { log.push(`${client.name}: invalid repo format "${repo}"`); continue; }
      const { owner, repoName } = parsed;
      const ref = client.publishing.branch || "main";

      const { pages, error } = await fetchSchedule(owner, repoName, ref, headers);
      if (error) { log.push(`${client.name}: FAILED to read schedule.ts (${error})`); continue; }

      // Refreshed every run regardless of whether anything new published —
      // otherwise a broken/stuck GitHub Action looks identical to "nothing
      // due yet" from the Suite's side. Surfaced on the client's Indexing
      // tab (public/index.html).
      const workflowHealth = await fetchLatestWorkflowRun(owner, repoName, headers).catch((e: any) => ({ error: String(e?.message || e) }));
      const delta = { clientId: client.id, tasks: [] as any[], activities: [] as any[], notifiedPaths: [] as string[], indexHistory: {} as Record<string, any>, workflowHealth };

      if (pages.length === 0) { deltas.push(delta); continue; }

      const notified: string[] = client.publishing.notifiedPaths || [];
      const history: Record<string, any> = client.publishing.indexHistory || {};
      const isLive = (p: any) => {
        const t = new Date(p.date + "T00:00:00Z").getTime();
        return Number.isFinite(t) && t <= now;
      };
      const newlyPublished = pages.filter((p: any) => !notified.includes(p.path) && isLive(p));
      // Pages already logged (task/activity exists) whose indexing hasn't
      // FULLY succeeded — checked per-service (google.ok AND primeIndexer.ok
      // independently), not a combined flag, so fixing one broken service
      // (e.g. an expired Google token) doesn't get silently ignored just
      // because the other one already succeeded on an earlier run.
      const retryPages = pages.filter((p: any) => {
        if (!notified.includes(p.path) || !isLive(p)) return false;
        const rec = history[p.path];
        if (!rec) return true; // logged but never even got a URL to submit (e.g. no website on file at the time)
        return !rec.google?.ok || !rec.primeIndexer?.ok;
      });
      if (newlyPublished.length === 0 && retryPages.length === 0) { deltas.push(delta); continue; }

      // Auto-submit the whole run's URLs (new pages + retries) for indexing
      // in ONE batch — best-effort. A missing website field or an indexing-
      // API failure must NEVER block logging the task/activity; the page is
      // still live either way, this is just a bonus signal. Batched (not one
      // call per page) because per-page PrimeIndexer projects fired back-to-
      // back rate-limited (HTTP 429) when several pages went live in one run.
      // Staged indexing (task #56): pace submissions per client per day rather
      // than firing a whole batch at once. This caps only what is SUBMITTED —
      // the task/activity below is still logged for every page that went live,
      // because the page really is live whether or not we've pinged Google
      // about it yet. A held-back page writes no submission record, so the
      // retry sweep above picks it up on a later run automatically; the queue
      // is implicit rather than a second store that could drift.
      const staged = selectForSubmission({
        newPages: newlyPublished, retryPages, history, publishing: client.publishing, now,
      });
      const releasedPaths = new Set(staged.release);
      const allPages = [...newlyPublished, ...retryPages];
      const pageEntries = allPages.map((page: any) => ({
        page,
        pageUrl: buildPageUrl(client.website, page.path),
        released: releasedPaths.has(page.path),
      }));
      const batchUrls = pageEntries.filter((e: any) => e.pageUrl && e.released).map((e: any) => e.pageUrl as string);
      let batchResults: Record<string, any> = {};
      if (batchUrls.length > 0) {
        try { batchResults = await submitBatchAndLog(batchUrls, client.name, "auto-publish", client.gscProperty); }
        catch { /* handled per-page below via the missing-result note */ }
      }

      const newlyPublishedPaths = new Set(newlyPublished.map((p: any) => p.path));

      for (const { page, pageUrl, released } of pageEntries) {
        const nowIso = new Date().toISOString();
        const result = pageUrl && released ? batchResults[pageUrl] : null;
        const okCount = result ? (result.google.ok ? 1 : 0) + (result.primeIndexer.ok ? 1 : 0) : 0;
        const prevRec = history[page.path]; // this path's state BEFORE this run, for detecting newly-fixed services below

        // Per-page record for the Indexing tab — additive to (never
        // replaces) notifiedPaths, which stays the source of truth for the
        // task/activity-logged check above. Merged (not overwritten) into
        // any existing entry on write, so a retry's fresh submission result
        // never clobbers a confirmed/coverageState the check-indexed-status
        // cron already set.
        if (pageUrl && !released) {
          // Held back by the daily pacing cap. Deliberately writes NO
          // submittedAt and NO google/primeIndexer result: a queued page must
          // not look like a failed one in the Indexing tab, must not count
          // against the trailing-24h allowance, and must stay eligible for the
          // retry sweep (which tests google?.ok / primeIndexer?.ok) so a later
          // run picks it up without any extra bookkeeping.
          delta.indexHistory[page.path] = {
            date: page.date,
            url: pageUrl,
            queued: true,
            queuedAt: nowIso,
          };
        } else if (pageUrl) {
          delta.indexHistory[page.path] = {
            date: page.date,
            // Cleared explicitly rather than left to the merge — a page that
            // was queued on an earlier run and is submitted now must stop
            // reporting itself as queued.
            queued: false,
            // result.url is the RESOLVED canonical URL (submitBatchAndLog
            // follows redirects before submitting — see resolveCanonicalUrl,
            // shared/indexing.mts) — may differ from pageUrl if schedule.ts's
            // path is missing a trailing slash the site enforces. Storing the
            // resolved one here means the confirmed-indexed check
            // (check-indexed-status) inspects the REAL page, not a URL that
            // just redirects.
            url: result?.url || pageUrl,
            submittedAt: nowIso,
            google: result?.google || { ok: false, detail: "errored" },
            primeIndexer: result?.primeIndexer || { ok: false, detail: "errored" },
          };
        }

        let indexingNote = "";
        if (!pageUrl) indexingNote = " — no website on file, skipped indexing submission";
        else if (!released) indexingNote = ` — queued for indexing (pacing at ${staged.allowance}/day for this client), will submit automatically`;
        else if (!result) indexingNote = " — indexing submission errored, will retry automatically";
        else if (okCount === 2) indexingNote = " — submitted for indexing (Google + PrimeIndexer)";
        else if (okCount === 1) indexingNote = ` — submitted for indexing (${result.google.ok ? "Google" : "PrimeIndexer"} only — ${result.google.ok ? "PrimeIndexer" : "Google"} failed, will keep retrying that one)`;
        else if (!client.gscProperty) indexingNote = " — Google Search Console isn't connected for this client (connect it in Analytics), PrimeIndexer also failed; will keep retrying";
        else indexingNote = " — indexing submission failed, will retry automatically";

        if (newlyPublishedPaths.has(page.path)) {
          const taskId = now + (taskIdCounter++); // client-side tasks use a raw Date.now() number id — offset keeps these unique within this run
          delta.tasks.push({
            id: taskId,
            date: page.date,
            title: `New website page: ${page.path}`,
            description: `Auto-published via the scheduled GitHub Action from ${repo} (schedule.ts).${indexingNote}`,
            phase: "Ongoing",
            status: "Completed",
            createdAt: nowIso,
            completedAt: nowIso,
          });
          // TWO SEPARATE ACTIVITIES, deliberately — these are two distinct
          // pieces of work and the client report shows them as two actions:
          //   1. we published the page to their site (the GitHub commit went
          //      live via the scheduled Action)
          //   2. we asked Google + PrimeIndexer to index it
          // They used to be ONE line ("Published new page: /path — <indexing
          // note>"), which meant the indexing work was invisible in reports,
          // and the appended "(PrimeIndexer …)" text also made the publish line
          // look like an indexing entry to the report's classifier.
          // Keep BOTH on category "new-page": the report filters on
          // REPORT_ACTIVITY_CATEGORIES, and adding a new category here would
          // silently drop these rows from every report.
          delta.activities.push({
            id: uid(),
            taskId,
            date: nowIso,
            text: `Published new page: ${page.path}`,
            category: "new-page",
            autoGenerated: true,
            createdAt: nowIso,
          });
          delta.activities.push({
            id: uid(),
            taskId,
            date: nowIso,
            text: `Submitted for indexing: ${page.path}${indexingNote}`,
            category: "new-page",
            autoGenerated: true,
            createdAt: nowIso,
          });
        } else if (result) {
          // Only note it when a service NEWLY succeeded this run (wasn't ok
          // before) — otherwise a page stuck on one permanently-broken
          // service (e.g. no website on file) would get a fresh activity
          // logged every single hour for the other service re-confirming
          // success it already had.
          const newlySucceeded = (result.google.ok && !prevRec?.google?.ok) || (result.primeIndexer.ok && !prevRec?.primeIndexer?.ok);
          if (newlySucceeded) {
            delta.activities.push({
              id: uid(),
              date: nowIso,
              text: `Indexing retry succeeded for ${page.path}${indexingNote}`,
              category: "new-page",
              autoGenerated: true,
              createdAt: nowIso,
            });
          }
        }
      }
      delta.notifiedPaths = newlyPublished.map((p: any) => p.path);
      deltas.push(delta);
      const parts: string[] = [];
      if (newlyPublished.length) parts.push(`logged ${newlyPublished.length} newly-published page(s) — ${newlyPublished.map((p: any) => p.path).join(", ")}`);
      // Includes each service's actual result, not just the path — a bare
      // path list here was useless for diagnosing WHY something keeps
      // retrying (found the hard way debugging the 2026-07-20 incident).
      if (retryPages.length) {
        const details = retryPages.map((p: any) => {
          const rec = delta.indexHistory[p.path];
          if (!rec) return `${p.path}: no URL to submit`;
          return `${p.path} (google=${rec.google.ok ? "ok" : rec.google.detail}, primeIndexer=${rec.primeIndexer.ok ? "ok" : rec.primeIndexer.detail})`;
        }).join(" | ");
        parts.push(`retried indexing for ${retryPages.length} previously-failed page(s) — ${details}`);
      }
      log.push(`${client.name}: ${parts.join("; ")}`);
    }

    if (deltas.length > 0) {
      await mutateAppData((fresh: any) => {
        for (const d of deltas) {
          const c = (fresh.clients || []).find((x: any) => x.id === d.clientId);
          if (!c) continue;
          c.tasks = [...(c.tasks || []), ...d.tasks];
          c.activities = [...(c.activities || []), ...d.activities];
          c.publishing = c.publishing || {};
          c.publishing.notifiedPaths = Array.from(new Set([...(c.publishing.notifiedPaths || []), ...d.notifiedPaths]));
          // indexedPaths (the old combined success flag) is no longer written —
          // retry eligibility now reads indexHistory's per-service ok flags
          // directly (see the comment at the top of this file). Any stale
          // indexedPaths data left over from before this fix is inert.
          c.publishing.workflowHealth = d.workflowHealth;
          c.publishing.indexHistory = c.publishing.indexHistory || {};
          for (const [path, rec] of Object.entries(d.indexHistory)) {
            // Merge, don't overwrite — a retry's fresh submission result
            // must never erase confirmed/coverageState/checkAttempts that
            // check-indexed-status already recorded for this path.
            c.publishing.indexHistory[path] = { ...c.publishing.indexHistory[path], ...(rec as any) };
          }
        }
      });
    }
    return json({ ok: true, changed: deltas.length > 0, log });
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e), log }, 500);
  }
};

// Hourly — publishing only ever happens once daily at UTC midnight per the
// client's own GitHub Action schedule, so hourly is far more often than
// needed but still catches it same-day promptly without any extra cost
// (this only ever reads schedule.ts, a single small file per client repo).
export const config: Config = { schedule: "0 * * * *" };
