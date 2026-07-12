// Shared between scheduled-pages-status (interactive, per-request from the
// browser) and publish-page-log (the cron job that auto-creates a task +
// activity the first time a scheduled page's date passes) — kept in ONE
// place so both read/parse a client's schedule.ts identically, the same
// reasoning as netlify/shared/heatmap.mts for the rank-map functions.

export function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export const SCHEDULE_CANDIDATES = ["src/lib/schedule.ts", "src/lib/schedule.js"];

export interface ScheduleEntry { path: string; date: string; }

export function parseSchedule(src: string): ScheduleEntry[] {
  const out: ScheduleEntry[] = [];
  for (const line of src.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    const m = trimmed.match(/^["']([^"']+)["']\s*:\s*["'](\d{4}-\d{2}-\d{2})["']/);
    if (m) out.push({ path: m[1], date: m[2] });
  }
  return out;
}

// Fetches and parses whichever schedule file candidate exists in the repo.
// Returns pages:[] (not an error) when neither candidate exists — a repo
// with no schedule.ts at all is a valid, unremarkable state, not a failure.
export async function fetchSchedule(owner: string, repoName: string, ref: string, headers: HeadersInit): Promise<{ pages: ScheduleEntry[]; error?: string }> {
  for (const path of SCHEDULE_CANDIDATES) {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/${path}?ref=${encodeURIComponent(ref)}`, { headers, cache: "no-store" });
    if (res.status === 404) continue;
    if (!res.ok) return { pages: [], error: `GitHub ${res.status}` };
    const data = await res.json();
    const content = Buffer.from(data.content, "base64").toString("utf8");
    return { pages: parseSchedule(content) };
  }
  return { pages: [] };
}

// Page-producing file types across the stacks these client sites use
// (Astro, plain HTML, occasionally Next/Vue) — matched against every blob
// in the repo's git tree under the configured pages directory.
const PAGE_FILE_RE = /\.(astro|md|mdx|html|tsx|jsx|vue)$/i;

export async function countPageFiles(owner: string, repoName: string, ref: string, pagesDir: string, headers: HeadersInit): Promise<{ count: number; error?: string }> {
  const dir = (pagesDir || "src/pages").replace(/^\/+|\/+$/g, "");
  const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { headers, cache: "no-store" });
  if (!res.ok) return { count: 0, error: `GitHub ${res.status} listing ${dir}` };
  const data = await res.json();
  const tree: any[] = Array.isArray(data.tree) ? data.tree : [];
  const prefix = dir + "/";
  const count = tree.filter((t) => t.type === "blob" && typeof t.path === "string" && t.path.startsWith(prefix) && PAGE_FILE_RE.test(t.path)).length;
  return { count };
}

export function parseOwnerRepo(repo: string): { owner: string; repoName: string } | null {
  const m = (repo || "").match(/^([^/\s]+)\/([^/\s]+)$/);
  return m ? { owner: m[1], repoName: m[2] } : null;
}
