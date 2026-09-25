import type { Context, Config } from "@netlify/functions";
import { refreshStripeCache, gmailSyncAll, githubSyncAll, ingestFromRepo, merchyntSyncAll } from "../../shared/client-sync.mts";

// Nightly autopilot for Client Management: refresh Stripe (who's paying, who's
// past due) and, if Gmail access happens to be granted, refresh "last
// contacted". Nothing here needs anyone to press a button.
//
// Gmail is best-effort on purpose: while the OAuth app is unverified Google
// expires that permission every 7 days, so this must never fail the run.

export default async (_req: Request, _ctx: Context) => {
  const out: any = { at: new Date().toISOString() };
  const stripe = await refreshStripeCache(true);
  out.stripe = stripe.ok ? { customers: stripe.cache?.customers?.length ?? 0 } : { error: stripe.error };
  try {
    const m = await merchyntSyncAll();
    out.merchynt = m.ok ? { checked: m.checked, noSlug: m.noSlug?.length || 0, failed: m.failed?.length || 0 } : { error: m.reason };
  } catch (e: any) {
    out.merchynt = { error: String(e?.message || e) };
  }
  try {
    const ingest = await ingestFromRepo();
    out.sessionData = ingest.ok ? { sources: ingest.sources, matched: ingest.matched, unmatched: ingest.unmatched?.length || 0 } : { error: ingest.reason };
  } catch (e: any) {
    out.sessionData = { error: String(e?.message || e) };
  }
  try {
    const gh = await githubSyncAll();
    out.github = gh.ok ? { checked: gh.checked, commits: gh.commits, noRepo: gh.noRepo?.length || 0, failed: gh.failed?.length || 0 } : { error: gh.reason };
  } catch (e: any) {
    out.github = { error: String(e?.message || e) };
  }
  try {
    const gmail = await gmailSyncAll();
    out.gmail = gmail.needsGmail ? { skipped: gmail.reason } : { checked: gmail.checked, found: gmail.found, failed: gmail.failed?.length || 0 };
  } catch (e: any) {
    out.gmail = { error: String(e?.message || e) };
  }
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
};

// 08:20 UTC — about 3:20am Central, clear of the other crons.
export const config: Config = { schedule: "20 8 * * *" };
