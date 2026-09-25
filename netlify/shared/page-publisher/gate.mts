// THE GATE — page-publisher-build-spec.md §5, Stage 3 items 5-7.
//
// Evaluates one page against the checklist registry (checklist-items.mts),
// combining three sources:
//   page-scoped   — facts about THIS page (its own H1, alt text, links)
//   site-scoped   — facts about the whole site (from siteGraph, built by
//                   the whole-site scan; shared across every page's report,
//                   never recomputed per page — §5a)
//   live_host     — runtime/CDN behavior (from liveHostChecks)
//
// ─── The three rules that must never bend ───
// 1. `unverifiable` NEVER counts as a pass. If a check can't be run, it
//    says so; it does not quietly succeed.
// 2. Permanently-N/A items (platform-limitations.mts, matched with
//    isItemNA so ".*" wildcards apply) are filtered OUT of pass/fail
//    entirely and reported separately — repeating "GoDaddy can't do
//    schema" as a per-page failure on every run just trains the operator
//    to ignore the report.
// 3. Site-scoped blocking failures do NOT permanently block publishing.
//    They raise a banner and require per-page acknowledgment
//    (blockingBehavior: 'requires_acknowledgment' in the registry). Only
//    page-scoped 'blocks_page' items hard-block, with zero override. This
//    is Anthony's explicit constraint: otherwise one missing llms.txt
//    bricks a whole client and we'd end up wanting an override button.
import { CHECKLIST_ITEMS, getItem, type ChecklistItem } from "./checklist-items.mts";
import { isItemNA } from "./platform-limitations.mts";
import { canonicalUrl, canonicalInternalHref } from "./urls.mts";
import type { PagePublisherPage, PagePublisherSite, PagePublisherImage } from "./firestore.mts";

// 'unverifiable' vs 'not_implemented' is a REAL distinction, not pedantry —
// found by testing the gate against a deliberately-good page (2026-07-26),
// which failed with 4 hard blockers purely because those items have no
// evaluator written yet. Every page would have failed forever.
//
//   unverifiable    — we tried to check and genuinely couldn't (no scan
//                     data, no page index, host unreachable). Never a pass;
//                     blocks or requires acknowledgment per the registry.
//   not_implemented — THIS BUILD has no evaluator for the item at all.
//                     Not the page's fault and not a real finding, so it
//                     must not block publishing — but it is reported loudly
//                     in its own bucket so it can never be mistaken for a
//                     pass. The checklist's "unverifiable never passes"
//                     rule is about runtime unverifiability, not about the
//                     tool being unfinished.
export type ItemResult = "pass" | "fail" | "unverifiable" | "not_applicable" | "not_implemented";

export interface GateItemOutcome {
  itemId: string;
  label: string;
  layer: 1 | 2 | "x";
  category: string;
  scope: "page" | "site" | "live_host";
  result: ItemResult;
  evidence: string;
  // Effective consequence AFTER scope is taken into account — the UI reads
  // this rather than re-deriving it, so page/site treatment can't drift
  // between backend and frontend.
  consequence: "blocks_page" | "requires_acknowledgment" | "warning" | "none";
  naReason?: string;
}

export interface GateRunResult {
  pageId: string;
  siteId: string;
  runAt: number;
  overall: "pass" | "fail";
  blockingFailures: GateItemOutcome[];       // page-scoped, hard-block, zero override
  acknowledgmentRequired: GateItemOutcome[]; // site-scoped problems — banner + per-page ack
  warnings: GateItemOutcome[];
  passed: GateItemOutcome[];
  unverifiable: GateItemOutcome[];
  notApplicable: GateItemOutcome[];
  // Items this build has no evaluator for — never blocking, always visible,
  // never counted as passing. The report must show this count prominently:
  // a "pass" that silently skipped 20 unimplemented checks is exactly the
  // kind of false confidence this whole module exists to prevent.
  notImplemented: GateItemOutcome[];
  siteDataAge: { scannedAt: number | null; stale: boolean; scanComplete: boolean; scanDegraded: boolean } ;
  // Real, actionable findings rather than a bare flag (Anthony: orphans are
  // "an actual client finding, not just test noise").
  actionableFindings: { kind: string; detail: string; urls?: string[] }[];
  gateVersion: string;
}

const GATE_VERSION = "stage3.2";

// Minimum server-rendered text for a page to count as real content.
// Anthony's decision 2026-07-26: this stays BLOCKING (it caught a genuinely
// thin page during testing), but the number is mine rather than the
// checklist's — so it lives here as one named constant, tunable in one
// place if it ever false-flags a legitimately short page.
const MIN_PAGE_TEXT_CHARS = 200;
const SITE_DATA_TTL_MS = 24 * 60 * 60 * 1000; // §5a's 24h TTL

