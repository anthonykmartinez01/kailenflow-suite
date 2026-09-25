import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

// Current total review count + star rating for a business, straight from the
// public Places API (New) — the SAME API/key already used for the Rank Maps
// "Find Business on Google" lookup (GOOGLE_PLACES_KEY). Deliberately NOT the
// Google Business Profile Performance/Business Information API — that one is
// access-gated and gone through manual Google review (see
// [[monthly-reporting-integrations]]); this data doesn't need any of that.
//
// Only gives a live snapshot (no history) — the caller is responsible for
// storing readings over time if it wants to show a month-over-month delta.

const PLACE_DETAILS = "https://places.googleapis.com/v1/places";

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const placeId: string = (body.placeId || "").trim();
  if (!placeId) return json({ error: "placeId is required" }, 400);

  const apiKey = Netlify.env.get("GOOGLE_PLACES_KEY");
  if (!apiKey) return json({ error: "GOOGLE_PLACES_KEY not configured on the server" }, 500);

  try {
    const res = await fetch(`${PLACE_DETAILS}/${encodeURIComponent(placeId)}`, {
      headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "id,rating,userRatingCount" },
    });
    const data = await res.json();
    if (!res.ok) return json({ error: data.error?.message || `Places API ${res.status}` }, 502);

    return json({ rating: data.rating ?? null, reviewCount: data.userRatingCount ?? 0 });
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, 500);
  }
};

export const config: Config = { path: "/api/place-review-count" };
