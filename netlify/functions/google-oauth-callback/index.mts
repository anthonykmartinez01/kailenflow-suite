import type { Context, Config } from "@netlify/functions";
import { saveRefreshToken } from "../../shared/google-auth.mts";

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

  if (error) return html(`<h2>Google declined the connection</h2><p>${error}</p>`, 400);
  if (!code) return html(`<h2>Missing authorization code</h2><p>This page should only be reached via a Google consent redirect.</p>`, 400);

  const clientId = Netlify.env.get("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = Netlify.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
  const redirectUri = `${url.origin}/.netlify/functions/google-oauth-callback`;
  if (!clientId || !clientSecret) return html(`<h2>Server not configured</h2><p>Missing GOOGLE_OAUTH_CLIENT_ID/SECRET.</p>`, 500);

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
    await saveRefreshToken(tokenData.refresh_token);
    return html(`<h2>✅ Connected</h2><p>Google account linked. You can close this tab.</p>`);
  } catch (e: any) {
    return html(`<h2>Unexpected error</h2><pre>${String(e?.message || e)}</pre>`, 500);
  }
};