// consequenceOverride exists for exactly one documented case — see
// l2.links.hub_to_spoke's acknowledged-missing branch. Not a general escape
// hatch: every other call derives consequence from the registry alone.
function outcome(item: ChecklistItem, result: ItemResult, evidence: string, naReason?: string, consequenceOverride?: GateItemOutcome["consequence"]): GateItemOutcome {
  // Consequence is derived from the registry, never hand-set per call site.
  let consequence: GateItemOutcome["consequence"] = "none";
  if (result === "fail" || result === "unverifiable") {
    consequence = item.blockingBehavior === "blocks_page"
      ? (item.scope === "page" ? "blocks_page" : "requires_acknowledgment")
      : item.blockingBehavior;
  }
  // not_implemented never blocks and never needs acknowledgment — it isn't
  // a finding about the page, it's a gap in this tool. Reported in its own
  // bucket instead (see GateRunResult.notImplemented).
  if (consequenceOverride) consequence = consequenceOverride;
  return {
    itemId: item.id, label: item.label, layer: item.layer, category: item.category,
    scope: item.scope, result, evidence, consequence, ...(naReason ? { naReason } : {}),
  };
}

// ─── page-scoped evaluators ───
// Only items this build can genuinely evaluate today are implemented.
// Everything else returns 'unverifiable' with an honest reason rather than
// a fabricated pass — rule 1.
function evaluatePageItem(item: ChecklistItem, page: PagePublisherPage, images: PagePublisherImage[], site: PagePublisherSite, scan: any | null): GateItemOutcome {
  switch (item.id) {
    // Head-derived per-page items. For an UNPUBLISHED page there is no live
    // URL to inspect, so these fall back to the site's head sample, which
    // answers "does this site's template emit OG tags at all" — honestly
    // labelled as a template-level answer rather than a per-page one.
    case "l1.doc.og_twitter_tags": {
      const h = scan?.siteHead;
      if (!h) return outcome(item, "unverifiable", "No live page could be fetched for head inspection — run a site scan.");
      const { ogTagCount, twitterTagCount } = h.facts;
      if (ogTagCount > 0 && twitterTagCount > 0) return outcome(item, "pass", `Site template emits ${ogTagCount} OG and ${twitterTagCount} Twitter tag(s) (sampled ${h.url}). Per-page values are only verifiable once this page is live.`);
      return outcome(item, "fail", `Site template emits ${ogTagCount} OG and ${twitterTagCount} Twitter card tag(s) (sampled ${h.url}) — both are needed.`);
    }
    case "l1.crawl.noindex_utility": {
      // A content page should NOT be noindexed. Utility pages are the ones
      // that should be — and this tool only ever creates content pages, so
      // the useful check is "we didn't accidentally noindex this one".
      const h = scan?.siteHead;
      if (!h) return outcome(item, "unverifiable", "No live page could be fetched for head inspection — run a site scan.");
      return h.facts.hasNoindex
        ? outcome(item, "fail", `The sampled page (${h.url}) carries a noindex robots meta — a content page must not be noindexed.`)
        : outcome(item, "pass", `No accidental noindex on the site template (sampled ${h.url}).`);
    }
    case "l1.render.static_html": {
      // Page-scoped version: is THIS page's stored body real content, or an
      // empty shell? (The sitewide SPA question is l1.render.no_spa.)
      const text = page.htmlBody.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return text.length >= MIN_PAGE_TEXT_CHARS
        ? outcome(item, "pass", `${text.length} chars of real text content in this page's HTML.`)
        : outcome(item, "fail", `Only ${text.length} chars of text content (minimum ${MIN_PAGE_TEXT_CHARS}) — this page has almost no server-renderable content.`);
    }
    case "l2.meta.single_h1": {
      const count = (page.htmlBody.match(/<h1[\s>]/gi) || []).length;
      if (count === 1) return outcome(item, "pass", "Exactly one <h1> found.");
      return outcome(item, "fail", count === 0 ? "No <h1> found on this page." : `${count} <h1> elements found — there must be exactly one.`);
    }
    case "l1.gate.missing_alt":
    case "l2.img.alt_descriptive": {
      if (images.length === 0) return outcome(item, "pass", "No images on this page.");
      const missing = images.filter((i) => !i.altText || !i.altText.trim());
      return missing.length === 0
        ? outcome(item, "pass", `All ${images.length} image(s) have alt text.`)
        : outcome(item, "fail", `${missing.length} image(s) missing alt text: ${missing.map((i) => i.originalFilename).join(", ")}`);
    }
    case "l1.render.img_dimensions": {
      if (images.length === 0) return outcome(item, "pass", "No images on this page.");
      const bad = images.filter((i) => !i.width || !i.height);
      return bad.length === 0
        ? outcome(item, "pass", `All ${images.length} image(s) have real width/height.`)
        : outcome(item, "fail", `${bad.length} image(s) missing real dimensions.`);
    }
    case "l2.img.filenames": {
      if (images.length === 0) return outcome(item, "pass", "No images on this page.");
      const generic = images.filter((i) => /^(image|img|photo|untitled)[-_]?\d*\.\w+$/i.test(i.originalFilename || ""));
      // 'fail' as a RESULT; the registry's blockingBehavior:'warning' is
      // what makes its consequence non-blocking. Result and consequence are
      // deliberately separate concepts.
      return generic.length === 0
        ? outcome(item, "pass", "All image filenames are descriptive.")
        : outcome(item, "fail", `${generic.length} generic filename(s): ${generic.map((i) => i.originalFilename).join(", ")}`);
    }
    case "l1.gate.broken_internal_links": {
      const idx = new Set(Object.keys(site.siteGraph?.pageIndex || {}).map(canonicalUrl));
      if (idx.size === 0) return outcome(item, "unverifiable", "No page index for this site yet — connect/refresh it so links can be checked.");
      const broken = (page.internalLinks || [])
        .map((l) => ({ raw: l.targetUrl, resolved: canonicalInternalHref(l.targetUrl, site.domain) }))
        .filter((l) => l.resolved !== null && !idx.has(l.resolved!));
      return broken.length === 0
        ? outcome(item, "pass", `All ${(page.internalLinks || []).length} internal link(s) resolve to known pages.`)
        : outcome(item, "fail", `Broken internal link(s): ${broken.map((b) => b.raw).join(", ")}`);
    }
    case "l2.links.hub_to_spoke": {
      if (page.parentUrl) return outcome(item, "pass", `Parent/hub set: ${page.parentUrl}`);
      // §6d: "an acknowledged absence is allowed, but it is never silent —
      // the gate report surfaces it as a flagged, visible fact on every
      // run, not a quietly-passed check." So: not a pass, but explicitly
      // downgraded from blocks_page to acknowledgment. The one documented
      // use of consequenceOverride.
      if (page.parentAcknowledgedMissing) {
        return outcome(item, "fail", "No suitable parent — acknowledged at intake. Allowed, but surfaced every run rather than passing silently.", undefined, "requires_acknowledgment");
      }
      return outcome(item, "fail", "No parent/hub page chosen and no acknowledgment that none exists.");
    }
    case "l1.gate.orphan_pages":
    case "l2.links.zero_orphans": {
      const inbound = (page.inboundLinkTasks || []).length;
      if (inbound >= 2) return outcome(item, "pass", `${inbound} inbound link(s) recorded.`);
      const applied = (page.inboundLinkTasks || []).filter((t) => t.status === "applied").length;
      if (inbound > 0) return outcome(item, "fail", `Only ${inbound} inbound link(s) — needs at least 2 (${applied} actually applied so far).`);
      return outcome(item, "fail", "No inbound links — this page would publish as an orphan.");
    }
    // ─── Built 2026-07-26: evaluators reachable with NO new infrastructure,
    // i.e. answerable from the page's own stored htmlBody/schema/images.
    case "l2.meta.heading_hierarchy": {
      const levels = [...page.htmlBody.matchAll(/<h([1-6])[\s>]/gi)].map((m) => Number(m[1]));
      if (levels.length === 0) return outcome(item, "fail", "No headings at all on this page.");
      const skips: string[] = [];
      for (let i = 1; i < levels.length; i++) if (levels[i] > levels[i - 1] + 1) skips.push(`h${levels[i - 1]} → h${levels[i]}`);
      return skips.length === 0
        ? outcome(item, "pass", `Heading order is sequential (${levels.map((l) => "h" + l).join(" → ")}).`)
        : outcome(item, "fail", `Skipped heading level(s): ${skips.join(", ")}.`);
    }
    case "l1.url.lowercase_hyphens": {
      const slug = page.slug || "";
      if (!slug) return outcome(item, "fail", "No slug set for this page.");
      const problems: string[] = [];
      if (/[A-Z]/.test(slug)) problems.push("contains uppercase");
      if (/[_\s]/.test(slug)) problems.push("contains underscores or spaces");
      if (/[^a-z0-9\-\/]/.test(slug)) problems.push("contains non-URL-safe characters");
      return problems.length === 0
        ? outcome(item, "pass", `Slug "${slug}" is lowercase and hyphenated.`)
        : outcome(item, "fail", `Slug "${slug}" ${problems.join(", ")}.`);
    }
    case "l1.doc.semantic_html": {
      // Body-fragment scope only: <header>/<nav>/<footer> belong to the site
      // template, not a pasted page, so requiring them here would fail every
      // page for something the page can't control.
      const has = /<(section|article|main|aside)[\s>]/i.test(page.htmlBody);
      return has
        ? outcome(item, "pass", "Page body uses semantic sectioning elements.")
        : outcome(item, "fail", "No semantic sectioning (<section>/<article>/<main>/<aside>) in the page body.");
    }
    case "l1.render.lazy_below_fold": {
      if (images.length === 0) return outcome(item, "pass", "No images on this page.");
      const lcp = images.find((i) => i.isLcp);
      if (!lcp) return outcome(item, "pass", `No LCP image marked (valid — not every page has a hero); ${images.length} image(s) may lazy-load.`);
      const lcpStillLazy = new RegExp(`<img[^>]*${lcp.originalFilename.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}[^>]*loading=["']lazy["']`, "i").test(page.htmlBody);
      return lcpStillLazy
        ? outcome(item, "fail", `The LCP image (${lcp.originalFilename}) still has loading="lazy" — it must load eagerly.`)
        : outcome(item, "pass", `LCP image (${lcp.originalFilename}) is not lazy-loaded.`);
    }
    case "l1.render.modern_img_formats": {
      if (images.length === 0) return outcome(item, "pass", "No images on this page.");
      const legacy = images.filter((i) => i.format !== "webp" && i.format !== "avif");
      return legacy.length === 0
        ? outcome(item, "pass", `All ${images.length} image(s) are WebP/AVIF.`)
        : outcome(item, "fail", `${legacy.length} image(s) still in a legacy format: ${legacy.map((i) => `${i.originalFilename} (${i.format})`).join(", ")}`);
    }
    case "l1.render.lcp_preload": {
      const lcp = images.find((i) => i.isLcp);
      if (!lcp) return outcome(item, "pass", "No LCP image marked for this page (valid).");
      const preloaded = new RegExp(`<link[^>]*rel=["']preload["'][^>]*${lcp.originalFilename.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`, "i").test(page.htmlBody);
      return preloaded
        ? outcome(item, "pass", `LCP image ${lcp.originalFilename} is preloaded.`)
        : outcome(item, "fail", `LCP image ${lcp.originalFilename} has no <link rel="preload"> — add one so it starts downloading immediately.`);
    }
    case "l1.gate.schema_invalid": {
      // The checklist item is "schema that doesn't parse or validate" — a
      // hard deploy blocker. ABSENCE of schema is a different concern,
      // covered by the l2.schema.* presence items (warnings). Treating
      // "no schema" as an invalid-schema blocker would hard-block every
      // page that simply hasn't had schema added yet, which the checklist
      // doesn't ask for.
      if (!page.schemaJsonLd) return outcome(item, "pass", "No schema on this page — nothing invalid. (Presence is covered by the l2.schema.* items.)");
      try {
        JSON.parse(JSON.stringify(page.schemaJsonLd));
        const graph = (page.schemaJsonLd as any)["@graph"];
        if (Array.isArray(graph) && graph.some((n: any) => !n || !n["@type"])) {
          return outcome(item, "fail", "Schema graph contains a node with no @type.");
        }
        return outcome(item, "pass", "Schema parses and every graph node has an @type.");
      } catch (e: any) {
        return outcome(item, "fail", `Schema does not parse: ${String(e?.message || e)}`);
      }
    }
    case "l1.doc.breadcrumb_website_schema": {
      const types = collectSchemaTypes(page.schemaJsonLd);
      const has = types.includes("BreadcrumbList");
      return has
        ? outcome(item, "pass", "BreadcrumbList present in this page's schema.")
        : outcome(item, "fail", `No BreadcrumbList in this page's schema (found: ${types.join(", ") || "none"}). §6b's schema merge would add it — not built yet.`);
    }
    case "l1.doc.schema_dates": {
      const raw = JSON.stringify(page.schemaJsonLd || {});
      const hasPub = raw.includes("datePublished");
      const hasMod = raw.includes("dateModified");
      if (hasPub && hasMod) return outcome(item, "pass", "datePublished and dateModified both present.");
      return outcome(item, "fail", `Missing ${[!hasPub && "datePublished", !hasMod && "dateModified"].filter(Boolean).join(" and ")} in schema.`);
    }
    case "l2.schema.service":
      return schemaTypePresence(item, page, "Service", page.pageType === "service");
    case "l2.schema.article":
      return schemaTypePresence(item, page, "Article", page.pageType === "blog");
    case "l2.schema.faq":
      return schemaTypePresence(item, page, "FAQPage", /<(h[23])[^>]*>[^<]*\?/i.test(page.htmlBody));
    case "l2.schema.local_business": {
      const types = collectSchemaTypes(page.schemaJsonLd);
      const bizLike = types.some((t) => /LocalBusiness|Organization|.*Business$|Electrician|Plumber|HVACBusiness|Contractor/i.test(t));
      return bizLike
        ? outcome(item, "pass", `Business entity present in schema (${types.filter((t) => /Business|Organization|Electrician|Plumber|Contractor/i.test(t)).join(", ")}).`)
        : outcome(item, "fail", `No LocalBusiness/Organization-type node in this page's schema (found: ${types.join(", ") || "none"}).`);
    }
    case "l2.links.descriptive_anchors": {
      const generic = (page.internalLinks || []).filter((l) => /^(click here|here|read more|learn more|this page|link)$/i.test((l.anchorText || "").trim()));
      return generic.length === 0
        ? outcome(item, "pass", "All internal anchors are descriptive.")
        : outcome(item, "fail", `${generic.length} non-descriptive anchor(s): ${generic.map((l) => `"${l.anchorText}"`).join(", ")}`);
    }
    case "l1.url.canonical_self_ref":
    case "l1.gate.missing_canonical": {
      // Built 2026-07-26. Anthony: "since Rankin's Layout.astro computes
      // canonical automatically, building canonical_self_ref may just be
      // verifying the layout emitted it — do that if it's cheap." It was:
      // the scan already captures canonicalHref from the live head sample.
      //
      // Three real states, none of them a silent pass:
      //   explicit canonicalUrl on the page   → pass
      //   site template demonstrably emits one → pass (template-level, said so)
      //   neither                              → FAIL (this is a blocker)
      if (page.canonicalUrl) return outcome(item, "pass", `Canonical explicitly set on this page: ${page.canonicalUrl}`);
      const h = scan?.siteHead;
      if (!h) return outcome(item, "unverifiable", "No live page could be fetched to confirm the site template emits a canonical — run a site scan. Not treated as a pass.");
      if (h.facts.canonicalHref) {
        return outcome(item, "pass", `This page has no explicit canonical, but the site template emits one automatically (sampled ${h.url} → ${h.facts.canonicalHref}). Verified at template level, not per-page — a per-page check is only possible once this page is live.`);
      }
      return outcome(item, "fail", `No canonical on this page and the site template doesn't emit one either (sampled ${h.url}). Every page needs a self-referencing canonical.`);
    }
    default:
      return outcome(item, "not_implemented", `No evaluator built yet for this item (registry status: ${item.status}) — NOT checked, and deliberately not treated as a pass.`);
  }
}

