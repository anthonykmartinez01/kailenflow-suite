import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { getGoogleAccessToken } from "../../shared/google-auth.mts";

// Google Business Profile performance data for ONE client's listing
// (client.gbpLocationId, set in Settings) — powers the Reports tab's
// "GBP Impressions" and "Calls" cards, both hardcoded "not connected"
// placeholders until now.
//
// POST /api/gbp-metrics
//   {action:"locations"}                → {locations:[{name,title,address}]}
//   {action:"query", locationId, months} → {impressions:{...}, calls:{...}}
//
// ─── Why OAuth, not the service account ──────────────────────────────────
// shared/google-auth.mts documents this at length: Business Profile does NOT
// support service accounts — it needs consent from an account that actually
// manages the listing. Indexing/GSC/GA4 moved to the service account because
// the shared refresh token kept expiring; GBP cannot follow them. Don't
// "finish the migration" by swapping getGoogleAccessToken() for
// getServiceAccountToken() here — it will 403.
//
// ─── API access is APPROVED — don't re-add "pending approval" handling ───
// Access request 7-3208000041254 (submitted 2026-07-10) was granted, verified
// 2026-08-02 against the Cloud quota pages: businessprofileperformance shows
// 300 req/min, not the 0 that means "never granted". A 403/429 from here is
// therefore a REAL fault now (wrong account, wrong location, or genuine rate
// limiting) — reporting it as "still waiting on Google" would send Anthony to
// wait on an approval that already landed, so each cause is named separately
// below instead.

const ACCOUNTS_API = "https://mybusinessaccountmanagement.googleapis.com/v1";
const INFO_API = "https://mybusinessbusinessinformation.googleapis.com/v1";
const PERF_API = "https://businessprofileperformance.googleapis.com/v1";
// Posts never moved off the legacy v4 surface when the rest of the Business
// Profile APIs were split up — that's why this one host looks out of place.
const POSTS_API_V4 = "https://mybusiness.googleapis.com/v4";

// The four metrics that together make up "how often did this listing show
// up" — Google reports Search and Maps separately, and each split by device,
// so a single honest impressions total is the sum of all four. Kept as a
// list (not hardcoded into the query string) so the breakdown can be
// reported alongside the total.
const IMPRESSION_METRICS = [
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
] as const;

// CALL_CLICKS is taps on the listing's call button — NOT the same thing as
// tracked inbound calls (no per-client call tracking exists; CallCoach is the
// agency's own OUTBOUND cold-call log). It's the honest ceiling of what GBP
// can say about calls, so the card is labelled accordingly rather than
// implying every tap became a conversation.
const CALL_METRIC = "CALL_CLICKS";

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

// Turns Google's raw error into the one sentence that says what to actually
// DO about it. These three causes look almost identical in the payload but
// need completely different responses, so collapsing them into a single
// "couldn't connect" (or worse, into "waiting on approval", which is no
// longer ever true — see the header) would waste real debugging time.
function explainFailure(status: number, message: string): string | null {
  if (/has not been used|is disabled|accessnotconfigured|service_disabled/i.test(message)) {
    return "The Business Profile Performance API is switched off for the Cloud project — enable it at console.cloud.google.com for project kailenflow-suite.";
  }
  if (status === 429 || /rate limit|too many requests|resource_exhausted/i.test(message)) {
    // Not an approval problem: the quota is 300 req/min and non-zero.
    return "Hit Google's Business Profile rate limit. Nothing is misconfigured — reopen this report in a minute.";
  }
  if (status === 403 || status === 404 || /permission|not authorized|not found/i.test(message)) {
    return "The connected Google account can't see this listing. Check the GBP Location ID in Settings, and that anthonykmartinez01@gmail.com still manages this profile.";
  }
  return null;
}

class GbpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function gbpFetch(url: string, token: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({} as any));
  if (!res.ok) {
    throw new GbpError(body?.error?.message || `Business Profile API error ${res.status}`, res.status);
  }
  return body;
}

// The Performance API addresses a listing as `locations/{id}` with no
// account segment, but the Business Information API hands back names in that
// same `locations/{id}` form while the older v4 API used
// `accounts/{a}/locations/{id}` — and a user pasting an ID from the GBP
// dashboard URL will have neither prefix. Normalising here means all three
// work in the Settings field instead of only the one shape that happens to
// match the docs.
function normalizeLocationId(raw: string): string {
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, "");
  const m = trimmed.match(/locations\/([^/]+)/);
  return m ? m[1] : trimmed;
}

