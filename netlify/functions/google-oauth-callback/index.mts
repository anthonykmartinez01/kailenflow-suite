import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { saveRefreshToken, saveRnrRefreshToken } from "../../shared/google-auth.mts";
import { clearPortfolioStore } from "../../shared/gbp-portfolio-store.mts";

// email claim from the id_token Google returns alongside the tokens (openid
// email scopes). Only a label so the operator can see WHICH Gmail is connected;
// it came straight from Google's token endpoint over TLS.
function emailFromIdToken(idToken: string | undefined): string | null {
  try { return JSON.parse(Buffer.from(String(idToken).split(".")[1], "base64url").toString()).email || null; }
  catch { return null; }
}

// One-time landing page for Google's OAuth redirect. Anthony visits the
// consent URL once (see indexing-tool memory for the exact link), Google
// redirects here with ?code=..., we exchange it for a refresh token and
// store it in Blobs. Never called by end users — only reachable by knowing
// this exact URL, which only Google (post-consent) and Anthony have.
function html(body: string, status = 200) {
  return new Response(`<!doctype html><html><body style="font-family:sans-serif;padding:40px;max-width:560px;margin:0 auto">${body}</body></html>`, {
    status,
    headers: { "content-type": "text/html" },
  });
}

export default async (req: Request, _ctx: Context) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const state = url.searchParams.get("state") || "";
  // "<slot>.<nonce>": "rnr" = the SEPARATE rank-and-rent account (GBP Portfolio
  // only); "main" = the original client-work account, re-consented with Gmail
  // read. No state at all = the original manual link, unchanged.
  const slot = state.includes(".") ? state.split(".")[0] : "";
  const isRnr = slot === "rnr";
  const isMain = slot === "main";

  if (error) return html(`<h2>Google declined the connection</h2><p>${error}</p>`, 400);
  if (!code) return html(`<h2>Missing authorization code</h2><p>This page should only be reached via a Google consent redirect.</p>`, 400);

  const clientId = Netlify.env.get("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = Netlify.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
  const redirectUri = `${url.origin}/.netlify/functions/google-oauth-callback`;
  if (!clientId || !clientSecret) return html(`<h2>Server not configured</h2><p>Missing GOOGLE_OAUTH_CLIENT_ID/SECRET.</p>`, 500);

  if (isRnr || isMain) {
    const stateStore = getStore("google-oauth");
    const key = `${slot}-state`;
    const saved = (await stateStore.get(key, { type: "json" }).catch(() => null)) as any;
    await stateStore.delete(key).catch(() => null); // one use only
    const fresh = saved?.at && Date.now() - saved.at < 15 * 60 * 1000;
    if (!fresh || `${slot}.${saved.nonce}` !== state) {
      return html(`<h2>Link expired</h2><p>Go back to the app and get a new connect link.</p>`, 400);
    }
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) return html(`<h2>Token exchange failed</h2><pre>${JSON.stringify(tokenData, null, 2)}</pre>`, 500);
    if (!tokenData.refresh_token) {
      return html(
        `<h2>No refresh token returned</h2><p>Google only issues a refresh token on the FIRST consent, or when the request includes <code>prompt=consent</code>. Revoke access at <a href="https://myaccount.google.com/permissions" target="_blank">myaccount.google.com/permissions</a> and try the connect link again.</p>`,
        500
      );
    }
    if (isRnr) {
      const email = emailFromIdToken(tokenData.id_token);
      await saveRnrRefreshToken(tokenData.refresh_token, email);
      await clearPortfolioStore();
      return html(`<h2>✅ Rank-and-rent account connected</h2><p>${email ? `Connected <b>${email.replace(/[<>&"]/g, "")}</b>. ` : ""}It is used only by GBP Portfolio. You can close this tab.</p>`);
    }
    await saveRefreshToken(tokenData.refresh_token);
    if (isMain) {
      const email = emailFromIdToken(tokenData.id_token);
      return html(`<h2>✅ Google account reconnected</h2><p>${email ? `Connected <b>${email.replace(/[<>&"]/g, "")}</b>. ` : ""}Gmail read access is now available for "last contacted". You can close this tab.</p>`);
    }
    return html(`<h2>✅ Connected</h2><p>Google account linked. You can close this tab.</p>`);
  } catch (e: any) {
    return html(`<h2>Unexpected error</h2><pre>${String(e?.message || e)}</pre>`, 500);
  }
};
