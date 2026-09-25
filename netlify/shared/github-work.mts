// Website work, read from GitHub. Every commit to a client's site repo is real
// work done for that client — "Updated the H1 on /services", "Added
// /ac-repair-prosper" — so it counts toward Client Management's activity flags
// and shows up in the client update draft with a link.
//
// READ-ONLY: only GET /repos/.../commits. Nothing here pushes, edits, or opens
// anything. Uses the GITHUB_TOKEN already configured for Page Publisher.

const API = "https://api.github.com";

export type CommitWork = { at: string; kind: string; text: string; url: string };

// Noise that says nothing to a client reading an update.
const SKIP = /^(merge\b|revert\b|wip\b|chore\b|ci:|bump |update dependencies|deploy\b|\[skip ci\])/i;

/** Commit subject -> something a client would understand. */
export function humanize(message: string): string | null {
  const first = String(message || "").split("\n")[0].trim();
  if (!first || SKIP.test(first)) return null;
  // Strip conventional-commit prefixes: "feat(pages): add x" -> "add x"
  const stripped = first.replace(/^(\w+)(\([^)]*\))?!?:\s*/, "").trim();
  const text = stripped || first;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export async function recentCommits(repo: string, branch: string | undefined, sinceMs: number, token: string, cap = 50): Promise<CommitWork[]> {
  const since = new Date(sinceMs).toISOString();
  const url = `${API}/repos/${repo}/commits?since=${encodeURIComponent(since)}&per_page=${Math.min(cap, 100)}${branch ? `&sha=${encodeURIComponent(branch)}` : ""}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "kailenflow-suite" },
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const data: any = await r.json();
  const out: CommitWork[] = [];
  for (const c of Array.isArray(data) ? data : []) {
    const text = humanize(c.commit?.message || "");
    if (!text) continue;
    const at = c.commit?.author?.date || c.commit?.committer?.date;
    if (!at) continue;
    out.push({ at: new Date(at).toISOString(), kind: "website", text: `Website: ${text}`, url: c.html_url || "" });
  }
  return out;
}

export function githubToken(): string | null {
  return Netlify.env.get("GITHUB_TOKEN") || null;
}
