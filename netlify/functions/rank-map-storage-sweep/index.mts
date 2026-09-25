import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { runRankMapStorageSweep } from "../../shared/rank-map-sweep.mts";

// Manual/on-demand entry point for the storage sweep (see
// shared/rank-map-sweep.mts for what it does and why it exists). Defaults to
// dryRun — you have to ask for a live run explicitly with {"dryRun":false}.
// The daily cron path is run-rank-map-sweep, which shares this exact
// implementation so a scheduled run is never different code.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body means dry run */ }

  try {
    const result = await runRankMapStorageSweep({ dryRun: body?.dryRun !== false });
    return json(result, result.ok ? 200 : 500);
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
};

export const config: Config = { path: "/api/rank-map-storage-sweep" };
