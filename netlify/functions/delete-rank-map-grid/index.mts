import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { deleteRankMapGrid } from "../../shared/firestore-admin.mts";

// Cleanup companion to save-rank-map-grid — called when the user deletes a
// rank map from Rankings, so its cloud grid document doesn't sit around
// orphaned forever. Best-effort: the caller doesn't need to block on this,
// and a missed cleanup (e.g. offline at the moment of deletion) costs
// negligible storage, nothing worth retrying aggressively over.

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
    await deleteRankMapGrid(mapId);
    return json({ ok: true });
  } catch (e: any) {
    return json({ error: "Couldn't delete map detail.", detail: String(e?.message || e) }, 500);
  }
};

export const config: Config = { path: "/api/delete-rank-map-grid" };
