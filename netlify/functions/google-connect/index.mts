import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { rnrConnection, disconnectRnr } from "../../shared/google-auth.mts";
import { clearPortfolioStore } from "../../shared/gbp-portfolio-store.mts";
import { gmailGranted, GMAIL_SCOPE } from "../../shared/gmail.mts";

// Connect / check / disconnect Google accounts.
//
//   slot "rnr"  — the SEPARATE rank-and-rent account used only by GBP Portfolio
//   slot "main" — the original client-work account (Search Console, indexing,
//                 Business Profile), optionally re-consented WITH Gmail read
//                 so Client Management can fill in "last contacted"
//
// POST /api/google-connect
//   {action:"status"}                  -> rank-and-rent connection
//   {action:"main-status"}             -> {gmailGranted}
//   {action:"start", slot}             -> {url} consent link for that slot
//   {action:"disconnect"}              -> revokes + forgets the rank-and-rent account
//
// Security: the OAuth callback is a public URL, so a one-time `state` nonce is
// minted here (behind app login) and must match on the way back. Without it,
// anyone could send a code for THEIR account and swap in their data.
// The nonce expires after 15 minutes and is deleted once used.

const STATE_STORE = "google-oauth";
const RNR_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/business.manage"];
// The main account's existing grants, plus Gmail read. Re-consenting must not
// LOSE scopes the app already depends on, so they're all listed here.
const MAIN_SCOPES = [
  "openid", "email",
  "https://www.googleapis.com/auth/indexing",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/business.manage",
  GMAIL_SCOPE,
];

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* empty is fine */ }
  const action = String(body.action || "status");

  if (action === "status") return json(await rnrConnection());
  if (action === "main-status") return json(await gmailGranted());

  if (action === "disconnect") {
    await disconnectRnr();
    await clearPortfolioStore();
    return json({ ok: true, connected: false });
  }

  if (action === "start") {
    const slot = body.slot === "main" ? "main" : "rnr";
    const clientId = Netlify.env.get("GOOGLE_OAUTH_CLIENT_ID");
    if (!clientId) return json({ error: "GOOGLE_OAUTH_CLIENT_ID not configured." }, 500);
    const nonce = crypto.randomBytes(24).toString("hex");
    await getStore(STATE_STORE).setJSON(`${slot}-state`, { nonce, at: Date.now() });
    const origin = new URL(req.url).origin;
    const params = new URLSearchParams({
      client_id: clientId,
      // Same redirect URI the main connection already registered in Google Cloud.
      redirect_uri: `${origin}/.netlify/functions/google-oauth-callback`,
      response_type: "code",
      scope: (slot === "main" ? MAIN_SCOPES : RNR_SCOPES).join(" "),
      access_type: "offline",
      // Always show the account chooser + consent, so a refresh token is issued
      // and the operator consciously picks the right account.
      prompt: "select_account consent",
      include_granted_scopes: "false",
      state: `${slot}.${nonce}`,
    });
    return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, slot });
  }

  return json({ error: `Unknown action "${action}"` }, 400);
};

export const config: Config = { path: "/api/google-connect" };
