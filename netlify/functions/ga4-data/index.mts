import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { getGoogleAccessToken } from "../../shared/google-auth.mts";

// Server-backed GA4 reporting (added 2026-07-20), mirroring gsc-data's exact
// pattern — uses the ONE stored agency refresh token (shared/google-auth.mts,
// same one indexing/GSC use; the consent now includes analytics.readonly),
// so the browser never has to run a Google login popup for this again.
// Replaces the old client-side Google Identity Services flow (public/index.html's
// GA4Section) whose access tokens expired every hour and needed a fresh popup
// approval to refresh — the Dashboard's "Google Analytics" card relied on a
// summary only that flow could cache, so an expired token there silently made
// a genuinely-connected client look disconnected.
//
// POST /api/ga4-data
//   {action:"properties"}            → {properties:[{property,displayName},...]}
//   {action:"query", propertyId}     → the assembled dashboard payload

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

async function gaFetch(url: string, token: string, options: any = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({} as any));
    throw new Error(err.error?.message || `GA4 API error ${res.status}`);
  }
  return res.json();
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action: string = (body.action || "").toString();

  let token: string;
  try { token = await getGoogleAccessToken(); }
  catch (e: any) { return json({ error: String(e?.message || e) }, 500); }

  try {
    if (action === "properties") {
      const data = await gaFetch("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200", token);
      const properties = (data.accountSummaries || []).flatMap((a: any) =>
        (a.propertySummaries || []).map((p: any) => ({ property: p.property, displayName: p.displayName || p.property }))
      );
      return json({ properties });
    }

    if (action === "query") {
      const propertyId: string = (body.propertyId || "").toString().trim();
      if (!propertyId) return json({ error: "propertyId is required" }, 400);
      const end = new Date(); end.setDate(end.getDate() - 1);
      const start = new Date(); start.setDate(start.getDate() - 29);
      const fmt = (d: Date) => d.toISOString().split("T")[0];
      const dateRanges = [{ startDate: fmt(start), endDate: fmt(end) }];
      const baseUrl = `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`;
      const run = (extra: any) => gaFetch(baseUrl, token, { method: "POST", body: JSON.stringify({ dateRanges, ...extra }) });

      const [summary, daily, pages, channels] = await Promise.all([
        run({ metrics: [{ name: "activeUsers" }, { name: "sessions" }, { name: "conversions" }, { name: "engagementRate" }] }),
        run({ dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }, { name: "activeUsers" }], orderBys: [{ dimension: { dimensionName: "date" } }] }),
        run({ dimensions: [{ name: "pagePath" }], metrics: [{ name: "screenPageViews" }, { name: "sessions" }], orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }], limit: 10 }),
        run({ dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }], orderBys: [{ metric: { metricName: "sessions" }, desc: true }] }),
      ]);

      const sRow = summary.rows?.[0];
      const noData = !sRow;
      const mv = (row: any, i: number) => parseFloat(row?.metricValues?.[i]?.value || 0);
      return json({
        noData,
        totalUsers: mv(sRow, 0),
        totalSessions: mv(sRow, 1),
        totalConversions: mv(sRow, 2),
        avgEngagementRate: mv(sRow, 3) * 100,
        daily: (daily.rows || []).map((r: any) => ({ date: r.dimensionValues[0].value, sessions: parseFloat(r.metricValues[0].value || 0), users: parseFloat(r.metricValues[1].value || 0) })),
        pages: (pages.rows || []).map((r: any) => ({ page: r.dimensionValues[0].value, views: parseFloat(r.metricValues[0].value || 0), sessions: parseFloat(r.metricValues[1].value || 0) })),
        channels: (channels.rows || []).map((r: any) => ({ channel: r.dimensionValues[0].value, sessions: parseFloat(r.metricValues[0].value || 0) })),
      });
    }

    return json({ error: `Unknown action "${action}"` }, 400);
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, 502);
  }
};

export const config: Config = { path: "/api/ga4-data" };
