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
