// THE canonical checklist registry — page-publisher-build-spec.md §5/§5b.
// Formalizes the full audit (spec §5b, 2026-07-23) into real code so every
// item ID used anywhere in the gate reconciles against one list instead of
// ad-hoc strings scattered across functions.
//
// Item IDs match §5b's audit table exactly. If you add an item here, add it
// to that table too — the table is the human-readable index, this is the
// machine-readable one, and they are meant to stay in lockstep.
//
// ─── §5a's non-negotiable rule, encoded STRUCTURALLY ───
// Anthony's explicit requirement (2026-07-23): "site-scoped failures must
// NOT hard-block every page forever... otherwise one missing llms.txt
// bricks the whole client until someone fixes it, and I'll end up wanting
// an override button — which we agreed not to have."
//
// So `blockingBehavior` is a real field on every item, not a UI convention
// a later change could quietly undo:
//   - 'blocks_page'              → a real failure on THIS page. Hard-blocks
//                                  this page's publish. Zero override.
//   - 'requires_acknowledgment'  → a pre-existing SITE-level problem. Raises
//                                  a persistent site banner and must be
//                                  acknowledged per page, but never
//                                  permanently blocks publishing. This is
//                                  the mechanism that makes an override
//                                  button unnecessary rather than tempting.
//   - 'warning'                  → surfaced, never blocks, never needs an ack.
//
// `scope` drives the report's visual separation (Anthony's ask #2, same
// date): 'page' items render under "This page", 'site'/'live_host' items
// under "This client's site — pre-existing". Same data, different meaning,
// distinguishable at a glance.

export type ItemLayer = 1 | 2 | "x";
export type ItemScope = "page" | "site" | "live_host";
export type BlockingBehavior = "blocks_page" | "requires_acknowledgment" | "warning";
// 'implemented'  — real code enforces/verifies this today
// 'stage3'       — planned, mechanism identified, not built
// 'reused'       — satisfied by existing code elsewhere in this app (named in `note`)
// 'not_our_job'  — deliberately out of this tool's remit (reason in `note`)
export type ImplStatus = "implemented" | "stage3" | "reused" | "not_our_job";

export interface ChecklistItem {
  id: string;
  layer: ItemLayer;
  category: string;
  label: string;
  scope: ItemScope;
  blockingBehavior: BlockingBehavior;
  status: ImplStatus;
  note?: string;
}

