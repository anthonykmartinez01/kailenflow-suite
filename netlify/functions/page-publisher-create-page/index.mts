import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { savePage, saveImage, getSite, upsertPageRef } from "../../shared/page-publisher/firestore.mts";
import { canonicalUrl, canonicalInternalHref } from "../../shared/page-publisher/urls.mts";

// POST /api/page-publisher-create-page — the intake save step (page-
// publisher-build-spec.md §6a/§6d, built 2026-07-23). The heavy
// sanitization AND internal-linking work (comment/class stripping,
// placeholder detection, H1 promotion, image extraction, parent picking,
// inbound/outbound link tables) already ran CLIENT-SIDE before this is
// called — see public/index.html's sanitizePastedHtml + PageIntakeForm.
// This function re-checks the genuine hard-block rules server-side rather
// than trusting the client alone: unresolved [BRACKETED] placeholders
// (§6a fix #1), missing image alt text, an unmade parent decision, fewer
// than 2 total inbound links (§6d's orphan gate — "zero blocks, one still
// blocks unless there were no other pages to link from at all"), and any
// broken internal outbound link (l1.gate.broken_internal_links). Anything
// else these features do is a client-side convenience, not a save-time gate.
//
// Always creates a NEW page — editing an existing draft is a separate,
// later concern (this round is paste-to-create only, per Anthony's scope).
// §6d's "same commit as the inbound-link edits" atomicity rule for
// GIT_STATIC is NOT implemented here — inboundLinkTasks are persisted as
// 'pending', not applied, because there's no real "commit a page + edit
// existing pages" mechanism built yet for ANY platform (GIT_STATIC's own
// publish mechanism is a separate, still-open gap — see the build spec).
// This captures the decision at intake time, as required; applying it is
// deferred to whenever real publishing exists.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

const PLACEHOLDER_RE = /\[[A-Z_]+:\s*[^\]]*\]/;

// Internal-link resolution uses the SHARED canonical rule (urls.mts).
//
// This previously had its own local isInternalCandidate() plus a raw
// `pageIndexUrls.has(l.targetUrl)` comparison, which was a real bug: the
// client sends the raw href, so a link to the homepage arrived as "/" and
// was compared against a pageIndex key of "https://site.com/" — never
// matching, so ANY page linking to the homepage was rejected as having a
// broken link. Found 2026-07-26 during the "is the normalizer called
// everywhere" audit, not by the gate.

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const { siteId, title, slug, metaDescription, pageType, htmlBody, schemaJsonLd, images, parentUrl, parentAcknowledgedMissing, internalLinks, inboundLinkTasks } = body;
  if (!siteId || !title || !htmlBody) return json({ error: "siteId, title, and htmlBody are required" }, 400);

  const site = await getSite(siteId);
  if (!site) return json({ error: "No site found for that siteId" }, 404);

  if (PLACEHOLDER_RE.test(htmlBody)) {
    return json({ error: "This page still has an unresolved [BRACKETED] placeholder — resolve every one before saving." }, 400);
  }
  const imgList: any[] = Array.isArray(images) ? images : [];
  const missingAlt = imgList.find((img) => !img.altText || !String(img.altText).trim());
  if (missingAlt) {
    return json({ error: `Image "${missingAlt.originalFilename || "(unnamed)"}" has no alt text — every image needs alt text before saving.` }, 400);
  }

  // §6d — parent/hub link: required, exactly one, or an explicit
  // acknowledged absence. Never silently defaulted to null.
  if (!parentUrl && !parentAcknowledgedMissing) {
    return json({ error: "Pick a parent/hub page, or explicitly acknowledge no suitable parent exists, before saving." }, 400);
  }

  // §6d — inbound links: the orphan gate. Minimum 2 total (the auto-
  // proposed hub link, if accepted, counts as one) — UNLESS this site's
  // pageIndex has no other pages to link from at all yet (a real, sensible
  // gap the spec's "zero/one blocks" rule doesn't explicitly address —
  // waiving it only in that specific case, otherwise enforcing it
  // strictly, is Anthony's own judgment call, flagged here as such).
  const inboundList: any[] = Array.isArray(inboundLinkTasks) ? inboundLinkTasks : [];
  const otherPageCount = Object.keys(site.siteGraph?.pageIndex || {}).length;
  if (otherPageCount > 0 && inboundList.length < 2) {
    return json({ error: `This page needs at least 2 inbound links (the hub link plus one more) before saving — only ${inboundList.length} accepted. This is the orphan gate — it exists to stop pages from shipping with no way for a visitor or crawler to reach them.` }, 400);
  }

  // §6d — outbound links: any that look like internal page links but
  // don't match a real known page on this site are broken and block save
  // (l1.gate.broken_internal_links, enforced at intake, not just at a
  // later gate run). External links, tel:/mailto:, and in-page anchors are
  // never checked against pageIndex — they aren't internal page links.
  const outboundList: any[] = Array.isArray(internalLinks) ? internalLinks : [];
  // Both sides through the same canonical rule — keys AND targets.
  const pageIndexUrls = new Set(Object.keys(site.siteGraph?.pageIndex || {}).map(canonicalUrl));
  const brokenLink = outboundList.find((l) => {
    const resolved = canonicalInternalHref(l.targetUrl, site.domain);
    return resolved !== null && !pageIndexUrls.has(resolved);
  });
  if (brokenLink) {
    return json({ error: `Outbound link to "${brokenLink.targetUrl}" doesn't match any known page on this site — fix or remove it before saving.` }, 400);
  }

  const now = Date.now();
  const pageId = await savePage({
    siteId,
    clientId: site.clientId,
    title: String(title).trim(),
    slug: String(slug || "").trim(),
    htmlBody,
    metaDescription: String(metaDescription || ""),
    canonicalUrl: null,
    schemaJsonLd: schemaJsonLd || null,
    ogTags: {},
    pageType: pageType || "other",
    status: "draft",
    scheduledFor: null,
    publishedAt: null,
    publishedUrl: null,
    commitSha: null,
    // parentUrl/sourceUrl are compared against pageIndex keys by the gate,
    // so they're stored canonical — not as whatever form the picker sent.
    parentUrl: parentUrl ? canonicalUrl(parentUrl) : null,
    parentAcknowledgedMissing: !!parentAcknowledgedMissing,
    internalLinks: outboundList,
    inboundLinkTasks: inboundList.map((t: any) => ({ ...t, sourceUrl: canonicalUrl(t.sourceUrl) })),
    createdAt: now,
    updatedAt: now,
  });

  for (let i = 0; i < imgList.length; i++) {
    const img = imgList[i];
    await saveImage({
      pageId,
      originalFilename: img.originalFilename || `image-${i}`,
      storedPath: img.storedPath || "",
      altText: String(img.altText),
      width: Number(img.width) || 0,
      height: Number(img.height) || 0,
      isLcp: !!img.isLcp,
      format: img.format || "webp",
      uploadedRemoteUrl: img.uploadedRemoteUrl || null,
      sortOrder: i,
    });
  }

  // Keeps CalendarView's light-pointer array in sync (page-publisher-
  // build-spec.md §2/§7) — this page won't actually show on the Calendar
  // until scheduledFor is set (still null here, Stage 4 work), but the
  // pointer exists from creation onward rather than needing a separate
  // backfill once scheduling exists.
  await upsertPageRef(site.clientId, { id: pageId, title: String(title).trim(), status: "draft", scheduledFor: null, siteId });

  return json({ ok: true, pageId });
};

export const config: Config = { path: "/api/page-publisher-create-page" };
