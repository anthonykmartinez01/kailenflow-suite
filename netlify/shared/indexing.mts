// Shared between submit-indexing (interactive/per-client-GitHub-Action
// endpoint) and publish-page-log (the cron job that now also auto-submits
// a page for indexing the moment its schedule.ts date passes) — kept in
// ONE place so a page gets indexed identically no matter which path
// triggered it, same reasoning as netlify/shared/heatmap.mts and
// netlify/shared/github-schedule.mts.
import { getStore } from "@netlify/blobs";
// Service-account first: the shared user-OAuth refresh token died on
// 2026-07-30 (invalid_grant) and took every scheduled page's indexing check
// with it. A service account has no refresh token to expire. Falls back to
// OAuth automatically if the SA isn't authorised yet. See google-auth.mts.
import { getTokenPreferServiceAccount, GOOGLE_SCOPES } from "./google-auth.mts";

const LOG_STORE = "indexing-log";
const LOG_KEY = "entries";
const LOG_CAP = 300;

export async function appendIndexingLog(entry: any) {
  try {
    const store = getStore(LOG_STORE);
    const existing = (await store.get(LOG_KEY, { type: "json" })) as any[] | null;
    const list = Array.isArray(existing) ? existing : [];
    list.unshift(entry); // newest first
    await store.setJSON(LOG_KEY, list.slice(0, LOG_CAP));
  } catch {
    // Logging is best-effort — never let a logging failure break the actual submission.
  }
}

// Submits a URL to Google's Indexing API. Officially scoped to JobPosting/
// BroadcastEvent content — Google may silently ignore this for a normal page,
// but it costs nothing to try and often works in practice.
//
// Gated on gscProperty (found 2026-07-20): the shared kailenflow-suite
// Google account backs EVERY client's indexing calls, but the Indexing API
// checks the exact same domain-ownership requirement as regular Search
// Console access — the calling account must actually be a verified
// user/owner of that specific site in Search Console, or the call is a
// silent no-op no matter how many times it's retried. client.gscProperty
// (set once, in the client's Analytics tab, via the "Connect Search
// Console" flow — public/index.html's GSCSection) is the app's own record
// that this has actually been done for a given client. Before this fix
// nothing ever checked it — a client whose GSC was never connected (like
// Anytime Air Pros) got indexing "attempts" that were doomed from the
// start, indistinguishable in the logs from a real transient failure.
// Skipping the network call entirely when it's missing surfaces the REAL
// blocker (go connect Search Console for this client) instead of a vague
// "failed, will retry" that retries forever for no reason.
export async function submitToGoogle(pageUrl: string, gscProperty?: string | null): Promise<{ ok: boolean; detail: string }> {
  if (!gscProperty) {
    return { ok: false, detail: "Google Search Console isn't connected for this client yet — connect it in the client's Analytics tab, then indexing will actually submit" };
  }
  try {
    const { token: accessToken } = await getTokenPreferServiceAccount([GOOGLE_SCOPES.indexing]);
    const res = await fetch("https://indexing.googleapis.com/v3/urlNotifications:publish", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ url: pageUrl, type: "URL_UPDATED" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, detail: data.error?.message || `HTTP ${res.status}` };
    return { ok: true, detail: "Submitted" };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message || e) };
  }
}

// Creates ONE PrimeIndexer project for the whole URL list (their API takes
// up to 500 per call). One retry on HTTP 429: PrimeIndexer rate-limits
// bursts, and the 2026-07-12 cron run proved it — four one-URL projects
// fired back-to-back all came back 429 and none got indexed. Batching is
// the real fix (one call per run can't burst); the retry is insurance for
// the leftover single-URL paths (manual UI button, per-repo GitHub Action).
export async function submitToPrimeIndexer(urls: string | string[], label: string): Promise<{ ok: boolean; detail: string }> {
  const apiKey = Netlify.env.get("PRIMEINDEXER_API_KEY");
  if (!apiKey) return { ok: false, detail: "PRIMEINDEXER_API_KEY not configured" };
  const urlList = Array.isArray(urls) ? urls : [urls];
  try {
    const post = () => fetch("https://app.primeindexer.com/api/v1/projects", {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ name: label, urls: urlList }),
    });
    let res = await post();
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 4000));
      res = await post();
    }
    const data = await res.json().catch(() => ({}));
    // 409 means these URLs are already tracked in PrimeIndexer (e.g. from an
    // earlier same-day submission still active under today's project name)
    // — that's success, not failure. Found 2026-07-20: publish-page-log
    // always resubmits to BOTH services together on every retry, even when
    // only Google needs it (its own submission was still broken that day) —
    // without this, PrimeIndexer would 409 on every single hourly retry for
    // the rest of the day for a page that was already fine on its side.
    if (res.status === 409) return { ok: true, detail: data.message || "Already submitted to PrimeIndexer" };
    if (!res.ok || data.success === false) return { ok: false, detail: data.message || `HTTP ${res.status}` };
    return { ok: true, detail: data.message || "Submitted" };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message || e) };
  }
}

