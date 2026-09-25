// Typed Firestore access for the Page Publisher module — separate per-item
// collections (pagePublisherSites/Pages/Images/GateRuns/Log), following the
// exact structural pattern that fixed the rank-map 1MiB crisis
// (firestore-admin.mts's saveRankMapGrid/getRankMapGrid): appData/main only
// ever holds light pointers (see appendPageRef/removePageRef below), every
// heavy record gets its own document in its own collection. See
// page-publisher-build-spec.md §2 for the full field-level shape and the
// 1MiB headroom math each collection was sized against.
// ─── QUERY CONVENTION — read before adding a query here ───
// NEVER combine .where() with .orderBy() on a DIFFERENT field. Firestore
// requires a hand-created composite index for that shape, and because these
// collections were all new in this build, such a query throws
// FAILED_PRECONDITION the first time it runs in production — not in
// development, not at deploy time, but live.
//
// It has bitten twice already:
//   listImagesForPage      (2026-07-23) — broke delete-page AND, silently,
//                          generate-paste-package
//   latestGateRunForPage   (2026-07-26) — broke the publish guard, which
//                          correctly failed closed but for the wrong reason
//
// Both fixed the same way: query by the single equality filter, then sort in
// memory. These result sets are inherently small (images per page, gate runs
// per page, pages per site), so the sort costs nothing and removes an entire
// class of production-only failure. Audited 2026-07-26: zero remaining
// where+orderBy pairs in this file.
//
// If a future collection genuinely needs server-side ordering at scale
// (pagePublisherLog is the likely candidate — it has no read function yet),
// create the composite index deliberately and note it here. Don't discover
// it from a failing gate.
import admin from "firebase-admin";
import { mutateAppData } from "../firestore-admin.mts";

let app: admin.app.App | null = null;
// Exported so storage.mts can target the same Admin app for Firebase
// Storage uploads without duplicating the FIREBASE_SERVICE_ACCOUNT parsing.
export function getApp(): admin.app.App {
  if (app) return app;
  const raw = Netlify.env.get("FIREBASE_SERVICE_ACCOUNT");
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not configured on the server");
  const serviceAccount = JSON.parse(raw);
  app = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return app;
}
function db() {
  return admin.firestore(getApp());
}

// ---- pagePublisherSites ----

export interface SiteGraph {
  updatedAt: number;
  pageIndex: Record<string, { title: string; path: string; parentUrl: string | null; lastSeenAt: number }>;
  linkGraph: Record<string, string[]>;
  schemaGraph: Record<string, string[]>;
  sitemapUrls: string[];
}

export interface AstroLayoutInfo {
  layoutPath: string;
  contentDir: string;
  frontmatterShape: Record<string, any>;
  sampledFrom: string[];
  derivedAt: number;
  inconsistent?: boolean;
  inconsistencyNote?: string;
}

export interface PagePublisherSite {
  id: string;
  clientId: string;
  domain: string;
  platform: "git_static" | "wordpress" | "wix" | "manual";
  repo?: string;
  branch?: string;
  pagesDir?: string;
  capabilityFlags: Record<string, boolean>;
  connectionStatus: "pending" | "connected" | "error" | "revoked";
  lastVerifiedAt: number;
  indexNowKey?: string;
  indexNowKeyFileCommitted?: boolean;
  astroLayout?: AstroLayoutInfo;
  siteGraph?: SiteGraph;
  // llmsTxtPresent added 2026-07-23 (Anthony's ask: confirm l1.crawl.llms_txt
  // is actually planned, not forgotten) — same fetch-once-cache-it shape as
  // the other live-host facts; Stage 3 populates it via a plain
  // `fetch(domain + '/llms.txt')`, no new mechanism needed.
  liveHostChecks?: { checkedAt: number; real404: boolean; hostHonors404: boolean; singleHostOk: boolean; httpsRedirectOk: boolean; llmsTxtPresent: boolean };
  // Set ONCE at connect time from platform-limitations.mts's static map —
  // never re-derived per page or per gate run. Stage 3's gate report filters
  // these item keys out of the main pass/fail list and shows them once in a
  // separate collapsed "Permanently N/A for this platform" section instead
  // (Anthony's explicit instruction, 2026-07-23 — repeating a structural
  // platform fact as a per-page warning trains the operator to ignore it).
  naGateItems?: Record<string, string>;
  // MANUAL-platform only — operator-pasted URLs, merged into
  // siteGraph.pageIndex alongside whatever sitemap discovery finds. Kept
  // separately (not just merged once and forgotten) so a later
  // connect/refresh that re-runs sitemap discovery doesn't silently drop
  // URLs the operator added by hand (page-publisher-connect-manual-site.mts,
  // 2026-07-23 — sitemap discovery on a real Wix client came back at 1 page
  // due to an unhandled sitemap-index; this is the fallback for when
  // discovery is thin or a platform's sitemap is simply unreliable).
  manualUrlOverrides?: string[];
}