const pad = (n: number) => String(n).padStart(2, "0");

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
    // ─── locations: the Settings picker ──────────────────────────────────
    // Saves the user from hunting a numeric location ID out of a GBP
    // dashboard URL. Also doubles as the connectivity check — if this
    // returns pendingApproval, nothing else in this file can work yet.
    if (action === "locations") {
      const accts = await gbpFetch(`${ACCOUNTS_API}/accounts?pageSize=20`, token);
      const accounts = accts.accounts || [];
      if (!accounts.length) return json({ locations: [], available: true, note: "No Business Profile accounts are visible to the connected Google account." });

      // Agencies commonly have the listings spread across several accounts
      // (own account + client-granted ones), so every account is walked
      // rather than just the first — gbp-probe only looked at accounts[0]
      // because it was a yes/no diagnostic, not a picker.
      const perAccount = await Promise.all(accounts.map(async (a: any) => {
        try {
          const locs = await gbpFetch(
            `${INFO_API}/${a.name}/locations?readMask=name,title,storefrontAddress&pageSize=100`,
            token,
          );
          return (locs.locations || []).map((l: any) => ({
            name: l.name,
            id: normalizeLocationId(l.name || ""),
            title: l.title || l.name,
            address: [l.storefrontAddress?.locality, l.storefrontAddress?.administrativeArea]
              .filter(Boolean).join(", "),
            account: a.accountName || a.name,
          }));
        } catch {
          // One inaccessible account shouldn't blank out the whole picker.
          return [];
        }
      }));

      return json({ available: true, locations: perAccount.flat() });
    }

    // ─── posts-capability: can we publish posts via the API at all? ──────
    // GBP posts live on the OLD v4 endpoint (mybusiness.googleapis.com/v4),
    // a different API from businessprofileperformance which serves the
    // Impressions/Calls cards. Our access approval was verified against the
    // latter, so v4 availability is genuinely unknown — this answers it
    // before anyone builds a publish button on the assumption it works.
    //
    // Strictly READ-ONLY: it LISTS existing posts (GET). It never creates,
    // edits, or deletes anything on a client's live listing.
    if (action === "posts-capability") {
      const locationId = normalizeLocationId((body.locationId || "").toString());
      if (!locationId) return json({ error: "locationId is required" }, 400);

      // v4 addresses a location as accounts/{a}/locations/{l} — unlike the
      // performance API's bare locations/{l} — so the account has to be
      // resolved first.
      const accts = await gbpFetch(`${ACCOUNTS_API}/accounts?pageSize=20`, token);
      const accountName = accts.accounts?.[0]?.name;
      if (!accountName) return json({ available: false, reason: "no-accounts", message: "No Business Profile accounts are visible to the connected Google account." });

      const url = `${POSTS_API_V4}/${accountName}/locations/${encodeURIComponent(locationId)}/localPosts?pageSize=1`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const bodyText = await res.text();
      if (res.ok) {
        return json({
          available: true,
          endpoint: url.replace(/\?.*$/, ""),
          message: "The v4 Local Posts API is reachable — publishing straight to the listing can be wired up.",
        });
      }
      let detail = bodyText.slice(0, 300);
      try { detail = JSON.parse(bodyText)?.error?.message || detail; } catch { /* keep raw text */ }
      return json({
        available: false,
        status: res.status,
        reason: /has not been used|is disabled|accessnotconfigured|service_disabled/i.test(detail)
          ? "api-not-enabled"
          : res.status === 403 ? "not-authorized" : res.status === 404 ? "not-found" : "unknown",
        message: `v4 Local Posts is not usable for this project (HTTP ${res.status}). Publishing cannot be wired up until this resolves.`,
        detail,
      });
    }

    // ─── query: the card payload ─────────────────────────────────────────
    if (action === "query") {
      const locationId = normalizeLocationId((body.locationId || "").toString());
      if (!locationId) return json({ error: "locationId is required" }, 400);
      const months = Math.max(1, Math.min(12, Number(body.months) || 4));

      // GBP performance data lands with a lag of a couple of days and the
      // API simply omits days it has nothing for, so the window ends
      // yesterday rather than today — asking for today would reliably
      // contribute a phantom 0 to the current month and make every report
      // opened in the morning look like a drop.
      const end = new Date();
      end.setDate(end.getDate() - 1);
      const monthsStart = new Date(end.getFullYear(), end.getMonth() - (months - 1), 1);

      // Optional trailing-window mode, for the Dashboard cards — they all
      // read "last 28 days", not "this calendar month", so a month bucket
      // can't answer them. Same days/months split ghl-leads uses, and for
      // the same reason: the two windows mean different things and one must
      // not silently redefine the other.
      const days = body.days == null ? null : Math.max(1, Math.min(540, Number(body.days) || 28));
      const windowStart = days == null ? null : new Date(end.getFullYear(), end.getMonth(), end.getDate() - (days - 1));
      // Whichever reaches further back wins, so a caller asking for both
      // (e.g. months:1 + days:28 near the start of a month) still gets every
      // day the window needs instead of a total silently truncated at the
      // 1st. Fetching the union costs one request either way.
      const start = windowStart && windowStart < monthsStart ? windowStart : monthsStart;

      // Impressions and call clicks come back in ONE request — the endpoint
      // is multi-metric by design, so splitting them into two calls would
      // double the rate-limit cost for identical data.
      const params = new URLSearchParams();
      for (const m of IMPRESSION_METRICS) params.append("dailyMetrics", m);
      params.append("dailyMetrics", CALL_METRIC);
      params.set("dailyRange.start_date.year", String(start.getFullYear()));
      params.set("dailyRange.start_date.month", String(start.getMonth() + 1));
      params.set("dailyRange.start_date.day", String(start.getDate()));
      params.set("dailyRange.end_date.year", String(end.getFullYear()));
      params.set("dailyRange.end_date.month", String(end.getMonth() + 1));
      params.set("dailyRange.end_date.day", String(end.getDate()));

      const data = await gbpFetch(
        `${PERF_API}/locations/${encodeURIComponent(locationId)}:fetchMultiDailyMetricsTimeSeries?${params}`,
        token,
      );

      // Pre-seed every month in the requested range at 0 so a month with no
      // data renders as a real zero bar instead of vanishing from the chart
      // and silently shifting the others along the axis.
      const monthKeys: string[] = [];
      for (let i = months - 1; i >= 0; i--) {
        const d = new Date(end.getFullYear(), end.getMonth() - i, 1);
        monthKeys.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
      }
      const impressionCounts: Record<string, number> = {};
      const callCounts: Record<string, number> = {};
      for (const k of monthKeys) { impressionCounts[k] = 0; callCounts[k] = 0; }

      const breakdown: Record<string, number> = { search: 0, maps: 0, desktop: 0, mobile: 0 };
      let impressionTotal = 0;
      let callTotal = 0;
      let windowImpressions = 0;
      let windowCalls = 0;

      // Response shape: multiDailyMetricTimeSeries[] → dailyMetricTimeSeries[]
      // → {dailyMetric, timeSeries:{datedValues:[{date:{y,m,d}, value}]}}.
      // `value` is omitted entirely on zero days, hence the ?? 0.
      for (const multi of data.multiDailyMetricTimeSeries || []) {
        for (const series of multi.dailyMetricTimeSeries || []) {
          const metric: string = series.dailyMetric || "";
          const isCalls = metric === CALL_METRIC;
          for (const dv of series.timeSeries?.datedValues || []) {
            const v = Number(dv.value ?? 0);
            if (!v || !dv.date) continue;
            const key = `${dv.date.year}-${pad(dv.date.month)}`;
            // The fetched range can reach further back than the trailing
            // window (see `start` above), so each day is tested rather than
            // assumed to be inside it.
            const inWindow = windowStart
              ? new Date(dv.date.year, dv.date.month - 1, dv.date.day) >= windowStart
              : false;
            if (isCalls) {
              if (key in callCounts) callCounts[key] += v;
              callTotal += v;
              if (inWindow) windowCalls += v;
              continue;
            }
            if (inWindow) windowImpressions += v;
            if (key in impressionCounts) impressionCounts[key] += v;
            impressionTotal += v;
            if (metric.includes("SEARCH")) breakdown.search += v;
            if (metric.includes("MAPS")) breakdown.maps += v;
            if (metric.includes("DESKTOP")) breakdown.desktop += v;
            if (metric.includes("MOBILE")) breakdown.mobile += v;
          }
        }
      }

      // Same rule ghl-leads uses, kept identical on purpose so the cards
      // sitting side by side can never disagree about what "+100%" means:
      // growth from a zero baseline is reported as 100%, not Infinity.
      const summarize = (counts: Record<string, number>, total: number) => {
        const monthly = monthKeys.map((month) => ({ month, count: counts[month] }));
        const currentMonthCount = monthly[monthly.length - 1]?.count ?? 0;
        const previousMonthCount = monthly[monthly.length - 2]?.count ?? 0;
        return {
          monthly,
          currentMonthCount,
          previousMonthCount,
          total,
          changePct: previousMonthCount > 0
            ? Math.round(((currentMonthCount - previousMonthCount) / previousMonthCount) * 100)
            : (currentMonthCount > 0 ? 100 : 0),
        };
      };

      return json({
        available: true,
        impressions: { ...summarize(impressionCounts, impressionTotal), breakdown },
        calls: summarize(callCounts, callTotal),
        // Only present when `days` was asked for, so a caller that didn't
        // request a window can't mistake a month total for one.
        window: days == null ? null : { days, impressions: windowImpressions, calls: windowCalls },
        throughDate: `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`,
      });
    }

    return json({ error: `Unknown action "${action}"` }, 400);
  } catch (e: any) {
    const status = e instanceof GbpError ? e.status : 0;
    const message = String(e?.message || e);
    const explained = explainFailure(status, message);
    return json({
      available: false,
      // `error` is what the card shows. When the cause is recognisable it's
      // the actionable sentence; otherwise the raw Google message, which
      // beats a generic "something went wrong" for an unknown fault.
      error: explained || "Couldn't reach Google Business Profile.",
      detail: message,
      // Rate limiting is transient and self-healing, so the UI can offer a
      // retry instead of sending Anthony to Settings to "fix" a correct ID.
      retryable: status === 429,
    }, 502);
  }
};

export const config: Config = { path: "/api/gbp-metrics" };
