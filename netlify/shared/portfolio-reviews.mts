import { getStore } from "@netlify/blobs";
import { applyObservation, type Daily, type Counts } from "./portfolio-reviews-math.mts";
import { TZ, todayIn, keyStr } from "./gbp-portfolio-window.mts";
import { getRnrAccessToken } from "./google-auth.mts";
import { allLocations } from "./rnr-locations.mts";

// Review history for the GBP Portfolio's SELECTED listings.
//
// Reads ONLY the public Places API (GOOGLE_PLACES_KEY) — the same public
// rating/review count anyone sees on Google. It never touches the Business
// Profile API or either Google login, so it cannot affect a listing.
//
// Storage: its own Blobs store (NOT appData/main, NOT the gbp-portfolio store
// that's wiped when the Google account changes). Keys:
//   meta     — {listings:[{id,title,city,placeId}]} written by gbp-portfolio
//   daily    — per-day first/last/gained/lost per listing (portfolio-reviews-math)
//   intraday — raw scans from the last 48h, for the 1D chart
//   latest   — {id:{count,rating,at}}
//   seen     — recently visible reviews per listing, to name likely removals
//   removed  — log of detected drops, newest first (capped)

export const REVIEWS_STORE = "portfolio-reviews";
const PLACE_DETAILS = "https://places.googleapis.com/v1/places";
const INTRADAY_MS = 48 * 60 * 60 * 1000;
const SEEN_MS = 120 * 24 * 60 * 60 * 1000;
const REMOVED_CAP = 300;

export type ListingMeta = { id: string; title: string; city: string; placeId: string | null };
export type SeenReview = { author: string; rating: number | null; publishTime: string | null; text: string; firstSeen: number; lastSeen: number };
export type RemovedEvent = {
  id: string; title: string; detectedAt: number; from: number; to: number;
  // Reviews that were visible on an earlier scan and gone on this one. Google
  // only ever shows up to 5 reviews, ordered by relevance, so these are
  // "likely" matches — not proof of which review was removed.
  candidates: { author: string; rating: number | null; publishTime: string | null; text: string }[];
};

const store = () => getStore(REVIEWS_STORE);

export async function saveListingMeta(listings: ListingMeta[]): Promise<void> {
  const s = store();
  const old = ((await s.get("meta", { type: "json" }).catch(() => null)) as any)?.listings || [];
  // Merge, so a listing unselected today keeps its title if it's re-selected later.
  const byId = new Map<string, ListingMeta>(old.map((l: ListingMeta) => [l.id, l]));
  for (const l of listings) byId.set(l.id, l);
  await s.setJSON("meta", { listings: [...byId.values()], at: Date.now() });
}

/** All listings picked in GBP Portfolio, with their placeIds. */
export async function selectedListings(): Promise<ListingMeta[]> {
  const sel = (await getStore("gbp-portfolio").get("selection", { type: "json" }).catch(() => null)) as any;
  const ids: string[] = Array.isArray(sel?.ids) ? sel.ids.map(String) : [];
  if (!ids.length) return [];
  let meta: ListingMeta[] = ((await store().get("meta", { type: "json" }).catch(() => null)) as any)?.listings || [];

  // Any picked listing we don't have details for yet: look it up ourselves
  // (read-only, rank-and-rent account) instead of waiting for the portfolio
  // report to hand them over — a cached report never does.
  if (ids.some((id) => !meta.some((l) => l.id === id))) {
    try {
      const token = await getRnrAccessToken();
      const all = await allLocations(token);
      if (all.ok) {
        await saveListingMeta(all.locations.filter((l) => ids.includes(l.id)));
        meta = ((await store().get("meta", { type: "json" }).catch(() => null)) as any)?.listings || [];
      }
    } catch { /* not connected / Google down: fall back to what we have */ }
  }
  return ids.map((id) => meta.find((l) => l.id === id)).filter(Boolean) as ListingMeta[];
}