const SITES = "pagePublisherSites";

export async function getSite(siteId: string): Promise<PagePublisherSite | null> {
  const snap = await db().collection(SITES).doc(siteId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...(snap.data() as any) };
}

export async function getSiteByClientId(clientId: string): Promise<PagePublisherSite | null> {
  const q = await db().collection(SITES).where("clientId", "==", clientId).limit(1).get();
  if (q.empty) return null;
  const d = q.docs[0];
  return { id: d.id, ...(d.data() as any) };
}

export async function saveSite(site: Omit<PagePublisherSite, "id"> & { id?: string }): Promise<string> {
  const id = site.id || db().collection(SITES).doc().id;
  const { id: _drop, ...rest } = site as any;
  await db().collection(SITES).doc(id).set(rest, { merge: true });
  return id;
}

export async function patchSite(siteId: string, patch: Record<string, any>): Promise<void> {
  await db().collection(SITES).doc(siteId).set(patch, { merge: true });
}

// REPLACES siteGraph wholesale instead of deep-merging it.
//
// set(..., {merge:true}) deep-merges nested maps, so a key removed from
// pageIndex (a deleted or renamed page) survives forever. That's not
// hypothetical: it produced a phantom duplicate-title finding on Rankin
// Waste (2026-07-26) — a stale "/index" key from before the URL
// normalization fix sat alongside the corrected "/" entry, and the gate
// dutifully reported them as duplicates. update() with a whole-map value
// replaces that field outright, which is what a rebuilt index needs.
export async function replaceSiteGraph(siteId: string, siteGraph: SiteGraph): Promise<void> {
  await db().collection(SITES).doc(siteId).update({ siteGraph });
}

// ---- pagePublisherPages ----

export interface PagePublisherPage {
  id: string;
  siteId: string;
  clientId: string;
  title: string;
  slug: string;
  htmlBody: string;
  metaDescription: string;
  canonicalUrl: string | null;
  schemaJsonLd: any;
  ogTags: Record<string, string>;
  pageType: "service" | "location" | "blog" | "other";
  status: "draft" | "gate_failed" | "approved" | "scheduled" | "publishing" | "published" | "publish_failed" | "ready_to_paste" | "paste_confirmed";
  scheduledFor: string | null;
  publishedAt: number | null;
  publishedUrl: string | null;
  commitSha: string | null;
  parentUrl: string | null;
  parentAcknowledgedMissing: boolean;
  internalLinks: { targetUrl: string; anchorText: string; verified200: boolean }[];
  inboundLinkTasks: { sourceUrl: string; anchorText: string; status: "pending" | "applied" | "failed" | "manual_required" }[];
  createdAt: number;
  updatedAt: number;
  // Set only by the ScheduledPages migration (§9 Stage 1) — absent on pages
  // authored directly in Page Publisher.
  migratedFromScheduledPageId?: string;
}

const PAGES = "pagePublisherPages";

export async function getPage(pageId: string): Promise<PagePublisherPage | null> {
  const snap = await db().collection(PAGES).doc(pageId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...(snap.data() as any) };
}

