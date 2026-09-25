// Whole-site content scan — page-publisher-build-spec.md §5a, Stage 3
// items 3 + 4. Builds siteGraph.linkGraph / schemaGraph plus liveHostChecks.
//
// ─── Why this reads the LIVE page, not just repo source (Option B) ───
// First real run against a real client (Rankin Waste, 22 pages, 2026-07-23)
// reported 13 orphans — including /about-us, /reviews, and every
// /service-areas/* page. All false. Verified directly against the repo:
// Nav.astro defines its links in a JS array and renders `href={link.href}`,
// and the service-area children are rendered by a .map() on the hub page.
// Static source extraction cannot see through a JSX expression, so it
// counted 13 unresolved hrefs and — fatally — treated the pages those
// expressions point at as unlinked.
//
// So: static extraction first (fast, free, no network), and ONLY when a
// page has unresolved dynamic hrefs, fetch that page's LIVE deployed URL
// and extract the rendered links to fill the gap. Links are MERGED, never
// replaced — a page routinely has both literal and dynamic links, and
// dropping the static set would lose real edges.
//
// ─── "Withhold" must never collapse into "silently pass" ───
// Anthony's explicit requirement, same date. Three states per page, never
// two:
//   'resolved'     — links fully known (no dynamic hrefs, or live fetch filled them)
//   'unverifiable' — had dynamic hrefs AND the live fetch failed
//   'skipped'      — source itself couldn't be read
//
// And orphan status is TRANSITIVE, which is the subtle part: a page's
// orphan status depends on every OTHER page's links being trustworthy. If
// any page anywhere is unverifiable, then a zero-inbound page might in fact
// be linked from that page — so its status is 'unverifiable', not 'orphan'.
// Only when every page resolves cleanly can a zero-inbound page be called a
// real orphan.
import { fetchRepoFileContent, listRepoPageFiles } from "./adapters/git-static-adapter.mts";
import { isUnsupported } from "./adapters/base-adapter.mts";
import { manualAdapter } from "./adapters/manual-adapter.mts";
import { buildPageUrl } from "../indexing.mts";
import { extractFromSource, normalizeInternalHref, canonicalPageUrl, extractHeadFacts, type HeadFacts } from "./extract.mts";
import type { PagePublisherSite } from "./firestore.mts";

const CONCURRENCY = 6;          // GitHub is fine with this; keeps us well clear of secondary rate limits
const MAX_PAGES = 600;          // hard ceiling — a bigger site needs a paged design and should say so, not silently truncate
const RATE_LIMIT_FLOOR = 100;   // stop cleanly while this many GitHub requests remain

// Degraded thresholds (Anthony's rule 4): when enough pages are
// unverifiable, individual orphan results stop being meaningful at all —
// report the scan as degraded instead of publishing a list nobody should
// act on. Either condition trips it.
const DEGRADED_ABS = 5;
const DEGRADED_FRACTION = 0.25;

export type LinkStatus = "resolved" | "unverifiable" | "skipped";
export type OrphanStatus = "linked" | "orphan" | "unverifiable";

export interface ScanPageResult {
  url: string;
  linkStatus: LinkStatus;
  statusReason?: string;
  outboundInternal: string[];
  unresolvedHrefCount: number;      // permanent scan-health signal, kept even after live resolution
  liveResolved: boolean;            // true when a live fetch actually filled dynamic links for this page
  schemaTypes: string[];
  schemaIds: string[];
  title: string | null;
  // Only present for pages we actually live-fetched — head facts can't be
  // read from .astro source (the head lives in the layout component).
  headFacts?: HeadFacts;
}

