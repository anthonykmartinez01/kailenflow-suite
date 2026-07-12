import type { Context, Config } from "@netlify/functions";
import tweetsodium from "tweetsodium";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

// One-click onboarding for the "auto-submit newly-published pages for
// indexing" workflow (see indexing-tool memory). Given a client's
// owner/repo + branch (already stored as client.publishing on the Suite
// side), this does the 3 manual steps a new client repo needs:
//   1. Add scripts/kailenflow-indexing-ping.mjs (generic, reads the site's
//      domain straight out of astro.config.mjs — never needs editing).
//   2. Append a step to .github/workflows/scheduled-publish.yml that runs
//      it after the daily deploy (idempotent — skipped if already present).
//   3. Set the KAILENFLOW_INDEXING_KEY repo secret (encrypted client-side
//      with the repo's own public key, per GitHub's Actions Secrets API).
// Requires GITHUB_TOKEN to have Contents:write AND Secrets:write on the
// target repo (a fine-grained PAT needs both permissions granted).

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

const SCRIPT_PATH = "scripts/kailenflow-indexing-ping.mjs";
const WORKFLOW_PATH = ".github/workflows/scheduled-publish.yml";
const SCRIPT_MARKER = "kailenflow-indexing-ping.mjs";

const SCRIPT_CONTENT = `#!/usr/bin/env node
/**
 * KailenFlow indexing ping — after a scheduled-publish deploy, submits any
 * page whose schedule.ts date is exactly today to the KailenFlow Suite
 * indexing endpoint (Google Indexing API + PrimeIndexer). Only newly-due
 * pages are submitted (not the whole sitemap), so PrimeIndexer credits are
 * spent once per page, not once per day.
 *
 * Fully generic — this file is identical across every client repo using
 * this pattern. It reads the site's domain straight out of
 * astro.config.mjs's \`site:\` field, so it never needs editing.
 *
 * Required repo secret: KAILENFLOW_INDEXING_KEY.
 * Installed automatically by the "Enable Auto-Indexing" button in the
 * KailenFlow Suite app (client Settings tab) — see the enable-indexing-
 * automation Netlify function if you need to re-run onboarding by hand.
 */
import { readFileSync, existsSync } from "node:fs";

const ENDPOINT = "https://kailenflow-suite.netlify.app/api/submit-indexing";
const SCHEDULE_CANDIDATES = ["src/lib/schedule.ts", "src/lib/schedule.js"];
const CONFIG_CANDIDATES = ["astro.config.mjs", "astro.config.ts", "astro.config.js"];

const apiKey = process.env.KAILENFLOW_INDEXING_KEY;
if (!apiKey) {
  console.log("kailenflow-indexing: KAILENFLOW_INDEXING_KEY not set, skipping.");
  process.exit(0);
}

const configFile = CONFIG_CANDIDATES.find(existsSync);
if (!configFile) {
  console.error("kailenflow-indexing: no astro.config.* found.");
  process.exit(1);
}
const configSrc = readFileSync(configFile, "utf8");
const siteMatch = configSrc.match(/site:\\s*['"]([^'"]+)['"]/);
if (!siteMatch) {
  console.error(\`kailenflow-indexing: no site: field found in \${configFile}.\`);
  process.exit(1);
}
const HOST = siteMatch[1].replace(/\\/$/, "");

const scheduleFile = SCHEDULE_CANDIDATES.find(existsSync);
if (!scheduleFile) {
  console.log("kailenflow-indexing: no schedule.ts found, nothing to submit.");
  process.exit(0);
}
const src = readFileSync(scheduleFile, "utf8");

const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
const dueToday = [];
for (const line of src.split("\\n")) {
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
  const m = trimmed.match(/^["']([^"']+)["']\\s*:\\s*["'](\\d{4}-\\d{2}-\\d{2})["']/);
  if (m && m[2] === today) dueToday.push(m[1]);
}

if (dueToday.length === 0) {
  console.log(\`kailenflow-indexing: no pages due \${today}, nothing to submit.\`);
  process.exit(0);
}

for (const path of dueToday) {
  const url = HOST + (path.startsWith("/") ? path : "/" + path);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "x-automation-key": apiKey },
      body: JSON.stringify({ url, label: HOST.replace(/^https?:\\/\\//, "") }),
    });
    const data = await res.json().catch(() => ({}));
    console.log(\`kailenflow-indexing: \${url} -> google=\${data.google?.ok} primeIndexer=\${data.primeIndexer?.ok}\`);
  } catch (e) {
    console.error(\`kailenflow-indexing: failed for \${url}: \${e.message || e}\`);
  }
}
`;

