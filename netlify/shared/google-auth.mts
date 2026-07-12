// Server-side Google OAuth token storage/refresh. One shared refresh token
// (from Anthony's one-time consent via google-oauth-callback) backs every
// unattended Google API call — Indexing API today, GSC/GBP reporting later.
import { getStore } from "@netlify/blobs";

const STORE_NAME = "google-oauth";
const TOKEN_KEY = "refresh-token";

export async function saveRefreshToken(refreshToken: string): Promise<void> {
  const store = getStore(STORE_NAME);
  await store.setJSON(TOKEN_KEY, { refreshToken, savedAt: Date.now() });
}

// Exchanges the stored refresh token for a short-lived access token. Throws
// with a clear message if no refresh token has been saved yet (i.e. the
// one-time consent flow hasn't been completed).
export async function getGoogleAccessToken(): Promise<string> {
  const store = getStore(STORE_NAME);
  const saved = await store.get(TOKEN_KEY, { type: "json" }) as { refreshToken: string } | null;
  if (!saved?.refreshToken) {
    throw new Error("Google account not connected yet — complete the one-time consent flow first.");
  }
  const clientId = Netlify.env.get("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = Netlify.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("GOOGLE_OAUTH_CLIENT_ID/SECRET not configured.");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: saved.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.access_token;
}
