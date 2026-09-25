import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { getPage, getSite, patchPageContent, saveImage, deleteImageDocsForPage } from "../../shared/page-publisher/firestore.mts";
import { canonicalUrl, canonicalInternalHref } from "../../shared/page-publisher/urls.mts";

// POST /api/page-publisher-update-page {pageId, ...fields}
// — edits a page's CONTENT. Every field this accepts is one a gate check
// reads, so it always goes through patchPageContent, which bumps updatedAt
// and therefore invalidates any prior gate pass (the staleness rule).
//
// That invalidation is the entire point: without an edit path that bumps
// updatedAt, "editing after a pass invalidates the pass" would be an
// unenforceable claim. Anything that must NOT invalidate a pass (status,
// scheduledFor, commitSha) belongs in patchPageStatus instead — see
// firestore.mts.
//
// Re-validates the same hard rules create-page does (no unresolved
// placeholders, alt text required, no broken internal links, parent decided)
// rather than trusting a client edit.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

const PLACEHOLDER_RE = /\[[A-Z_]+:\s*[^\]]*\]/;
const CONTENT_FIELDS = ["title", "slug", "metaDescription", "pageType", "htmlBody", "schemaJsonLd", "canonicalUrl", "parentUrl", "parentAcknowledgedMissing", "internalLinks", "inboundLinkTasks"] as const;

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const { pageId, images } = body;
  if (!pageId) return json({ error: "pageId is required" }, 400);

  const page = await getPage(pageId);
  if (!page) return json({ error: "No such page" }, 404);
  const site = await getSite(page.siteId);
  if (!site) return json({ error: "That page's site no longer exists" }, 404);

  const patch: Record<string, any> = {};
  for (const f of CONTENT_FIELDS) if (f in body) patch[f] = body[f];

  if (typeof patch.htmlBody === "string" && PLACEHOLDER_RE.test(patch.htmlBody)) {
    return json({ error: "This page still has an unresolved [BRACKETED] placeholder — resolve every one before saving." }, 400);
  }
  if ("parentUrl" in patch || "parentAcknowledgedMissing" in patch) {
    const parentUrl = "parentUrl" in patch ? patch.parentUrl : page.parentUrl;
    const ack = "parentAcknowledgedMissing" in patch ? patch.parentAcknowledgedMissing : page.parentAcknowledgedMissing;
    if (!parentUrl && !ack) return json({ error: "Pick a parent/hub page, or explicitly acknowledge no suitable parent exists." }, 400);
    if (parentUrl) patch.parentUrl = canonicalUrl(parentUrl);
  }
  if (Array.isArray(patch.internalLinks)) {
    const idx = new Set(Object.keys(site.siteGraph?.pageIndex || {}).map(canonicalUrl));
    const broken = patch.internalLinks.find((l: any) => {
      const resolved = canonicalInternalHref(l.targetUrl, site.domain);
      return resolved !== null && !idx.has(resolved);
    });
    if (broken) return json({ error: `Outbound link to "${broken.targetUrl}" doesn't match any known page on this site.` }, 400);
  }
  if (Array.isArray(patch.inboundLinkTasks)) {
    patch.inboundLinkTasks = patch.inboundLinkTasks.map((t: any) => ({ ...t, sourceUrl: canonicalUrl(t.sourceUrl) }));
  }

  const imgList: any[] | null = Array.isArray(images) ? images : null;
  if (imgList) {
    const missingAlt = imgList.find((i) => !i.altText || !String(i.altText).trim());
    if (missingAlt) return json({ error: `Image "${missingAlt.originalFilename || "(unnamed)"}" has no alt text.` }, 400);
  }

  if (Object.keys(patch).length === 0 && !imgList) return json({ error: "Nothing to update." }, 400);

  // Bumps updatedAt → invalidates any prior gate pass.
  await patchPageContent(pageId, patch);

  if (imgList) {
    // Images are replaced wholesale so a removed image actually disappears
    // (the same stale-key reasoning as replaceSiteGraph).
    await deleteImageDocsForPage(pageId);
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
  }

  const updated = await getPage(pageId);
  return json({
    ok: true,
    updatedAt: updated?.updatedAt,
    gatePassInvalidated: true,
    note: "Any previous gate pass no longer covers this page — re-run the gate before scheduling.",
  });
};

export const config: Config = { path: "/api/page-publisher-update-page" };
