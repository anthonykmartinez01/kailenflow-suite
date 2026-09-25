import type { Config } from "@netlify/functions";
import { runRankMapStorageSweep } from "../../shared/rank-map-sweep.mts";

// Daily cron for the storage sweep — the part that makes the 1MiB
// appData/main crisis non-recurring rather than merely fixed-again (see
// shared/rank-map-sweep.mts for the full history: it hit 4 times, each time
// a write-path fix that left another path leaking).
//
// Nothing here depends on every write path staying correct. If any code path
// ever puts heavy grid data back into the shared document, this moves it out
// within a day, long before it could accumulate toward the ceiling where
// saves start failing silently.
//
// Scheduled functions aren't HTTP-reachable on Netlify, which is why this is
// separate from rank-map-storage-sweep rather than one function with both a
// path and a schedule. Both call the same implementation.

export default async () => {
  try {
    const result = await runRankMapStorageSweep({ dryRun: false });
    // Surfaces in the Netlify function log. A quiet day is a single line
    // saying there was nothing inline to move.
    console.log("[rank-map-sweep] " + JSON.stringify({
      ok: result.ok, migrated: result.migrated ?? 0, freed: result.bytesFreed,
      before: result.before, after: result.after ?? result.before,
      clientsIntact: result.clientsIntact, rankMapsIntact: result.rankMapsIntact,
    }));
    for (const line of result.log) console.log("[rank-map-sweep] " + line);
  } catch (e: any) {
    console.error("[rank-map-sweep] FAILED: " + String(e?.message || e));
  }
};

// Daily at 09:10 UTC. The sweep is idempotent and returns after one document
// read when there's nothing inline, so a no-op day is nearly free.
export const config: Config = { schedule: "10 9 * * *" };