// ─── site-scoped evaluators (read cached siteGraph — §5a: computed once, shared) ───
function evaluateSiteItem(item: ChecklistItem, site: PagePublisherSite, scan: any | null, clientRecord: any | null): GateItemOutcome {
  const idx = site.siteGraph?.pageIndex || {};
  const titles = Object.values(idx).map((p: any) => (p.title || "").trim().toLowerCase()).filter(Boolean);

  switch (item.id) {
    case "l1.crawl.sitemap_present":
      return Object.keys(idx).length > 0
        ? outcome(item, "pass", `${Object.keys(idx).length} page(s) discovered for this site.`)
        : outcome(item, "fail", "No pages discovered — no sitemap or repo index available.");
    // Built 2026-07-26 (Anthony: "titles are already scanned, most buildable
    // of the important ones"). Depends on the scan having written REAL titles
    // into pageIndex — a placeholder-title index would produce false
    // duplicates, which is exactly the bug that surfaced earlier this build,
    // so this refuses to run on a never-scanned index rather than guessing.
    case "l1.gate.missing_duplicate_titles":
    case "l2.meta.unique_title": {
      if (!scan) return outcome(item, "unverifiable", "No site scan has run yet — page titles come from the scan, and a path-derived placeholder index would produce false duplicates.");
      const missing = Object.entries(idx).filter(([, p]: [string, any]) => !(p.title || "").trim()).map(([u]) => u);
      const seen = new Map<string, string[]>();
      for (const [url, p] of Object.entries(idx)) {
        const t = ((p as any).title || "").trim().toLowerCase();
        if (!t) continue;
        seen.set(t, [...(seen.get(t) || []), url]);
      }
      const dupes = [...seen.entries()].filter(([, urls]) => urls.length > 1);
      if (missing.length > 0) return outcome(item, "fail", `${missing.length} page(s) have no title: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`);
      if (dupes.length > 0) return outcome(item, "fail", `Duplicate title(s) across pages: ${dupes.map(([t, urls]) => `"${t}" on ${urls.join(" + ")}`).join("; ")}`);
      return outcome(item, "pass", `All ${seen.size} page title(s) present and unique.`);
    }
    case "l1.gate.orphan_pages_sitewide": {
      if (!scan) return outcome(item, "unverifiable", "No site scan has run yet.");
      if (scan.degraded) return outcome(item, "unverifiable", scan.degradedReason || "Scan degraded — orphan results withheld as untrustworthy.");
      if (!scan.complete) return outcome(item, "unverifiable", scan.incompleteReason || "Last scan did not complete.");
      const orphans: string[] = scan.orphans || [];
      return orphans.length === 0
        ? outcome(item, "pass", "No orphan pages found sitewide.")
        : outcome(item, "fail", `${orphans.length} orphan page(s) on this site: ${orphans.join(", ")}`);
    }
    // ─── Built 2026-07-26: site-scoped evaluators answerable from data
    // already stored (siteGraph, the site record, or the client record).
    case "l1.crawl.indexnow":
      return site.indexNowKeyFileCommitted
        ? outcome(item, "pass", "IndexNow key file is committed for this site. (The ping call itself is still Stage 3.)")
        : outcome(item, "fail", "No IndexNow key file committed for this site yet.");
    case "l1.crawl.gsc_verification": {
      // Reuse, don't rebuild — client.gscProperty comes from the existing
      // GSC integration (Part A), not a new verification mechanism.
      const prop = (clientRecord as any)?.gscProperty;
      return prop
        ? outcome(item, "pass", `Search Console property connected: ${prop}`)
        : outcome(item, "fail", "No Search Console property connected for this client (Analytics → connect Search Console).");
    }
    // Built 2026-07-26 (Anthony: "a sitemap with a 404 in it actively hurts
    // crawling"). sitemap_inclusion and sitemap_integrity check the two
    // directions of the same relationship:
    //   inclusion — is anything IN the sitemap that shouldn't be?
    //   integrity — is anything missing FROM it that should be there?
    case "l1.gate.sitemap_integrity": {
      const sitemapUrls: string[] = (site.siteGraph as any)?.sitemapUrls || [];
      if (sitemapUrls.length === 0) {
        // GIT_STATIC generates its sitemap at build time from src/pages, so an
        // empty captured list means "not captured", not "empty sitemap".
        return outcome(item, "unverifiable", "No sitemap URL list captured for this site. On a git-static site the sitemap is generated at build time, so this can only be verified against the deployed sitemap.xml — not yet wired.");
      }
      const inSitemap = new Set(sitemapUrls.map(canonicalUrl));
      const knownPages = Object.keys(idx).map(canonicalUrl);
      // A 404 page legitimately belongs in neither, so exclude it.
      const shouldBeListed = knownPages.filter((u) => !/\/404$/.test(u));
      const absent = shouldBeListed.filter((u) => !inSitemap.has(u));
      return absent.length === 0
        ? outcome(item, "pass", `All ${shouldBeListed.length} indexable page(s) appear in the sitemap.`)
        : outcome(item, "fail", `${absent.length} page(s) exist but are missing from the sitemap: ${absent.slice(0, 5).join(", ")}${absent.length > 5 ? "…" : ""}`);
    }
    case "l1.crawl.sitemap_lastmod":
    case "l1.crawl.sitemap_inclusion": {
      const sitemapUrls: string[] = (site.siteGraph as any)?.sitemapUrls || [];
      if (sitemapUrls.length === 0) return outcome(item, "unverifiable", "No sitemap URL list captured for this site — run a connect/refresh.");
      const known = new Set(Object.keys(idx).map(canonicalUrl));
      const strays = sitemapUrls.map(canonicalUrl).filter((u) => !known.has(u));
      if (item.id === "l1.crawl.sitemap_inclusion") {
        return strays.length === 0
          ? outcome(item, "pass", `All ${sitemapUrls.length} sitemap URL(s) correspond to real, known pages — nothing listed that would 404.`)
          : outcome(item, "fail", `${strays.length} sitemap URL(s) don't match any known page (these would 404 for a crawler): ${strays.slice(0, 5).join(", ")}${strays.length > 5 ? "…" : ""}`);
      }
      // lastmod values are now retained by the sitemap reader. What's
      // checkable without a content-history baseline is whether they exist
      // and are plausible — a sitemap where every lastmod is today is the
      // classic faked-freshness signal the checklist warns about (Google
      // ignores lastmod sitewide once it stops trusting it).
      const withLastmod = Object.values(idx).filter((p: any) => p.lastmod);
      if (withLastmod.length === 0) return outcome(item, "fail", "No <lastmod> values in this site's sitemap — Google uses lastmod for discovery, so omitting it wastes the signal.");
      const days = withLastmod.map((p: any) => Math.abs(Date.now() - Date.parse(p.lastmod)) / 86400000).filter((n) => !isNaN(n));
      const allSameDay = days.length > 2 && days.every((d) => Math.abs(d - days[0]) < 1);
      if (allSameDay) return outcome(item, "fail", `All ${days.length} lastmod value(s) are the same date — that reads as faked freshness, which makes Google discount lastmod for the whole site.`);
      return outcome(item, "pass", `${withLastmod.length} page(s) have lastmod values spanning a real range.`);
    }
    case "l2.trust.author_pages": {
      const hasBlog = Object.values(idx).some((p: any) => /blog|post|article/i.test(p.path || ""));
      if (!hasBlog) return outcome(item, "pass", "No blog pages on this site — author pages not required.");
      return pathMatches(idx, /author/i)
        ? outcome(item, "pass", "Author page(s) found.")
        : outcome(item, "fail", "This site has blog content but no author page.");
    }
    // ─── Built 2026-07-26 (second pass): the scan now parses head facts
    // from one live page per site, so these are answerable from cache with
    // no per-gate-run network calls (§5a).
    case "l1.doc.lang_attribute": {
      const h = scan?.siteHead;
      if (!h) return outcome(item, "unverifiable", "No live page could be fetched for head inspection — run a site scan.");
      return h.facts.lang
        ? outcome(item, "pass", `<html lang="${h.facts.lang}"> present (sampled ${h.url}).`)
        : outcome(item, "fail", `No lang attribute on <html> (sampled ${h.url}).`);
    }
    case "l1.doc.viewport_charset": {
      const h = scan?.siteHead;
      if (!h) return outcome(item, "unverifiable", "No live page could be fetched for head inspection — run a site scan.");
      const { hasViewport, hasCharset } = h.facts;
      if (hasViewport && hasCharset) return outcome(item, "pass", `Viewport and charset both declared (sampled ${h.url}).`);
      return outcome(item, "fail", `Missing ${[!hasViewport && "viewport meta", !hasCharset && "charset"].filter(Boolean).join(" and ")} (sampled ${h.url}).`);
    }
    case "l1.doc.favicon_set": {
      const h = scan?.siteHead;
      if (!h) return outcome(item, "unverifiable", "No live page could be fetched for head inspection — run a site scan.");
      const n = h.facts.faviconCount;
      if (n >= 2) return outcome(item, "pass", `${n} icon link(s) found (sampled ${h.url}).`);
      if (n === 1) return outcome(item, "fail", `Only one icon link found — a complete favicon set has multiple sizes (sampled ${h.url}).`);
      return outcome(item, "fail", `No favicon link tags found (sampled ${h.url}).`);
    }
    case "l1.render.no_spa": {
      const h = scan?.siteHead;
      if (!h) return outcome(item, "unverifiable", "No live page could be fetched — run a site scan.");
      // Conservative: report what was observed. An empty root div AND almost
      // no server-rendered text is the real SPA signature.
      if (h.facts.emptyRootDiv && h.facts.bodyTextLength < 200) {
        return outcome(item, "fail", `Live page looks client-rendered: empty root div and only ${h.facts.bodyTextLength} chars of server-rendered text (sampled ${h.url}).`);
      }
      return outcome(item, "pass", `Content is server-rendered — ${h.facts.bodyTextLength} chars present in the initial HTML (sampled ${h.url}).`);
    }
    case "l1.crawl.robots_present": {
      const c = site.liveHostChecks as any;
      if (!c || c.robotsTxtPresent === undefined) return outcome(item, "unverifiable", "robots.txt wasn't checked in the last scan — run a site scan.");
      if (!c.robotsTxtPresent) return outcome(item, "fail", "No robots.txt at the domain root.");
      return c.robotsMentionsSitemap
        ? outcome(item, "pass", "robots.txt present and references a sitemap.")
        : outcome(item, "fail", "robots.txt present but doesn't reference a sitemap.");
    }
    case "l1.crawl.ai_crawler_policy": {
      const c = site.liveHostChecks as any;
      if (!c || c.robotsAiCrawlerPolicy === undefined) return outcome(item, "unverifiable", "robots.txt wasn't checked in the last scan — run a site scan.");
      return c.robotsAiCrawlerPolicy
        ? outcome(item, "pass", "robots.txt makes an explicit AI-crawler decision (allow or block).")
        : outcome(item, "fail", "robots.txt makes no explicit AI-crawler decision — the checklist asks for a deliberate choice either way.");
    }
    case "l1.crawl.robots_custom": {
      // On a platform where robots.txt is editable at all, having one that
      // isn't purely the platform default is the observable proxy.
      const c = site.liveHostChecks as any;
      if (!c || c.robotsTxtPresent === undefined) return outcome(item, "unverifiable", "robots.txt wasn't checked in the last scan — run a site scan.");
      return c.robotsTxtPresent
        ? outcome(item, "pass", "robots.txt exists and is reachable for editing on this platform.")
        : outcome(item, "fail", "No robots.txt to customize.");
    }
    case "l2.trust.about_page":
      return matchPage(item, idx, /about/i, "About page");
    case "l2.trust.privacy_terms": {
      const hasPrivacy = pathMatches(idx, /privacy/i);
      const hasTerms = pathMatches(idx, /terms/i);
      if (hasPrivacy && hasTerms) return outcome(item, "pass", "Privacy policy and terms pages both found.");
      const missing = [!hasPrivacy && "privacy policy", !hasTerms && "terms"].filter(Boolean).join(" and ");
      return outcome(item, "fail", `Missing ${missing} page.`);
    }
    case "l2.trust.contact_nap":
      return matchPage(item, idx, /contact/i, "Contact page");
    case "l2.schema.entity_graph": {
      if (!scan) return outcome(item, "unverifiable", "No site scan has run yet.");
      const ids: string[] = scan.allSchemaIds || [];
      return ids.length > 0
        ? outcome(item, "pass", `${ids.length} stable @id(s) found across the site's schema graph.`)
        : outcome(item, "fail", "No schema @id references found anywhere — there's no connected entity graph.");
    }
    default:
      return outcome(item, "not_implemented", `No evaluator built yet for this item (registry status: ${item.status}) — NOT checked, and deliberately not treated as a pass.`);
  }
}

