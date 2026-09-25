import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { gitStaticAdapter, gitStaticCapabilities, isUnsupported } from "../../shared/page-publisher/adapters/index.mts";
import { listRepoPageFiles, titleFromPath } from "../../shared/page-publisher/adapters/git-static-adapter.mts";
import { canonicalPageUrlFromPath } from "../../shared/page-publisher/urls.mts";
import { deriveAstroLayoutForRepo } from "../../shared/page-publisher/astro-layout.mts";
import { generateIndexNowKey, commitIndexNowKeyFile } from "../../shared/page-publisher/indexnow.mts";
import { saveSite, getSiteByClientId, replaceSiteGraph } from "../../shared/page-publisher/firestore.mts";

// POST /api/page-publisher-connect-site — page-publisher-build-spec.md §9
// Stage 1. Connects a GIT_STATIC site for a client and does every
// connect-time action in one pass: verify repo/branch access, populate
// siteGraph.pageIndex (title/path/parentUrl only — NOT linkGraph/schemaGraph,
// which need full page-content fetches and are Stage 3), derive astroLayout
// by sampling real existing pages (flagged, never guessed, if inconsistent),
// and generate + commit the site's IndexNow key file (the ping call itself
// is Stage 3 — this only ever proves the key file exists).
//
// Re-running this for an already-connected site is safe and idempotent: it
// re-verifies, refreshes pageIndex, and re-derives astroLayout, but reuses
// the existing indexNowKey/keyFile rather than generating a new one (the
// live key file must not silently change under an already-published site).

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const { clientId, domain, repo, branch, pagesDir } = body;
  if (!clientId || !domain || !repo) return json({ error: "clientId, domain, and repo are required" }, 400);

  const site = {
    clientId,
    domain: String(domain).trim(),
    platform: "git_static" as const,
    repo: String(repo).trim(),
    branch: (branch || "main").trim(),
    pagesDir: (pagesDir || "src/pages").trim(),
  };

  const verify = await gitStaticAdapter.verifyConnection({}, site);
  if (!verify.ok) {
    return json({ ok: false, error: verify.detail, connectionStatus: "error" }, 502);
  }

  const files = await listRepoPageFiles(site);
  if (isUnsupported(files)) {
    return json({ ok: false, error: files.reason, connectionStatus: "error" }, 502);
  }

  // Built directly from `files` (one tree fetch total) rather than also
  // calling gitStaticAdapter.listExistingUrls, which would re-fetch the same
  // tree a second time for the same information.
  const now = Date.now();
  const pageIndex: Record<string, { title: string; path: string; parentUrl: string | null; lastSeenAt: number }> = {};
  for (const f of files) {
    // Canonical key (urls.mts) — pageIndex keys and link targets MUST be
    // produced by the same rule or edges silently fail to match.
    const url = canonicalPageUrlFromPath(site.domain, f.urlPath);
    pageIndex[url] = { title: titleFromPath(f.repoPath), path: f.urlPath, parentUrl: null, lastSeenAt: now };
  }

  let astroLayout;
  try {
    astroLayout = await deriveAstroLayoutForRepo(site.repo, site.branch, site.pagesDir, files.map((f) => f.repoPath));
  } catch (e: any) {
    astroLayout = { layoutPath: "", contentDir: site.pagesDir, frontmatterShape: {}, sampledFrom: [], derivedAt: now, inconsistent: true, inconsistencyNote: String(e?.message || e) };
  }

  // Reuse the existing site/key if this client was already connected —
  // never regenerate a live IndexNow key silently.
  const existing = await getSiteByClientId(clientId);
  let indexNowKey = existing?.indexNowKey;
  let indexNowKeyFileCommitted = existing?.indexNowKeyFileCommitted || false;
  let indexNowNote = "";
  if (!indexNowKey) {
    indexNowKey = generateIndexNowKey();
    const commit = await commitIndexNowKeyFile(site.repo, site.branch, indexNowKey);
    indexNowKeyFileCommitted = commit.ok;
    indexNowNote = commit.detail;
  }

  const siteId = await saveSite({
    id: existing?.id,
    ...site,
    capabilityFlags: gitStaticCapabilities,
    connectionStatus: "connected",
    lastVerifiedAt: now,
    indexNowKey,
    indexNowKeyFileCommitted,
    astroLayout,
    siteGraph: { updatedAt: now, pageIndex, linkGraph: {}, schemaGraph: {}, sitemapUrls: [] },
  });

  // Reconnecting an EXISTING site rebuilds pageIndex from scratch, so stale
  // keys (renamed/deleted pages) must be dropped, not deep-merged — see
  // replaceSiteGraph's header for the phantom-duplicate bug this caused.
  if (existing?.id) {
    await replaceSiteGraph(siteId, { updatedAt: now, pageIndex, linkGraph: existing.siteGraph?.linkGraph || {}, schemaGraph: existing.siteGraph?.schemaGraph || {}, sitemapUrls: [] } as any);
  }

  return json({
    ok: true,
    siteId,
    verify: verify.detail,
    pageCount: Object.keys(pageIndex).length,
    astroLayout,
    indexNowKeyFileCommitted,
    indexNowNote: indexNowNote || undefined,
  });
};

export const config: Config = { path: "/api/page-publisher-connect-site" };
