import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { runScan, selectedListings, readHistory, REVIEWS_STORE } from "../../shared/portfolio-reviews.mts";
import { dailySeries, intradaySeries, periodStats, latestKnown, addDaysStr, earliestDay } from "../../shared/portfolio-reviews-math.mts";
import { TZ, todayIn, keyStr } from "../../shared/gbp-portfolio-window.mts";

// POST /api/portfolio-reviews
//   {action:"history", range}  -> summary, chart series, per-listing table, removed log
//   {action:"scan", range}     -> runs a live Places scan first, then the same
// range: "1D" | "7D" | "30D" | "3M" | "6M" | "1Y" | "All"
// Public Places data only; never touches the Business Profile API.

const RANGE_DAYS: Record<string, number> = { "7D": 7, "30D": 30, "3M": 90, "6M": 180, "1Y": 365 };

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* empty is fine */ }
  const action = String(body.action || "history");
  const range = ["1D", "7D", "30D", "3M", "6M", "1Y", "All"].includes(body.range) ? body.range : "30D";

  try {
    let scan: any = null;
    if (action === "scan") scan = await runScan();

    const listings = await selectedListings();
    if (!listings.length) return json({ needsSelection: true });
    const ids = listings.map((l) => l.id);

    const { daily, intraday, latest, removed } = await readHistory();
    const lastScan = (await getStore(REVIEWS_STORE).get("lastScan", { type: "json" }).catch(() => null)) as any;
    const today = keyStr(todayIn(TZ));
    const yesterday = addDaysStr(today, -1);
    const first = earliestDay(daily);

    const from = range === "All" ? (first || today) : range === "1D" ? today : addDaysStr(today, -(RANGE_DAYS[range] - 1));
    const known = latestKnown(daily);
    const now = ids.reduce((t, id) => t + (known[id] ?? 0), 0);
    const rangeStats = periodStats(daily, ids, from, today);

    const series = range === "1D"
      ? intradaySeries(daily, ids, today, intraday).map((p) => ({ t: p.at, total: p.total }))
      : dailySeries(daily, ids, from, today).map((p) => ({ t: p.day, total: p.total }));

    const byListing = listings.map((l) => ({
      id: l.id, title: l.title, city: l.city,
      now: known[l.id] ?? null,
      rating: latest[l.id]?.rating ?? null,
      gained: rangeStats.perListing[l.id].gained,
      lost: rangeStats.perListing[l.id].lost,
      tracked: known[l.id] !== undefined,
      noPlaceId: !l.placeId,
    })).sort((a, b) => (b.now ?? -1) - (a.now ?? -1));

    const today_ = periodStats(daily, ids, today, today);
    const yday = periodStats(daily, ids, yesterday, yesterday);

    return json({
      range,
      trackingSince: first,
      lastScanAt: lastScan?.at || null,
      scan,
      summary: {
        totalNow: now,
        today: { gained: today_.gained, lost: today_.lost, net: today_.net },
        yesterday: { gained: yday.gained, lost: yday.lost, net: yday.net },
        range: { gained: rangeStats.gained, lost: rangeStats.lost, net: rangeStats.net },
        profilesTracked: byListing.filter((l) => l.tracked).length,
        profilesSelected: listings.length,
      },
      series,
      listings: byListing,
      removed: removed.filter((e) => ids.includes(e.id)).slice(0, 50),
    });
  } catch (e: any) {
    return json({ error: "Couldn't load review history.", detail: String(e?.message || e) }, 500);
  }
};

export const config: Config = { path: "/api/portfolio-reviews" };
