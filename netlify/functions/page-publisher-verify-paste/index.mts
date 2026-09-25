import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { getAdapter, isUnsupported } from "../../shared/page-publisher/adapters/index.mts";
import { getPage, getSite, patchPageStatus, upsertPageRef } from "../../shared/page-publisher/firestore.mts";

// POST /api/page-publisher-verify-paste {pageId, url} — Stage 2's
// post-paste verification (page-publisher-build-spec.md §9, revised
// 2026-07-23): the operator pastes a page by hand into the platform's own
// editor, then calls this with the live URL they published it to (there's
// no reliable way to auto-derive a MANUAL-platform URL the way GIT_STATIC's
// schedule.ts does — the operator has to say where it actually landed).
// Fetches the live page (adapter.fetchPageHtml — genuinely just a plain GET,
// no API needed) and checks title/meta actually landed. Schema is checked
// ONLY when the site's naGateItems don't mark it permanently N/A for this
// platform (platform-limitations.mts) — e.g. skipped outright on GoDaddy,
// where it's confirmed impossible, rather than reported as a failure every
// single time.
//
// The schema check requires a REAL, parseable `<script type="application/
// ld+json">` tag — not just the expected text appearing somewhere in the
// raw HTML. That distinction matters: GoDaddy's actual failure mode
// (2026-07-23 hands-on test) is entity-encoding the tag's content, so the
// expected JSON text IS visibly present in the page's raw HTML as escaped
// text, without ever being valid, executable JSON-LD. A naive substring
// check would have been fooled by exactly the bug this was built to catch.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

function titleMatches(html: string, expected: string): boolean {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return false;
  const found = m[1].trim().toLowerCase();
  const want = expected.trim().toLowerCase();
  return !!want && found.includes(want);
}

function metaDescriptionMatches(html: string, expected: string): boolean {
  const tags = [...html.matchAll(/<meta\s+[^>]*>/gi)].map((m) => m[0]);
  const descTag = tags.find((t) => /name=["']description["']/i.test(t));
  if (!descTag) return false;
  const contentMatch = descTag.match(/content=["']([^"']*)["']/i);
  if (!contentMatch) return false;
  const found = contentMatch[1].trim().toLowerCase();
  const want = expected.trim().toLowerCase();
  return !!want && found === want;
}

// Requires an ACTUAL parseable ld+json script — see file header for why a
// substring check on raw HTML isn't safe here.
function hasValidSchema(html: string): boolean {
  const scripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const s of scripts) {
    try { JSON.parse(s[1]); return true; } catch { /* not valid JSON — doesn't count */ }
  }
  return false;
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const { pageId, url } = body;
  if (!pageId || !url) return json({ error: "pageId and url are required" }, 400);

  const page = await getPage(pageId);
  if (!page) return json({ error: "No page found for that pageId" }, 404);
  const site = await getSite(page.siteId);
  if (!site) return json({ error: `Page ${pageId} references siteId ${page.siteId}, which no longer exists` }, 404);

  const adapter = getAdapter(site.platform);
  const htmlResult = await adapter.fetchPageHtml({}, { id: site.id, clientId: site.clientId, domain: site.domain, repo: site.repo, branch: site.branch, pagesDir: site.pagesDir }, url);
  if (isUnsupported(htmlResult)) return json({ error: htmlResult.reason }, 502);

  const titleOk = titleMatches(htmlResult, page.title);
  const metaOk = metaDescriptionMatches(htmlResult, page.metaDescription);

  const schemaNaReason = site.naGateItems?.["l2.schema.*"];
  let schema: { checked: boolean; ok: boolean; skippedReason?: string };
  if (schemaNaReason) {
    schema = { checked: false, ok: true, skippedReason: schemaNaReason };
  } else if (!page.schemaJsonLd) {
    schema = { checked: false, ok: true, skippedReason: "This page has no schema to verify." };
  } else {
    schema = { checked: true, ok: hasValidSchema(htmlResult) };
  }

  const ok = titleOk && metaOk && schema.ok;
  if (ok) {
    // No updatedAt — confirming a paste records WHERE the page went live;
    // it doesn't change the page's content, so it must not invalidate the
    // gate pass that authorized publishing it.
    await patchPageStatus(pageId, { status: "paste_confirmed", publishedAt: Date.now(), publishedUrl: url });
    await upsertPageRef(site.clientId, { id: pageId, title: page.title, status: "paste_confirmed", scheduledFor: page.scheduledFor, siteId: site.id });
  }

  return json({
    ok,
    checks: { title: titleOk, metaDescription: metaOk, schema },
    detail: ok ? "All checks passed — page marked paste_confirmed." : "Not confirmed — one or more checks failed. Nothing changed; fix the live page and re-verify.",
  });
};

export const config: Config = { path: "/api/page-publisher-verify-paste" };
