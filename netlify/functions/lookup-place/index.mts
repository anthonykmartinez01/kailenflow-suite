import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

// One-time lookup: given a business name + address, finds its Google Place ID
// and precise lat/lng. Heat maps match the target business by Place ID (not
// name string), which is what makes rank matching unambiguous — two "Arbor
// Care" businesses in different cities never get confused. Cache the result
// on the client record so this only runs once per client.

const PLACES_SEARCH = "https://places.googleapis.com/v1/places:searchText";

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const name: string = (body.name || "").trim();
  const address: string = (body.address || "").trim();
  // Optional raw search override — used by the Re-lookup picker's search box
  // so a business whose Settings lack an address (name-only searches return
  // same-name businesses nationwide) can still be found by typing e.g.
  // "Anytime Heating & Air Providence Village TX".
  const query: string = (body.query || "").trim();
  if (!name && !query) return json({ error: "name is required" }, 400);

  const apiKey = Netlify.env.get("GOOGLE_PLACES_KEY");
  if (!apiKey) return json({ error: "GOOGLE_PLACES_KEY not configured on the server" }, 500);

  try {
    const res = await fetch(PLACES_SEARCH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location",
      },
      body: JSON.stringify({ textQuery: query || `${name} ${address}`.trim() }),
    });
    const data = await res.json();
    if (!res.ok) return json({ error: data.error?.message || `Places API ${res.status}` }, 502);
    const places: any[] = data.places || [];
    const place = places[0];
    if (!place) return json({ error: "No matching business found. Try adding more of the address." }, 404);

    const toCandidate = (p: any) => ({
      placeId: p.id,
      name: p.displayName?.text || name,
      address: p.formattedAddress || address,
      lat: p.location?.latitude,
      lng: p.location?.longitude,
    });

    return json({
      ...toCandidate(place),
      // Up to 8 alternates for the Re-lookup dropdown — the initial "Find
      // Business on Google" flow ignores this and just uses the top match.
      candidates: places.slice(0, 8).map(toCandidate),
    });
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, 500);
  }
};

export const config: Config = { path: "/api/lookup-place" };
