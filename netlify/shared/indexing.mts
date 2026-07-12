// Shared between submit-indexing (interactive/per-client-GitHub-Action
// endpoint) and publish-page-log (the cron job that now also auto-submits
// a page for indexing the moment its schedule.ts date passes) — kept in
// ONE place so a page gets indexed identically no matter which path
// triggered it, same reasoning as netlify/shared/heatmap.mts and
// netlify/shared/github-schedule.mts.
import { getStore } from "@netlify/blobs";
import { getGoogleAccessToken } from "./google-auth.mts";

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
export async function submitToGoogle(pageUrl: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const accessToken = await getGoogleAccessToken();
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

// Creates a fresh PrimeIndexer project containing just this one URL. Project
// organization doesn't matter for indexing to work — each call is standalone.
export async function submitToPrimeIndexer(pageUrl: string, label: string): Promise<{ ok: boolean; detail: string }> {
  const apiKey = Netlify.env.get("PRIMEINDEXER_API_KEY");
  if (!apiKey) return { ok: false, detail: "PRIMEINDEXER_API_KEY not configured" };
  try {
    const res = await fetch("https://app.primeindexer.com/api/v1/projects", {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ name: label, urls: [pageUrl] }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) return { ok: false, detail: data.message || `HTTP ${res.status}` };
    return { ok: true, detail: data.message || "Submitted" };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message || e) };
  }
}

// Submits to both services in parallel and logs the result — the one call
// both submit-indexing and publish-page-log need.
export async function submitAndLog(pageUrl: string, label: string, source: string) {
  const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
  const projectName = `${label} - auto ${dateStr}`;
  const [google, primeIndexer] = await Promise.all([
    submitToGoogle(pageUrl),
    submitToPrimeIndexer(pageUrl, projectName),
  ]);
  await appendIndexingLog({ at: Date.now(), url: pageUrl, label, source, google, primeIndexer });
  return { url: pageUrl, google, primeIndexer };
}
