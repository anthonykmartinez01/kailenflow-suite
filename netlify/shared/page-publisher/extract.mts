// Link + schema + title extraction from a page's SOURCE — used by the
// whole-site scan (page-publisher-build-spec.md §5a, Stage 3 item 3).
//
// Regex-based on purpose: this runs server-side in a Netlify Function where
// there's no DOMParser (that's a browser API — the intake pipeline in
// public/index.html uses the real DOM precisely because it CAN). Adding a
// DOM library just for this would be a native-dependency cost for no gain,
// since everything needed here (href values, ld+json blocks, title text) is
// reliably extractable with anchored patterns.
//
// IMPORTANT: what this reads is Astro/MD SOURCE, not rendered HTML. That
// means a link written as `href={someVariable}` or built inside a .map() is
// NOT statically extractable — see UNRESOLVED_HREF below. Those are
// reported as such rather than dropped, because silently ignoring them
// would undercount inbound links and produce false orphans.

export interface ExtractedPage {
  links: string[];               // resolvable internal/external hrefs found in source
  unresolvedHrefCount: number;   // dynamic hrefs (href={expr}) that can't be read statically
  schemaTypes: string[];         // @type values found in any ld+json block
  schemaIds: string[];           // @id values found — feeds the entity-graph consistency check
  schemaParseError: string | null;
  title: string | null;          // best-effort: frontmatter title, <title>, or first <h1>
}

// href={...} / href={`...`} — a JSX/Astro expression, not a literal URL.
const DYNAMIC_HREF_RE = /href=\{/g;
const LITERAL_HREF_RE = /href=["']([^"']+)["']/gi;
const LDJSON_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const TITLE_TAG_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
// Frontmatter `title: "..."` or `title = "..."` (Astro frontmatter is JS/TS,
// so both shapes occur; confirmed against real client repos this session
// that Astro frontmatter is NOT flat YAML).
const FM_TITLE_RE = /^\s*(?:const\s+)?title\s*[:=]\s*["'`]([^"'`]+)["'`]/m;

function collectTypesAndIds(node: any, types: Set<string>, ids: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) collectTypesAndIds(n, types, ids); return; }
  if (typeof node["@type"] === "string") types.add(node["@type"]);
  else if (Array.isArray(node["@type"])) for (const t of node["@type"]) if (typeof t === "string") types.add(t);
  if (typeof node["@id"] === "string") ids.add(node["@id"]);
  for (const key of Object.keys(node)) {
    if (key === "@type" || key === "@id") continue;
    collectTypesAndIds(node[key], types, ids);
  }
}

export function extractFromSource(source: string): ExtractedPage {
  const links: string[] = [];
  for (const m of source.matchAll(LITERAL_HREF_RE)) {
    const href = m[1].trim();
    // Skip template-literal fragments that slipped through as literals
    // (e.g. href="${x}") — they're dynamic, not real targets.
    if (!href || href.includes("${") || href.startsWith("{")) continue;
    links.push(href);
  }
  const unresolvedHrefCount = [...source.matchAll(DYNAMIC_HREF_RE)].length;

  const types = new Set<string>();
  const ids = new Set<string>();
  let schemaParseError: string | null = null;
  for (const m of source.matchAll(LDJSON_RE)) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      collectTypesAndIds(JSON.parse(raw), types, ids);
    } catch (e: any) {
      // Recorded, not thrown — one malformed block on one page must not
      // abort a whole-site scan.
      schemaParseError = String(e?.message || e);
    }
  }

  let title: string | null = null;
  const fm = source.match(FM_TITLE_RE);
  if (fm) title = fm[1].trim();
  if (!title) {
    const t = source.match(TITLE_TAG_RE);
    if (t) title = t[1].replace(/<[^>]+>/g, "").trim() || null;
  }
  if (!title) {
    const h = source.match(H1_RE);
    if (h) title = h[1].replace(/<[^>]+>/g, "").trim() || null;
  }

  return { links: [...new Set(links)], unresolvedHrefCount, schemaTypes: [...types], schemaIds: [...ids], schemaParseError, title };
}

// Head facts parsed from a LIVE rendered page — stores booleans/values, not
// raw markup, deliberately: the scan blob would balloon if it retained every
// page's <head> verbatim, and the gate only ever needs the parsed answers.
// Unlocks 7 checklist items that were previously not_implemented because the
// scan discarded head markup (2026-07-26).
//
// Only meaningful against LIVE HTML — an .astro source file's head lives in
// its layout component, not the page, so parsing source here would produce
// false negatives on every page.
export interface HeadFacts {
  lang: string | null;
  hasViewport: boolean;
  hasCharset: boolean;
  faviconCount: number;
  ogTagCount: number;
  twitterTagCount: number;
  hasNoindex: boolean;
  canonicalHref: string | null;
  // Heuristic: a real SPA shell has an empty root div and ships a big JS
  // bundle. Deliberately conservative — reports what it saw rather than
  // asserting "this is an SPA".
  emptyRootDiv: boolean;
  bodyTextLength: number;
}

export function extractHeadFacts(html: string): HeadFacts {
  const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  const head = headMatch ? headMatch[1] : "";
  const langMatch = html.match(/<html[^>]*\slang=["']([^"']+)["']/i);
  const metaTags = [...head.matchAll(/<meta\s+[^>]*>/gi)].map((m) => m[0]);
  const linkTags = [...head.matchAll(/<link\s+[^>]*>/gi)].map((m) => m[0]);
  const robotsMeta = metaTags.find((t) => /name=["']robots["']/i.test(t)) || "";
  const canonicalTag = linkTags.find((t) => /rel=["']canonical["']/i.test(t)) || "";
  const canonicalHref = canonicalTag.match(/href=["']([^"']+)["']/i)?.[1] || null;
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;

  return {
    lang: langMatch ? langMatch[1] : null,
    hasViewport: metaTags.some((t) => /name=["']viewport["']/i.test(t)),
    hasCharset: metaTags.some((t) => /charset=/i.test(t)),
    faviconCount: linkTags.filter((t) => /rel=["'][^"']*icon[^"']*["']/i.test(t)).length,
    ogTagCount: metaTags.filter((t) => /property=["']og:/i.test(t)).length,
    twitterTagCount: metaTags.filter((t) => /name=["']twitter:/i.test(t)).length,
    hasNoindex: /noindex/i.test(robotsMeta),
    canonicalHref,
    emptyRootDiv: /<div[^>]+id=["'](root|app|__next)["'][^>]*>\s*<\/div>/i.test(body),
    bodyTextLength: body.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length,
  };
}

// URL canonicalization lives in ONE place — urls.mts. These re-exports keep
// existing imports working while guaranteeing there is only one rule (see
// urls.mts's header for the phantom-orphan bug that made this necessary).
export { canonicalInternalHref as normalizeInternalHref, canonicalUrl as canonicalPageUrl } from "./urls.mts";