// Walks any JSON-LD shape (object, array, nested @graph) collecting @type
// values — the real files use several different shapes, so a fixed-path
// lookup would miss them (confirmed against real generator output).
function collectSchemaTypes(node: any, acc: Set<string> = new Set()): string[] {
  if (!node || typeof node !== "object") return [...acc];
  if (Array.isArray(node)) { for (const n of node) collectSchemaTypes(n, acc); return [...acc]; }
  const t = node["@type"];
  if (typeof t === "string") acc.add(t);
  else if (Array.isArray(t)) for (const x of t) if (typeof x === "string") acc.add(x);
  for (const k of Object.keys(node)) if (k !== "@type") collectSchemaTypes(node[k], acc);
  return [...acc];
}

// "Required only when relevant" — an FAQPage schema isn't a finding on a
// page with no questions, and a Service schema isn't one on a blog post.
function schemaTypePresence(item: ChecklistItem, page: PagePublisherPage, type: string, expected: boolean): GateItemOutcome {
  const types = collectSchemaTypes(page.schemaJsonLd);
  const has = types.includes(type);
  if (has) return outcome(item, "pass", `${type} schema present.`);
  if (!expected) return outcome(item, "pass", `${type} schema not required for this page type (${page.pageType}).`);
  return outcome(item, "fail", `${type} schema expected for this page but not found (found: ${types.join(", ") || "none"}).`);
}

