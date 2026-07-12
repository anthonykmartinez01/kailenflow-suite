import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { buildGrid, submitHeatmapTasks } from "../../shared/heatmap.mts";

// Submits one grid-search task per grid point to DataForSEO's Google Local
// Finder SERP API (standard queue — cheap, ~5 min turnaround). Each task
// simulates a real Google Search (not the Maps app) from that exact GPS
// coordinate and asks for the local finder ranking (the pack's "more places"
// expansion) — positions 1-3 of this are IDENTICAL to what the visible 3-pack
// shows; positions 4-20 show how close a business is to breaking into it.
// Submission only — see heatmap-status/index.mts for polling results once
// DataForSEO has processed them. Interactive (button-click) entry point —
// see run-scheduled-heatmaps/index.mts for the recurring/cron equivalent,
// which shares this same grid/submission logic from shared/heatmap.mts.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const { keyword, placeId, businessName, centerLat, centerLng } = body;
  const mapsCid: string | undefined = body.mapsCid || undefined;
  const gridSize = Number(body.gridSize) || 7;
  const radiusMiles = Number(body.radiusMiles) || 2;
  const device = body.device === "desktop" ? "desktop" : "mobile";

  if (!keyword || !placeId || !businessName || typeof centerLat !== "number" || typeof centerLng !== "number") {
    return json({ error: "keyword, placeId, businessName, centerLat, centerLng are required" }, 400);
  }
  if (gridSize < 3 || gridSize > 15) return json({ error: "gridSize must be between 3 and 15" }, 400);

  const heatmapId = `hm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const grid = buildGrid(centerLat, centerLng, gridSize, radiusMiles);

  try {
    const { grid: gridWithTasks } = await submitHeatmapTasks({ keyword, grid, device, heatmapId });
    return json({
      heatmapId, keyword, placeId, businessName, mapsCid, centerLat, centerLng, gridSize, radiusMiles, device,
      submittedAt: Date.now(),
      status: "pending",
      grid: gridWithTasks,
    });
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, 500);
  }
};

export const config: Config = { path: "/api/generate-heatmap" };
