import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { isUnsupported, manualAdapter } from "../../shared/page-publisher/adapters/index.mts";
import { listRepoPageFiles, titleFromPath } from "../../shared/page-publisher/adapters/git-static-adapter.mts";
import { parseManualUrls, discoveredCountNote, titleFromUrlPath } from "../../shared/page-publisher/adapters/manual-adapter.mts";
import { canonicalPageUrlFromPath, canonicalUrl } from "../../shared/page-publisher/urls.mts";
import { getSite, patchSite, replaceSiteGraph } from "../../shared/page-publisher/firestore.mts";

// POST /api/page-publisher-list-urls {siteId, manualUrls?} — on-demand
// refresh of an already-connected site's siteGraph.pageIndex (page-
// publisher-build-spec.md §5a's manual "rescan" pattern, Stage 1 scope:
// title/path/parentUrl only — NOT linkGraph/schemaGraph, which need full
// page-content fetches and are Stage 3 work). Existing parentUrl values
// already recorded (e.g. by a page Page Publisher itself created) are
// preserved rather than reset to null on refresh.
//
// GIT_STATIC: repo tree + schedule.ts, as originally built. MANUAL (added
// 2026-07-23): re-runs sitemap discovery through the same fixed
// sitemap-index-aware logic connect-manual-site uses, merges in any
// operator-pasted manualUrls (appended to whatever was already saved, not
// replacing it), and returns the same lowConfidenceNote when sitemap
// discovery alone still looks implausibly thin.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const { siteId, manualUrls } = body;
  if (!siteId) return json({ error: "siteId is required" }, 400);

  const site = await getSite(siteId);
  if (!site) return json({ error: "No site found for that siteId" }, 404);

  const now = Date.now();
  const prevIndex = site.siteGraph?.pageIndex || {};

  if (site.platform === "manual") {
    const pageIndex: Record<string, { title: string; path: string; parentUrl: string | null; lastSeenAt: number }> = {};
    let discoveredCount = 0;
    let pageListNote: string | undefined;
    const existingUrls = await manualAdapter.listExistingUrls({}, { id: site.id, clientId: site.clientId, domain: site.domain });
    // Every key canonicalized (urls.mts) — sitemap <loc> values and
    // operator-pasted URLs arrive in arbitrary form (trailing slashes, www),
    // and an uncanonicalized key here silently fails to match link targets.
    if (Array.isArray(existingUrls)) {
      for (const u of existingUrls) {
        const key = canonicalUrl(u.url);
        pageIndex[key] = { title: u.title, path: u.path, parentUrl: prevIndex[key]?.parentUrl ?? null, lastSeenAt: now };
      }
      discoveredCount = existingUrls.length;
    } else {
      pageListNote = existingUrls.reason;
    }
    const manualList = [...new Set([...(site.manualUrlOverrides || []), ...parseManualUrls(manualUrls)].map(canonicalUrl).filter(Boolean))];
    for (const url of manualList) {
      if (pageIndex[url]) continue;
      let pathname = url;
      try { pathname = new URL(url).pathname; } catch { /* not a full URL — use as-is */ }
      pageIndex[url] = { title: titleFromUrlPath(pathname), path: pathname, parentUrl: prevIndex[url]?.parentUrl ?? null, lastSeenAt: now };
    }
    await patchSite(siteId, { manualUrlOverrides: manualList });
    // replaceSiteGraph, not patchSite — a rebuilt index must DROP keys for
    // pages that no longer exist; merge would keep them forever.
    await replaceSiteGraph(siteId, { ...(site.siteGraph || {}), updatedAt: now, pageIndex, sitemapUrls: Object.keys(pageIndex) } as any);
    return json({ ok: true, pageCount: Object.keys(pageIndex).length, pageListNote, lowConfidenceNote: discoveredCountNote(discoveredCount) });
  }

  if (site.platform !== "git_static" || !site.repo) return json({ error: "This endpoint only refreshes git_static and manual sites" }, 400);

  const files = await listRepoPageFiles({ id: site.id, clientId: site.clientId, domain: site.domain, repo: site.repo, branch: site.branch, pagesDir: site.pagesDir });
  if (isUnsupported(files)) return json({ error: files.reason }, 502);

  const pageIndex: Record<string, { title: string; path: string; parentUrl: string | null; lastSeenAt: number }> = {};
  for (const f of files) {
    const url = canonicalPageUrlFromPath(site.domain, f.urlPath);
    pageIndex[url] = { title: titleFromPath(f.repoPath), path: f.urlPath, parentUrl: prevIndex[url]?.parentUrl ?? null, lastSeenAt: now };
  }

  await replaceSiteGraph(siteId, { ...(site.siteGraph || {}), updatedAt: now, pageIndex } as any);
  return json({ ok: true, pageCount: Object.keys(pageIndex).length });
};

export const config: Config = { path: "/api/page-publisher-list-urls" };