function pathMatches(idx: Record<string, any>, re: RegExp): boolean {
  return Object.entries(idx).some(([url, p]: [string, any]) => re.test(url) || re.test(p.path || "") || re.test(p.title || ""));
}
function matchPage(item: ChecklistItem, idx: Record<string, any>, re: RegExp, label: string): GateItemOutcome {
  if (Object.keys(idx).length === 0) return outcome(item, "unverifiable", "No page index — run a site scan first.");
  return pathMatches(idx, re) ? outcome(item, "pass", `${label} found.`) : outcome(item, "fail", `${label} not found on this site.`);
}

// ─── live-host evaluators ───
function evaluateLiveHostItem(item: ChecklistItem, site: PagePublisherSite): GateItemOutcome {
  const c = site.liveHostChecks;
  if (!c) return outcome(item, "unverifiable", "Live-host checks haven't run yet — run a site scan.");
  const map: Record<string, [boolean | undefined, string]> = {
    "l1.http.real_404": [c.real404, "custom 404 returns a real HTTP 404"],
    "l1.http.host_honors": [c.hostHonors404, "host honors 404 status codes"],
    "l1.http.no_fake_200": [c.real404, "missing pages do not return 200"],
    "l1.url.https_redirect": [c.httpsRedirectOk, "HTTP redirects to HTTPS with a 301/308"],
    "l1.url.single_host": [c.singleHostOk, "exactly one of www/non-www serves, the other redirects"],
    "l1.crawl.llms_txt": [(c as any).llmsTxtPresent, "llms.txt present at the domain root"],
  };
  const entry = map[item.id];
  if (!entry) return outcome(item, "not_implemented", "No live-host evaluator built yet for this item — NOT checked.");
  const [value, desc] = entry;
  if (value === undefined) return outcome(item, "unverifiable", `Not measured in the last scan (${desc}).`);
  return value ? outcome(item, "pass", `Confirmed: ${desc}.`) : outcome(item, "fail", `Failed: ${desc}.`);
}

