// MANUAL adapter — page-publisher-build-spec.md's revised priority
// (2026-07-23, Anthony): built ahead of Wix, behind GIT_STATIC, because a
// real client (GoDaddy, confirmed no content API — see platform-
// limitations.mts) needs it now and it's the cheapest tier to build.
//
// There is no API at all on this platform. Everything publish/edit-related
// is genuinely NOT_YET here — not a Stage-2/3 backlog item like GIT_STATIC's
// stubs, but a permanent characteristic of the platform. The real mechanism
// for this adapter is the paste-package + post-paste verification flow
// (Stage 2+ work, once intake is built) — this file only covers what Stage
// 1 covers for every platform: proving the site is reachable and reading
// what already exists there, both of which genuinely don't need an API.
import { isUnsupported } from "./base-adapter.mts";
import { canonicalUrl } from "../urls.mts";
import type {
  PlatformAdapter, CapabilityFlags, Credentials, Site, ExistingUrl, VerifyResult,
  SupportResult, AdapterImage, AdapterPage, InboundLinkTask, LinkResult, PublishResult,
} from "./base-adapter.mts";

const NOT_YET = (what: string) => ({ supported: false as const, reason: `${what} has no API on this platform — this is a manual/paste-package step, not a Stage 2/3 gap.` });

export const manualCapabilities: CapabilityFlags = {
  canCreatePage: false,
  canCreatePost: false,
  canListExistingUrls: true, // best-effort, via sitemap.xml — see listExistingUrls
  canEditExistingPage: false,
  canSetCanonical: false,
  canSetMetaDescription: false,
  canInjectSchema: false,
  canUploadMedia: false,
  autoPublish: false,
};

// Turn a sitemap URL path into a rough human title — same placeholder
// caveat as git-static-adapter.mts's titleFromPath: this is "we know this
// URL exists," never "we know what it says."
export function titleFromUrlPath(pathname: string): string {
  const trimmed = pathname.replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "Home";
  const last = trimmed.split("/").pop() || trimmed;
  return last.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Shared by connect-manual-site.mts and page-publisher-list-urls.mts so the
// "paste a URL list" fallback and the low-confidence flag behave
// identically regardless of which endpoint triggered discovery.
export function parseManualUrls(raw: string | string[] | undefined): string[] {
  const list = Array.isArray(raw) ? raw : (raw || "").split(/\r?\n/);
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))];
}

// Flags a suspiciously thin (but non-empty) sitemap result — an outright
// failure already returns {supported:false}, but "found exactly 1 or 2
// pages" for what's presumably a real small-business site (contact, about,
// services...) is very likely the same sitemap-index bug this was written
// to catch, just on a platform/site this exact fix hasn't been proven
// against yet. Counts ONLY sitemap-discovered pages, never operator-pasted
// ones — a deliberate manual list of 1 URL isn't a red flag.
export function discoveredCountNote(discoveredCount: number): string | undefined {
  if (discoveredCount > 0 && discoveredCount <= 2) {
    return `Only ${discoveredCount} page${discoveredCount === 1 ? "" : "s"} found via sitemap discovery — implausibly low for most real sites. Check the sitemap manually, or paste a URL list below.`;
  }
  return undefined;
}

