import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { getTokenPreferServiceAccount, GOOGLE_SCOPES } from "../../shared/google-auth.mts";

// Server-side Search Console data for the Analytics tab. Uses the ONE
// stored agency refresh token (netlify/shared/google-auth.mts — same one
// the Indexing API uses; the consent included webmasters.readonly), so the
// browser never has to run a Google login popup again. Replaces the old
// client-side Google Identity Services flow whose access tokens expired
// every hour and constantly demanded re-login.
//
// POST /api/gsc-data
//   {action:"sites"}                → {sites:[siteUrl,...]}
//   {action:"query", siteUrl}      → the assembled dashboard payload

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

async function gscFetch(url: string, token: string, options: any = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({} as any));
    throw new Error(err.error?.message || `GSC API error ${res.status}`);
  }
  return res.json();
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action: string = (body.action || "").toString();

  // Service-account first (no refresh token to expire), OAuth as fallback.
  let token: string;
  try { ({ token } = await getTokenPreferServiceAccount([GOOGLE_SCOPES.searchConsole])); }
  catch (e: any) { return json({ error: String(e?.message || e) }, 500); }

  try {
    if (action === "sites") {
      const data = await gscFetch("https://www.googleapis.com/webmasters/v3/sites", token);
      return json({ sites: (data.siteEntry || []).map((s: any) => s.siteUrl) });
    }

    if (action === "query") {
      const siteUrl: string = (body.siteUrl || "").toString().trim();
      if (!siteUrl) return json({ error: "siteUrl is required" }, 400);
      const end = new Date(); end.setDate(end.getDate() - 1);
      const start = new Date(); start.setDate(start.getDate() - 29);
      const fmt = (d: Date) => d.toISOString().split("T")[0];
      const startDate = fmt(start), endDate = fmt(end);
      const baseUrl = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
      const q = (extra: any) => gscFetch(baseUrl, token, { method: "POST", body: JSON.stringify({ startDate, endDate, type: "web", ...extra }) });

      const [summary, queries, pages, daily, devices] = await Promise.all([
        q({ dimensions: [] }),
        q({ dimensions: ["query"], rowLimit: 10 }),
        q({ dimensions: ["page"], rowLimit: 10 }),
        q({ dimensions: ["date"] }),
        q({ dimensions: ["device"] }),
      ]);

      const s = summary.rows?.[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
      const noData = (!summary.rows || summary.rows.length === 0) && (!queries.rows || queries.rows.length === 0);
      return json({
        noData,
        totalClicks: s.clicks || 0,
        totalImpressions: s.impressions || 0,
        avgCtr: (s.ctr || 0) * 100,
        avgPosition: s.position || 0,
        queries: (queries.rows || []).map((r: any) => ({ query: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr * 100, position: r.position })),
        pages: (pages.rows || []).map((r: any) => ({ page: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr * 100, position: r.position })),
        daily: (daily.rows || []).map((r: any) => ({ date: r.keys[0], clicks: r.clicks, impressions: r.impressions })),
        devices: (devices.rows || []).map((r: any) => ({ device: r.keys[0], clicks: r.clicks, impressions: r.impressions })),
      });
    }

    return json({ error: `Unknown action "${action}"` }, 400);
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, 502);
  }
};

export const config: Config = { path: "/api/gsc-data" };