// Resolves a URL to its REAL final destination by following HTTP redirects
// server-side, before anything gets submitted or checked. Added 2026-07-20
// after finding that different clients' schedule.ts entries are
// inconsistent about trailing slashes — some sites (Astro, by default)
// 301-redirect a path missing its trailing slash to the "real" canonical
// one. Whichever way a path happens to be typed in schedule.ts, this makes
// sure the URL that actually gets submitted/checked is wherever the site's
// own routing really sends a visitor — not a URL that just redirects
// somewhere else. HEAD (not GET) — cheaper, and all that's needed is the
// Location header. Bounded hops guard against a redirect loop; ANY failure
// (network error, HEAD unsupported, non-redirect response) just returns
// whatever URL we had so far — resolution is a best-effort improvement,
// never a reason to block indexing entirely.
const MAX_REDIRECT_HOPS = 5;
export async function resolveCanonicalUrl(url: string): Promise<string> {
  let current = url;
  for (let i = 0; i < MAX_REDIRECT_HOPS; i++) {
    try {
      const res = await fetch(current, { method: "HEAD", redirect: "manual" });
      if (res.status < 300 || res.status >= 400) return current; // not a redirect — this IS the real page
      const location = res.headers.get("location");
      if (!location) return current;
      current = new URL(location, current).toString();
    } catch {
      return current; // network error, HEAD unsupported, etc — fall back to what we had
    }
  }
  return current; // hit the hop cap — use the last one found rather than looping forever
}

// Submits to both services in parallel and logs the result — the one call
// both submit-indexing and publish-page-log need. gscProperty (see
// submitToGoogle above) should be the calling client's own connected Search
// Console property — pass null/undefined only when there genuinely isn't
// one on file for this client yet.
export async function submitAndLog(pageUrl: string, label: string, source: string, gscProperty?: string | null) {
  const resolvedUrl = await resolveCanonicalUrl(pageUrl);
  const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
  const projectName = `${label} - auto ${dateStr}`;
  const [google, primeIndexer] = await Promise.all([
    submitToGoogle(resolvedUrl, gscProperty),
    submitToPrimeIndexer(resolvedUrl, projectName),
  ]);
  await appendIndexingLog({ at: Date.now(), url: resolvedUrl, originalUrl: resolvedUrl !== pageUrl ? pageUrl : undefined, label, source, google, primeIndexer });
  return { url: resolvedUrl, google, primeIndexer };
}

// Batch variant for the auto-publish cron: per-URL Google submissions (its
// quota is per-URL anyway and it doesn't rate-limit small bursts) but a
// single shared PrimeIndexer project for the whole batch. Returns a map of
// url → result in submitAndLog's shape so callers treat both identically.
// Every URL in a batch call belongs to the same client (publish-page-log
// batches per-client), so one gscProperty applies to the whole batch.
// Keyed by the ORIGINAL (pre-resolution) url, since that's what callers
// (publish-page-log) built from schedule.ts and look results up by — but
// each entry's own .url field is the RESOLVED one actually submitted, so
// downstream storage (indexHistory) records the real canonical URL.
export async function submitBatchAndLog(pageUrls: string[], label: string, source: string, gscProperty?: string | null): Promise<Record<string, { url: string; google: any; primeIndexer: any }>> {
  const resolvedUrls = await Promise.all(pageUrls.map((u) => resolveCanonicalUrl(u)));
  const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
  const projectName = `${label} - auto ${dateStr}`;
  const [googleResults, primeIndexer] = await Promise.all([
    Promise.all(resolvedUrls.map((u) => submitToGoogle(u, gscProperty))),
    submitToPrimeIndexer(resolvedUrls, projectName),
  ]);
  const out: Record<string, { url: string; google: any; primeIndexer: any }> = {};
  for (let i = 0; i < pageUrls.length; i++) {
    const entry = { at: Date.now(), url: resolvedUrls[i], originalUrl: resolvedUrls[i] !== pageUrls[i] ? pageUrls[i] : undefined, label, source, google: googleResults[i], primeIndexer };
    await appendIndexingLog(entry);
    out[pageUrls[i]] = entry;
  }
  return out;
}