export async function readHistory() {
  const s = store();
  const [daily, intraday, latest, removed] = await Promise.all([
    s.get("daily", { type: "json" }).catch(() => null),
    s.get("intraday", { type: "json" }).catch(() => null),
    s.get("latest", { type: "json" }).catch(() => null),
    s.get("removed", { type: "json" }).catch(() => null),
  ]);
  return {
    daily: (daily || {}) as Daily,
    intraday: (intraday || []) as { at: number; day: string; counts: Counts }[],
    latest: (latest || {}) as Record<string, { count: number; rating: number | null; at: number }>,
    removed: (removed || []) as RemovedEvent[],
  };
}

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/** One live scan of every selected listing. Writes history; returns what it saw. */
export async function runScan(): Promise<{ scanned: number; failed: string[]; drops: RemovedEvent[]; skippedNoPlaceId: string[] }> {
  const apiKey = Netlify.env.get("GOOGLE_PLACES_KEY");
  if (!apiKey) throw new Error("GOOGLE_PLACES_KEY not configured");

  const listings = await selectedListings();
  const withPlace = listings.filter((l) => l.placeId);
  const skippedNoPlaceId = listings.filter((l) => !l.placeId).map((l) => l.title);
  const now = Date.now();
  const day = keyStr(todayIn(TZ));

  const results = await pool(withPlace, 4, async (l) => {
    try {
      const r = await fetch(`${PLACE_DETAILS}/${encodeURIComponent(l.placeId!)}`, {
        headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "id,rating,userRatingCount,reviews" },
      });
      if (!r.ok) return { l, ok: false as const };
      const d: any = await r.json();
      return { l, ok: true as const, count: Number(d.userRatingCount ?? 0), rating: d.rating ?? null, reviews: Array.isArray(d.reviews) ? d.reviews : [] };
    } catch {
      return { l, ok: false as const };
    }
  });

  const s = store();
  const hist = await readHistory();
  const seen = ((await s.get("seen", { type: "json" }).catch(() => null)) || {}) as Record<string, Record<string, SeenReview>>;

  const counts: Counts = {};
  for (const r of results) if (r.ok) counts[r.l.id] = r.count;
  const { drops } = applyObservation(hist.daily, day, counts);

  const events: RemovedEvent[] = drops.map((dr) => {
    const r = results.find((x) => x.l.id === dr.id)!;
    const visibleNow = new Set((r.ok ? r.reviews : []).map((rv: any) => rv.name));
    const candidates = Object.entries(seen[dr.id] || {})
      .filter(([name]) => !visibleNow.has(name))
      .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
      .slice(0, 3)
      .map(([, v]) => ({ author: v.author, rating: v.rating, publishTime: v.publishTime, text: v.text }));
    return { id: dr.id, title: r.l.title, detectedAt: now, from: dr.from, to: dr.to, candidates };
  });

  for (const r of results) {
    if (!r.ok) continue;
    hist.latest[r.l.id] = { count: r.count, rating: r.rating, at: now };
    const bucket = (seen[r.l.id] ||= {});
    for (const rv of r.reviews) {
      if (!rv?.name) continue;
      const prior = bucket[rv.name];
      bucket[rv.name] = {
        author: rv.authorAttribution?.displayName || "A Google user",
        rating: rv.rating ?? null,
        publishTime: rv.publishTime || null,
        text: String(rv.text?.text || rv.originalText?.text || "").slice(0, 280),
        firstSeen: prior?.firstSeen || now,
        lastSeen: now,
      };
    }
    for (const [name, v] of Object.entries(bucket)) if (now - v.lastSeen > SEEN_MS) delete bucket[name];
  }

  hist.intraday.push({ at: now, day, counts });
  const intraday = hist.intraday.filter((o) => now - o.at <= INTRADAY_MS);
  const removed = [...events, ...hist.removed].slice(0, REMOVED_CAP);

  await Promise.all([
    s.setJSON("daily", hist.daily),
    s.setJSON("intraday", intraday),
    s.setJSON("latest", hist.latest),
    s.setJSON("seen", seen),
    s.setJSON("removed", removed),
    s.setJSON("lastScan", { at: now, scanned: Object.keys(counts).length }),
  ]);

  return { scanned: Object.keys(counts).length, failed: results.filter((r) => !r.ok).map((r) => r.l.title), drops: events, skippedNoPlaceId };
}
