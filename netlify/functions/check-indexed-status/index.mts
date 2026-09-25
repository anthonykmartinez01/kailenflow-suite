import type { Context, Config } from "@netlify/functions";
import { readAppData, mutateAppData } from "../../shared/firestore-admin.mts";
import { checkPageIndexed } from "../../shared/indexing.mts";

// Daily cron (added 2026-07-20 alongside the client Indexing tab,
// public/index.html) — the ONE thing publish-page-log's "submitted for
// indexing" note can't tell you: whether Google actually indexed the page.
// Submission success just means the API call didn't error; this checks the
// real, current verdict via Search Console's URL Inspection API
// (shared/indexing.mts's checkPageIndexed/inspectUrl) for every page still
// awaiting confirmation, so a client's Indexing tab can show a true
// "Indexed" state instead of just "we tried." The manual "Recheck now"
// button lives in its own function (recheck-indexing) — Netlify forbids a
// scheduled function from also declaring a custom path, so the on-demand
// single-page check couldn't stay in this file.
//
// Daily, not hourly like publish-page-log — Google's indexing turnaround is
// days, not hours, so checking more often than once a day just burns API
// calls for no new information.
//
// Stops checking a page once confirmed (never re-checked again — indexed is
// a terminal state) or after MAX_CHECK_ATTEMPTS days without success (a
// stalled page keeps its last-known coverageState on display, but stops
// consuming a check every day forever — at that point it needs a human
// look, not more polling).

const MAX_CHECK_ATTEMPTS = 21; // ~3 weeks at one check/day

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (_req: Request, _ctx: Context) => {
  const log: string[] = [];
  try {
    const data = await readAppData();

    // Flatten every eligible page across every client into one task list and
    // check them ALL in parallel. Fixed 2026-07-20: this used to be a nested
    // sequential loop (client → path → await one at a time) — 15 pages meant
    // 15 serialized Search Console calls (each doing its own token refresh
    // too, before google-auth.mts's cache/de-dupe fix), which blew past
    // Netlify's function time limit and crashed with a 502 before it could
    // even respond. Running them concurrently, combined with the token
    // cache, turns ~30 sequential round-trips into one token refresh plus
    // N calls in parallel.
    const tasks: { clientId: string; clientName: string; path: string }[] = [];
    for (const client of data.clients || []) {
      if (!client.gscProperty) continue;
      const history: Record<string, any> = client.publishing?.indexHistory || {};
      for (const path of Object.keys(history)) {
        const rec = history[path];
        if (rec.confirmed) continue; // terminal — never re-checked once indexed
        if ((rec.checkAttempts || 0) >= MAX_CHECK_ATTEMPTS) continue; // stalled — flagged already, stop polling
        tasks.push({ clientId: client.id, clientName: client.name, path });
      }
    }

    const results = await Promise.all(tasks.map(async (t) => {
      try {
        return { ...t, result: await checkPageIndexed(data, t.clientId, t.path) };
      } catch (e: any) {
        return { ...t, result: { ok: false as const, error: String(e?.message || e) } };
      }
    }));

    // PLAN complete — deltas applied atomically to the FRESH document
    // afterward via mutateAppData (same reasoning as every other cron here).
    const deltasByClient: Record<string, Record<string, any>> = {};
    for (const r of results) {
      if (r.result.ok) {
        (deltasByClient[r.clientId] ||= {})[r.path] = r.result.patch;
        log.push(`${r.clientName}: ${r.path} = ${r.result.patch.confirmed ? "indexed" : r.result.patch.coverageState}`);
      } else {
        log.push(`${r.clientName}: skipped ${r.path} (${r.result.error})`);
      }
    }

    if (Object.keys(deltasByClient).length > 0) {
      await mutateAppData((fresh: any) => {
        for (const [clientId, updates] of Object.entries(deltasByClient)) {
          const c = (fresh.clients || []).find((x: any) => x.id === clientId);
          if (!c?.publishing?.indexHistory) continue;
          for (const [path, patch] of Object.entries(updates)) {
            c.publishing.indexHistory[path] = { ...c.publishing.indexHistory[path], ...(patch as any) };
          }
        }
      });
    }
    return json({ ok: true, changed: Object.keys(deltasByClient).length > 0, log });
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e), log }, 500);
  }
};

// Once daily, a few hours after publish-page-log's hourly runs would have
// caught a freshly-published page — gives Google's initial crawl some head
// start before the first check.
export const config: Config = { schedule: "0 14 * * *" };
