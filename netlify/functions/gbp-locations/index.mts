import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { getGoogleAccessToken } from "../../shared/google-auth.mts";
// All Business Profile traffic routes through the shared guard — see
// shared/gbp-guard.mts.
import { gbpRead } from "../../shared/gbp-guard.mts";

// Lists the Google Business Profile locations the agency's Google account can
// see, so onboarding a client is just "pick their listing from a dropdown" —
// the same one-time, locked-in selection the Search Console property uses
// (client.gscProperty). The chosen id is stored as client.gbpLocationId and
// every GBP report card reads from that.
//
// Firebase-authed because this is called FROM THE BROWSER. The older
// /api/gbp-probe does the same two calls but is gated by a shared webhook key
// for server-to-server diagnostics — don't point the UI at that one.
//
// ⚠️ USER OAUTH, NOT THE SERVICE ACCOUNT. Business Profile APIs do not support
// service accounts (they 403); see the header of shared/google-auth.mts. The
// Indexing/Search Console migration to a service account deliberately did NOT
// include GBP.
//
// Verified live 2026-08-02: the agency account (accounts/112198649847474423548)
// returns 9 locations. NOTE there are MORE listings than app clients, so the
// operator must choose explicitly — a fuzzy name match is offered only as a
// pre-selected suggestion, never as the stored value.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

// "Anytime Heating & Air" vs "Anytime Heating and Air" etc. — loose enough to
// pre-select the obvious match, never authoritative.
function normalize(s: string) {
  return String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();

  let body: any = {};
  try { body = await req.json(); } catch { /* optional */ }
  const clientName: string = (body?.clientName || "").toString();

  try {
    const token = await getGoogleAccessToken();

    const acctRes = await gbpRead("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", token);
    const acctBody = await acctRes.json().catch(() => ({} as any));
    if (!acctRes.ok) {
      return json({
        error: "Couldn't reach Google Business Profile.",
        detail: (acctBody as any)?.error?.message || `HTTP ${acctRes.status}`,
        // The one failure worth naming explicitly: a dead/638 token reads as a
        // generic error otherwise, and the fix (re-connect Google) is specific.
        needsReconnect: acctRes.status === 401 || /invalid_grant/i.test(JSON.stringify(acctBody)),
      }, 502);
    }

    const accounts = (acctBody as any).accounts || [];
    if (!accounts.length) {
      return json({ locations: [], accounts: [], note: "Google returned no Business Profile accounts for the connected Google login." });
    }

    // Locations can span multiple accounts; walk them all rather than assuming
    // the first one holds everything.
    const locations: { id: string; title: string; account: string }[] = [];
    for (const acct of accounts) {
      let pageToken = "";
      do {
        const url = `https://mybusinessbusinessinformation.googleapis.com/v1/${acct.name}/locations?readMask=name,title&pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
        const r = await gbpRead(url, token);
        if (!r.ok) break;
        const b: any = await r.json().catch(() => ({}));
        for (const l of b.locations || []) locations.push({ id: l.name, title: l.title || l.name, account: acct.name });
        pageToken = b.nextPageToken || "";
      } while (pageToken);
    }

    locations.sort((a, b) => a.title.localeCompare(b.title));

    // Best-guess match for the client being onboarded, so the dropdown opens
    // on the right one. Returned separately from the list — the UI must still
    // store whatever the operator actually picks.
    let suggestedId: string | null = null;
    if (clientName) {
      const want = normalize(clientName);
      const exact = locations.find((l) => normalize(l.title) === want);
      const loose = exact || locations.find((l) => normalize(l.title).includes(want) || want.includes(normalize(l.title)));
      suggestedId = loose ? loose.id : null;
    }

    return json({ locations, suggestedId, accounts: accounts.map((a: any) => ({ name: a.name, accountName: a.accountName })) });
  } catch (e: any) {
    const msg = String(e?.message || e);
    return json({ error: "Couldn't load Business Profile locations.", detail: msg, needsReconnect: /invalid_grant|not connected/i.test(msg) }, 500);
  }
};

export const config: Config = { path: "/api/gbp-locations" };