export function runGate(page: PagePublisherPage, images: PagePublisherImage[], site: PagePublisherSite, scan: any | null, clientRecord: any | null = null): GateRunResult {
  const runAt = Date.now();
  const naMap = site.naGateItems || {};
  const outcomes: GateItemOutcome[] = [];

  for (const item of CHECKLIST_ITEMS) {
    if (item.layer === "x") continue; // my own additions aren't checklist gate items
    if (item.status === "not_our_job") continue;

    // Rule 2 — filtered out of pass/fail entirely, reported separately.
    const na = isItemNA(item.id, naMap);
    if (na.na) { outcomes.push(outcome(item, "not_applicable", "Structurally impossible on this platform.", na.reason)); continue; }

    if (item.scope === "page") outcomes.push(evaluatePageItem(item, page, images, site, scan));
    else if (item.scope === "site") outcomes.push(evaluateSiteItem(item, site, scan, clientRecord));
    else outcomes.push(evaluateLiveHostItem(item, site));
  }

  const failedOrUnverifiable = outcomes.filter((o) => o.result === "fail" || o.result === "unverifiable");
  const blockingFailures = failedOrUnverifiable.filter((o) => o.consequence === "blocks_page");
  const acknowledgmentRequired = failedOrUnverifiable.filter((o) => o.consequence === "requires_acknowledgment");
  const warnings = failedOrUnverifiable.filter((o) => o.consequence === "warning");

  // Rule 3 — ONLY page-scoped hard blockers decide overall pass/fail.
  const overall: "pass" | "fail" = blockingFailures.length === 0 ? "pass" : "fail";

  const scannedAt = site.siteGraph?.updatedAt ?? null;
  const siteDataAge = {
    scannedAt,
    stale: scannedAt === null || runAt - scannedAt > SITE_DATA_TTL_MS,
    scanComplete: !!scan?.complete,
    scanDegraded: !!scan?.degraded,
  };

  // Actionable findings — real fixes, not just flags.
  const actionableFindings: GateRunResult["actionableFindings"] = [];
  const sitewideOrphans: string[] = (scan && !scan.degraded && scan.complete && scan.orphans) || [];
  if (sitewideOrphans.length > 0) {
    actionableFindings.push({
      kind: "orphan_pages",
      detail: `${sitewideOrphans.length} page(s) on this client's site have no inbound links. Add a link to each from a relevant existing page (nav, footer, or a related content page) so visitors and crawlers can reach them.`,
      urls: sitewideOrphans,
    });
  }
  const pendingInbound = (page.inboundLinkTasks || []).filter((t) => t.status !== "applied");
  if (pendingInbound.length > 0) {
    actionableFindings.push({
      kind: "inbound_links_not_applied",
      detail: `${pendingInbound.length} inbound link(s) accepted at intake but not yet added to the source page(s). Until they're added by hand, this page publishes as an orphan.`,
      urls: pendingInbound.map((t) => `${t.sourceUrl} → "${t.anchorText}"`),
    });
  }

  return {
    pageId: page.id, siteId: site.id, runAt, overall,
    blockingFailures, acknowledgmentRequired, warnings,
    passed: outcomes.filter((o) => o.result === "pass"),
    unverifiable: outcomes.filter((o) => o.result === "unverifiable"),
    notApplicable: outcomes.filter((o) => o.result === "not_applicable"),
    notImplemented: outcomes.filter((o) => o.result === "not_implemented"),
    siteDataAge, actionableFindings, gateVersion: GATE_VERSION,
  };
}
