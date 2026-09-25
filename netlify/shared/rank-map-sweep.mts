import { readAppData, mutateAppData, saveRankMapGrid, getRankMapGrid } from "./firestore-admin.mts";

// SELF-HEALING STORAGE SWEEP — the reason the 1MiB appData/main crisis can't
// come back a fifth time (it hit 2026-07-14, 07-15, 07-17, and again
// 07-26 — that last one silently failing saves until two clients were lost).
//
// Every previous fix was a WRITE-PATH fix: stop putting heavy grid data into
// the shared document. Each worked for the path it touched and left another
// leaking — most recently public/index.html's browser finalizer, which set
// hasGridDoc:true but never cleared the entry's own inline `grid`, quietly
// re-adding ~16KB per completed map while the surrounding comments claimed
// the problem was structurally solved. The server finalizer had it right
// (`delete fields.grid`), so the two paths disagreed for nine days.
//
// This is the backstop that does NOT depend on every write path being
// correct: it finds any completed rank map still carrying heavy per-point
// data inline, moves it to that map's own document, and strips it. Run on a
// schedule, a regression can no longer accumulate — it gets healed within a
// day instead of compounding invisibly until writes start failing.
//
// It NEVER deletes a rank map and never drops grid data. A grid leaves
// appData/main only after the separate document has been written AND read
// back and verified to hold the same number of points. Anything that fails
// either step keeps its inline copy and is retried by the next sweep.
//
// One real implementation, two entry points (an authed HTTP endpoint that
// defaults to dry-run, and the daily cron) — deliberately mirroring how
// shared/heatmap.mts is shared, so a scheduled run is never a different
// code path from a manual one.

const DOC_LIMIT_BYTES = 1048576; // Firestore's hard per-document ceiling
export const pctOfLimit = (n: number) => Math.round((n / DOC_LIMIT_BYTES) * 1000) / 10;

export type SweepMove = {
  clientName: string;
  mapId: string;
  keyword: string;
  ownGridPoints: number;    // inline points to move (0 = own grid already moved)
  competitorCids: string[]; // competitor grids to move
  bytes: number;            // freed from appData/main, measured not estimated
};

export type SweepResult = {
  ok: boolean;
  error?: string;
  dryRun: boolean;
  mapsToMigrate: number;
  bytesFreed: number;
  before: { bytes: number; pctOfLimit: number };
  projected: { bytes: number; pctOfLimit: number };
  after?: { bytes: number; pctOfLimit: number };
  migrated?: number;
  strippedMaps?: number;
  clientsIntact?: number;
  rankMapsIntact?: number;
  moves: SweepMove[];
  log: string[];
};