export const manualAdapter: PlatformAdapter = {
  platform: "manual",
  capabilities: manualCapabilities,

  async verifyConnection(_creds: Credentials, site: Site): Promise<VerifyResult> {
    if (!site.domain) return { ok: false, detail: "No domain configured for this site" };
    const url = site.domain.startsWith("http") ? site.domain : `https://${site.domain}`;
    try {
      const res = await fetch(url, { method: "GET", redirect: "follow", cache: "no-store" });
      if (!res.ok) return { ok: false, detail: `Domain responded with HTTP ${res.status} — confirm it's live before connecting` };
      return { ok: true, detail: `${url} is live and reachable` };
    } catch (e: any) {
      return { ok: false, detail: `Could not reach ${url}: ${String(e?.message || e)}` };
    }
  },

  // Best-effort only — there's no API, so this is literally fetching
  // whatever sitemap the platform auto-generates. Confirmed live 2026-07-23
  // against a real Wix client (Higher Power Electric — Wix uses the same
  // sitemap-index structure GoDaddy does): the root sitemap is very
  // commonly a <sitemapindex> whose <loc> entries point to CHILD sitemaps
  // (e.g. pages-sitemap.xml), not real pages. The original version of this
  // function extracted every <loc> tag regardless of parent element,
  // silently mistook the one child-sitemap link for "1 page found," and
  // never fetched the child at all. Fixed below: detect <sitemapindex> vs
  // <urlset> by root tag and recurse into child sitemaps one level.
  //
  // Returns unsupported rather than an empty list when nothing usable is
  // found, so callers don't mistake "couldn't check" for "genuinely zero
  // pages" — but ALSO see connect-manual-site.mts's lowConfidenceNote,
  // which flags a suspiciously thin (but non-empty) result the way an
  // outright failure alone wouldn't.
  async listExistingUrls(_creds: Credentials, site: Site): Promise<SupportResult<ExistingUrl[]>> {
    if (!site.domain) return { supported: false, reason: "No domain configured for this site" };
    const base = (site.domain.startsWith("http") ? site.domain : `https://${site.domain}`).replace(/\/+$/, "");

    const candidates: string[] = [];
    try {
      const robotsRes = await fetch(`${base}/robots.txt`, { cache: "no-store" });
      if (robotsRes.ok) {
        const robotsTxt = await robotsRes.text();
        for (const m of robotsTxt.matchAll(/^\s*Sitemap:\s*(\S+)/gim)) candidates.push(m[1]);
      }
    } catch { /* robots.txt is a nice-to-have hint, not required */ }
    candidates.push(`${base}/sitemap.xml`, `${base}/sitemap_index.xml`);
    const tried = [...new Set(candidates)];

    const pages = new Map<string, ExistingUrl>();
    const sitemapsUsed: string[] = [];
    const errors: string[] = [];
    let fetchBudget = 25; // total sitemap fetches (root + children) across every candidate — bounded, real sites don't need more

    const addPage = (loc: string, lastmod: string | null = null) => {
      // Canonicalized (urls.mts) before keying — sitemap <loc> values arrive
      // in arbitrary form (trailing slashes, www) and must match how link
      // targets resolve, or the same page gets counted twice / missed.
      const key = canonicalUrl(loc);
      if (!key || pages.has(key)) return;
      let pathname = key;
      try { pathname = new URL(key).pathname || "/"; } catch { /* not a full URL — use as-is */ }
      pages.set(key, { url: key, title: titleFromUrlPath(pathname), path: pathname, parentUrl: null, ...(lastmod ? { lastmod } : {}) } as any);
    };

    // Parses a <urlset> capturing BOTH <loc> and its sibling <lastmod>.
    // lastmod was previously discarded, which is why l1.crawl.sitemap_lastmod
    // was unimplementable (2026-07-26) — retaining it is a small reader
    // change that unlocks that check.
    const captureUrlset = (xml: string) => {
      for (const block of xml.matchAll(/<url\b[\s\S]*?<\/url>/gi)) {
        const seg = block[0];
        const loc = seg.match(/<loc>\s*([^<\s]+)\s*<\/loc>/i)?.[1];
        if (!loc) continue;
        const lastmod = seg.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i)?.[1] || null;
        addPage(loc, lastmod);
      }
      // Fallback for sitemaps that don't wrap entries in <url> (rare/malformed)
      if (!/<url\b/i.test(xml)) for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) addPage(m[1], null);
    };

    const fetchXml = async (url: string): Promise<string | null> => {
      if (fetchBudget-- <= 0) return null;
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) { errors.push(`HTTP ${res.status} at ${url}`); return null; }
        return await res.text();
      } catch (e: any) { errors.push(`Could not fetch ${url}: ${String(e?.message || e)}`); return null; }
    };

    for (const candidate of tried) {
      const xml = await fetchXml(candidate);
      if (!xml) continue;
      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
      if (locs.length === 0) continue;
      sitemapsUsed.push(candidate);
      if (/<sitemapindex[\s>]/i.test(xml)) {
        // Every loc here is a CHILD sitemap, not a page — fetch each and
        // pull real pages from its <urlset>.
        for (const childUrl of locs) {
          const childXml = await fetchXml(childUrl);
          if (!childXml) continue;
          sitemapsUsed.push(childUrl);
          captureUrlset(childXml);
        }
      } else {
        captureUrlset(xml);
      }
    }

    if (pages.size === 0) {
      return { supported: false, reason: `No sitemap found or all attempts empty. Tried: ${tried.join(", ")}${errors.length ? ` — ${errors.join("; ")}` : ""}` };
    }
    return [...pages.values()];
  },

  // The one adapter method that genuinely works here with zero API — this
  // is a plain fetch of whatever's already publicly live, which is exactly
  // the post-paste verification mechanism this platform depends on (Stage
  // 2+ builds the caller; this is just the reusable primitive).
  async fetchPageHtml(_creds: Credentials, _site: Site, url: string): Promise<SupportResult<string>> {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return { supported: false, reason: `HTTP ${res.status} fetching ${url}` };
      return await res.text();
    } catch (e: any) {
      return { supported: false, reason: `Could not fetch ${url}: ${String(e?.message || e)}` };
    }
  },

  async uploadImage(_creds: Credentials, _site: Site, _image: AdapterImage): Promise<SupportResult<{ remoteUrl: string }>> { return NOT_YET("Image upload"); },
  async publish(_creds: Credentials, _site: Site, _page: AdapterPage): Promise<SupportResult<PublishResult>> { return NOT_YET("Publishing"); },
  async update(_creds: Credentials, _site: Site, _page: AdapterPage, _platformRef: string): Promise<SupportResult<PublishResult>> { return NOT_YET("Updating a published page"); },
  async insertInboundLink(_creds: Credentials, _site: Site, _task: InboundLinkTask): Promise<SupportResult<LinkResult>> { return NOT_YET("Inserting an inbound link"); },
};
