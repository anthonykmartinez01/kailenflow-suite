import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { getRankMapGrid } from "../../shared/firestore-admin.mts";

// Fetches ONE rank map's heavy per-point data (its own grid + its top
// competitors' grids) on demand — this is the read half of the fix that
// moved that data out of the shared appData/main document (see
// saveRankMapGrid in shared/firestore-admin.mts for why). Called lazily by
// the browser only when a specific map's detail is actually being viewed
// (Rankings tab expanded row, a report's audit-comparison card, the
// competitor match-up modal) — never for every map in a list at once.

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

  try {
    const data = await getRankMapGrid(mapId);
    if (!data) return json({ error: "No detail available for this map." }, 404);
    return json(data);
  } catch (e: any) {
    return json({ error: "Couldn't load map detail.", detail: String(e?.message || e) }, 500);
  }
};

export const config: Config = { path: "/api/get-rank-map-grid" };