export async function runRankMapStorageSweep(opts: { dryRun: boolean }): Promise<SweepResult> {
  const { dryRun } = opts;
  const log: string[] = [];

  const data = await readAppData();
  const beforeBytes = JSON.stringify(data).length;

  // ── PLAN ────────────────────────────────────────────────────────────────
  const moves: SweepMove[] = [];
  const payloads = new Map<string, { grid: any[]; competitorGrids: Record<string, any[]> }>();

  for (const client of data.clients || []) {
    for (const m of client.rankMaps || []) {
      // PENDING maps must keep their inline grid: it carries the DataForSEO
      // taskIds the poller needs to finish the map. Only completed maps are
      // safe to strip.
      if (m.status !== "complete") continue;

      const inlineGrid: any[] = Array.isArray(m.grid) ? m.grid : [];
      const competitorGrids: Record<string, any[]> = {};
      const skippedNoCid: string[] = [];

      for (const c of m.competitors || []) {
        if (!Array.isArray(c.grid) || c.grid.length === 0) continue;
        // The reader looks this up as competitorGrids[c.cid] (see the merge
        // in public/index.html's rank-map detail view). A competitor with no
        // cid could never be matched back, so its grid stays inline rather
        // than being moved somewhere nothing can find it.
        if (!c.cid) { skippedNoCid.push(c.title || "(untitled)"); continue; }
        competitorGrids[c.cid] = c.grid;
      }

      if (inlineGrid.length === 0 && Object.keys(competitorGrids).length === 0) continue;

      // MERGE with whatever the map's document already holds. Some entries
      // are half-migrated (hasGridDoc:true, competitor grids already moved,
      // own grid still inline) — saveRankMapGrid uses set(), so writing a
      // bare payload here would WIPE the competitor grids that were moved
      // correctly earlier. Read first, then union.
      const existing = await getRankMapGrid(m.id);
      const mergedGrid = inlineGrid.length > 0 ? inlineGrid : (existing?.grid || []);
      const mergedCompetitorGrids = { ...(existing?.competitorGrids || {}), ...competitorGrids };
      if (mergedGrid.length === 0 && Object.keys(mergedCompetitorGrids).length === 0) continue;

      const before = JSON.stringify(m).length;
      const preview = JSON.parse(JSON.stringify(m));
      preview.grid = null;
      for (const c of preview.competitors || []) if (c.cid && competitorGrids[c.cid]) delete c.grid;
      preview.hasGridDoc = true;

      payloads.set(m.id, { grid: mergedGrid, competitorGrids: mergedCompetitorGrids });
      moves.push({
        clientName: client.name || "(unnamed)",
        mapId: m.id,
        keyword: m.keyword || "(no keyword)",
        ownGridPoints: inlineGrid.length,
        competitorCids: Object.keys(competitorGrids),
        bytes: before - JSON.stringify(preview).length,
      });
      if (skippedNoCid.length) log.push(`kept ${skippedNoCid.length} competitor grid(s) inline on ${m.id} (no cid to key them by): ${skippedNoCid.join(", ")}`);
    }
  }

  const bytesFreed = moves.reduce((a, m) => a + m.bytes, 0);
  const base = {
    dryRun,
    mapsToMigrate: moves.length,
    bytesFreed,
    before: { bytes: beforeBytes, pctOfLimit: pctOfLimit(beforeBytes) },
    projected: { bytes: beforeBytes - bytesFreed, pctOfLimit: pctOfLimit(beforeBytes - bytesFreed) },
    moves,
  };

  if (moves.length === 0) {
    log.push(`nothing to do — appData/main is ${beforeBytes} bytes (${pctOfLimit(beforeBytes)}% of 1MiB) and no completed map carries inline grid data`);
    return { ok: true, ...base, log };
  }
  if (dryRun) {
    log.push(`DRY RUN — nothing written. ${moves.length} map(s) would move, freeing ${bytesFreed} bytes: ${pctOfLimit(beforeBytes)}% -> ${base.projected.pctOfLimit}% of the 1MiB limit.`);
    return { ok: true, ...base, log };
  }

  // ── WRITE GRID DOCS FIRST, AND VERIFY ───────────────────────────────────
  // Order matters: the heavy copy must exist and be confirmed readable
  // before appData/main stops holding it. A map failing either step is
  // dropped from `migrated`, keeps its inline grid, and is retried next run.
  const migrated = new Set<string>();
  for (const mv of moves) {
    const payload = payloads.get(mv.mapId)!;
    try {
      await saveRankMapGrid(mv.mapId, payload);
      // Read back rather than trusting the write — this is the only thing
      // standing between "moved" and "lost".
      const check = await getRankMapGrid(mv.mapId);
      const gotGrid = check?.grid?.length || 0;
      const gotComps = Object.keys(check?.competitorGrids || {}).length;
      if (gotGrid !== payload.grid.length || gotComps !== Object.keys(payload.competitorGrids).length) {
        log.push(`VERIFY FAILED for ${mv.mapId} (grid ${gotGrid}/${payload.grid.length}, competitors ${gotComps}/${Object.keys(payload.competitorGrids).length}) — leaving it inline`);
        continue;
      }
      migrated.add(mv.mapId);
    } catch (e: any) {
      log.push(`FAILED to write grid doc for ${mv.mapId}: ${String(e?.message || e)} — leaving it inline`);
    }
  }

  if (migrated.size === 0) {
    return { ok: false, error: "No grid document could be written and verified — appData/main left untouched.", ...base, log };
  }

  // ── STRIP FROM appData/main, ATOMICALLY ─────────────────────────────────
  // The mutator re-reads the freshest committed data inside a transaction and
  // must stay pure and fast (no network) — see mutateAppData. It only touches
  // maps whose grid document was written AND verified above, so a map created
  // by a browser between the read and this commit is never stripped of a grid
  // that was never copied anywhere.
  let strippedMaps = 0;
  await mutateAppData((fresh: any) => {
    let changed = false;
    for (const client of fresh.clients || []) {
      for (const m of client.rankMaps || []) {
        if (!migrated.has(m.id) || m.status !== "complete") continue;
        let touched = false;
        if (Array.isArray(m.grid) && m.grid.length > 0) { m.grid = null; touched = true; }
        for (const c of m.competitors || []) {
          if (c.cid && Array.isArray(c.grid) && c.grid.length > 0) { delete c.grid; touched = true; }
        }
        if (!m.hasGridDoc) { m.hasGridDoc = true; touched = true; }
        if (touched) { strippedMaps++; changed = true; }
      }
    }
    return changed ? undefined : false;
  });

  const after = await readAppData();
  const afterBytes = JSON.stringify(after).length;
  log.push(`migrated ${migrated.size}/${moves.length} map(s), stripped ${strippedMaps}: ${beforeBytes} -> ${afterBytes} bytes (${pctOfLimit(beforeBytes)}% -> ${pctOfLimit(afterBytes)}% of 1MiB)`);

  return {
    ok: true, ...base,
    migrated: migrated.size,
    strippedMaps,
    after: { bytes: afterBytes, pctOfLimit: pctOfLimit(afterBytes) },
    clientsIntact: (after.clients || []).length,
    rankMapsIntact: (after.clients || []).reduce((a: number, c: any) => a + (c.rankMaps || []).length, 0),
    log,
  };
}
