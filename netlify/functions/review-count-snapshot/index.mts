import type { Context, Config } from "@netlify/functions";
import { readAppData, mutateAppData } from "../../shared/firestore-admin.mts";

// Daily cron: records every client's current Google review count + rating
// into client.reviewHistory ({date, count, rating}, one entry per day,
// capped at 400). This is what makes the Reviews card's "+N this month" and
// "They reviewed" numbers real for EVERY client — the history accumulates
// server-side whether or not anyone opens that client's report in a
// browser. (Opening a report also upserts today's entry client-side; both
// writers key on the same America/Chicago date so they can't duplicate.)
//
// Uses the public Places API (GOOGLE_PLACES_KEY) — deliberately NOT the
// access-gated Google Business Profile API.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (_req: Request, _ctx: Context) => {
  const log: string[] = [];
  try {
    const apiKey = Netlify.env.get("GOOGLE_PLACES_KEY");
    if (!apiKey) return json({ ok: false, error: "GOOGLE_PLACES_KEY not configured" }, 500);

    const data = await readAppData();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());

    // Fetch phase: gather every client's current count first (slow, external),
    // then apply all snapshots atomically to the FRESH document — never write
    // back the copy read before the fetches (that pattern erases any browser
    // save that landed in between).
    const snapshots: { clientId: string; count: number; rating: number | null }[] = [];
    for (const client of data.clients || []) {
      if (!client.placeId) continue;
      try {
        const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(client.placeId)}`, {
          headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "id,rating,userRatingCount" },
        });
        if (!res.ok) { log.push(`${client.name}: Places API ${res.status}`); continue; }
        const d = await res.json();
        snapshots.push({ clientId: client.id, count: d.userRatingCount ?? 0, rating: d.rating ?? null });
        log.push(`${client.name}: ${d.userRatingCount ?? 0} reviews (${d.rating ?? "no rating"})`);
      } catch (e: any) {
        log.push(`${client.name}: ${String(e?.message || e)}`);
      }
    }

    if (snapshots.length > 0) {
      await mutateAppData((fresh: any) => {
        for (const s of snapshots) {
          const c = (fresh.clients || []).find((x: any) => x.id === s.clientId);
          if (!c) continue;
          const hist = (c.reviewHistory || []).filter((h: any) => h.date !== today);
          hist.push({ date: today, count: s.count, rating: s.rating });
          hist.sort((a: any, b: any) => (a.date < b.date ? -1 : 1));
          c.reviewHistory = hist.slice(-400);
        }
      });
    }
    return json({ ok: true, changed: snapshots.length > 0, log });
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e), log }, 500);
  }
};

// Daily at 11:15 UTC (~6:15am Central) — once a day is exactly the
// granularity reviewHistory needs, and it stays clear of the hourly
// publish-page-log runs that also read/write the same app-data document.
export const config: Config = { schedule: "15 11 * * *" };
