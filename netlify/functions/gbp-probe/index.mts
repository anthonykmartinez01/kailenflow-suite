import type { Context, Config } from "@netlify/functions";
import { getGoogleAccessToken } from "../../shared/google-auth.mts";
// Every Business Profile call goes through the shared guard — see
// shared/gbp-guard.mts. These are reads, so they pass; routing them through it
// anyway is what keeps the guard from being bypassable by convention.
import { gbpRead } from "../../shared/gbp-guard.mts";

// Temporary diagnostic: is the Google Business Profile API approved yet for
// our OAuth client? (Access request case 7-3208000041254, submitted
// 2026-07-10 — quota stays 0 until Google manually approves.) Gated by the
// webhook key since Claude runs this server-to-server without a Firebase
// user session. Safe to delete once GBP reviews reporting is built.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  const expected = Netlify.env.get("GHL_REVIEW_WEBHOOK_KEY");
  const provided = new URL(req.url).searchParams.get("key") || "";
  if (!expected || provided !== expected) return json({ error: "unauthorized" }, 401);

  try {
    const token = await getGoogleAccessToken();
    const out: any = {};

    const acctRes = await gbpRead("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", token);
    out.accountsStatus = acctRes.status;
    const acctBody = await acctRes.json().catch(() => ({}));
    out.accounts = acctRes.ok
      ? (acctBody.accounts || []).map((a: any) => ({ name: a.name, accountName: a.accountName, type: a.type }))
      : (acctBody.error?.message || "").slice(0, 300);

    // If accounts worked, also try listing locations of the first account.
    if (acctRes.ok && acctBody.accounts?.length) {
      const locRes = await gbpRead(`https://mybusinessbusinessinformation.googleapis.com/v1/${acctBody.accounts[0].name}/locations?readMask=name,title&pageSize=10`, token);
      out.locationsStatus = locRes.status;
      const locBody = await locRes.json().catch(() => ({}));
      out.locations = locRes.ok
        ? (locBody.locations || []).map((l: any) => ({ name: l.name, title: l.title }))
        : (locBody.error?.message || "").slice(0, 300);
    }

    return json(out);
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, 500);
  }
};

export const config: Config = { path: "/api/gbp-probe" };
