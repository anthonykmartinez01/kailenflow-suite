import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { ghHeaders, fetchSchedule, countPageFiles, parseOwnerRepo } from "../../shared/github-schedule.mts";

// Reads each client repo's schedule.ts (every path->date entry, past and
// future) AND lists actual page files under the repo's pages directory —
// two separate, deliberately independent signals:
//   - `pages` (from schedule.ts) answers "what's scheduled, and when"
//   - `pageCount` (from the repo's real file tree) answers "how many pages
//     actually exist on the site right now"
// They're independent on purpose: a page published by hand (committed
// directly, skipping the schedule.ts registry entirely — e.g. "I just
// wanted this live right now") still needs to count as a real page even
// though it was never scheduled. Relying on schedule.ts alone for a
// "how many pages exist" number would silently undercount every page that
// didn't go through that flow.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const repos: { name: string; repo: string; branch?: string; pagesDir?: string }[] = Array.isArray(body.repos) ? body.repos : [];
  const token = Netlify.env.get("GITHUB_TOKEN");
  if (!token) return json({ error: "GITHUB_TOKEN not configured on the server" }, 500);
  const headers = ghHeaders(token);

  const results = await Promise.all(repos.map(async ({ name, repo, branch, pagesDir }) => {
    const parsed = parseOwnerRepo(repo);
    if (!parsed) return { client: name, repo, error: "invalid repo format" };
    const { owner, repoName } = parsed;
    const ref = branch || "main";

    const [scheduleResult, pageCountResult] = await Promise.all([
      fetchSchedule(owner, repoName, ref, headers),
      countPageFiles(owner, repoName, ref, pagesDir || "src/pages", headers),
    ]);

    return {
      client: name, repo,
      pages: scheduleResult.pages,
      pageCount: pageCountResult.count,
      error: scheduleResult.error || pageCountResult.error,
    };
  }));

  return json({ results });
};

export const config: Config = { path: "/api/scheduled-pages-status" };
