import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { saveRankMapGrid } from "../../shared/firestore-admin.mts";

// Called by the BROWSER the moment it detects a live heat map just finished
// (checkLiveHeatMapStatus in public/index.html) — persists the map's heavy
// per-point data to its own document instead of the shared appData/main
// doc. The server cron (run-scheduled-heatmaps) writes the same way but
// calls saveRankMapGrid directly since it already runs server-side; this
// endpoint exists purely so the browser (which only has the client SDK
// wired to appData/main, not this new collection) has a path to write it
// too, without needing a Firestore security-rule change for a second
// collection.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const mapId: string = (body.mapId || "").toString().trim();
  if (!mapId) return json({ error: "Missing mapId" }, 400);
  if (!Array.isArray(body.grid)) return json({ error: "Missing grid array" }, 400);

  try {
    await saveRankMapGrid(mapId, { grid: body.grid, competitorGrids: body.competitorGrids || {} });
    return json({ ok: true });
  } catch (e: any) {
    return json({ error: "Couldn't save map detail.", detail: String(e?.message || e) }, 500);
  }
};

export const config: Config = { path: "/api/save-rank-map-grid" };