export const CHECKLIST_ITEMS: ChecklistItem[] = [
  // ─── Layer 1 — Rendering & performance ───
  { id: "l1.render.static_html", layer: 1, category: "Rendering & performance", label: "Full content in the initial HTML response", scope: "page", blockingBehavior: "blocks_page", status: "stage3" },
  { id: "l1.render.no_spa", layer: 1, category: "Rendering & performance", label: "No client-side-rendered content", scope: "site", blockingBehavior: "requires_acknowledgment", status: "stage3" },
  { id: "l1.render.minimal_css", layer: 1, category: "Rendering & performance", label: "No render-blocking stylesheets", scope: "site", blockingBehavior: "warning", status: "stage3" },
  { id: "l1.render.no_blocking_js", layer: 1, category: "Rendering & performance", label: "No render-blocking JavaScript", scope: "site", blockingBehavior: "warning", status: "stage3" },
  { id: "l1.render.font_display_swap", layer: 1, category: "Rendering & performance", label: "font-display: swap + preloaded fonts", scope: "site", blockingBehavior: "warning", status: "stage3" },
  { id: "l1.render.lcp_preload", layer: 1, category: "Rendering & performance", label: "LCP image preloaded", scope: "page", blockingBehavior: "warning", status: "stage3" },
  { id: "l1.render.img_dimensions", layer: 1, category: "Rendering & performance", label: "Explicit width/height on every image", scope: "page", blockingBehavior: "blocks_page", status: "implemented", note: "Intake flags missing height; real dimensions read from the uploaded file, never trusted from pasted markup." },
  { id: "l1.render.lazy_below_fold", layer: 1, category: "Rendering & performance", label: "loading=lazy below the fold only, never on LCP", scope: "page", blockingBehavior: "warning", status: "implemented", note: "LCP marking removes loading=lazy from the chosen image." },
  { id: "l1.render.modern_img_formats", layer: 1, category: "Rendering & performance", label: "WebP/AVIF with srcset", scope: "page", blockingBehavior: "warning", status: "implemented", note: "Real WebP conversion + srcset via Canvas at intake." },
  { id: "l1.render.compression", layer: 1, category: "Rendering & performance", label: "Brotli/gzip enabled", scope: "live_host", blockingBehavior: "warning", status: "stage3" },
  { id: "l1.render.cache_headers", layer: 1, category: "Rendering & performance", label: "Cache headers configured", scope: "live_host", blockingBehavior: "warning", status: "stage3" },

  // ─── Layer 1 — URLs & redirects ───
  { id: "l1.url.single_host", layer: 1, category: "URLs & redirects", label: "Single canonical hostname", scope: "live_host", blockingBehavior: "requires_acknowledgment", status: "stage3" },
  { id: "l1.url.https_redirect", layer: 1, category: "URLs & redirects", label: "HTTP → HTTPS 301", scope: "live_host", blockingBehavior: "requires_acknowledgment", status: "stage3" },
  { id: "l1.url.trailing_slash", layer: 1, category: "URLs & redirects", label: "Trailing-slash consistency", scope: "live_host", blockingBehavior: "requires_acknowledgment", status: "reused", note: "indexing.mts's resolveCanonicalUrl already handles this app-wide (Part A); not yet wired into this gate's report." },
  { id: "l1.url.lowercase_hyphens", layer: 1, category: "URLs & redirects", label: "Lowercase, hyphenated, clean URLs", scope: "page", blockingBehavior: "warning", status: "stage3" },
  { id: "l1.url.canonical_self_ref", layer: 1, category: "URLs & redirects", label: "Self-referencing canonical tag", scope: "page", blockingBehavior: "blocks_page", status: "implemented", note: "Built 2026-07-26 by verifying the site template emits a canonical (scan head sample). Permanently N/A on MANUAL — see platform-limitations.mts (l1.url.canonical_custom)." },
  { id: "l1.url.slug_redirect", layer: 1, category: "URLs & redirects", label: "Slug change generates a persistent 301", scope: "site", blockingBehavior: "warning", status: "stage3" },
  { id: "l1.url.mixed_content_hsts", layer: 1, category: "URLs & redirects", label: "No mixed content; HSTS set", scope: "live_host", blockingBehavior: "requires_acknowledgment", status: "stage3" },

  // ─── Layer 1 — HTTP status code integrity ───
  { id: "l1.http.real_404", layer: 1, category: "HTTP status integrity", label: "Real 404s return HTTP 404", scope: "live_host", blockingBehavior: "requires_acknowledgment", status: "stage3" },
  { id: "l1.http.real_301", layer: 1, category: "HTTP status integrity", label: "Redirects return real 301s", scope: "live_host", blockingBehavior: "requires_acknowledgment", status: "stage3" },
  { id: "l1.http.no_fake_200", layer: 1, category: "HTTP status integrity", label: "Never 200 for a missing page", scope: "live_host", blockingBehavior: "requires_acknowledgment", status: "stage3" },
  { id: "l1.http.host_honors", layer: 1, category: "HTTP status integrity", label: "Host itself honors status codes", scope: "live_host", blockingBehavior: "requires_acknowledgment", status: "stage3" },

  // ─── Layer 1 — Crawling & indexing ───
  { id: "l1.crawl.sitemap_present", layer: 1, category: "Crawling & indexing", label: "XML sitemap present", scope: "site", blockingBehavior: "requires_acknowledgment", status: "implemented", note: "MANUAL: real sitemap-index-aware discovery. GIT_STATIC uses schedule.ts per the platform model." },
  { id: "l1.crawl.sitemap_inclusion", layer: 1, category: "Crawling & indexing", label: "Sitemap lists only indexable/canonical/200 pages", scope: "site", blockingBehavior: "requires_acknowledgment", status: "implemented", note: "Built 2026-07-26 — flags sitemap URLs with no matching real page (they would 404 for a crawler)." },
  { id: "l1.crawl.sitemap_lastmod", layer: 1, category: "Crawling & indexing", label: "Accurate sitemap lastmod", scope: "site", blockingBehavior: "warning", status: "stage3" },
  { id: "l1.crawl.robots_present", layer: 1, category: "Crawling & indexing", label: "robots.txt present and correct", scope: "site", blockingBehavior: "requires_acknowledgment", status: "stage3", note: "Confirmed present by default on GoDaddy (2026-07-23); still verified generally." },
  { id: "l1.crawl.robots_custom", layer: 1, category: "Crawling & indexing", label: "robots.txt is editable when it needs to be", scope: "site", blockingBehavior: "warning", status: "stage3", note: "Permanently N/A on MANUAL." },
  { id: "l1.crawl.ai_crawler_policy", layer: 1, category: "Crawling & indexing", label: "Deliberate AI-crawler policy", scope: "site", blockingBehavior: "warning", status: "stage3", note: "Permanently N/A on MANUAL (robots.txt not editable)." },
  { id: "l1.crawl.llms_txt", layer: 1, category: "Crawling & indexing", label: "llms.txt present", scope: "live_host", blockingBehavior: "warning", status: "stage3", note: "liveHostChecks.llmsTxtPresent — populated by the site scan. Deliberately a warning, never blocking: this is exactly the 'one missing llms.txt must not brick a client' case." },
  { id: "l1.crawl.noindex_utility", layer: 1, category: "Crawling & indexing", label: "noindex on utility pages", scope: "page", blockingBehavior: "warning", status: "stage3", note: "Permanently N/A on MANUAL — <head>-only tag, Custom Code reaches <body> only." },
  { id: "l1.crawl.indexnow", layer: 1, category: "Crawling & indexing", label: "IndexNow ping on publish", scope: "site", blockingBehavior: "warning", status: "implemented", note: "Key generation + key-file commit built (GIT_STATIC); the ping call itself is Stage 3. Permanently N/A on MANUAL." },
  { id: "l1.crawl.gsc_verification", layer: 1, category: "Crawling & indexing", label: "Search Console verified", scope: "site", blockingBehavior: "warning", status: "reused", note: "Reads the existing client.gscProperty (GSCSection/gsc-data.mts, Part A) — Page Publisher does not build its own GSC verification." },

  // ─── Layer 1 — Document fundamentals ───
  { id: "l1.doc.lang_attribute", layer: 1, category: "Document fundamentals", label: "<html lang> set", scope: "site", blockingBehavior: "requires_acknowledgment", status: "stage3" },
  { id: "l1.doc.viewport_charset", layer: 1, category: "Document fundamentals", label: "Viewport + charset declared", scope: "site", blockingBehavior: "requires_acknowledgment", status: "stage3" },
  { id: "l1.doc.favicon_set", layer: 1, category: "Document fundamentals", label: "Complete favicon set", scope: "site", blockingBehavior: "warning", status: "stage3" },
  { id: "l1.doc.og_twitter_tags", layer: 1, category: "Document fundamentals", label: "Open Graph + Twitter Card tags", scope: "page", blockingBehavior: "warning", status: "stage3", note: "Permanently N/A on MANUAL — <head>-only, confirmed by GoDaddy's own UI copy (2026-07-23)." },
  { id: "l1.doc.semantic_html", layer: 1, category: "Document fundamentals", label: "HTML5 semantic sectioning", scope: "page", blockingBehavior: "warning", status: "stage3" },
  { id: "l1.doc.breadcrumb_website_schema", layer: 1, category: "Document fundamentals", label: "Breadcrumb + WebSite schema", scope: "page", blockingBehavior: "warning", status: "stage3", note: "§6b merge not built. Permanently N/A on MANUAL." },
  { id: "l1.doc.schema_dates", layer: 1, category: "Document fundamentals", label: "datePublished / dateModified in schema", scope: "page", blockingBehavior: "warning", status: "stage3", note: "Permanently N/A on MANUAL." },

  // ─── Layer 1 — Build-time validation (the seven hard blockers) ───
  // Every one of these is genuinely about the page being published EXCEPT
  // where noted — the sitewide ones (duplicate titles, sitemap integrity,
  // orphans across the whole site) are pre-existing-site problems by
  // nature and so are acknowledgment-scoped, per §5a. That distinction is
  // the whole reason blockingBehavior exists as a separate field from scope.
  { id: "l1.gate.broken_internal_links", layer: 1, category: "Build-time validation", label: "No broken internal links", scope: "page", blockingBehavior: "blocks_page", status: "implemented", note: "Outbound-link validation at intake blocks save (client + server)." },
  { id: "l1.gate.orphan_pages", layer: 1, category: "Build-time validation", label: "No orphan pages", scope: "page", blockingBehavior: "blocks_page", status: "implemented", note: "Per-page orphan gate at intake (2+ inbound links). The SITEWIDE orphan scan is l1.gate.orphan_pages_sitewide." },
  { id: "l1.gate.orphan_pages_sitewide", layer: 1, category: "Build-time validation", label: "No orphan pages anywhere on the site", scope: "site", blockingBehavior: "requires_acknowledgment", status: "stage3", note: "Pre-existing orphans elsewhere on a client's site are not this page's fault — acknowledgment, never a permanent block." },
  { id: "l1.gate.missing_duplicate_titles", layer: 1, category: "Build-time validation", label: "No missing or duplicate titles", scope: "site", blockingBehavior: "requires_acknowledgment", status: "implemented", note: "Built 2026-07-26. Requires a completed site scan — real titles, not path-derived placeholders." },
  { id: "l1.gate.missing_canonical", layer: 1, category: "Build-time validation", label: "No missing canonicals", scope: "page", blockingBehavior: "blocks_page", status: "implemented", note: "Same evaluator as l1.url.canonical_self_ref. Permanently N/A on MANUAL." },
  { id: "l1.gate.missing_alt", layer: 1, category: "Build-time validation", label: "No missing alt text", scope: "page", blockingBehavior: "blocks_page", status: "implemented", note: "Hard block at intake, client + server." },
  { id: "l1.gate.schema_invalid", layer: 1, category: "Build-time validation", label: "Schema parses and validates", scope: "page", blockingBehavior: "blocks_page", status: "implemented", note: "Parse-validity checked at intake; real schema.org structural validation is Stage 3. Permanently N/A on MANUAL." },
  { id: "l1.gate.sitemap_integrity", layer: 1, category: "Build-time validation", label: "Sitemap integrity", scope: "site", blockingBehavior: "requires_acknowledgment", status: "implemented", note: "Built 2026-07-26 — the other direction from sitemap_inclusion: real pages MISSING from the sitemap." },

  // ─── Layer 2 — Titles & meta ───
  { id: "l2.meta.unique_title", layer: 2, category: "Titles & meta", label: "Unique title per page", scope: "site", blockingBehavior: "requires_acknowledgment", status: "implemented", note: "Built 2026-07-26 — same evaluator as l1.gate.missing_duplicate_titles." },
  { id: "l2.meta.unique_description", layer: 2, category: "Titles & meta", label: "Unique meta description per page", scope: "site", blockingBehavior: "requires_acknowledgment", status: "stage3" },
  { id: "l2.meta.single_h1", layer: 2, category: "Titles & meta", label: "Exactly one H1", scope: "page", blockingBehavior: "blocks_page", status: "implemented", note: "Detection + hero-div promotion at intake, verified against real generator output." },
  // UPGRADED to acknowledgment 2026-07-26 (Anthony): "skipped levels are a
  // real defect; warning-only lets it slide silently." Not blocks_page —
  // a skipped level is a structural flaw worth stopping to look at, not a
  // reason a page can never ship.
  { id: "l2.meta.heading_hierarchy", layer: 2, category: "Titles & meta", label: "Logical heading hierarchy, no skipped levels", scope: "page", blockingBehavior: "requires_acknowledgment", status: "implemented" },

  // ─── Layer 2 — Internal linking architecture ───
  { id: "l2.links.zero_orphans", layer: 2, category: "Internal linking", label: "Every page reachable via internal links", scope: "page", blockingBehavior: "blocks_page", status: "implemented", note: "Same intake gate as l1.gate.orphan_pages." },
  { id: "l2.links.contextual_siblings", layer: 2, category: "Internal linking", label: "Contextual links between sibling pages", scope: "page", blockingBehavior: "warning", status: "stage3", note: "Sibling suggestion deliberately not built in the §6d round — a suggestion feature, never a blocking requirement." },
  { id: "l2.links.hub_to_spoke", layer: 2, category: "Internal linking", label: "Hub-to-spoke linking", scope: "page", blockingBehavior: "blocks_page", status: "implemented", note: "Parent/hub picker + auto-proposed inbound task at intake." },
  { id: "l2.links.descriptive_anchors", layer: 2, category: "Internal linking", label: "Descriptive anchor text", scope: "page", blockingBehavior: "warning", status: "implemented", note: "Non-blocking warning in the intake outbound table." },

  // ─── Layer 2 — Schema depth ───
  { id: "l2.schema.local_business", layer: 2, category: "Schema depth", label: "LocalBusiness schema with NAP/geo/hours/sameAs", scope: "page", blockingBehavior: "warning", status: "stage3", note: "Permanently N/A on MANUAL (l2.schema.* wildcard)." },
  { id: "l2.schema.service", layer: 2, category: "Schema depth", label: "Service schema on service pages", scope: "page", blockingBehavior: "warning", status: "stage3", note: "Permanently N/A on MANUAL." },
  { id: "l2.schema.article", layer: 2, category: "Schema depth", label: "Article schema on blog pages", scope: "page", blockingBehavior: "warning", status: "stage3", note: "Permanently N/A on MANUAL." },
  { id: "l2.schema.faq", layer: 2, category: "Schema depth", label: "FAQPage schema where warranted", scope: "page", blockingBehavior: "warning", status: "stage3", note: "Permanently N/A on MANUAL." },
  { id: "l2.schema.entity_graph", layer: 2, category: "Schema depth", label: "One connected JSON-LD graph with stable @ids", scope: "site", blockingBehavior: "requires_acknowledgment", status: "stage3", note: "Sitewide by nature — needs siteGraph.schemaGraph. Permanently N/A on MANUAL." },

  // ─── Layer 2 — Images ───
  { id: "l2.img.alt_descriptive", layer: 2, category: "Images", label: "Descriptive alt text on every image", scope: "page", blockingBehavior: "blocks_page", status: "implemented" },
  { id: "l2.img.filenames", layer: 2, category: "Images", label: "Descriptive image filenames", scope: "page", blockingBehavior: "warning", status: "implemented", note: "Generated from alt text at intake." },

  // ─── Layer 2 — E-E-A-T trust pages ───
  // Reclassified 2026-07-23 (Anthony: "the checklist has no out-of-scope
  // tier") — these are real site-scoped checks with concrete mechanisms,
  // not unaudited gaps. All acknowledgment-scoped: a client site missing a
  // privacy policy is a real finding, but it is emphatically not a reason
  // to block an unrelated service page from publishing.
  { id: "l2.trust.about_page", layer: 2, category: "Trust pages", label: "About page exists", scope: "site", blockingBehavior: "requires_acknowledgment", status: "stage3", note: "pageIndex title/path scan — no new data needed." },
  { id: "l2.trust.contact_nap", layer: 2, category: "Trust pages", label: "Contact page with NAP matching GBP", scope: "site", blockingBehavior: "requires_acknowledgment", status: "stage3", note: "Existence via pageIndex scan; NAP match via fetchPageHtml + the client's existing NAP fields in appData/main." },
  { id: "l2.trust.privacy_terms", layer: 2, category: "Trust pages", label: "Privacy policy + terms exist", scope: "site", blockingBehavior: "requires_acknowledgment", status: "stage3", note: "pageIndex title/path scan." },
  { id: "l2.trust.author_pages", layer: 2, category: "Trust pages", label: "Author pages exist (if the site has a blog)", scope: "site", blockingBehavior: "warning", status: "stage3", note: "pageIndex scan, conditional on any pageType:'blog' pages existing." },
  { id: "l2.trust.content_depth", layer: 2, category: "Trust pages", label: "Trust content answers real buyer questions", scope: "site", blockingBehavior: "warning", status: "not_our_job", note: "Qualitative judgment, not a mechanical pass/fail — the content-ranker skill or manual review owns this. Surfaced as a reminder in the report, never auto-scored." },

  // ─── Additions that are NOT checklist items ───
  // 'x.' prefix so a future reconciliation can never mistake these for
  // items from the real checklist. See spec §5b.
  { id: "x.links.external_reachable", layer: "x", category: "My additions", label: "External links are still reachable (not dead)", scope: "page", blockingBehavior: "warning", status: "stage3", note: "MY OWN ADDITION, not from the checklist. Needs a new externalLinks[] field on PagePublisherPage — planned, not built." },
];

const BY_ID = new Map(CHECKLIST_ITEMS.map((i) => [i.id, i]));

export function getItem(id: string): ChecklistItem | undefined {
  return BY_ID.get(id);
}

export function itemsByScope(scope: ItemScope): ChecklistItem[] {
  return CHECKLIST_ITEMS.filter((i) => i.scope === scope);
}

// The set a gate report must treat as hard page blockers — deliberately a
// derived function rather than a hand-maintained second list, so it can
// never drift out of sync with the registry above.
export function pageBlockingItems(): ChecklistItem[] {
  return CHECKLIST_ITEMS.filter((i) => i.blockingBehavior === "blocks_page");
}

export function acknowledgmentItems(): ChecklistItem[] {
  return CHECKLIST_ITEMS.filter((i) => i.blockingBehavior === "requires_acknowledgment");
}
