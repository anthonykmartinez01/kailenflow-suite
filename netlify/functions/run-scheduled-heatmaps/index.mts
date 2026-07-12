import type { Context, Config } from "@netlify/functions";
import { readAppData, writeAppData } from "../../shared/firestore-admin.mts";
import { buildGrid, submitHeatmapTasks, pollHeatmapTasks, summarizeGrid } from "../../shared/heatmap.mts";
import { advanceNextRunAt } from "../../shared/schedule.mts";

// Runs daily on Netlify's own cron (see config.schedule below) — this is what
// makes recurring heat maps actually fire at a fixed time whether or not
// anyone has the Suite app open, unlike everything else in this app (which
// only writes to Firestore from the browser). Two jobs each run:
//   1. Start any due recurring heat maps (client.scheduledHeatMaps[]).
//   2. Finalize any pending live heat map (client.rankMaps[] with
//      generatedBy:'live' && status:'pending') — covers BOTH scheduled runs
//      and manually-started ones, so results save even if Anthony never
//      reopens the browser after clicking Generate.
// Uses the exact same grid/DataForSEO logic as the interactive functions
// (shared/heatmap.mts) so a scheduled run is never a different code path
// from clicking "Generate" by hand.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

// DataForSEO occasionally never resolves a handful of grid tasks (silently,
// no error) — without a cutoff those entries stay "pending" in Firestore
// forever. Matches the same 20min cutoff used client-side in index.html.
const STUCK_TIMEOUT_MS = 20 * 60 * 1000;

export default async (req: Request, _ctx: Context) => {
  const log: string[] = [];
  try {
    const data = await readAppData();
    const now = Date.now();
    log.push(`clients: ${(data.clients || []).length}`);
    for (const c of data.clients || []) {
      const live = (c.rankMaps || []).filter((m: any) => m.generatedBy === "live");
      const pending = live.filter((m: any) => m.status === "pending");
      if (live.length) log.push(`${c.name}: ${live.length} live map(s), ${pending.length} pending — ${pending.map((m: any) => `[${m.keyword} taskIds=${(m.grid || []).filter((p: any) => p.taskId).length} submittedAt=${m.submittedAt ? new Date(m.submittedAt).toISOString() : "?"}]`).join(" ")}`);
    }

    for (const client of data.clients || []) {
      // 1. Start any due recurring (or one-time) heat maps. A "once" schedule
      // is removed entirely after it fires — nothing left to advance.
      const stillScheduled: any[] = [];
      for (const sched of client.scheduledHeatMaps || []) {
        if (!sched.active || (sched.nextRunAt || 0) > now) { stillScheduled.push(sched); continue; }
        try {
          const heatmapId = `hm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const grid = buildGrid(sched.centerLat, sched.centerLng, sched.gridSize, sched.radiusMiles);
          const { grid: gridWithTasks } = await submitHeatmapTasks({ keyword: sched.keyword, grid, device: sched.device || "mobile", heatmapId });
          const entry = {
            id: `rm_${heatmapId}`, generatedBy: "live", scheduledFrom: sched.id,
            heatmapId, keyword: sched.keyword, placeId: client.placeId, mapsCid: client.mapsCid,
            businessName: client.name, centerLat: sched.centerLat, centerLng: sched.centerLng,
            gridSize: sched.gridSize, radiusMiles: sched.radiusMiles, device: sched.device || "mobile",
            submittedAt: now, status: "pending", grid: gridWithTasks, snapshotDate: new Date(now).toISOString().slice(0, 10),
          };
          client.rankMaps = [entry, ...(client.rankMaps || [])];
          log.push(`started ${client.name} / ${sched.keyword}`);
          if (sched.frequency !== "once") {
            sched.lastRunAt = now;
            sched.nextRunAt = advanceNextRunAt(sched.nextRunAt || now, sched);
            stillScheduled.push(sched);
          }
          // frequency==='once': dropped from the list — it already ran.
        } catch (e: any) {
          log.push(`FAILED to start ${client.name} / ${sched.keyword}: ${String(e?.message || e)}`);
          stillScheduled.push(sched); // keep it so it retries next tick
        }
      }
      client.scheduledHeatMaps = stillScheduled;

      // 2. Finalize any pending live heat map (scheduled- or manually-started).
      for (const m of client.rankMaps || []) {
        if (m.generatedBy !== "live" || m.status !== "pending") continue;
        const taskIds: string[] = (m.grid || []).map((p: any) => p.taskId).filter(Boolean);
        if (taskIds.length === 0) continue;
        try {
          const result = await pollHeatmapTasks({
            taskIds, mapsCid: client.mapsCid || m.mapsCid, businessName: m.businessName,
            businessPhone: client.phone, businessWebsite: client.website,
          });
          // Only ever auto-adopt a CID that was independently confirmed by
          // phone or website match (see scoreCandidate in shared/heatmap.mts)
          // — never a bare name match. If it's ambiguous, surface the
          // candidates on the client for a human to resolve instead.
          if (result.discoveredCid && !client.mapsCid) client.mapsCid = result.discoveredCid;
          if (result.unconfirmedCandidates?.length && !client.mapsCid) client.mapsCidCandidates = result.unconfirmedCandidates;
          const rankByTask: Record<string, number | null> = {};
          result.results.forEach((r) => { rankByTask[r.taskId] = r.rank; });
          m.grid = (m.grid || []).map((p: any) => (p.taskId in rankByTask ? { ...p, rank: rankByTask[p.taskId], resolved: true } : p));
          const stuck = now - (m.submittedAt || now) > STUCK_TIMEOUT_MS;
          if (result.pendingCount === 0 || stuck) {
            Object.assign(m, summarizeGrid(m.grid), { status: "complete", mapsCid: result.discoveredCid || client.mapsCid || m.mapsCid, completedAt: now, incomplete: stuck && result.pendingCount > 0, competitors: result.competitors || m.competitors });
            log.push(`finalized ${client.name} / ${m.keyword}${stuck && result.pendingCount > 0 ? " (partial — some points never resolved)" : ""}`);
          }
        } catch (e: any) {
          log.push(`FAILED to poll ${client.name} / ${m.keyword}: ${String(e?.message || e)}`);
        }
      }
    }

    await writeAppData(data);
    return json({ ok: true, log });
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e), log }, 500);
  }
};

// Every 15 minutes — schedules have their own exact time-of-day (see
// shared/schedule.mts), so this needs to poll often enough to catch them
// close to that time, not just once a day. Netlify's scheduler invokes this
// directly — no HTTP path/auth needed for that trigger; the function's own
// impact if someone found the URL is minor (submits real searches, small $,
// no destructive writes), so it's left open rather than over-engineered.
export const config: Config = { schedule: "*/15 * * * *" };
