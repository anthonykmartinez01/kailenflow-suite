import type { Context, Config } from "@netlify/functions";
import { runScan } from "../../shared/portfolio-reviews.mts";

// Scheduled review scan for GBP Portfolio's selected listings (public Places
// API only — see shared/portfolio-reviews.mts). Every 3 hours, so a review
// that appears and then drops within a day is usually caught. The 05:05 UTC
// run lands just after midnight Central (during daylight time).

export default async (_req: Request, _ctx: Context) => {
  try {
    const r = await runScan();
    return new Response(JSON.stringify({ ok: true, ...r }), { headers: { "content-type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }), { status: 500, headers: { "content-type": "application/json" } });
  }
};

export const config: Config = { schedule: "5 2,5,8,11,14,17,20,23 * * *" };
