import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

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

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

const SCHEDULE_CANDIDATES = ["src/lib/schedule.ts", "src/lib/schedule.js"];

function parseSchedule(src: string): { path: string; date: string }[] {
  const out: { path: string; date: string }[] = [];
  for (const line of src.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    const m = trimmed.match(/^["']([^"']+)["']\s*:\s*["'](\d{4}-\d{2}-\d{2})["']/);
    if (m) out.push({ path: m[1], date: m[2] });
  }
  return out;
}

// Page-producing file types across the stacks these client sites use
// (Astro, plain HTML, occasionally Next/Vue) — matched against every blob
// in the repo's git tree under the configured pages directory.
const PAGE_FILE_RE = /\.(astro|md|mdx|html|tsx|jsx|vue)$/i;

async function countPageFiles(owner: string, repoName: string, ref: string, pagesDir: string, headers: HeadersInit): Promise<{ count: number; error?: string }> {
  const dir = (pagesDir || "src/pages").replace(/^\/+|\/+$/g, "");
  const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { headers, cache: "no-store" });
  if (!res.ok) return { count: 0, error: `GitHub ${res.status} listing ${dir}` };
  const data = await res.json();
  const tree: any[] = Array.isArray(data.tree) ? data.tree : [];
  const prefix = dir + "/";
  const count = tree.filter((t) => t.type === "blob" && typeof t.path === "string" && t.path.startsWith(prefix) && PAGE_FILE_RE.test(t.path)).length;
  return { count };
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
    const m = (repo || "").match(/^([^/\s]+)\/([^/\s]+)$/);
    if (!m) return { client: name, repo, error: "invalid repo format" };
    const [, owner, repoName] = m;
    const ref = branch || "main";

    const [scheduleResult, pageCountResult] = await Promise.all([
      (async () => {
        for (const path of SCHEDULE_CANDIDATES) {
          const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/${path}?ref=${encodeURIComponent(ref)}`, { headers, cache: "no-store" });
          if (res.status === 404) continue;
          if (!res.ok) return { pages: [] as { path: string; date: string }[], error: `GitHub ${res.status}` };
          const data = await res.json();
          const content = Buffer.from(data.content, "base64").toString("utf8");
          return { pages: parseSchedule(content) };
        }
        return { pages: [] as { path: string; date: string }[] };
      })(),
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