export async function savePage(page: Omit<PagePublisherPage, "id"> & { id?: string }): Promise<string> {
  const id = page.id || db().collection(PAGES).doc().id;
  const { id: _drop, ...rest } = page as any;
  await db().collection(PAGES).doc(id).set(rest, { merge: true });
  return id;
}

export async function listPagesBySite(siteId: string): Promise<PagePublisherPage[]> {
  const q = await db().collection(PAGES).where("siteId", "==", siteId).get();
  return q.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
}

// ─── Two deliberately different patch functions ───
// The gate's staleness rule is "gateRun.runAt must be newer than
// page.updatedAt". That only works if updatedAt tracks CONTENT changes and
// nothing else:
//
//   patchPageContent — bumps updatedAt. Use for ANYTHING a gate check reads:
//     body, meta, slug, schema, images, alt text, internal/outbound links,
//     parent. Editing after a pass MUST invalidate that pass.
//   patchPageStatus  — does NOT bump updatedAt. Use for bookkeeping only:
//     status, publishedAt, publishedUrl, commitSha, scheduledFor, link-task
//     status. If status writes bumped updatedAt, run-gate would invalidate
//     its own pass the instant it recorded the result (runAt < updatedAt on
//     every single run) and no page could ever be publishable.
//
// patchPage is kept as an explicit alias of the status variant so existing
// callers keep their (correct) non-bumping behavior.
export async function patchPageContent(pageId: string, patch: Record<string, any>): Promise<void> {
  await db().collection(PAGES).doc(pageId).set({ ...patch, updatedAt: Date.now() }, { merge: true });
}

export async function patchPageStatus(pageId: string, patch: Record<string, any>): Promise<void> {
  await db().collection(PAGES).doc(pageId).set(patch, { merge: true });
}

export const patchPage = patchPageStatus;

export async function deletePage(pageId: string): Promise<void> {
  await db().collection(PAGES).doc(pageId).delete();
}

// ---- pagePublisherImages ----

export interface PagePublisherImage {
  id: string;
  pageId: string;
  originalFilename: string;
  storedPath: string;
  altText: string;
  width: number;
  height: number;
  isLcp: boolean;
  format: "webp" | "avif" | "jpeg" | "png";
  uploadedRemoteUrl: string | null;
  sortOrder: number;
}

const IMAGES = "pagePublisherImages";

export async function saveImage(image: Omit<PagePublisherImage, "id"> & { id?: string }): Promise<string> {
  const id = image.id || db().collection(IMAGES).doc().id;
  const { id: _drop, ...rest } = image as any;
  await db().collection(IMAGES).doc(id).set(rest, { merge: true });
  return id;
}

