import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { getGoogleAccessToken } from "../../shared/google-auth.mts";

const LOG_STORE = "indexing-log";
const LOG_KEY = "entries";
const LOG_CAP = 300;

async function appendLog(entry: any) {
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

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

// Submits a URL to Google's Indexing API. Officially scoped to JobPosting/
// BroadcastEvent content — Google may silently ignore this for a normal page,
// but it costs nothing to try and often works in practice.
async function submitToGoogle(pageUrl: string): Promise<{ ok: boolean; detail: string }> {
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
async function submitToPrimeIndexer(pageUrl: string, label: string): Promise<{ ok: boolean; detail: string }> {
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

// Server-to-server callers (GitHub Actions in a client repo) can't sign in
// as a suite user, so they authenticate with a static shared key instead.
function isAutomationRequest(req: Request): boolean {
  const key = req.headers.get("x-automation-key");
  const expected = Netlify.env.get("AUTOMATION_API_KEY");
  return !!key && !!expected && key === expected;
}

export default async (req: Request, _ctx: Context) => {
  const isAutomation = isAutomationRequest(req);
  if (!(await isAuthed(req)) && !isAutomation) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const pageUrl: string = (body.url || "").trim();
  if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) return json({ error: "A valid http(s) url is required" }, 400);

  const label = (body.label || pageUrl).toString().slice(0, 80);
  const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
  const projectName = `${label} - auto ${dateStr}`;

  const [google, primeIndexer] = await Promise.all([
    submitToGoogle(pageUrl),
    submitToPrimeIndexer(pageUrl, projectName),
  ]);

  await appendLog({ at: Date.now(), url: pageUrl, label, source: isAutomation ? "automation" : "manual", google, primeIndexer });

  return json({ url: pageUrl, google, primeIndexer });
};

export const config: Config = { path: "/api/submit-indexing" };
