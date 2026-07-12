import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

// Read-only check: is this client's repo actually reachable via our
// GITHUB_TOKEN, and if so, is the auto-indexing automation already set up?
// Powers the "Connected"/"Not connected" badge in the Settings tab.

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

async function fileExists(owner: string, repo: string, path: string, branch: string, token: string): Promise<{ exists: boolean; hasMarker?: boolean }> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, { headers: ghHeaders(token) });
  if (res.status === 404) return { exists: false };
  if (!res.ok) return { exists: false };
  const data = await res.json();
  const content = Buffer.from(data.content, "base64").toString("utf8");
  return { exists: true, hasMarker: content.includes("kailenflow-indexing-ping.mjs") };
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();

  const url = new URL(req.url);
  const repoFull = (url.searchParams.get("repo") || "").trim();
  const branch = (url.searchParams.get("branch") || "main").trim();
  const m = repoFull.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) return json({ error: 'repo must look like "owner/repo-name"' }, 400);
  const [, owner, repo] = m;

  const token = Netlify.env.get("GITHUB_TOKEN");
  if (!token) return json({ error: "GITHUB_TOKEN not configured on the server" }, 500);

  // 1. Repo reachable at all?
  const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: ghHeaders(token) });
  if (!repoRes.ok) {
    return json({
      repo: repoFull, branch,
      connected: false,
      reason: repoRes.status === 404 ? "Repo not found, or GITHUB_TOKEN doesn't have access to it." : `GitHub API error ${repoRes.status}`,
    });
  }

  // 2. Branch reachable?
  const branchRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`, { headers: ghHeaders(token) });
  if (!branchRes.ok) {
    return json({ repo: repoFull, branch, connected: false, reason: `Branch "${branch}" not found in this repo.` });
  }

  // 3-5. Is the automation already installed?
  const [script, workflow, secretRes] = await Promise.all([
    fileExists(owner, repo, "scripts/kailenflow-indexing-ping.mjs", branch, token),
    fileExists(owner, repo, ".github/workflows/scheduled-publish.yml", branch, token),
    fetch(`https://api.github.com/repos/${owner}/${repo}/actions/secrets/KAILENFLOW_INDEXING_KEY`, { headers: ghHeaders(token) }),
  ]);

  return json({
    repo: repoFull,
    branch,
    connected: true,
    automation: {
      scriptInstalled: script.exists,
      workflowFound: workflow.exists,
      workflowStepInstalled: !!workflow.hasMarker,
      secretSet: secretRes.ok,
    },
  });
};

export const config: Config = { path: "/api/indexing-status" };
