import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

// Counts website form submissions for ONE client's GoHighLevel sub-account
// (client.ghlLocationId, set in Settings) over a trailing window — powers
// the Dashboard's "Website Leads" card. Uses the same agency-wide
// GHL_API_TOKEN as send-to-ghl/eod-report/call-coach; those all pass
// locationId explicitly in the request already, so the token is agency-
// scoped and can read any client's location this way, not just the one
// fixed GHL_LOCATION_ID used for prospecting.

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const token = Netlify.env.get("GHL_API_TOKEN");
  if (!token) return json({ error: "Server is missing GHL_API_TOKEN. Add it in Netlify env vars." }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const locationId: string = (body.locationId || "").toString().trim();
  if (!locationId) return json({ error: "Missing locationId" }, 400);

  const days = Number(body.days) || 28;
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);

  const headers = { Authorization: `Bearer ${token}`, Version: GHL_VERSION, Accept: "application/json" };

  try {
    // Forms API — every submission across every form on this location,
    // scoped to the trailing window. Paginate in case a client has more
    // than one page's worth of leads in the window.
    let total = 0;
    let page = 1;
    const limit = 100;
    for (let i = 0; i < 20; i++) { // hard cap so a runaway response can't loop forever
      const url = `${GHL_BASE}/forms/submissions?locationId=${encodeURIComponent(locationId)}&startAt=${start.toISOString()}&endAt=${end.toISOString()}&limit=${limit}&page=${page}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const t = await res.text();
        return json({ error: `GHL forms request failed (${res.status}). Check the API token's scopes, or that this Location ID is correct.`, detail: t.slice(0, 200) }, 502);
      }
      const data = await res.json();
      const submissions: any[] = data.submissions || [];
      total += submissions.length;
      if (submissions.length < limit) break; // last page
      page++;
    }
    return json({ totalLeads: total, windowDays: days });
  } catch (e: any) {
    return json({ error: "Couldn't reach GoHighLevel.", detail: String(e?.message || e) }, 502);
  }
};

export const config: Config = { path: "/api/ghl-leads" };
