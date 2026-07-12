import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { pollHeatmapTasks } from "../../shared/heatmap.mts";

// Polls DataForSEO for a batch of previously-submitted heat map grid tasks.
// Standard-queue tasks take ~5 minutes; call this again later if some grid
// points aren't ready — it only fetches (free) results for tasks that are
// actually done, and reports which ones are still pending. Interactive
// (button-click) entry point — the scheduled/recurring path calls
// shared/heatmap.mts's pollHeatmapTasks() directly, same logic.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const taskIds: string[] = Array.isArray(body.taskIds) ? body.taskIds.filter(Boolean) : [];
  const businessName: string = body.businessName || "";
  const mapsCid: string | undefined = body.mapsCid || undefined;
  const businessPhone: string | undefined = body.businessPhone || undefined;
  const businessWebsite: string | undefined = body.businessWebsite || undefined;
  if (taskIds.length === 0) return json({ error: "taskIds is required" }, 400);
  if (!mapsCid && !businessName) return json({ error: "mapsCid or businessName is required" }, 400);

  try {
    const result = await pollHeatmapTasks({ taskIds, mapsCid, businessName, businessPhone, businessWebsite });
    return json({ total: taskIds.length, ...result });
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, 500);
  }
};

export const config: Config = { path: "/api/heatmap-status" };