const WORKFLOW_STEP = `
      - name: Submit newly-due pages for indexing (KailenFlow)
        env:
          KAILENFLOW_INDEXING_KEY: \${{ secrets.KAILENFLOW_INDEXING_KEY }}
        run: node ${SCRIPT_PATH}
`;

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function getFile(owner: string, repo: string, path: string, branch: string, token: string) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, {
    headers: ghHeaders(token),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub read ${path} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return { sha: data.sha as string, content: Buffer.from(data.content, "base64").toString("utf8") };
}

async function putFile(owner: string, repo: string, path: string, branch: string, token: string, content: string, sha: string | undefined, message: string) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    headers: { ...ghHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) throw new Error(`GitHub write ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function setRepoSecret(owner: string, repo: string, token: string, secretName: string, secretValue: string) {
  const pkRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`, { headers: ghHeaders(token) });
  if (!pkRes.ok) throw new Error(`GitHub public-key fetch failed: ${pkRes.status} ${(await pkRes.text()).slice(0, 200)}`);
  const { key, key_id } = await pkRes.json();

  const encryptedBytes = tweetsodium.seal(Buffer.from(secretValue), Buffer.from(key, "base64"));
  const encrypted_value = Buffer.from(encryptedBytes).toString("base64");

  const putRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/secrets/${secretName}`, {
    method: "PUT",
    headers: { ...ghHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ encrypted_value, key_id }),
  });
  if (!putRes.ok) throw new Error(`GitHub secret set failed: ${putRes.status} ${(await putRes.text()).slice(0, 200)}`);
}

export default async (req: Request, _ctx: Context) => {
  try {
    if (!(await isAuthed(req))) return unauthorized();
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

    const repoFull: string = (body.repo || "").trim();
    const branch: string = (body.branch || "main").trim();
    const m = repoFull.match(/^([^/\s]+)\/([^/\s]+)$/);
    if (!m) return json({ error: 'repo must look like "owner/repo-name"' }, 400);
    const [, owner, repo] = m;

    const token = Netlify.env.get("GITHUB_TOKEN");
    const automationKey = Netlify.env.get("AUTOMATION_API_KEY");
    if (!token) return json({ error: "GITHUB_TOKEN not configured on the server" }, 500);
    if (!automationKey) return json({ error: "AUTOMATION_API_KEY not configured on the server" }, 500);

    const result: Record<string, string> = { script: "error", workflow: "error", secret: "error" };
    const errors: Record<string, string> = {};

    // 1. Script file — always overwrite so future improvements roll out on re-run.
    try {
      const existing = await getFile(owner, repo, SCRIPT_PATH, branch, token);
      if (existing?.content === SCRIPT_CONTENT) {
        result.script = "unchanged";
      } else {
        await putFile(owner, repo, SCRIPT_PATH, branch, token, SCRIPT_CONTENT, existing?.sha, "Add/update KailenFlow indexing ping script");
        result.script = existing ? "updated" : "created";
      }
    } catch (e: any) {
      console.error("enable-indexing-automation: script step failed", e);
      errors.script = String(e?.message || e);
    }

    // 2. Workflow step — append once, idempotent.
    try {
      const existing = await getFile(owner, repo, WORKFLOW_PATH, branch, token);
      if (!existing) {
        result.workflow = "no-workflow-found";
      } else if (existing.content.includes(SCRIPT_MARKER)) {
        result.workflow = "already-present";
      } else {
        const updated = existing.content.replace(/\n?$/, "") + "\n" + WORKFLOW_STEP.replace(/^\n/, "");
        await putFile(owner, repo, WORKFLOW_PATH, branch, token, updated, existing.sha, "Add KailenFlow indexing step to scheduled-publish workflow");
        result.workflow = "added";
      }
    } catch (e: any) {
      console.error("enable-indexing-automation: workflow step failed", e);
      errors.workflow = String(e?.message || e);
    }

    // 3. Repo secret.
    try {
      await setRepoSecret(owner, repo, token, "KAILENFLOW_INDEXING_KEY", automationKey);
      result.secret = "set";
    } catch (e: any) {
      console.error("enable-indexing-automation: secret step failed", e);
      errors.secret = String(e?.message || e);
    }

    return json({ repo: repoFull, branch, result, errors: Object.keys(errors).length ? errors : undefined });
  } catch (e: any) {
    console.error("enable-indexing-automation: unhandled error", e);
    return json({ error: `Unhandled server error: ${String(e?.message || e)}` }, 500);
  }
};

export const config: Config = { path: "/api/enable-indexing-automation" };
