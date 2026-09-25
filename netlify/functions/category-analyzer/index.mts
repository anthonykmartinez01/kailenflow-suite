import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { dataForSeoHeaders } from "../../shared/dataforseo.mts";

// STANDALONE GBP category analyser — deliberately NOT tied to a client record.
// Give it a niche and a city; it reports which categories the businesses in
// that market actually use, ranked by how many of them use each, separating
// "chosen as PRIMARY" from "carried as an additional category".
//
// For picking a primary category and finding the secondary categories worth
// adding, before a client even exists. Distinct from the per-client
// "Competitor Category Analysis" in the GBP tab, which diffs against one
// client's current categories.
//
// ⚠️ WHY NOT local_finder — VERIFIED THE HARD WAY 2026-09-08.
// The first build used serp/google/local_finder (the endpoint the heat maps
// use). It returned 21 real businesses for "pool cleaning service in Celina,
// Texas" with names and ratings — and ZERO category data on every single one.
// local_finder does not carry categories. Do not go back to it for this.
// business_data/business_listings/search DOES carry `category` and
// `additional_categories`, in bulk, in one billed call.
//
// ⚠️ CREDENTIALS ARE SERVER-SIDE. The older per-client version has the operator
// paste a DataForSEO login/password into the BROWSER and posts them in the
// request body. This uses DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD via
// dataForSeoHeaders(). Do not reintroduce browser-supplied credentials.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

const PLACES_SEARCH = "https://places.googleapis.com/v1/places:searchText";
const DFS = "https://api.dataforseo.com/v3";

const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Holds the raw taxonomy response when the parse yields nothing, so an empty
// category list is diagnosable rather than silent.
let lastTaxonomyRaw: string | null = null;

// Anchor the search on the city itself rather than the median of whatever comes
// back, so "in Celina" means Celina and not a Dallas-wide average.
async function cityCenter(apiKey: string, text: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const res = await fetch(PLACES_SEARCH, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "places.location" },
      body: JSON.stringify({ textQuery: text, pageSize: 1, languageCode: "en", regionCode: "US" }),
    });
    if (!res.ok) return null;
    const d: any = await res.json();
    const loc = d.places?.[0]?.location;
    return loc && typeof loc.latitude === "number" ? { lat: loc.latitude, lng: loc.longitude } : null;
  } catch { return null; }
}

