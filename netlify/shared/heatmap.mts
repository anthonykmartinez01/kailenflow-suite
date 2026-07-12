// Core heat map logic shared between the interactive functions
// (generate-heatmap, heatmap-status) and the scheduled recurring-heatmap
// function — kept in ONE place specifically so a scheduled run is
// guaranteed identical to clicking "Generate" by hand, never a
// reimplementation that could quietly drift.
import { dataForSeoHeaders } from "./dataforseo.mts";

export interface GridPoint { lat: number; lng: number; row: number; col: number; }

// Builds an N x N grid of {lat,lng} centered on (centerLat, centerLng),
// clipped to a circle — NOT a full square. A plain square grid's corners
// sit sqrt(2)x farther from center than its edges, which is visually a
// much bigger/denser footprint than the diamond/circular grid every
// comparable rank-tracking tool (Local Falcon, GridMySEO, etc.) produces.
// Dropping the corner points also means fewer billed DataForSEO tasks.
//
// IMPORTANT: radiusMiles is the distance BETWEEN each adjacent grid point
// (matches how "Radius" is defined in Local Falcon/GridMySEO), NOT the
// total half-width of the grid. So total coverage grows with gridSize at
// a fixed radiusMiles — a 9x9 grid at 1mi genuinely covers more ground
// than a 5x5 at 1mi, same as every comparable tool. (An earlier version of
// this function treated radiusMiles as the fixed total half-width instead,
// so every gridSize at the same radius covered the identical area — only
// point density changed, not coverage — which didn't match user
// expectations or the reference tools this app is meant to mirror.)
export function buildGrid(centerLat: number, centerLng: number, gridSize: number, radiusMiles: number): GridPoint[] {
  const points: GridPoint[] = [];
  const milesPerDegLat = 69.0;
  const milesPerDegLng = 69.0 * Math.cos((centerLat * Math.PI) / 180);
  const step = radiusMiles; // distance between adjacent points
  const coverageRadius = gridSize > 1 ? radiusMiles * (gridSize - 1) / 2 : 0; // center-to-edge distance
  const eps = 1e-9; // float slop so exact-boundary points (row/col at the very edge) aren't dropped
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const milesFromCenterLat = row * step - coverageRadius;
      const milesFromCenterLng = col * step - coverageRadius;
      if (Math.hypot(milesFromCenterLat, milesFromCenterLng) > coverageRadius + eps) continue;
      points.push({
        lat: centerLat + milesFromCenterLat / milesPerDegLat,
        lng: centerLng + milesFromCenterLng / milesPerDegLng,
        row, col,
      });
    }
  }
  return points;
}

// DataForSEO's task_post endpoint caps out at 100 tasks per request — grids
// larger than 10x10 (e.g. 11x11 = 121 points) must be split into batches or
// everything past #100 silently comes back with no task id and can never
// resolve (surfaces as a permanently-stuck row/cluster in the finished map).
const DATAFORSEO_BATCH_LIMIT = 100;

