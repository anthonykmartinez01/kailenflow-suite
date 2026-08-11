import type { Context, Config } from "@netlify/functions";
import { readAppData, mutateAppData, saveRankMapGrid } from "../../shared/firestore-admin.mts";
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

    // PLAN + external work phase, against a plain read: submit/poll
    // DataForSEO and collect the resulting deltas. Nothing is written here —
    // deltas get applied to the FRESH document afterward via mutateAppData,
    // so a browser save landing during these (slow) external calls can no
    // longer be clobbered by this cron writing back a stale copy.
    const newMaps: any[] = [];    // {clientId, entry, schedId, schedUpdate|null(remove)}
    const mapUpdates: any[] = []; // {clientId, mapId, fields, discoveredCid?, unconfirmedCandidates?}
    const gridWrites: any[] = []; // {mapId, grid, competitorGrids} — written to their own doc, outside appData/main

    for (const client of data.clients || []) {
      // 1. Start any due recurring (or one-time) heat maps. A "once" schedule
      // is removed entirely after it fires — nothing left to advance.
      for (const sched of client.scheduledHeatMaps || []) {
        if (!sched.active || (sched.nextRunAt || 0) > now) continue;
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
          log.push(`started ${client.name} / ${sched.keyword}`);
          newMaps.push({
            clientId: client.id, entry, schedId: sched.id,
            schedUpdate: sched.frequency !== "once" ? { lastRunAt: now, nextRunAt: advanceNextRunAt(sched.nextRunAt || now, sched) } : null,
          });
        } catch (e: any) {
          log.push(`FAILED to start ${client.name} / ${sched.keyword}: ${String(e?.message || e)}`);
          // no delta recorded — the schedule stays as-is and retries next tick
        }
      }

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
          const rankByTask: Record<string, number | null> = {};
          result.results.forEach((r) => { rankByTask[r.taskId] = r.rank; });
          const grid = (m.grid || []).map((p: any) => (p.taskId in rankByTask ? { ...p, rank: rankByTask[p.taskId], resolved: true } : p));
          const stuck = now - (m.submittedAt || now) > STUCK_TIMEOUT_MS;
          const fields: any = { grid };
          if (result.pendingCount === 0 || stuck) {
            // Split off the heavy per-point data (this map's own grid + its
            // top competitors' grids) into its own document (saveRankMapGrid,
            // shared/firestore-admin.mts) instead of writing it into
            // appData/main — that document used to fill up with exactly this
            // data (1MiB crisis, 2026-07-14/15/17). fields.grid gets deleted
            // below; appData/main only keeps hasGridDoc:true pointing at it.
            const competitorsFull = result.competitors || m.competitors || [];
            const competitorGrids: Record<string, any[]> = {};
            const competitorsLight = competitorsFull.map((c: any) => {
              if (c.grid) competitorGrids[c.cid] = c.grid;
              const { grid: _cg, ...rest } = c;
              return rest;
            });
            gridWrites.push({ mapId: m.id, grid, competitorGrids });
            Object.assign(fields, summarizeGrid(grid), { status: "complete", mapsCid: result.discoveredCid || client.mapsCid || m.mapsCid, completedAt: now, incomplete: stuck && result.pendingCount > 0, competitors: competitorsLight, hasGridDoc: true });
            delete fields.grid;
            log.push(`finalized ${client.name} / ${m.keyword}${stuck && result.pendingCount > 0 ? " (partial — some points never resolved)" : ""}`);
          }
          // Only ever auto-adopt a CID that was independently confirmed by
          // phone or website match (see scoreCandidate in shared/heatmap.mts)
          // — never a bare name match. If it's ambiguous, surface the
          // candidates on the client for a human to resolve instead.
          mapUpdates.push({ clientId: client.id, mapId: m.id, keyword: m.keyword, fields, discoveredCid: result.discoveredCid || null, unconfirmedCandidates: result.unconfirmedCandidates || null });
        } catch (e: any) {
          log.push(`FAILED to poll ${client.name} / ${m.keyword}: ${String(e?.message || e)}`);
        }
      }
    }

    // Write the heavy per-map grid documents BEFORE committing the summary
    // to appData/main — if a specific write fails, that map's update is
    // walked back to "still pending" (just its taskId grid, no hasGridDoc)
    // so it naturally retries next tick instead of appData/main claiming
    // detail that was never actually saved.
    for (const gw of gridWrites) {
      try {
        await saveRankMapGrid(gw.mapId, { grid: gw.grid, competitorGrids: gw.competitorGrids });
      } catch (e: any) {
        log.push(`FAILED to save grid doc for map ${gw.mapId}: ${String(e?.message || e)}`);
        const mu = mapUpdates.find((x) => x.mapId === gw.mapId);
        if (mu) mu.fields = { grid: gw.grid };
      }
    }

    // APPLY phase — atomic, against the freshest committed data, and only
    // when there's actually something to change (the old version wrote the
    // whole document back every 15 minutes even when idle).
    if (newMaps.length > 0 || mapUpdates.length > 0) {
      await mutateAppData((fresh: any) => {
        let changed = false;
        for (const nm of newMaps) {
          const c = (fresh.clients || []).find((x: any) => x.id === nm.clientId);
          if (!c) continue;
          if (!(c.rankMaps || []).some((m: any) => m.id === nm.entry.id)) { c.rankMaps = [nm.entry, ...(c.rankMaps || [])]; changed = true; }
          const scheds = c.scheduledHeatMaps || [];
          const idx = scheds.findIndex((s: any) => s.id === nm.schedId);
          if (idx >= 0) {
            if (nm.schedUpdate) scheds[idx] = { ...scheds[idx], ...nm.schedUpdate };
            else scheds.splice(idx, 1); // "once" schedule — already ran
            c.scheduledHeatMaps = scheds;
            changed = true;
          }
        }
        for (const mu of mapUpdates) {
          const c = (fresh.clients || []).find((x: any) => x.id === mu.clientId);
          if (!c) continue;
          if (mu.discoveredCid && !c.mapsCid) { c.mapsCid = mu.discoveredCid; c.mapsCidCandidates = null; changed = true; }
          else if (mu.unconfirmedCandidates?.length && !c.mapsCid && !c.mapsCidCandidates) { c.mapsCidCandidates = mu.unconfirmedCandidates; changed = true; }
          const m = (c.rankMaps || []).find((x: any) => x.id === mu.mapId);
          if (!m) continue;
          // No pruning needed anymore (was pruneRankMapHistory, removed
          // 2026-07-17) — the heavy grid data this used to delete never
          // lands in appData/main in the first place now (see gridWrites
          // above), so there's nothing here that needs trimming for space.
          Object.assign(m, mu.fields);
          changed = true;
        }
        return changed ? undefined : false;
      });
    }
    return json({ ok: true, changed: newMaps.length > 0 || mapUpdates.length > 0, log });
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
