import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { manualAdapter, manualCapabilities } from "../../shared/page-publisher/adapters/index.mts";
import { parseManualUrls, discoveredCountNote, titleFromUrlPath } from "../../shared/page-publisher/adapters/manual-adapter.mts";
import { naItemsForPlatform } from "../../shared/page-publisher/platform-limitations.mts";
import { canonicalUrl } from "../../shared/page-publisher/urls.mts";
import { saveSite, getSiteByClientId } from "../../shared/page-publisher/firestore.mts";

// POST /api/page-publisher-connect-manual-site — page-publisher-build-
// spec.md's revised priority (2026-07-23): MANUAL/paste adapter for
// GoDaddy-tier clients, built ahead of Wix. This is the MANUAL equivalent of
// what Stage 1 already built for GIT_STATIC (connect + read what already
// exists) — the actual paste-package/verification flow is Stage 2+ work,
// same stage GIT_STATIC's own real publish mechanism is deferred to. No
// repo/branch/astroLayout/IndexNow-key here: none of those apply to a
// platform with no API and no way to host a key file (see platform-
// limitations.mts's l1.crawl.indexnow entry).
//
// Idempotent, same pattern as connect-site: re-running for an already-
// connected client refreshes verification + siteGraph.pageIndex rather than
// creating a duplicate site doc.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const { clientId, domain, manualUrls } = body;
  if (!clientId || !domain) return json({ error: "clientId and domain are required" }, 400);

  const site = {
    clientId,
    domain: String(domain).trim(),
    platform: "manual" as const,
  };

  const verify = await manualAdapter.verifyConnection({}, site);
  if (!verify.ok) {
    return json({ ok: false, error: verify.detail, connectionStatus: "error" }, 502);
  }

  // Best-effort — a brand new domain may not have a sitemap yet. Doesn't
  // block connecting; the operator can rescan later via list-urls once
  // pages exist.
  const now = Date.now();
  const pageIndex: Record<string, { title: string; path: string; parentUrl: string | null; lastSeenAt: number }> = {};
  let listNote: string | undefined;
  let discoveredCount = 0;
  const existingUrls = await manualAdapter.listExistingUrls({}, site);
  if (Array.isArray(existingUrls)) {
    // Canonical keys (urls.mts) — sitemap <loc> values arrive in arbitrary
    // form and must key identically to how link targets resolve.
    for (const u of existingUrls) pageIndex[canonicalUrl(u.url)] = { title: u.title, path: u.path, parentUrl: null, lastSeenAt: now };
    discoveredCount = existingUrls.length;
  } else {
    listNote = existingUrls.reason;
  }

  // Operator-pasted fallback (2026-07-23 — sitemap discovery came back
  // implausibly thin on a real Wix client due to an unhandled sitemap-
  // index). Merged in every time, not just when discovery is empty — an
  // operator may know about pages the sitemap never listed at all. Persisted
  // separately on the site doc so a later reconnect (which re-runs
  // discovery) doesn't drop these.
  const existing = await getSiteByClientId(clientId);
  const manualList = [...new Set([...(existing?.manualUrlOverrides || []), ...parseManualUrls(manualUrls)].map(canonicalUrl).filter(Boolean))];
  for (const url of manualList) {
    if (pageIndex[url]) continue; // sitemap-discovered wins on collision
    let pathname = url;
    try { pathname = new URL(url).pathname; } catch { /* not a full URL — use as-is */ }
    pageIndex[url] = { title: titleFromUrlPath(pathname), path: pathname, parentUrl: null, lastSeenAt: now };
  }

  const siteId = await saveSite({
    id: existing?.id,
    ...site,
    capabilityFlags: manualCapabilities,
    connectionStatus: "connected",
    lastVerifiedAt: now,
    naGateItems: naItemsForPlatform("manual"),
    manualUrlOverrides: manualList,
    siteGraph: { updatedAt: now, pageIndex, linkGraph: {}, schemaGraph: {}, sitemapUrls: Object.keys(pageIndex) },
  });

  return json({
    ok: true,
    siteId,
    verify: verify.detail,
    pageCount: Object.keys(pageIndex).length,
    pageListNote: listNote,
    lowConfidenceNote: discoveredCountNote(discoveredCount),
    naGateItems: naItemsForPlatform("manual"),
  });
};

export const config: Config = { path: "/api/page-publisher-connect-manual-site" };