// Sorted in memory rather than via Firestore's own .orderBy("sortOrder") —
// confirmed live 2026-07-23 that a where()+orderBy() on different fields
// needs a composite index Firestore doesn't build automatically, and this
// one was never created (this query path had never actually run in
// production before generate-paste-package/delete-page existed — every
// image list here is small, so sorting client-side costs nothing and
// removes the index dependency entirely rather than requiring a manual
// Firebase Console step).
export async function listImagesForPage(pageId: string): Promise<PagePublisherImage[]> {
  const q = await db().collection(IMAGES).where("pageId", "==", pageId).get();
  return q.docs.map((d) => ({ id: d.id, ...(d.data() as any) })).sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function deleteImageDocsForPage(pageId: string): Promise<void> {
  const q = await db().collection(IMAGES).where("pageId", "==", pageId).get();
  await Promise.all(q.docs.map((d) => d.ref.delete()));
}

// ---- pagePublisherGateRuns ----

export interface GateItemResult {
  itemId: string;
  // 'not_applicable' = permanently impossible on this platform.
  // 'not_implemented' = this build has no evaluator yet — never a pass,
  // never blocking (see gate.mts's ItemResult for why they're distinct).
  result: "pass" | "fail" | "unverifiable" | "not_applicable" | "not_implemented";
  evidence: string;
}

export interface PagePublisherGateRun {
  id: string;
  pageId: string;
  runAt: number;
  layer1Results: GateItemResult[];
  layer2Results: GateItemResult[];
  blockingFailures: string[];
  warnings: string[];
  overall: "pass" | "fail";
  gateVersion: string;
  // readyToPublish is STRICTER than overall:'pass' — it additionally requires
  // every site-scoped finding to have been acknowledged for this page.
  // Persisted (added 2026-07-26) because it previously existed only in the
  // run-gate HTTP response, which meant the publish guard had no way to
  // verify acknowledgment and would have let an unacknowledged page through
  // on overall:'pass' alone.
  readyToPublish?: boolean;
  acknowledgedItems?: string[];
  unacknowledgedItems?: string[];
}

const GATE_RUNS = "pagePublisherGateRuns";

export async function saveGateRun(run: Omit<PagePublisherGateRun, "id"> & { id?: string }): Promise<string> {
  const id = run.id || db().collection(GATE_RUNS).doc().id;
  const { id: _drop, ...rest } = run as any;
  await db().collection(GATE_RUNS).doc(id).set(rest);
  return id;
}

// Sorted in memory, NOT via Firestore's .orderBy() — a where()+orderBy() on
// different fields needs a composite index that doesn't exist, and this
// query path only started running in production when the publish guard
// began calling it (2026-07-26). Caught live: the guard failed closed with
// "could not read gate history", which was the right behavior for the wrong
// reason. Same fix already applied to listImagesForPage for the same cause.
export async function latestGateRunForPage(pageId: string): Promise<PagePublisherGateRun | null> {
  const q = await db().collection(GATE_RUNS).where("pageId", "==", pageId).get();
  if (q.empty) return null;
  const runs = q.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as PagePublisherGateRun[];
  runs.sort((a, b) => (b.runAt || 0) - (a.runAt || 0));
  return runs[0];
}

// ---- pagePublisherLog ----

export interface PagePublisherLogEntry {
  id: string;
  pageId: string;
  attemptedAt: number;
  adapter: string;
  requestSummary: Record<string, any>;
  responseStatus: number | null;
  responseBodyExcerpt: string | null;
  outcome: "success" | "failure" | "partial";
  errorMessage: string | null;
}

const LOG = "pagePublisherLog";

export async function appendLog(entry: Omit<PagePublisherLogEntry, "id">): Promise<void> {
  // Excerpt/message caps match §2's data-model note — never let an
  // unbounded upstream error message or response body grow this doc.
  const capped: PagePublisherLogEntry = {
    ...entry,
    id: "",
    responseBodyExcerpt: entry.responseBodyExcerpt ? entry.responseBodyExcerpt.slice(0, 2000) : null,
    errorMessage: entry.errorMessage ? entry.errorMessage.slice(0, 500) : null,
  };
  const { id: _drop, ...rest } = capped;
  await db().collection(LOG).add(rest);
}

// ---- appData/main light pointers (client.pagePublisher.pageRefs) ----
// The ONLY Page Publisher data allowed to live in the shared appData/main
// document — everything else above lives in its own collection. Kept
// intentionally tiny (id/title/status/scheduledFor/siteId) per §2's 1MiB
// headroom math. Pruning old entries is a separate, later concern (§2's own
// recommendation) — not implemented yet, deliberately, since Stage 1 has no
// scheduling/publish flow that would make entries accumulate yet.
export interface PageRef {
  id: string;
  title: string;
  status: PagePublisherPage["status"];
  scheduledFor: string | null;
  siteId: string;
}

export async function upsertPageRef(clientId: string, ref: PageRef): Promise<void> {
  await mutateAppData((data: any) => {
    const client = (data.clients || []).find((c: any) => c.id === clientId);
    if (!client) return false;
    client.pagePublisher = client.pagePublisher || {};
    const refs: PageRef[] = client.pagePublisher.pageRefs || [];
    const idx = refs.findIndex((r) => r.id === ref.id);
    if (idx >= 0) refs[idx] = ref;
    else refs.push(ref);
    client.pagePublisher.pageRefs = refs;
  });
}
