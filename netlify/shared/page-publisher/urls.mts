// THE single URL canonicalization rule for Page Publisher. One file, one
// rule, imported everywhere a URL is keyed, stored, or compared.
//
// ─── Why this exists ───
// The first real scan (Rankin Waste, 2026-07-26) reported the homepage as an
// orphan because pageIndex keyed it "https://site.com/" while every link to
// it normalized to "https://site.com". Patching those two call sites wasn't
// enough — an audit at Anthony's insistence ("confirm the normalizer is
// called EVERYWHERE... a second normalization mismatch anywhere
// reintroduces phantom orphans") found SIX more unnormalized sites,
// including one causing a real intake bug: create-page compared a raw href
// ("/") against a raw pageIndex key ("https://site.com/") and so rejected
// any page linking to the homepage as a BROKEN LINK.
//
// The rule: every page URL and every internal link target passes through
// canonicalUrl() before being used as a key or compared. Absolute form,
// https, no "www.", no trailing slash (except the bare root, which becomes
// the host with no path).
//
// Deliberately NOT lowercasing the path: URL paths are case-sensitive per
// RFC 3986, and silently equating /Services with /services would be a
// different (quieter) class of wrong answer than the one this fixes.

// Canonicalizes any absolute URL. Safe to call repeatedly — idempotent.
export function canonicalUrl(url: string): string {
  const trimmed = (url || "").trim();
  if (!trimmed) return "";
  try {
    const u = new URL(trimmed);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, ""); // "/" -> "", "/a/" -> "/a"
    return `https://${host}${path}`;
  } catch {
    // Not a parseable absolute URL — strip a trailing slash and return as-is
    // rather than throwing, so a caller with a bare path still gets a
    // stable, comparable string.
    return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
  }
}

// Resolves an href found in page content against the site's domain.
// Returns the canonical absolute URL if it's an INTERNAL page link, or null
// if it isn't one at all (external host, tel:, mailto:, #fragment,
// javascript:, data:, protocol-relative to another host).
export function canonicalInternalHref(href: string, domain: string): string | null {
  const raw = (href || "").trim();
  if (!raw || /^(tel:|mailto:|sms:|#|javascript:|data:)/i.test(raw)) return null;

  const siteHost = canonicalHost(domain);
  if (!siteHost) return null;

  if (/^https?:\/\//i.test(raw)) {
    let host: string;
    try { host = new URL(raw).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return null; }
    if (host !== siteHost) return null;
    return canonicalUrl(raw);
  }
  if (raw.startsWith("//")) return null; // protocol-relative → another host

  const path = raw.startsWith("/") ? raw : "/" + raw;
  // Drop query/fragment for identity purposes — "/a?utm=1" and "/a#top" are
  // the same PAGE, and treating them as distinct would both miss real
  // inbound links and invent phantom broken ones.
  const clean = path.split("#")[0].split("?")[0];
  return canonicalUrl(`https://${siteHost}${clean}`);
}

export function canonicalHost(domain: string): string {
  const d = (domain || "").trim();
  if (!d) return "";
  try {
    if (/^https?:\/\//i.test(d)) return new URL(d).hostname.replace(/^www\./i, "").toLowerCase();
  } catch { /* fall through */ }
  return d.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").toLowerCase();
}

// Builds a canonical page URL from a site domain + a site-relative path.
// Replaces ad-hoc `buildPageUrl(...) || urlPath` usage inside Page
// Publisher so every pageIndex key is produced by one code path.
export function canonicalPageUrlFromPath(domain: string, urlPath: string): string {
  const host = canonicalHost(domain);
  if (!host) return canonicalUrl(urlPath);
  const path = urlPath.startsWith("/") ? urlPath : "/" + urlPath;
  return canonicalUrl(`https://${host}${path}`);
}
