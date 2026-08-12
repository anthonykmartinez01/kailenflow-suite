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
  // page's worth in the window. Returns {leads, fbAdsHidden} so callers can
  // report what got dropped.
  async function fetchSubmissions(from: Date, to: Date): Promise<{ leads: any[]; fbAdsHidden: number }> {
    const out: any[] = [];
    let fbAdsHidden = 0;
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
      // Chat-widget submissions COUNT as leads (Anthony's call, 2026-07-15
      // — a lead typing into the widget is still a lead). Only these two
      // specific historical submissions are excluded: they hit Anytime
      // Heating & Air's chat widget from an unrelated Facebook-ad situation
      // before the client had any web presence set up — a one-off, same
      // spirit as eod-report's MANUAL_BOOKINGS adjustments. Remove entries
      // once they age out of every displayed window.
      const EXCLUDED_SUBMISSION_IDS = new Set([
        "2ebb5c59-b69f-4170-8675-7e4f4fbab3d9", // Patricia Butler, 2026-07 (Anytime H&A)
        "d7b929ed-1838-41d9-a1ea-b5e35933aefd", // Pat Locklear, 2026-07 (Anytime H&A)
      ]);
      const raw: any[] = data.submissions || [];
      for (const s of raw) {
        if (EXCLUDED_SUBMISSION_IDS.has(String(s.id || ""))) continue;
        // GHL's native Facebook Lead Ads sync writes these in as "form
        // submissions" too, with formId always exactly `fb-<locationId>`
        // (confirmed against live data, 2026-07-17 — 360 IV Infusion &
        // Wellness had 7/10 "leads" this way, none from the real website
        // form). This card is meant to be organic website form traffic
        // only — Facebook ad leads are a paid-traffic funnel Anthony runs
        // through GHL's own automation and tracks separately there, not
        // something this count should mix in.
        if (String(s.formId || "") === `fb-${locationId}`) { fbAdsHidden++; continue; }
        out.push(s);
      }
      if (raw.length < limit) break; // last page — judged on the RAW page size, not the filtered count
      page++;
    }
    return { leads: out, fbAdsHidden };
  }

  // Structural diagnostic for onboarding a new client: answers "what is
  // actually arriving in this sub-account, and through which form?" without
  // exposing a single lead's personal details. Returns form ids/names, the
  // KEYS present on a submission, and counts — never field VALUES, because
  // those are real people's names, emails and phone numbers and there is no
  // reason for a debugging call to carry them anywhere.
  if (body.debug === true) {
    try {
      const { leads } = await fetchSubmissions(monthsStart < start ? monthsStart : start, end);
      const byForm: Record<string, number> = {};
      const keySet = new Set<string>();
      for (const s of leads) {
        const id = String(s.formId || "(none)");
        byForm[id] = (byForm[id] || 0) + 1;
        Object.keys(s || {}).forEach((k) => keySet.add(k));
      }
      // `s.name` on a GHL submission is the LEAD'S name, not the form's — a
      // trap worth naming, since "name" next to "formId" reads like a form
      // title. It is deliberately never returned here; this endpoint reports
      // structure and counts only.
      // Webhook-delivered leads never appear in /forms/submissions — a site
      // that POSTs straight into GHL creates a CONTACT instead. This probes
      // whether the client's token can even read contacts (a separate scope
      // most existing tokens were never granted) and what `source` values
      // exist, which is what any auto-detection would have to key off.
      // Counts and source labels only — no names, emails or phone numbers.
      let contactsProbe: any = { checked: false };
      try {
        const cRes = await fetch(
          `${GHL_BASE}/contacts/?locationId=${encodeURIComponent(locationId)}&limit=100`,
          { headers },
        );
        if (!cRes.ok) {
          contactsProbe = { checked: true, ok: false, status: cRes.status, note: cRes.status === 401 ? "token lacks the Contacts scope" : (await cRes.text()).slice(0, 120) };
        } else {
          const cData = await cRes.json();
          const list: any[] = cData.contacts || [];
          const bySource: Record<string, number> = {};
          for (const c of list) {
            const src = String(c.source || c.attributionSource?.utmSource || "(no source set)");
            bySource[src] = (bySource[src] || 0) + 1;
          }
          contactsProbe = {
            checked: true, ok: true, sampled: list.length,
            sources: Object.entries(bySource).map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
          };
        }
      } catch (e: any) {
        contactsProbe = { checked: true, ok: false, note: String(e?.message || e).slice(0, 120) };
      }

      return json({
        debug: true,
        submissionsFound: leads.length,
        contactsProbe,
        forms: Object.entries(byForm).map(([formId, count]) => ({
          formId,
          // `cwf-` is GHL's chat-widget form prefix — this is what
          // distinguishes a widget conversation from a page form.
          kind: formId.startsWith("cwf-") ? "chat widget" : "page form",
          count,
        })),
        submissionFieldNames: Array.from(keySet).sort(),
      });
    } catch (e: any) {
      return json({ debug: true, error: String(e?.message || e) }, 502);
    }
  }

  // ─── Webhook-delivered leads ─────────────────────────────────────────
  // Some client sites POST straight into GHL rather than using a GHL form.
  // Those leads become CONTACTS and never appear in /forms/submissions, so
  // the card under-reports them to zero. Anthony's rule: on those clients the
  // webhook is used for nothing but website enquiries, so a contact IS a
  // lead.
  //
  // Deduped by contactId against form submissions, because a client can have
  // both: a GHL form ALSO creates a contact, and counting both would double
  // every form lead. Submissions carry contactId, which makes the join exact
  // rather than a guess on name or email.
  //
  // Caveat worth stating plainly, and surfaced in the response: this counts
  // contacts, and anything else that creates a contact in that sub-account
  // (a manual add, a CSV import, a call-in logged by hand) is indistinguish-
  // able from a webhook lead here. It is only accurate while the webhook is
  // genuinely the sole contact-creating path.
  async function fetchContacts(from: Date, to: Date): Promise<{ contacts: any[]; error: string | null }> {
    const out: any[] = [];
    let startAfterId = "";
    let startAfter = "";
    for (let i = 0; i < 20; i++) {
      const q = new URLSearchParams({ locationId, limit: "100" });
      if (startAfterId) { q.set("startAfterId", startAfterId); q.set("startAfter", startAfter); }
      const res = await fetch(`${GHL_BASE}/contacts/?${q}`, { headers });
      if (!res.ok) {
        return { contacts: out, error: res.status === 401
          ? "This client's GHL token doesn't include the View Contacts scope, so webhook leads can't be read. Add it to their Private Integration and save the token again."
          : `GHL contacts request failed (${res.status})` };
      }
      const data = await res.json();
      const batch: any[] = data.contacts || [];
      if (batch.length === 0) break;
      let reachedEnd = false;
      for (const c of batch) {
        const t = new Date(c.dateAdded || c.createdAt || 0).getTime();
        if (!Number.isFinite(t) || t === 0) continue;
        if (t < from.getTime()) { reachedEnd = true; continue; } // list is newest-first
        if (t > to.getTime()) continue;
        out.push(c);
      }
      if (reachedEnd || batch.length < 100) break;
      const last = batch[batch.length - 1];
      startAfterId = last.id;
      startAfter = String(new Date(last.dateAdded || last.createdAt || 0).getTime());
    }
    return { contacts: out, error: null };
  }

  try {
    const [windowResult, monthlyResult] = await Promise.all([
      fetchSubmissions(start, end),
      // Only re-fetch the wider range if it doesn't already fall inside the
      // rolling window we just pulled — avoids a redundant second call for
      // the common case (days >= the requested months' span).
      monthsStart < start ? fetchSubmissions(monthsStart, end) : Promise.resolve<{ leads: any[]; fbAdsHidden: number }>({ leads: [], fbAdsHidden: 0 }),
    ]);
    const windowSubmissions = windowResult.leads;
    const allForMonthly = monthsStart < start ? monthlyResult.leads : windowSubmissions;
    const fbAdsHidden = monthsStart < start ? monthlyResult.fbAdsHidden : windowResult.fbAdsHidden;

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
    // Webhook mode: add contacts that aren't already represented by a form
    // submission, into both the rolling window total and the monthly buckets.
    let webhookLeads = 0;
    let webhookError: string | null = null;
    let webhookCounted = false;
    if (body.leadsViaWebhook === true) {
      webhookCounted = true;
      const fetchFrom = monthsStart < start ? monthsStart : start;
      const { contacts, error } = await fetchContacts(fetchFrom, end);
      webhookError = error;
      // contactId is present on submissions, so the join is exact.
      const seenContactIds = new Set(
        [...allForMonthly, ...windowSubmissions].map((s: any) => String(s.contactId || "")).filter(Boolean),
      );
      for (const c of contacts) {
        if (seenContactIds.has(String(c.id || ""))) continue; // already counted as a form submission
        const t = new Date(c.dateAdded || c.createdAt || 0).getTime();
        if (!Number.isFinite(t)) continue;
        const key = new Date(t).toISOString().slice(0, 7);
        if (key in counts) counts[key]++;
        if (t >= start.getTime()) webhookLeads++;
      }
    }

    const monthly = monthKeys.map((month) => ({ month, count: counts[month] }));
    const currentMonthCount = monthly[monthly.length - 1]?.count ?? 0;
    const previousMonthCount = monthly[monthly.length - 2]?.count ?? 0;
    const changePct = previousMonthCount > 0
      ? Math.round(((currentMonthCount - previousMonthCount) / previousMonthCount) * 100)
      : (currentMonthCount > 0 ? 100 : 0);

    return json({
      totalLeads: windowSubmissions.length + webhookLeads,
      // Broken out so the number is auditable rather than a single figure to
      // take on trust — and so a webhook client with a broken scope shows a
      // reason instead of a silent zero.
      formLeads: windowSubmissions.length,
      webhookLeads,
      webhookCounted,
      webhookError,
      windowDays: days,
      fbAdsHidden,
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