// DataForSEO filters on its own snake_case category taxonomy ("pool_cleaning_
// service"), not free text — a guessed id silently returns zero results rather
// than an error. So fetch the real taxonomy and match against it. It changes
// rarely, so it's cached for 30 days; the fetch is cheap but not free.
async function resolveCategoryId(headers: any, niche: string): Promise<{ id: string | null; candidates: string[]; fromCache: boolean }> {
  let list: string[] = [];
  let fromCache = false;
  const store = getStore("dfs-taxonomy");
  try {
    const cached = (await store.get("business-categories", { type: "json" })) as any;
    if (cached?.at && Date.now() - cached.at < 30 * 86400000 && Array.isArray(cached.list)) {
      list = cached.list; fromCache = true;
    }
  } catch { /* cache miss is fine */ }

  if (!list.length) {
    // ⚠️ GET, NOT POST — verified against the docs 2026-09-08 after a POST
    // returned an empty list and every niche silently reported "no category
    // matches". Most DataForSEO endpoints are POST; this one is not.
    const r = await fetch(`${DFS}/business_data/business_listings/categories`, { method: "GET", headers });
    const d: any = await r.json().catch(() => ({}));
    const items = d?.tasks?.[0]?.result ?? [];
    // VERIFIED SHAPE 2026-09-08: each entry is
    //   { category_name: "pool_cleaning_service", business_count: 12345 }
    // The key is category_name — NOT `category` or `name`. Reading the wrong
    // key returns an empty list and every niche then reports "no category
    // matches", which looks like a bad search term rather than a parse bug.
    list = (Array.isArray(items) ? items : [])
      .map((x: any) => (typeof x === "string" ? x : x?.category_name ?? x?.category ?? x?.name ?? null))
      .filter((x: any): x is string => typeof x === "string" && !!x.trim());
    if (list.length) { try { await store.setJSON("business-categories", { at: Date.now(), list }); } catch {} }
    else {
      // Describe the SHAPE, not the first 300 bytes of envelope — the envelope
      // is identical whether the parse worked or not, which told us nothing.
      const res0 = d?.tasks?.[0]?.result;
      lastTaxonomyRaw = JSON.stringify({
        resultType: Array.isArray(res0) ? "array" : typeof res0,
        resultLen: Array.isArray(res0) ? res0.length : null,
        firstThree: Array.isArray(res0) ? res0.slice(0, 3) : res0,
        firstKeys: Array.isArray(res0) && res0[0] && typeof res0[0] === "object" ? Object.keys(res0[0]).slice(0, 20) : null,
      }).slice(0, 1200);
    }
  }

  const want = norm(niche);
  const wantTokens = want.split(" ").filter(Boolean);
  const scored = list
    .map((id) => {
      const label = norm(id.replace(/_/g, " "));
      if (label === want) return { id, score: 1000 };
      let score = 0;
      for (const t of wantTokens) if (label.includes(t)) score += 10;
      if (label.includes(want)) score += 25;
      if (want.includes(label)) score += 15;
      // Prefer the shorter, more specific id when scores tie.
      return { id, score: score ? score - label.length / 100 : 0 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return { id: scored[0]?.id ?? null, candidates: scored.slice(0, 8).map((s) => s.id), fromCache };
}

// A listing carries ONE primary category plus additional ones. Read defensively
// — an unexpected key yields a silent "no categories found", which is the worst
// failure mode for this tool and exactly what local_finder produced.
function categoriesOf(item: any): { primary: string | null; extra: string[] } {
  const p = item?.category ?? item?.category_name ?? null;
  const primary = typeof p === "string" && p.trim() ? p : (p?.name ?? p?.category ?? null);
  const extraRaw = item?.additional_categories ?? item?.additionalCategories ?? [];
  const extra = (Array.isArray(extraRaw) ? extraRaw : [])
    .map((c: any) => (typeof c === "string" ? c : c?.name ?? c?.category ?? null))
    .filter((c: any): c is string => typeof c === "string" && !!c.trim());
  return { primary: typeof primary === "string" && primary.trim() ? primary : null, extra };
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const niche: string = (body.category || "").toString().trim();
  const city: string = (body.city || "").toString().trim();
  const state: string = (body.state || "").toString().trim();
  const radiusKm: number = Math.min(80, Math.max(1, Number(body.radiusKm) || 25));
  const debug: boolean = body.debug === true;
  if (!niche) return json({ error: "Enter a category or niche, e.g. pool cleaning service." }, 400);
  if (!city) return json({ error: "Enter a city." }, 400);

  const headers = dataForSeoHeaders();
  if (!headers) return json({ error: "DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not configured on the server." }, 500);
  const placesKey = Netlify.env.get("GOOGLE_PLACES_KEY");
  if (!placesKey) return json({ error: "GOOGLE_PLACES_KEY is not configured on the server." }, 500);

  const where = city + (state ? ", " + state : "");

  try {
    const center = await cityCenter(placesKey, where);
    if (!center) return json({ error: `Couldn't locate "${where}". Check the city and state spelling.` }, 404);

    const resolved = await resolveCategoryId(headers, niche);
    if (!resolved.id) {
      return json({
        error: `No Google business category matches "${niche}".`,
        hint: "Try the wording Google uses, e.g. \"pool cleaning service\", \"hvac contractor\", \"roofing contractor\".",
        candidates: resolved.candidates,
        taxonomyRaw: debug ? lastTaxonomyRaw : undefined,
      }, 404);
    }

    const request = {
      categories: [resolved.id],
      location_coordinate: `${center.lat},${center.lng},${radiusKm}`,
      limit: 100,
      order_by: ["rating.votes_count,desc"],
    };
    const res = await fetch(`${DFS}/business_data/business_listings/search/live`, {
      method: "POST", headers, body: JSON.stringify([request]),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return json({ error: `DataForSEO returned HTTP ${res.status}.`, detail: JSON.stringify(data).slice(0, 400) }, 502);

    const task = data?.tasks?.[0];
    if (task?.status_code && task.status_code !== 20000) {
      return json({ error: `DataForSEO: ${task.status_message || "task failed"}`, detail: `status_code ${task.status_code}`, request: debug ? request : undefined }, 502);
    }

    const items: any[] = task?.result?.[0]?.items ?? [];
    if (!items.length) {
      return json({
        error: `No businesses found in the "${resolved.id}" category within ${radiusKm}km of ${where}.`,
        hint: "Widen the radius, or try a broader category.",
        matchedCategory: resolved.id, candidates: resolved.candidates,
      }, 404);
    }

    // Counted per BUSINESS, not per occurrence — a category is either on a
    // listing or it isn't, so "8 of 34 use this" is the honest reading.
    // Primary and additional are tallied SEPARATELY: which category a
    // competitor chose as PRIMARY is a different and stronger signal than
    // which categories are merely common.
    const tally = new Map<string, { name: string; asPrimary: number; asSecondary: number; total: number }>();
    const competitors: any[] = [];

    for (const it of items) {
      const { primary, extra } = categoriesOf(it);
      const seen = new Set<string>();
      const bump = (raw: string, isPrimary: boolean) => {
        const k = norm(raw);
        if (!k || seen.has(k)) return;
        seen.add(k);
        const cur = tally.get(k) ?? { name: raw.trim(), asPrimary: 0, asSecondary: 0, total: 0 };
        if (isPrimary) cur.asPrimary++; else cur.asSecondary++;
        cur.total++;
        tally.set(k, cur);
      };
      if (primary) bump(primary, true);
      for (const e of extra) bump(e, false);
      competitors.push({
        name: it?.title ?? "(unnamed)",
        primary, extra,
        rating: it?.rating?.value ?? null,
        reviews: it?.rating?.votes_count ?? null,
      });
    }

    const total = items.length;
    const ranked = [...tally.values()]
      .map((c) => ({ ...c, pctOfCompetitors: Math.round((c.total / total) * 100) }))
      .sort((a, b) => b.total - a.total || b.asPrimary - a.asPrimary || a.name.localeCompare(b.name));

    const primaryRanked = [...tally.values()].filter((c) => c.asPrimary > 0).sort((a, b) => b.asPrimary - a.asPrimary);
    const mostCommonPrimary = primaryRanked[0] ?? null;

    // At least a quarter of the field carries it, and it isn't the primary —
    // a credible secondary to add.
    const suggestedSecondary = ranked.filter(
      (c) => mostCommonPrimary && norm(c.name) !== norm(mostCommonPrimary.name) && c.pctOfCompetitors >= 25
    );

    const withCategoryData = competitors.filter((c) => c.primary || c.extra.length).length;

    return json({
      niche, where, radiusKm,
      matchedCategory: resolved.id,
      otherCategoryMatches: resolved.candidates.filter((c) => c !== resolved.id).slice(0, 5),
      totalBusinesses: total,
      // Honest coverage signal. If few listings carried categories, the
      // percentages rest on a thin sample and that must be visible rather than
      // being read as confidence. This field is what exposed local_finder
      // returning zero categories.
      businessesWithCategoryData: withCategoryData,
      mostCommonPrimary: mostCommonPrimary
        ? { name: mostCommonPrimary.name, usedAsPrimaryBy: mostCommonPrimary.asPrimary, of: total }
        : null,
      primaryCategoryBreakdown: primaryRanked.map((c) => ({ name: c.name, count: c.asPrimary })),
      rankedCategories: ranked,
      suggestedSecondary,
      competitors,
      ...(debug ? { _debug: { request, center, taxonomyCached: resolved.fromCache, rawFirstItem: items[0] } } : {}),
    });
  } catch (e: any) {
    return json({ error: "Category analysis failed.", detail: String(e?.message || e) }, 500);
  }
};

export const config: Config = { path: "/api/gbp-category-analyzer" };