export async function submitHeatmapTasks(opts: {
  keyword: string; grid: GridPoint[]; device: "mobile" | "desktop"; heatmapId: string;
}): Promise<{ grid: (GridPoint & { taskId: string | null; taskError?: string })[] }> {
  const headers = dataForSeoHeaders();
  if (!headers) throw new Error("DATAFORSEO_LOGIN/PASSWORD not configured on the server");
  const depth = opts.device === "desktop" ? 20 : 10;

  const tasks = opts.grid.map((p, i) => ({
    keyword: opts.keyword,
    // The 3rd number is a Google Maps ZOOM level (valid range 4-18, default
    // 9 if omitted) — NOT a search radius; DataForSEO has no radius param
    // here. 18 (their own docs' example, and the max) gives the tightest
    // possible zoom so each grid point simulates an exact-GPS-pin search,
    // not a blurred-together regional one. Grid spacing/spread itself is
    // controlled entirely by buildGrid()'s lat/lng math above, not by this.
    location_coordinate: `${p.lat.toFixed(7)},${p.lng.toFixed(7)},18`,
    location_code: 2840,
    language_code: "en",
    device: opts.device,
    depth,
    tag: `${opts.heatmapId}:${i}`,
  }));

  const results: any[] = [];
  for (let i = 0; i < tasks.length; i += DATAFORSEO_BATCH_LIMIT) {
    const batch = tasks.slice(i, i + DATAFORSEO_BATCH_LIMIT);
    const res = await fetch("https://api.dataforseo.com/v3/serp/google/local_finder/task_post", {
      method: "POST", headers, body: JSON.stringify(batch),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.status_message || `DataForSEO ${res.status}`);
    results.push(...(data.tasks || []));
  }

  const gridWithTasks = opts.grid.map((p, i) => ({
    ...p,
    taskId: results[i]?.id || null,
    taskError: results[i]?.status_code !== 20100 ? results[i]?.status_message : undefined,
  }));
  return { grid: gridWithTasks };
}

function normalize(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function normalizePhone(p: string): string {
  const digits = (p || "").replace(/\D/g, "");
  return digits.length === 11 && digits[0] === "1" ? digits.slice(1) : digits;
}
function normalizeHost(url: string): string {
  return (url || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].trim();
}
// Tightened from the original (which allowed pure substring containment at
// any length ratio — "Wellness Center" would match inside "Advanced
// Wellness Center", a different business). Substring match now only counts
// when the two names are close in length; otherwise falls through to a
// stricter word-overlap threshold.
function fuzzyMatch(title: string, businessName: string): boolean {
  const a = normalize(title), b = normalize(businessName);
  if (!a || !b) return false;
  const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  if ((a.includes(b) || b.includes(a)) && lenRatio >= 0.7) return true;
  const aWords = new Set(a.split(" ").filter((w) => w.length > 2));
  const bWords = b.split(" ").filter((w) => w.length > 2);
  const overlap = bWords.filter((w) => aWords.has(w)).length;
  return bWords.length > 0 && overlap / bWords.length >= 0.75;
}

export interface CidCandidate { cid: string; title: string; phone?: string; domain?: string; rating?: number; votes?: number; }

// Scores a fuzzy-name-matched item against known ground-truth (the client's
// own phone number / website domain, both already captured from onboarding —
// NOT derived from this search). Phone and domain are unique per physical
// location, so either one matching is strong independent confirmation that
// name-similarity alone can never provide (two different locations of the
// same franchise, or two different businesses with near-identical names,
// will not share a phone number).
function scoreCandidate(item: any, businessPhone?: string, businessWebsite?: string): number {
  const phone = normalizePhone(businessPhone || "");
  const host = normalizeHost(businessWebsite || "");
  if (phone && normalizePhone(item.phone || "") === phone) return 2; // confirmed
  if (host && normalizeHost(item.domain || item.url || "") === host) return 2; // confirmed
  return 1; // name-only, unconfirmed
}

// Polls task_get directly for every task (NOT DataForSEO's tasks_ready first —
// that endpoint has been observed returning 50000 Internal Error on this
// account; task_get for an unfinished task just comes back empty, no error,
// and retrieval is free either way, so skipping the pre-check is strictly
// more robust for no extra cost).
export async function pollHeatmapTasks(opts: {
  taskIds: string[]; mapsCid?: string; businessName?: string; businessPhone?: string; businessWebsite?: string;
}): Promise<{
  results: { taskId: string; rank: number | null }[]; readyCount: number; pendingCount: number;
  discoveredCid?: string; unconfirmedCandidates?: CidCandidate[];
}> {
  const headers = dataForSeoHeaders();
  if (!headers) throw new Error("DATAFORSEO_LOGIN/PASSWORD not configured on the server");
  let cid = opts.mapsCid;

  const fetched = await Promise.all(opts.taskIds.map(async (id) => {
    const r = await fetch(`https://api.dataforseo.com/v3/serp/google/local_finder/task_get/advanced/${id}`, { headers });
    const d = await r.json();
    const result = d.tasks?.[0]?.result?.[0];
    if (!result) return { taskId: id, ready: false, items: [] as any[] };
    return { taskId: id, ready: true, items: (result.items || []) as any[] };
  }));

  const ready = fetched.filter((f) => f.ready);

  let discoveredCid: string | undefined;
  let unconfirmedCandidates: CidCandidate[] | undefined;
  if (!cid && opts.businessName) {
    // Collect every distinct CID that fuzzy-matches the name across every
    // ready grid point (not just the first one found — a single point could
    // easily be near a same-named competitor).
    const byId = new Map<string, { item: any; score: number }>();
    for (const f of ready) {
      for (const it of f.items) {
        if (!it.cid || !fuzzyMatch(it.title, opts.businessName!)) continue;
        const score = scoreCandidate(it, opts.businessPhone, opts.businessWebsite);
        const existing = byId.get(it.cid);
        if (!existing || score > existing.score) byId.set(it.cid, { item: it, score });
      }
    }
    const confirmed = [...byId.values()].filter((c) => c.score === 2);
    if (confirmed.length === 1) {
      // Exactly one candidate independently confirmed by phone or domain — safe to auto-adopt.
      discoveredCid = confirmed[0].item.cid;
      cid = discoveredCid;
    } else if (byId.size > 0) {
      // Either no independent confirmation was possible (no phone/website on
      // file, or DataForSEO didn't return one), or more than one candidate
      // confirmed (genuinely ambiguous) — never guess. Surface everything
      // found so a human can pick the right one instead of us silently
      // locking onto whichever appeared first.
      unconfirmedCandidates = [...byId.values()].map(({ item }) => ({
        cid: item.cid, title: item.title, phone: item.phone, domain: item.domain,
        rating: item.rating?.value, votes: item.rating?.votes_count,
      }));
    } else {
      // fuzzyMatch never hit ONCE across the entire grid — real businesses
      // do get skipped this way when the name on file differs enough from
      // what Google actually displays (reordered words, a dropped "LLC",
      // a rebrand, etc). Silently leaving the map all "not found" with zero
      // explanation is worse than a wrong guess, so fall back to surfacing
      // whichever businesses showed up most often across all points —
      // gives a human something to manually confirm instead of nothing.
      const freq = new Map<string, { item: any; count: number }>();
      for (const f of ready) {
        for (const it of f.items) {
          if (!it.cid) continue;
          const existing = freq.get(it.cid);
          if (existing) existing.count++;
          else freq.set(it.cid, { item: it, count: 1 });
        }
      }
      if (freq.size > 0) {
        unconfirmedCandidates = [...freq.values()]
          .sort((a, b) => b.count - a.count)
          .slice(0, 6)
          .map(({ item }) => ({
            cid: item.cid, title: item.title, phone: item.phone, domain: item.domain,
            rating: item.rating?.value, votes: item.rating?.votes_count,
          }));
      }
    }
  }

  const results = ready.map((f) => {
    const match = cid ? f.items.find((it) => it.cid === cid) : undefined;
    return { taskId: f.taskId, rank: match ? match.rank_absolute : null };
  });

  return {
    results,
    readyCount: results.length,
    pendingCount: opts.taskIds.length - results.length,
    discoveredCid,
    unconfirmedCandidates,
  };
}

// Rolls up a completed grid's points into the same summary stats shape
// client.rankMaps[] entries use (top3/top4to10/top11to20/top21plus/avgRank/solv).
export function summarizeGrid(grid: { rank?: number | null }[]) {
  const total = grid.length;
  const found = grid.filter((p) => p.rank);
  const top3 = grid.filter((p) => p.rank && p.rank <= 3).length;
  const top4to10 = grid.filter((p) => p.rank && p.rank > 3 && p.rank <= 10).length;
  const top11to20 = grid.filter((p) => p.rank && p.rank > 10).length;
  const top21plus = total - found.length;
  const solv = total ? Math.round((top3 / total) * 1000) / 10 : 0;
  const avgRank = found.length ? Math.round((found.reduce((a, p) => a + (p.rank || 0), 0) / found.length) * 10) / 10 : 0;
  return { totalPoints: total, top3, top4to10, top11to20, top21plus, avgRank, solv };
}