export interface SiteScanResult {
  complete: boolean;
  degraded: boolean;
  incompleteReason?: string;
  degradedReason?: string;
  scannedAt: number;
  pagesTotal: number;
  pagesResolved: number;
  pagesUnverifiable: number;
  pagesSkipped: number;
  liveFetchAttempts: number;
  liveFetchFailures: number;
  results: ScanPageResult[];
  // One representative page's head facts, used for SITE-scoped head items
  // (lang, viewport, charset, favicons, SPA shell) — those are properties of
  // the shared site template, so one page answers them for the whole site.
  // Costs at most one extra fetch, not one per page.
  siteHead: { url: string; facts: HeadFacts } | null;
  linkGraph: Record<string, string[]>;
  schemaGraph: Record<string, string[]>;
  inboundCounts: Record<string, number>;
  orphanStatus: Record<string, OrphanStatus>;
  orphans: string[];                // definitive orphans only — empty when degraded
  unverifiableOrphans: string[];    // zero inbound, but can't be trusted because something else is unverifiable
  unresolvedHrefTotal: number;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function githubRemaining(): Promise<number | null> {
  const token = Netlify.env.get("GITHUB_TOKEN");
  if (!token) return null;
  try {
    const res = await fetch("https://api.github.com/rate_limit", { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.resources?.core?.remaining ?? null;
  } catch { return null; }
}

// Reuses MANUAL's live-fetch mechanism verbatim (Anthony's instruction) —
// a plain authenticated-free GET of a public URL. Same code path already
// proven against real client sites for post-paste verification.
async function fetchLive(site: PagePublisherSite, url: string): Promise<string | null> {
  const html = await manualAdapter.fetchPageHtml({}, { id: site.id, clientId: site.clientId, domain: site.domain }, url);
  return isUnsupported(html) ? null : html;
}

export async function scanSite(site: PagePublisherSite): Promise<SiteScanResult> {
  const scannedAt = Date.now();
  const empty: SiteScanResult = {
    complete: false, degraded: false, scannedAt, pagesTotal: 0, pagesResolved: 0, pagesUnverifiable: 0, pagesSkipped: 0,
    liveFetchAttempts: 0, liveFetchFailures: 0, results: [], siteHead: null, linkGraph: {}, schemaGraph: {},
    inboundCounts: {}, orphanStatus: {}, orphans: [], unverifiableOrphans: [], unresolvedHrefTotal: 0,
  };

  if (site.platform === "git_static") {
    const siteRef = { id: site.id, clientId: site.clientId, domain: site.domain, repo: site.repo, branch: site.branch, pagesDir: site.pagesDir };
    const files = await listRepoPageFiles(siteRef);
    if (isUnsupported(files)) return { ...empty, incompleteReason: files.reason };
    if (files.length > MAX_PAGES) {
      return { ...empty, pagesTotal: files.length, incompleteReason: `Site has ${files.length} pages, above this scan's ${MAX_PAGES}-page ceiling. Refusing to scan a truncated subset — it would report false orphans.` };
    }
    const remaining = await githubRemaining();
    if (remaining !== null && remaining < files.length + RATE_LIMIT_FLOOR) {
      return { ...empty, pagesTotal: files.length, incompleteReason: `GitHub API budget too low to finish cleanly (${remaining} left, need ~${files.length}).` };
    }

    // Guarantee at least ONE live fetch so site-scoped head items are
    // answerable even when every page's links happen to be static. One
    // extra request for the whole site, and only when nothing else already
    // triggered a live fetch.
    const homeUrl = canonicalPageUrl(buildPageUrl(site.domain, "/") || site.domain);

    const results = await mapWithConcurrency(files, CONCURRENCY, async (f): Promise<ScanPageResult> => {
      // Canonicalized with the SAME rule link targets get — otherwise the
      // homepage keys as ".../" while every link to it normalizes to "..."
      // and it reads as an orphan (real bug, caught 2026-07-26).
      const url = canonicalPageUrl(buildPageUrl(site.domain, f.urlPath) || f.urlPath);
      const content = await fetchRepoFileContent(siteRef, f.repoPath);
      if (isUnsupported(content)) {
        return { url, linkStatus: "skipped", statusReason: content.reason, outboundInternal: [], unresolvedHrefCount: 0, liveResolved: false, schemaTypes: [], schemaIds: [], title: null };
      }
      return resolvePageLinks(site, url, content);
    });

    // If nothing was live-fetched, grab the homepage once purely for the
    // site-scoped head sample.
    if (!results.some((r) => r.headFacts)) {
      const homeHtml = await fetchLive(site, homeUrl);
      if (homeHtml) {
        const target = results.find((r) => r.url === homeUrl) || results[0];
        if (target) target.headFacts = extractHeadFacts(homeHtml);
      }
    }

    return finalize(site, results, scannedAt, files.length);
  }

  if (site.platform === "manual") {
    // No repo — the live page IS the source here, so there's nothing static
    // to fall back from. A failed fetch is a skip, not an unverifiable
    // dynamic-link case.
    const urls = Object.keys(site.siteGraph?.pageIndex || {});
    if (urls.length === 0) return { ...empty, incompleteReason: "No pages known for this site yet — connect/refresh it first." };
    if (urls.length > MAX_PAGES) return { ...empty, pagesTotal: urls.length, incompleteReason: `Site has ${urls.length} pages, above this scan's ${MAX_PAGES}-page ceiling.` };

    const results = await mapWithConcurrency(urls, CONCURRENCY, async (rawUrl): Promise<ScanPageResult> => {
      const url = canonicalPageUrl(rawUrl);
      const html = await fetchLive(site, rawUrl);
      if (html === null) {
        return { url, linkStatus: "skipped", statusReason: `Live fetch failed for ${rawUrl}`, outboundInternal: [], unresolvedHrefCount: 0, liveResolved: false, schemaTypes: [], schemaIds: [], title: null };
      }
      const ex = extractFromSource(html);
      return {
        url, linkStatus: "resolved", liveResolved: true,
        outboundInternal: toInternal(ex.links, site.domain),
        unresolvedHrefCount: ex.unresolvedHrefCount,
        schemaTypes: ex.schemaTypes, schemaIds: ex.schemaIds, title: ex.title,
        headFacts: extractHeadFacts(html),
      };
    });

    return finalize(site, results, scannedAt, urls.length);
  }

  return { ...empty, incompleteReason: `Scanning isn't implemented for platform "${site.platform}" yet.` };
}

function toInternal(hrefs: string[], domain: string): string[] {
  return [...new Set(hrefs.map((h) => normalizeInternalHref(h, domain)).filter((u): u is string => !!u))];
}

// Static first; live only when static left unresolved expressions behind.
async function resolvePageLinks(site: PagePublisherSite, url: string, source: string): Promise<ScanPageResult> {
  const ex = extractFromSource(source);
  const staticLinks = toInternal(ex.links, site.domain);

  if (ex.unresolvedHrefCount === 0) {
    return { url, linkStatus: "resolved", liveResolved: false, outboundInternal: staticLinks, unresolvedHrefCount: 0, schemaTypes: ex.schemaTypes, schemaIds: ex.schemaIds, title: ex.title };
  }

  const liveHtml = await fetchLive(site, url);
  if (liveHtml === null) {
    // NOT an orphan, NOT a pass — the whole point of the three-state model.
    return {
      url, linkStatus: "unverifiable",
      statusReason: `${ex.unresolvedHrefCount} dynamic href(s) in source and the live page could not be fetched to resolve them`,
      outboundInternal: staticLinks, unresolvedHrefCount: ex.unresolvedHrefCount, liveResolved: false,
      schemaTypes: ex.schemaTypes, schemaIds: ex.schemaIds, title: ex.title,
    };
  }

  const liveEx = extractFromSource(liveHtml);
  const merged = [...new Set([...staticLinks, ...toInternal(liveEx.links, site.domain)])];
  return {
    url, linkStatus: "resolved", liveResolved: true,
    outboundInternal: merged,
    unresolvedHrefCount: ex.unresolvedHrefCount, // kept as a permanent health signal even though it's now resolved
    schemaTypes: ex.schemaTypes.length ? ex.schemaTypes : liveEx.schemaTypes,
    schemaIds: ex.schemaIds.length ? ex.schemaIds : liveEx.schemaIds,
    title: ex.title || liveEx.title,
    // Free while we already have the live HTML in hand.
    headFacts: extractHeadFacts(liveHtml),
  };
}

function finalize(site: PagePublisherSite, results: ScanPageResult[], scannedAt: number, pagesTotal: number): SiteScanResult {
  const resolved = results.filter((r) => r.linkStatus === "resolved");
  const unverifiable = results.filter((r) => r.linkStatus === "unverifiable");
  const skipped = results.filter((r) => r.linkStatus === "skipped");

  const linkGraph: Record<string, string[]> = {};
  const schemaGraph: Record<string, string[]> = {};
  const inboundCounts: Record<string, number> = {};
  // Every known page starts at 0 so a page with no inbound edges still
  // appears (rather than being absent and silently ignored).
  for (const r of results) {
    if (r.linkStatus !== "skipped") { linkGraph[r.url] = r.outboundInternal; schemaGraph[r.url] = r.schemaTypes; }
    inboundCounts[r.url] = 0;
  }
  // Count edges from every page whose links we actually know — including
  // unverifiable pages' partial static links, since a known edge is a known
  // edge regardless of what else that page might additionally link to.
  for (const r of results) {
    if (r.linkStatus === "skipped") continue;
    for (const target of r.outboundInternal) {
      if (target === r.url) continue;
      if (target in inboundCounts) inboundCounts[target]++;
    }
  }

  // TRANSITIVE: any unreadable/unverifiable page anywhere means a
  // zero-inbound page might still be linked from it.
  const trustworthy = unverifiable.length === 0 && skipped.length === 0;
  const orphanStatus: Record<string, OrphanStatus> = {};
  for (const r of results) {
    if (r.linkStatus === "skipped") { orphanStatus[r.url] = "unverifiable"; continue; }
    if (inboundCounts[r.url] > 0) { orphanStatus[r.url] = "linked"; continue; }
    orphanStatus[r.url] = trustworthy ? "orphan" : "unverifiable";
  }

  const unverifiableCount = unverifiable.length + skipped.length;
  const degraded = unverifiableCount >= DEGRADED_ABS || (pagesTotal > 0 && unverifiableCount / pagesTotal >= DEGRADED_FRACTION);

  const definiteOrphans = Object.keys(orphanStatus).filter((u) => orphanStatus[u] === "orphan");
  const unverifiableOrphans = Object.keys(orphanStatus).filter((u) => orphanStatus[u] === "unverifiable" && inboundCounts[u] === 0);

  const complete = skipped.length === 0 && results.length > 0;

  return {
    complete,
    degraded,
    ...(complete ? {} : { incompleteReason: `${skipped.length} of ${results.length} page(s) could not be read at all.` }),
    ...(degraded ? { degradedReason: `${unverifiableCount} of ${pagesTotal} page(s) have unverifiable links — individual orphan results are withheld as untrustworthy. Check that the site is deployed and its live URLs are reachable.` } : {}),
    scannedAt,
    pagesTotal,
    pagesResolved: resolved.length,
    pagesUnverifiable: unverifiable.length,
    pagesSkipped: skipped.length,
    liveFetchAttempts: results.filter((r) => r.unresolvedHrefCount > 0).length,
    liveFetchFailures: unverifiable.length,
    results,
    // Prefer the homepage's head as the site sample (most representative of
    // the shared template); fall back to any page we have facts for.
    siteHead: (() => {
      const withFacts = results.filter((r) => r.headFacts);
      if (withFacts.length === 0) return null;
      const home = withFacts.find((r) => !new URL(r.url + "/").pathname.replace(/\/+$/, ""));
      const chosen = home || withFacts[0];
      return { url: chosen.url, facts: chosen.headFacts! };
    })(),
    linkGraph,
    schemaGraph,
    inboundCounts,
    orphanStatus,
    // Withheld entirely when degraded — a list nobody should act on is
    // worse than no list.
    orphans: degraded ? [] : definiteOrphans,
    unverifiableOrphans,
    unresolvedHrefTotal: results.reduce((s, r) => s + r.unresolvedHrefCount, 0),
  };
}

// ─── liveHostChecks (Stage 3 item 4) ───
// Reuses the HEAD-request-with-manual-redirect approach already proven by
// indexing.mts's resolveCanonicalUrl (the code that found and fixed the real
// trailing-slash bug in production) rather than inventing a second
// redirect-following mechanism.
export async function runLiveHostChecks(domain: string): Promise<{ checkedAt: number; real404: boolean; hostHonors404: boolean; singleHostOk: boolean; httpsRedirectOk: boolean; llmsTxtPresent: boolean; robotsTxtPresent: boolean; robotsMentionsSitemap: boolean; robotsAiCrawlerPolicy: boolean }> {
  const clean = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const httpsRoot = `https://${clean}`;
  const checkedAt = Date.now();

  let real404 = false, hostHonors404 = false;
  try {
    const res = await fetch(`${httpsRoot}/kailenflow-404-probe-${checkedAt}`, { method: "GET", redirect: "manual", cache: "no-store" });
    real404 = res.status === 404;
    hostHonors404 = res.status === 404;
  } catch { /* unreachable is not a pass */ }

  let httpsRedirectOk = false;
  try {
    const res = await fetch(`http://${clean}`, { method: "HEAD", redirect: "manual", cache: "no-store" });
    const loc = res.headers.get("location") || "";
    httpsRedirectOk = (res.status === 301 || res.status === 308) && loc.startsWith("https://");
  } catch { /* leave false */ }

  let singleHostOk = false;
  try {
    const bare = clean.replace(/^www\./, "");
    const [a, b] = await Promise.all([
      fetch(`https://${bare}`, { method: "HEAD", redirect: "manual", cache: "no-store" }).catch(() => null),
      fetch(`https://www.${bare}`, { method: "HEAD", redirect: "manual", cache: "no-store" }).catch(() => null),
    ]);
    const isRedirect = (r: Response | null) => !!r && [301, 302, 307, 308].includes(r.status);
    const is200 = (r: Response | null) => !!r && r.status === 200;
    singleHostOk = (is200(a) && isRedirect(b)) || (is200(b) && isRedirect(a));
  } catch { /* leave false */ }

  let llmsTxtPresent = false;
  try {
    const res = await fetch(`${httpsRoot}/llms.txt`, { method: "GET", cache: "no-store" });
    llmsTxtPresent = res.ok;
  } catch { /* leave false */ }

  // robots.txt: presence, whether it points at a sitemap, and whether it
  // makes a DELIBERATE AI-crawler decision (either direction counts — the
  // checklist asks for a decision, not a specific answer).
  let robotsTxtPresent = false, robotsMentionsSitemap = false, robotsAiCrawlerPolicy = false;
  try {
    const res = await fetch(`${httpsRoot}/robots.txt`, { method: "GET", cache: "no-store" });
    if (res.ok) {
      const txt = await res.text();
      robotsTxtPresent = true;
      robotsMentionsSitemap = /^\s*sitemap:/im.test(txt);
      robotsAiCrawlerPolicy = /(GPTBot|ClaudeBot|PerplexityBot|Google-Extended|CCBot|anthropic-ai)/i.test(txt);
    }
  } catch { /* leave false */ }

  return { checkedAt, real404, hostHonors404, singleHostOk, httpsRedirectOk, llmsTxtPresent, robotsTxtPresent, robotsMentionsSitemap, robotsAiCrawlerPolicy };
}
