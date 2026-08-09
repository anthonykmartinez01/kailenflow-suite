import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

// Market Finder (task #55) — which nearby cities should THIS client expand
// into next.
//
// ─── Where the candidate cities come from ────────────────────────────────
// Not from a static town list or a locality lookup. Instead: search the
// client's trade across a wide radius, then group the businesses that come
// back by the city in their address. A city only appears if the trade
// actually operates there, which is a better filter than proximity — a town
// with no roofers in it is not a roofing market, however close it sits.
//
// ─── What it can and cannot tell you ─────────────────────────────────────
// Everything here is derived from Google Places: how many competitors a city
// has, how strong they look (review counts), and how many have no website.
// That is a real signal about how contested a market is. It is NOT search
// volume — nobody here is measuring demand, and the response says so rather
// than implying a precision it doesn't have. Volume would mean DataForSEO
// keyword calls, which cost per query; see the `note` field.

const PLACES_SEARCH = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = [
  "places.displayName",
  "places.formattedAddress",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.location",
].join(",");

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

const MILES_PER_METER = 0.000621371;
function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3958.8;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// "1234 Main St, Aubrey, TX 76227, USA" -> { city: "Aubrey", state: "TX" }
// Google's formatted addresses are comma-separated and consistent enough for
// this; anything that doesn't parse is dropped rather than guessed at.
function parseCityState(addr: string): { city: string; state: string } | null {
  const parts = (addr || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const stateZip = parts[parts.length - 2];
  const m = stateZip.match(/^([A-Z]{2})\b/);
  if (!m) return null;
  const city = parts[parts.length - 3];
  if (!city || /\d/.test(city)) return null;
  return { city, state: m[1] };
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const key = Netlify.env.get("GOOGLE_PLACES_KEY");
  if (!key) return json({ error: "GOOGLE_PLACES_KEY is not configured on the server." }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const trade: string = (body.trade || "").toString().trim();
  const homeCity: string = (body.city || "").toString().trim();
  const homeState: string = (body.state || "").toString().trim();
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const radiusMiles = Math.max(5, Math.min(60, Number(body.radiusMiles) || 30));

  if (!trade) return json({ error: "This client has no primary category set — add one in Settings so we know what trade to search." }, 400);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return json({ error: "This client has no map location yet. Use \"Find Business on Google\" in Rankings first." }, 400);
  }

  const home = { lat, lng };
  const radiusMeters = Math.round(radiusMiles / MILES_PER_METER);

  try {
    // One wide search, paged. locationBias (not restriction) keeps Google's
    // own relevance ranking rather than hard-cropping to a circle, then the
    // distance filter below enforces the radius honestly.
    const seen = new Map<string, any>();
    let pageToken = "";
    for (let page = 0; page < 3; page++) {
      const payload: any = {
        textQuery: `${trade} near ${homeCity}${homeState ? ", " + homeState : ""}`,
        locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: Math.min(radiusMeters, 50000) } },
        maxResultCount: 20,
      };
      if (pageToken) payload.pageToken = pageToken;

      const res = await fetch(PLACES_SEARCH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": FIELD_MASK + ",nextPageToken",
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        return json({ error: "Google Places rejected the search.", detail: (data?.error?.message || "").slice(0, 300) }, 502);
      }
      for (const p of data.places || []) {
        const addr = p.formattedAddress || "";
        if (!seen.has(addr + (p.displayName?.text || ""))) seen.set(addr + (p.displayName?.text || ""), p);
      }
      pageToken = data.nextPageToken || "";
      if (!pageToken) break;
    }

    // Group by city, keeping only businesses inside the requested radius.
    const byCity = new Map<string, { city: string; state: string; businesses: any[]; distances: number[] }>();
    // Array.from rather than spread/iterator, so a bare `tsc` (ES5 default,
    // no tsconfig) doesn't flag it — same reason as gbp-post-rules.mts.
    for (const p of Array.from(seen.values())) {
      const loc = p.location;
      if (!loc || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) continue;
      const d = haversineMiles(home, { lat: loc.latitude, lng: loc.longitude });
      if (d > radiusMiles) continue;
      const cs = parseCityState(p.formattedAddress || "");
      if (!cs) continue;
      const k = `${cs.city}|${cs.state}`;
      if (!byCity.has(k)) byCity.set(k, { city: cs.city, state: cs.state, businesses: [], distances: [] });
      const e = byCity.get(k)!;
      e.businesses.push(p);
      e.distances.push(d);
    }

    const homeKey = `${homeCity}|${homeState}`;
    const markets = Array.from(byCity.entries())
      .filter(([k, v]) => k !== homeKey && v.businesses.length >= 2) // a single result is noise, not a market
      .map(([, v]) => {
        const reviews = v.businesses.map((b) => Number(b.userRatingCount) || 0);
        const competitorCount = v.businesses.length;
        const avgReviews = Math.round(reviews.reduce((a, b) => a + b, 0) / competitorCount);
        const topReviews = Math.max(...reviews);
        const noWebsite = v.businesses.filter((b) => !b.websiteUri).length;
        const pctNoWebsite = Math.round((noWebsite / competitorCount) * 100);
        const distanceMiles = Math.round(Math.min(...v.distances) * 10) / 10;

        // Verdict is a readable summary of the same numbers shown alongside
        // it, deliberately coarse. The thresholds are judgement calls, not
        // measurements — so the `why` string always names the numbers behind
        // the label rather than asking anyone to trust the label alone.
        let verdict: "winnable" | "contested" | "hard";
        if (topReviews < 50 && avgReviews < 20) verdict = "winnable";
        else if (topReviews < 200 && avgReviews < 80) verdict = "contested";
        else verdict = "hard";

        const why =
          `${competitorCount} ${trade} listed, strongest has ${topReviews} reviews, ` +
          `average ${avgReviews}. ${pctNoWebsite}% have no website.`;

        return {
          city: v.city, state: v.state, distanceMiles,
          competitorCount, avgReviews, topReviews, pctNoWebsite,
          verdict, why,
          suggestedKeyword: `${trade} ${v.city} ${v.state}`.toLowerCase(),
          suggestedPage: `/${trade.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${v.city.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${v.state.toLowerCase()}/`,
        };
      })
      .sort((a, b) => {
        const rank = { winnable: 0, contested: 1, hard: 2 } as const;
        if (rank[a.verdict] !== rank[b.verdict]) return rank[a.verdict] - rank[b.verdict];
        return a.distanceMiles - b.distanceMiles;
      });

    return json({
      trade, homeCity, homeState, radiusMiles,
      businessesScanned: seen.size,
      markets,
      // Said plainly so nobody reads demand into a competition measure.
      note: "Based on Google Places competition only — how many businesses are listed, how strong they look by review count, and how many lack a website. It does not measure search volume.",
    });
  } catch (e: any) {
    return json({ error: "Market search failed.", detail: String(e?.message || e) }, 502);
  }
};

export const config: Config = { path: "/api/market-finder" };
