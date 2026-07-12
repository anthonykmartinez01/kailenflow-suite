import type { Context, Config } from "@netlify/functions";
import { readAppData, writeAppData } from "../../shared/firestore-admin.mts";
import { ghHeaders, fetchSchedule, parseOwnerRepo } from "../../shared/github-schedule.mts";
import { submitAndLog } from "../../shared/indexing.mts";

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
// Then records the path in client.publishing.notifiedPaths so it's never
// processed twice on the next run.
//
// Deliberately independent of client.scheduledPages (the in-app
// paste-content-and-schedule pipeline) — this watches the client's ACTUAL
// repo, so a page published by hand (committed directly, never entered
// into the Suite's own scheduler) still gets picked up once its
// schedule.ts entry's date passes, same as one that went through the full
// pipeline.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

// Mirrors the client's uid() (public/index.html) exactly, since activities
// there always use that string id format — no shared helper for it existed
// server-side before this function.
function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// client.website is stored as a bare host ("rankinwaste.com") or sometimes
// with a protocol/www already on it — normalize before gluing the
// schedule.ts path onto it so this never produces a malformed URL.
function buildPageUrl(website: string, path: string): string | null {
  const host = (website || "").trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  if (!host) return null;
  const cleanPath = path.startsWith("/") ? path : "/" + path;
  return `https://${host}${cleanPath}`;
}

export default async (req: Request, _ctx: Context) => {
  const log: string[] = [];
  try {
    const data = await readAppData();
    const token = Netlify.env.get("GITHUB_TOKEN");
    if (!token) return json({ ok: false, error: "GITHUB_TOKEN not configured on the server" }, 500);
    const headers = ghHeaders(token);
    const now = Date.now();
    let changed = false;
    let taskIdCounter = 0; // guarantees unique task ids even for several pages logged in the same run

    for (const client of data.clients || []) {
      const repo = client.publishing?.repo;
      if (!repo) continue;
      const parsed = parseOwnerRepo(repo);
      if (!parsed) { log.push(`${client.name}: invalid repo format "${repo}"`); continue; }
      const { owner, repoName } = parsed;
      const ref = client.publishing.branch || "main";

      const { pages, error } = await fetchSchedule(owner, repoName, ref, headers);
      if (error) { log.push(`${client.name}: FAILED to read schedule.ts (${error})`); continue; }
      if (pages.length === 0) continue;

      const notified: string[] = client.publishing.notifiedPaths || [];
      const newlyPublished = pages.filter((p: any) => {
        if (notified.includes(p.path)) return false;
        const t = new Date(p.date + "T00:00:00Z").getTime();
        return Number.isFinite(t) && t <= now;
      });
      if (newlyPublished.length === 0) continue;

      client.tasks = client.tasks || [];
      client.activities = client.activities || [];
      for (const page of newlyPublished) {
        const taskId = now + (taskIdCounter++); // client-side tasks use a raw Date.now() number id — offset keeps these unique within this run
        const nowIso = new Date().toISOString();

        // Auto-submit for indexing — best-effort. A missing website field or
        // an indexing-API failure must NEVER block logging the task/activity;
        // the page is still live either way, this is just a bonus signal.
        const pageUrl = buildPageUrl(client.website, page.path);
        let indexingNote = "";
        if (pageUrl) {
          try {
            const result = await submitAndLog(pageUrl, `${client.name}: ${page.path}`, "auto-publish");
            const okCount = (result.google.ok ? 1 : 0) + (result.primeIndexer.ok ? 1 : 0);
            indexingNote = okCount > 0 ? ` — submitted for indexing (${result.google.ok ? "Google" : ""}${result.google.ok && result.primeIndexer.ok ? " + " : ""}${result.primeIndexer.ok ? "PrimeIndexer" : ""})` : " — indexing submission failed, retry manually from the client's page";
          } catch (e: any) {
            indexingNote = ` — indexing submission errored (${String(e?.message || e)})`;
          }
        } else {
          indexingNote = " — no website on file, skipped indexing submission";
        }

        client.tasks.push({
          id: taskId,
          date: page.date,
          title: `New website page: ${page.path}`,
          description: `Auto-published via the scheduled GitHub Action from ${repo} (schedule.ts).${indexingNote}`,
          phase: "Ongoing",
          status: "Completed",
          createdAt: nowIso,
          completedAt: nowIso,
        });
        client.activities.push({
          id: uid(),
          taskId,
          date: nowIso,
          text: `Published new page: ${page.path}${indexingNote}`,
          autoGenerated: true,
          createdAt: nowIso,
        });
      }
      client.publishing.notifiedPaths = [...notified, ...newlyPublished.map((p: any) => p.path)];
      changed = true;
      log.push(`${client.name}: logged ${newlyPublished.length} newly-published page(s) — ${newlyPublished.map((p: any) => p.path).join(", ")}`);
    }

    if (changed) await writeAppData(data);
    return json({ ok: true, changed, log });
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e), log }, 500);
  }
};

// Hourly — publishing only ever happens once daily at UTC midnight per the
// client's own GitHub Action schedule, so hourly is far more often than
// needed but still catches it same-day promptly without any extra cost
// (this only ever reads schedule.ts, a single small file per client repo).
export const config: Config = { schedule: "0 * * * *" };
