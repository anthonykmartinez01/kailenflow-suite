import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { getRnrAccessToken, RnrNotConnectedError } from "../../shared/google-auth.mts";
import { gbpRead } from "../../shared/gbp-guard.mts";
import { allLocations, type Loc } from "../../shared/rnr-locations.mts";
import { saveListingMeta } from "../../shared/portfolio-reviews.mts";
import { TZ, todayIn, parseMonth, planMonth, finalizeWindows, classify, keyStr, dayKey } from "../../shared/gbp-portfolio-window.mts";

// GBP PORTFOLIO — a hand-picked set of Business Profiles side by side, one
// calendar month at a time: calls, website clicks, impressions, reviews. Built
// for Anthony's RANK-AND-RENT listings. Nothing is auto-included: the report
// covers ONLY the locations the operator has explicitly selected.
//
// POST /api/gbp-portfolio
//   {action:"locations"}         -> every location the account can see + which are selected
//   {action:"select", ids:[...]} -> save the selection (bare location ids)
//   {month:"YYYY-MM", fresh}     -> the report for that month (default: this month)
//
// Selection + cached reports live in Netlify Blobs, NOT appData/main (1MiB cap).
//
// ─── Which Google account ───────────────────────────────────────────────────
// ONLY the separate rank-and-rent account (getRnrAccessToken). Never the main
// client account, and no fallback to it — the two are kept apart on purpose.
//
// ─── STRICTLY READ-ONLY toward Google ───────────────────────────────────────
// Every Business Profile call is a GET routed through gbpRead(), which asserts
// against the write guard (shared/gbp-guard.mts). Reading performance data
// cannot change a listing. Saving the selection writes only to our own store.
//
// ─── Accuracy rules (see shared/gbp-portfolio-window.mts + its test) ────────
// • Dates are Central time, not the server's UTC clock.
// • Google fills in the last ~2–3 days late. Until a month is settled, it ends
//   on the last day Google has data for, and last month is cut to the same days.
// • A listing that fails to load is COUNTED as failed and flagged in the UI —
//   never silently treated as zero calls.
// • "Total reviews" is the all-time public count (Places API), not this month.
//   Reviews come from Places because the v4 reviews API isn't enabled here.
// • "Calls" = CALL_CLICKS = taps on the Call button, same as Google's own
//   Performance screen. "Impressions" = the four BUSINESS_IMPRESSIONS_* metrics
//   (Search + Maps, mobile + desktop), which Google counts once per person per day.

const PERF_API = "https://businessprofileperformance.googleapis.com/v1";
const PLACE_DETAILS = "https://places.googleapis.com/v1/places";

const IMPRESSIONS = [
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
];
const ACTIONS = ["CALL_CLICKS", "WEBSITE_CLICKS", "BUSINESS_DIRECTION_REQUESTS"];

const CACHE_TTL_MS = 60 * 60 * 1000;
const SELECTION_KEY = "selection";

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

