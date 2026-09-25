import type { Context, Config } from "@netlify/functions";
import { plaidConfig, syncTransactions } from "../../shared/plaid.mts";

// Nightly: pull new bank transactions so the Finance tool is current without
// anyone pressing a button. Stripe income is fetched on demand (cached hourly).
export default async (_req: Request, _ctx: Context) => {
  if (!plaidConfig().ok) return new Response(JSON.stringify({ skipped: "Plaid not configured" }));
  try {
    const r = await syncTransactions();
    return new Response(JSON.stringify({ ok: true, ...r }), { headers: { "content-type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }), { status: 500 });
  }
};

// 09:40 UTC — about 4:40am Central, after the other nightly jobs.
export const config: Config = { schedule: "40 9 * * *" };
