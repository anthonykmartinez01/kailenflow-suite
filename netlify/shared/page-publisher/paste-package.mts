// Paste-package builder — page-publisher-build-spec.md Stage 2 (revised
// 2026-07-23: this is the FIRST piece of Stage 2, moved ahead of GIT_STATIC
// intake, because a real GoDaddy client is waiting and this is the
// cheapest remaining piece). Platform-agnostic on purpose: Wix's real
// pages (not blog posts) go through this exact same flow per the
// Blog-API-only decision, so this is shared infrastructure, not
// GoDaddy-specific.
//
// Schema handling: the schema JSON-LD block is ALWAYS generated from
// page.schemaJsonLd when present — never silently dropped just because the
// connected platform can't use it. It's returned as its own labeled
// artifact with an `applicable` flag (driven by the site's naGateItems, set
// once at connect time — see platform-limitations.mts) so the work already
// exists intact the moment a client migrates to a platform that can
// actually use it. Confirmed necessary 2026-07-23: GoDaddy's Custom Code
// block HTML-entity-encodes <script> tags, so schema is permanently N/A
// there (l2.schema.* in PLATFORM_NA_ITEMS.manual) — but the block is still
// built, just labeled.
import type { PagePublisherPage, PagePublisherImage, PagePublisherSite } from "./firestore.mts";

export interface PastePackageImage {
  filename: string;
  altText: string;
  alreadyUploadedUrl: string | null;
  note: string;
}

export interface PastePackageSchema {
  jsonLd: any;
  scriptTag: string;
  applicable: boolean;
  notApplicableReason?: string;
}

export interface PastePackageInboundTask {
  sourceUrl: string;
  anchorText: string;
  status: string;
  // true when this platform genuinely has no way to ever apply this
  // automatically (confirmed via adapter.capabilities.canEditExistingPage
  // === false — MANUAL/GoDaddy today) — distinct from "not applied YET"
  // on a platform where real automation just isn't built yet (GIT_STATIC).
  // Anthony's explicit request 2026-07-23: the gate requires these links
  // to be accepted before save, but nothing applies them — without this
  // flag a page can silently ship as an orphan if the operator forgets.
  permanentlyManual: boolean;
}

export interface PastePackage {
  title: string;
  metaDescription: string;
  // Straight passthrough of page.htmlBody — the Gutenberg-sanitization
  // pipeline (build spec §6a: strip wp:* comments, wp-block-* classes,
  // resolve [FUTURE_SERVICE_PAGE_LINK]-style placeholders, promote a bare
  // hero <div> to <h1>, etc.) is intake work, not built yet. This function
  // assumes whatever's stored in htmlBody is already what should be pasted
  // — do not treat its output as sanitized until §6a exists.
  bodyHtml: string;
  images: PastePackageImage[];
  schema: PastePackageSchema | null;
  // §6d — persistent reminder, not a one-time notice: these were required
  // to pass the orphan gate at intake, but applying them (editing the
  // SOURCE page to add the link) has no real mechanism yet on any
  // platform. Surfaced here so the operator sees it every time they open
  // this page's package, not just once at save time.
  inboundLinkTasks: PastePackageInboundTask[];
}

export function buildPastePackage(page: PagePublisherPage, images: PagePublisherImage[], site: PagePublisherSite): PastePackage {
  const schemaNaReason = site.naGateItems?.["l2.schema.*"];
  const schema: PastePackageSchema | null = page.schemaJsonLd
    ? {
        jsonLd: page.schemaJsonLd,
        scriptTag: `<script type="application/ld+json">${JSON.stringify(page.schemaJsonLd)}</script>`,
        applicable: !schemaNaReason,
        ...(schemaNaReason ? { notApplicableReason: schemaNaReason } : {}),
      }
    : null;

  return {
    title: page.title,
    metaDescription: page.metaDescription,
    bodyHtml: page.htmlBody,
    images: images
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((img) => ({
        filename: img.originalFilename,
        altText: img.altText,
        alreadyUploadedUrl: img.uploadedRemoteUrl,
        note: img.uploadedRemoteUrl ? "Already uploaded — reuse this URL." : "Upload manually via the platform's own media library — no upload API on this platform.",
      })),
    schema,
    // MANUAL/GoDaddy: canEditExistingPage is permanently false (no API,
    // full stop) — every inbound task on this platform is permanently
    // manual, not a temporary gap. GIT_STATIC's own real "edit an
    // existing page's source" mechanism isn't built yet either, but that's
    // a stage boundary, not a platform ceiling — flagged false here.
    inboundLinkTasks: (page.inboundLinkTasks || []).map((t) => ({
      sourceUrl: t.sourceUrl,
      anchorText: t.anchorText,
      status: t.status,
      permanentlyManual: !site.capabilityFlags?.canEditExistingPage,
    })),
  };
}
