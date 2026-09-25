// Per-platform PERMANENTLY N/A gate items — page-publisher-build-spec.md
// §5's "unverifiable never counts as pass" rule is for a runtime result that
// could vary; this is different on purpose. Some Layer 1 items are
// structurally impossible on a given platform, always, for every page,
// forever (GoDaddy has no robots.txt editing — that's not a per-page
// finding, it's a fact about GoDaddy). Anthony's explicit instruction
// (2026-07-23): stop reporting those as a warning on every single page —
// that trains the operator to ignore the report. Instead: classify once,
// at connect time, per site (see connect-manual-site's use of this map),
// store on PagePublisherSite.naGateItems, and have the eventual gate report
// (Stage 3) filter these item keys out of the main pass/fail list entirely,
// showing them once in their own collapsed "Permanently N/A for this
// platform" section with the reason attached.
//
// Item keys follow the `l1.<category>.<item>` convention already used
// elsewhere in the build spec (l1.crawl.indexnow, l1.render.img_dimensions,
// etc.) but these specific keys are PROVISIONAL — Stage 3 builds the real
// `checklist-items.mts` registry every item key must ultimately reconcile
// against. Don't treat these strings as final.
//
// A key ending in ".*" is a WILDCARD covering every item under that prefix
// (e.g. "l2.schema.*" covers l2.schema.local_business, l2.schema.service,
// l2.schema.article, l2.schema.faq, l2.schema.entity_graph — the whole
// Layer 2 "schema depth" section at once) — use isItemNA() below rather
// than a plain key lookup so wildcards actually apply.
import type { Platform } from "./adapters/base-adapter.mts";

export const PLATFORM_NA_ITEMS: Record<Platform, Record<string, string>> = {
  // GIT_STATIC has the strongest position of any adapter (§5a) — the whole
  // repo is readable at commit time, so nothing here is structurally
  // impossible. Empty on purpose, not an oversight.
  git_static: {},

  // GoDaddy Website Builder — confirmed via research 2026-07-23 (no public
  // content API; developer.godaddy.com only covers Domains/Certificates/
  // Shoppers-type endpoints) plus Anthony's own hands-on verification of the
  // HTML-block schema test.
  manual: {
    "l1.crawl.robots_custom": "GoDaddy auto-generates robots.txt; there is no editing surface for it, on any plan.",
    "l1.crawl.sitemap_control": "GoDaddy auto-generates and maintains sitemap.xml from its own page list; content/inclusion isn't controllable.",
    "l1.url.canonical_custom": "No canonical-tag control in GoDaddy Website Builder — known duplicate-homepage-canonical behavior is a platform default, not a fixable per-page setting. Independently confirmed by the <head>-only placement issue too (2026-07-23): a canonical tag only functions in <head>, and Custom Code only reaches <body>.",
    "l1.crawl.indexnow": "No file-upload or API mechanism to host an IndexNow key file at the domain root — IndexNow is unreachable on this platform regardless of engineering effort.",
    "l1.crawl.ai_crawler_policy": "Same robots.txt restriction as above — an explicit AI-crawler allow/block decision isn't possible when robots.txt itself isn't editable.",

    // CONFIRMED FAILED — Anthony's hands-on test, 2026-07-23. Procedure: a
    // minimal `<script type="application/ld+json">{"@type":"Thing",...}</script>`
    // probe pasted into GoDaddy's HTML/Custom-Code block on a live page,
    // published for real (not preview). View-source showed the tag
    // HTML-entity-encoded (&quot; instead of ", &lt;/script&gt; instead of
    // </script>) — it renders as visible text on the page, never executes
    // as a script tag. Confirmed authoritatively via Google's Rich Results
    // Test against the live published page (https://poolclean.us/privacy-policy):
    // "No items detected" — the page crawled successfully and Google found
    // no structured data at all. JSON-LD/schema injection is impossible on
    // this platform via Custom Code — this is a platform fact, not a gap to
    // close. DO NOT re-attempt without re-testing on this exact platform
    // first (GoDaddy could change the editor's sanitizer in the future).
    "l1.doc.breadcrumb_website_schema": "GoDaddy's Custom Code block HTML-entity-encodes <script> tags — schema never executes. Confirmed 2026-07-23 via Google Rich Results Test ('No items detected') on a live published page.",
    "l1.doc.schema_dates": "Same root cause — datePublished/dateModified live inside the same non-executing JSON-LD block.",
    "l1.gate.schema_invalid": "There's no valid schema to validate — it never parses as JSON-LD on the live page at all (renders as visible entity-encoded text instead).",
    "l2.schema.*": "Entire Layer 2 schema-depth section (LocalBusiness/Service/Article/FAQPage schema, the connected JSON-LD entity graph) — all of it depends on a <script> tag surviving Custom Code, which it doesn't. Confirmed 2026-07-23, same test as above.",

    // CONFIRMED BY PLATFORM DOCUMENTATION, not a hands-on probe — recorded
    // as such deliberately (2026-07-23) so anyone revisiting this knows the
    // evidence type and can verify directly if they want to. GoDaddy's own
    // Custom Code panel states it injects "HTML, CSS, & JavaScript into
    // your site between the <Body> tags." Meta/link tags only function
    // inside <head> — so even in the hypothetical where they survive
    // unencoded (untested — the schema probe only confirmed <script>
    // entity-encoding, not tag placement), landing in <body> makes them
    // non-functional regardless. Anything that can ONLY be achieved via a
    // <head>-only tag with no native GoDaddy UI control is therefore
    // permanently N/A here — this is a placement problem, not an encoding
    // problem, and would hold even if the encoding issue were ever fixed.
    "l1.doc.og_twitter_tags": "Open Graph/Twitter Card tags require <head> placement; GoDaddy's Custom Code only injects into <body> (confirmed via GoDaddy's own UI copy, not a hands-on probe) and there's no native OG/Twitter-tag control in the platform's SEO panel.",
    "l1.crawl.noindex_utility": "A page-level noindex requires a <head> meta tag; GoDaddy's Custom Code only injects into <body> (same platform-documentation evidence as above) and there's no native per-page noindex toggle in the SEO panel.",
  },

  // Wix — left empty deliberately. Priority 3 in the build order (still
  // unbuilt); populating this before that adapter's actual scope is decided
  // (see the Blog-API-only recommendation from the 2026-07-23 Velo research)
  // would be guessing ahead of a real decision.
  wix: {},

  // Not built, not scoped yet.
  wordpress: {},
};

export function naItemsForPlatform(platform: Platform): Record<string, string> {
  return PLATFORM_NA_ITEMS[platform] || {};
}

// Checks a single checklist item key against a site's naGateItems, honoring
// ".*" wildcard entries (e.g. "l2.schema.*" matches "l2.schema.local_business").
// Stage 3's gate report should use this — not a plain object lookup — when
// deciding whether an item belongs in the main pass/fail list or the
// collapsed "Permanently N/A for this platform" section.
export function isItemNA(itemKey: string, naMap: Record<string, string>): { na: boolean; reason?: string } {
  if (naMap[itemKey]) return { na: true, reason: naMap[itemKey] };
  const prefix = itemKey.split(".").slice(0, -1).join(".") + ".*";
  if (naMap[prefix]) return { na: true, reason: naMap[prefix] };
  return { na: false };
}
