import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

// Reads each client repo's schedule.ts and returns every path->date entry
// (past and future) so the Suite can show "what's scheduled, and when" in
// one place instead of opening each repo on GitHub. Same line-based parser
// as scripts/kailenflow-indexing-ping.mjs (kept in sync deliberately).

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

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const repos: { name: string; repo: string; branch?: string }[] = Array.isArray(body.repos) ? body.repos : [];
  const token = Netlify.env.get("GITHUB_TOKEN");
  if (!token) return json({ error: "GITHUB_TOKEN not configured on the server" }, 500);

  const results = await Promise.all(repos.map(async ({ name, repo, branch }) => {
    const m = (repo || "").match(/^([^/\s]+)\/([^/\s]+)$/);
    if (!m) return { client: name, repo, error: "invalid repo format" };
    const [, owner, repoName] = m;
    const ref = branch || "main";

    for (const path of SCHEDULE_CANDIDATES) {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/${path}?ref=${encodeURIComponent(ref)}`, { headers: ghHeaders(token), cache: "no-store" });
      if (res.status === 404) continue;
      if (!res.ok) return { client: name, repo, error: `GitHub ${res.status}` };
      const data = await res.json();
      const content = Buffer.from(data.content, "base64").toString("utf8");
      return { client: name, repo, pages: parseSchedule(content) };
    }
    return { client: name, repo, pages: [] };
  }));

  return json({ results });
};

export const config: Config = { path: "/api/scheduled-pages-status" };