// Finds the client whose website matches a page URL's hostname, so callers
// with only a raw URL (submit-indexing's manual/automation path) can still
// look up that client's gscProperty — same host-normalization buildPageUrl
// (below) uses, just inverted (URL → host, not host → URL).
export function findGscPropertyForUrl(clients: any[], pageUrl: string): string | null {
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./i, "").toLowerCase();
    const match = (clients || []).find((c: any) => {
      const ch = (c.website || "").trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "").toLowerCase();
      return ch && ch === host;
    });
    return match?.gscProperty || null;
  } catch {
    return null;
  }
}

// client.website is stored as a bare host ("rankinwaste.com") or sometimes
// with a protocol/www already on it — normalize before gluing a schedule.ts
// path onto it so this never produces a malformed URL. Moved here (from
// publish-page-log) 2026-07-20 so check-indexed-status can build the same
// URLs without duplicating the normalization logic.
export function buildPageUrl(website: string, path: string): string | null {
  const host = (website || "").trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  if (!host) return null;
  const cleanPath = path.startsWith("/") ? path : "/" + path;
  return `https://${host}${cleanPath}`;
}

// Checks whether a URL is ACTUALLY indexed by Google — not "did we submit
// it" but the real, current verdict from Search Console's URL Inspection
// API (searchconsole.googleapis.com), the one Google API that reports true
// indexing state. Uses the same webmasters.readonly scope already granted
// for GSC reporting (netlify/functions/gsc-data) — no new Google consent
// needed. Requires gscProperty (same reasoning as submitToGoogle above):
// the calling account must be verified for this site in Search Console, or
// the inspection call itself fails.
export async function inspectUrl(pageUrl: string, gscProperty: string): Promise<{ indexed: boolean; coverageState: string; lastCrawlTime: string | null; detail: string }> {
  try {
    const { token: accessToken } = await getTokenPreferServiceAccount([GOOGLE_SCOPES.searchConsole]);
    const res = await fetch("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ inspectionUrl: pageUrl, siteUrl: gscProperty }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { indexed: false, coverageState: "error", lastCrawlTime: null, detail: data.error?.message || `HTTP ${res.status}` };
    const result = data.inspectionResult?.indexStatusResult;
    const coverageState: string = result?.coverageState || "Unknown";
    // verdict is Google's own PASS/PARTIAL/FAIL/NEUTRAL summary — PASS is
    // the one that actually means "yes, this is indexed," more reliable
    // than pattern-matching coverageState's human-readable text.
    const indexed = result?.verdict === "PASS";
    return { indexed, coverageState, lastCrawlTime: result?.lastCrawlTime || null, detail: coverageState };
  } catch (e: any) {
    return { indexed: false, coverageState: "error", lastCrawlTime: null, detail: String(e?.message || e) };
  }
}

// Shared by check-indexed-status (daily sweep) and recheck-indexing (manual
// "Recheck now" button) so both produce an identical patch shape — split
// into two functions only because Netlify forbids a scheduled function from
// also declaring a custom path, not because the logic differs.
export async function checkPageIndexed(appData: any, clientId: string, path: string): Promise<{ ok: true; patch: any } | { ok: false; error: string }> {
  const client = (appData.clients || []).find((c: any) => c.id === clientId);
  const rec = client?.publishing?.indexHistory?.[path];
  if (!rec?.url) return { ok: false, error: "No indexing record found for this client/path" };
  if (!client.gscProperty) return { ok: false, error: "Google Search Console isn't connected for this client" };

  // Self-heals stored URLs that still point at a redirect — resolveCanonicalUrl
  // was added 2026-07-20, after some indexHistory entries were already
  // written with a pre-redirect URL (e.g. a schedule.ts path missing a
  // trailing slash the site enforces). A page that never confirms indexed
  // gets checked here every day anyway, so re-resolving on each check
  // self-heals every affected page over time with no separate migration.
  const resolvedUrl = await resolveCanonicalUrl(rec.url);
  const result = await inspectUrl(resolvedUrl, client.gscProperty);
  return {
    ok: true,
    patch: {
      url: resolvedUrl,
      confirmed: result.indexed,
      confirmedAt: result.indexed ? Date.now() : null,
      lastCheckedAt: Date.now(),
      checkAttempts: (rec.checkAttempts || 0) + 1,
      coverageState: result.coverageState,
    },
  };
}