async function readJson(url: string, token: string): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await gbpRead(url, token);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const action: string = (body.action || "report").toString();
  const store = getStore("gbp-portfolio");

  const readSelection = async (): Promise<string[]> => {
    const s = (await store.get(SELECTION_KEY, { type: "json" }).catch(() => null)) as any;
    return Array.isArray(s?.ids) ? s.ids.map(String) : [];
  };
  const clearReportCache = async () => {
    try {
      const { blobs } = await store.list({ prefix: "m" });
      for (const b of blobs) { try { await store.delete(b.key); } catch { /* fine */ } }
    } catch { /* fine */ }
  };

  // ---- select: saving the choice touches only our own store, never Google ----
  if (action === "select") {
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map((x: any) => String(x).replace(/^locations\//, "").trim()).filter(Boolean))] : null;
    if (!ids) return json({ error: "ids must be an array" }, 400);
    await store.setJSON(SELECTION_KEY, { ids, at: Date.now() });
    await clearReportCache(); // a cached report was built for the OLD selection
    return json({ ok: true, selectedIds: ids });
  }

  const today = todayIn(TZ);
  const { y, m, month } = parseMonth(body.month, today);
  const plan = planMonth(y, m, today);
  // Google keeps ~18 months of performance data.
  if (action === "report" && (plan.monthsBack < 0 || plan.monthsBack > 17)) {
    return json({ error: "Pick a month between this month and 17 months ago — Google only keeps about 18 months of listing data." }, 400);
  }
  const fresh = body.fresh === true;

  // Token BEFORE cache: a report cached from an earlier account must never be
  // served while the rank-and-rent account isn't connected.
  let token: string;
  try { token = await getRnrAccessToken(); }
  catch (e: any) {
    if (e instanceof RnrNotConnectedError) return json({ needsRnrConnect: true });
    return json({ error: "Couldn't sign in to your rank-and-rent Google account.", detail: String(e?.message || e), needsRnrReconnect: true }, 500);
  }

  if (action === "report" && !fresh) {
    const cached = (await store.get(`m${month}`, { type: "json" }).catch(() => null)) as any;
    // Only a SETTLED month (ended 8+ days ago, built after it settled) is kept
    // for good. Anything newer can still change at Google, so it expires hourly.
    const permanent = cached?.data?.settled === true;
    if (cached?.at && (permanent || Date.now() - cached.at < CACHE_TTL_MS)) return json({ ...cached.data, cachedAt: cached.at });
  }

  try {
    const all = await allLocations(token);
    if (!all.ok) {
      return json({ error: "Couldn't reach Google Business Profile.", detail: all.message, needsRnrReconnect: all.status === 401 }, 502);
    }
    const selectedIds = await readSelection();

    // ---- locations: the picker ----
    if (action === "locations") {
      return json({
        locations: all.locations.map((l) => ({ id: l.id, title: l.title, city: l.city, selected: selectedIds.includes(l.id) })),
        selectedIds,
      });
    }

    if (action !== "report") return json({ error: `Unknown action "${action}"` }, 400);

    // ---- report: SELECTED listings only ----
    const chosen = all.locations.filter((l) => selectedIds.includes(l.id));
    const missingIds = selectedIds.filter((id) => !all.locations.some((l) => l.id === id));
    if (!chosen.length) {
      return json({ needsSelection: true, locations: [], missingIds, totals: null });
    }

    // The Reviews section's scheduled scan needs each selected listing's placeId
    // but has no Google login of its own — hand it the list here.
    try { await saveListingMeta(chosen.map((l) => ({ id: l.id, title: l.title, city: l.city, placeId: l.placeId }))); } catch { /* history is optional */ }

    const placesKey = Netlify.env.get("GOOGLE_PLACES_KEY");
    const canRequest = plan.requestEnd >= plan.requestStart;

    // Pass 1: raw daily points per listing. Windows are decided after, once we
    // know the last day Google has actually filled in.
    type Point = { metric: string; day: number; value: number };
    const fetched = await pool(chosen, 4, async (loc) => {
      const out: { loc: Loc; points: Point[]; error: string | null; rating: number | null; reviews: number | null } =
        { loc, points: [], error: null, rating: null, reviews: null };

      if (canRequest) {
        const s = Math.floor(plan.requestStart / 10000), sm = Math.floor(plan.requestStart / 100) % 100, sd = plan.requestStart % 100;
        const e = Math.floor(plan.requestEnd / 10000), em = Math.floor(plan.requestEnd / 100) % 100, ed = plan.requestEnd % 100;
        const p = new URLSearchParams();
        for (const metric of [...IMPRESSIONS, ...ACTIONS]) p.append("dailyMetrics", metric);
        p.set("dailyRange.start_date.year", String(s));
        p.set("dailyRange.start_date.month", String(sm));
        p.set("dailyRange.start_date.day", String(sd));
        p.set("dailyRange.end_date.year", String(e));
        p.set("dailyRange.end_date.month", String(em));
        p.set("dailyRange.end_date.day", String(ed));

        const perf = await readJson(`${PERF_API}/locations/${encodeURIComponent(loc.id)}:fetchMultiDailyMetricsTimeSeries?${p}`, token);
        if (!perf.ok) {
          out.error = perf.status === 429 ? "Google rate-limited this listing — press Refresh in a minute." : (perf.body?.error?.message || `HTTP ${perf.status}`);
        } else {
          for (const multi of perf.body.multiDailyMetricTimeSeries || []) {
            for (const series of multi.dailyMetricTimeSeries || []) {
              const metric: string = series.dailyMetric || "";
              for (const dv of series.timeSeries?.datedValues || []) {
                const value = Number(dv.value ?? 0);
                if (!dv.date || !Number.isFinite(value) || value <= 0) continue;
                out.points.push({ metric, day: dayKey(dv.date.year, dv.date.month, dv.date.day), value });
              }
            }
          }
        }
      }

      if (placesKey && loc.placeId) {
        try {
          // gbp-scan-allow: PLACE_DETAILS is places.googleapis.com (public Places API, read-only rating + review count), not a Business Profile host.
          const r = await fetch(`${PLACE_DETAILS}/${encodeURIComponent(loc.placeId)}`, {
            headers: { "X-Goog-Api-Key": placesKey, "X-Goog-FieldMask": "rating,userRatingCount" },
          });
          if (r.ok) {
            const d: any = await r.json();
            out.rating = d.rating ?? null;
            out.reviews = d.userRatingCount ?? 0;
          }
        } catch { /* flagged below as reviewsUnavailable */ }
      }
      return out;
    });

    // Google fills in every listing's numbers together, so the latest day with
    // ANY value across the selection is the last day that's actually complete.
    let lastDataKey: number | null = null;
    for (const f of fetched) for (const pt of f.points) if (lastDataKey == null || pt.day > lastDataKey) lastDataKey = pt.day;
    const windows = finalizeWindows(plan, lastDataKey);

    // Pass 2: sum each day into exactly one window (or neither).
    const rows = fetched.map((f) => {
      const row = {
        id: f.loc.id, title: f.loc.title, city: f.loc.city,
        calls: 0, websiteClicks: 0, directions: 0, views: 0,
        prevCalls: 0, prevWebsiteClicks: 0, prevDirections: 0, prevViews: 0,
        rating: f.rating, reviews: f.reviews, error: f.error,
      };
      for (const pt of f.points) {
        const w = classify(windows, pt.day);
        if (!w) continue;
        const cur = w === "cur";
        if (pt.metric === "CALL_CLICKS") cur ? (row.calls += pt.value) : (row.prevCalls += pt.value);
        else if (pt.metric === "WEBSITE_CLICKS") cur ? (row.websiteClicks += pt.value) : (row.prevWebsiteClicks += pt.value);
        else if (pt.metric === "BUSINESS_DIRECTION_REQUESTS") cur ? (row.directions += pt.value) : (row.prevDirections += pt.value);
        else if (IMPRESSIONS.includes(pt.metric)) cur ? (row.views += pt.value) : (row.prevViews += pt.value);
      }
      return row;
    });

    rows.sort((a, b) => b.calls - a.calls || b.websiteClicks - a.websiteClicks || a.title.localeCompare(b.title));

    const ok = rows.filter((r) => !r.error);
    const sum = (k: keyof (typeof rows)[number]) => ok.reduce((t, r) => t + (Number(r[k]) || 0), 0);
    const failed = rows.filter((r) => r.error).map((r) => r.title);
    const reviewsUnavailable = rows.filter((r) => r.reviews == null).map((r) => r.title);

    const data = {
      month,
      isCurrentMonth: plan.isCurrentMonth,
      settled: plan.settled && !failed.length,
      empty: windows.empty,
      period: windows.empty ? null : { start: keyStr(windows.cur.start), end: keyStr(windows.cur.end) },
      previousPeriod: windows.empty ? null : { start: keyStr(windows.prev.start), end: keyStr(windows.prev.end) },
      // True when the month was cut short because Google hasn't filled in the last days yet.
      trimmedForLag: windows.trimmedForLag,
      locationCount: rows.length,
      missingIds,
      // Listings whose numbers could NOT be loaded. Totals exclude them, and the UI says so.
      failed,
      reviewsUnavailable,
      totals: {
        calls: sum("calls"), prevCalls: sum("prevCalls"),
        websiteClicks: sum("websiteClicks"), prevWebsiteClicks: sum("prevWebsiteClicks"),
        directions: sum("directions"), prevDirections: sum("prevDirections"),
        views: sum("views"), prevViews: sum("prevViews"),
        reviews: rows.reduce((t, r) => t + (r.reviews || 0), 0),
      },
      locations: rows,
    };
    // Never cache a report with failures — the next load should retry Google.
    if (!failed.length) {
      try { await store.setJSON(`m${month}`, { at: Date.now(), data }); } catch { /* cache is optional */ }
    }
    return json({ ...data, cachedAt: null });
  } catch (e: any) {
    return json({ error: "Couldn't load the portfolio.", detail: String(e?.message || e) }, 500);
  }
};

export const config: Config = { path: "/api/gbp-portfolio" };
