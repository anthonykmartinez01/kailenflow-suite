import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

// Counts website form submissions for ONE client's GoHighLevel sub-account
// (client.ghlLocationId, set in Settings) over a trailing window — powers
// the Dashboard's "Website Leads" card.
//
// IMPORTANT: unlike send-to-ghl/eod-report/call-coach (which all share the
// one agency-wide GHL_API_TOKEN), GHL's forms.readonly scope is classified
// as a "Sub-Account" scope in their own docs — it is NOT available on an
// Agency-level Private Integration/app no matter what's granted, confirmed
// by testing (agency token → 401 "not authorized for this scope"). So this
// endpoint requires a PER-CLIENT token generated from inside that client's
// own GHL sub-account (client.ghlPrivateToken, set in Settings), passed in
// the request body. Falls back to GHL_API_TOKEN only if no per-client
// token is provided, purely so a client whose own GHL happens to BE the
// agency's own location still works — for every other client this fallback
// will just hit the same 401 the agency-wide token always gets for Forms.

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const locationId: string = (body.locationId || "").toString().trim();
  if (!locationId) return json({ error: "Missing locationId" }, 400);

  const token: string = (body.token || "").toString().trim() || Netlify.env.get("GHL_API_TOKEN") || "";
  if (!token) return json({ error: "No GHL Private Integration token set for this client, and no fallback GHL_API_TOKEN configured on the server." }, 500);

  const days = Number(body.days) || 28;
  // Months param drives the Reports tab's monthly bar chart (default: this
  // month + the 3 before it, matching the reference card's 4-month view).
  // Kept separate from `days` (still used by the Dashboard's rolling-28-day
  // card) rather than replacing it, so that card's meaning doesn't change.
  const months = Math.max(1, Math.min(12, Number(body.months) || 4));
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  const monthsStart = new Date(end.getFullYear(), end.getMonth() - (months - 1), 1);

  const headers = { Authorization: `Bearer ${token}`, Version: GHL_VERSION, Accept: "application/json" };

  // Pulls every submission (not just a count) in [from, to] so callers can
  // bucket by day/month — paginated in case a client has more than one
  // page's worth in the window.
  async function fetchSubmissions(from: Date, to: Date): Promise<any[]> {
    const out: any[] = [];
    let page = 1;
    const limit = 100;
    for (let i = 0; i < 20; i++) { // hard cap so a runaway response can't loop forever
      const url = `${GHL_BASE}/forms/submissions?locationId=${encodeURIComponent(locationId)}&startAt=${from.toISOString()}&endAt=${to.toISOString()}&limit=${limit}&page=${page}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`GHL forms request failed (${res.status}): ${t.slice(0, 200)}`);
      }
      const data = await res.json();
      const submissions: any[] = data.submissions || [];
      out.push(...submissions);
      if (submissions.length < limit) break; // last page
      page++;
    }
    return out;
  }

  try {
    const [windowSubmissions, monthlySubmissions] = await Promise.all([
      fetchSubmissions(start, end),
      // Only re-fetch the wider range if it doesn't already fall inside the
      // rolling window we just pulled — avoids a redundant second call for
      // the common case (days >= the requested months' span).
      monthsStart < start ? fetchSubmissions(monthsStart, end) : Promise.resolve<any[]>([]),
    ]);
    const allForMonthly = monthsStart < start ? monthlySubmissions : windowSubmissions;

    // Bucket into YYYY-MM counts across the requested month range. GHL's own
    // field name for a submission's timestamp isn't documented consistently
    // across API versions, so this checks the common variants defensively.
    const monthKeys: string[] = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(end.getFullYear(), end.getMonth() - i, 1);
      monthKeys.push(d.toISOString().slice(0, 7));
    }
    const counts: Record<string, number> = {};
    for (const k of monthKeys) counts[k] = 0;
    for (const s of allForMonthly) {
      const raw = s.createdAt || s.dateAdded || s.created_at || s.dateCreated;
      if (!raw) continue;
      const key = new Date(raw).toISOString().slice(0, 7);
      if (key in counts) counts[key]++;
    }
    const monthly = monthKeys.map((month) => ({ month, count: counts[month] }));
    const currentMonthCount = monthly[monthly.length - 1]?.count ?? 0;
    const previousMonthCount = monthly[monthly.length - 2]?.count ?? 0;
    const changePct = previousMonthCount > 0
      ? Math.round(((currentMonthCount - previousMonthCount) / previousMonthCount) * 100)
      : (currentMonthCount > 0 ? 100 : 0);

    return json({
      totalLeads: windowSubmissions.length,
      windowDays: days,
      monthly,
      currentMonthCount,
      previousMonthCount,
      changePct,
    });
  } catch (e: any) {
    return json({ error: "Couldn't reach GoHighLevel.", detail: String(e?.message || e) }, 502);
  }
};

export const config: Config = { path: "/api/ghl-leads" };
