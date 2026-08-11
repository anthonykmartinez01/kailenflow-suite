// Server-side Google auth. TWO backends, deliberately:
//
//   getServiceAccountToken(scopes)  — no refresh token, nothing to expire.
//   getGoogleAccessToken()          — the original user-OAuth refresh token.
//
// ─── Why both, and why not just migrate everything ───────────────────────
// The single shared refresh token died on 2026-07-30 with
// `invalid_grant: "Token has been expired or revoked"`, which silently broke
// EVERY unattended Google call at once — the indexing tool showed the same
// raw 400 on all 11 scheduled pages. Refresh tokens expire after 7 days
// while an OAuth consent screen sits in "Testing" status, so this was
// guaranteed to recur on a timer.
//
// A service account has no refresh token, so that failure mode simply does
// not exist. But it CANNOT replace OAuth everywhere:
//   • Indexing API      — service account is Google's documented path  ✅
//   • Search Console    — service account works (add it as a property user) ✅
//   • GA4 Data API      — works IF the SA is added as a property user   ✅
//   • Business Profile  — service accounts are NOT supported; GBP needs
//                         consent from an account that manages the listing ❌
// So gbp-probe stays on OAuth on purpose. Don't "finish the migration" by
// pointing it at the service account — it will 403.
//
// The service account must be added as an OWNER of the Search Console
// property for the Indexing API to accept its submissions, and the Indexing
// API + Search Console API must be enabled in the Cloud project.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

// Reuses FIREBASE_SERVICE_ACCOUNT — same Cloud project (kailenflow-suite),
// already configured, already trusted for Firestore. No new secret to manage.
function serviceAccount(): { client_email: string; private_key: string } | null {
  const raw = Netlify.env.get("FIREBASE_SERVICE_ACCOUNT");
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw);
    if (!sa.client_email || !sa.private_key) return null;
    return sa;
  } catch { return null; }
}

const b64url = (b: Buffer | string) => Buffer.from(b as any).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// One cache entry per scope set — a token is only valid for the scopes it was
// minted with, so keying by scope avoids handing a GSC-only token to Indexing.
const saTokenCache = new Map<string, { token: string; expiresAt: number }>();
const saInFlight = new Map<string, Promise<string>>();

export function serviceAccountEmail(): string | null {
  return serviceAccount()?.client_email ?? null;
}

// Signed-JWT grant (RFC 7523). No stored refresh token, nothing to revoke,
// nothing that expires on Google's 7-day Testing-mode clock.
export async function getServiceAccountToken(scopes: string[]): Promise<string> {
  const key = scopes.slice().sort().join(" ");
  const hit = saTokenCache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.token;
  const inflight = saInFlight.get(key);
  if (inflight) return inflight;

  const p = (async () => {
    try {
      const sa = serviceAccount();
      if (!sa) throw new Error("FIREBASE_SERVICE_ACCOUNT not configured — cannot use service-account auth.");
      const now = Math.floor(Date.now() / 1000);
      const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
      const claim = b64url(JSON.stringify({
        iss: sa.client_email, scope: key,
        aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now,
      }));
      const signer = crypto.createSign("RSA-SHA256");
      signer.update(`${header}.${claim}`);
      const jwt = `${header}.${claim}.${b64url(signer.sign(sa.private_key))}`;

      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
      });
      const data = await res.json();
      if (!res.ok || !data.access_token) {
        throw new Error(`Service-account token request failed: ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
      }
      saTokenCache.set(key, { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 - 60_000 });
      return data.access_token as string;
    } finally {
      saInFlight.delete(key);
    }
  })();
  saInFlight.set(key, p);
  return p;
}

export const GOOGLE_SCOPES = {
  indexing: "https://www.googleapis.com/auth/indexing",
  searchConsole: "https://www.googleapis.com/auth/webmasters.readonly",
  analytics: "https://www.googleapis.com/auth/analytics.readonly",
};

// Prefers the service account (cannot expire) and falls back to the stored
// user-OAuth token only if the SA is unavailable or rejected — so an
// un-authorised SA degrades to the old behaviour instead of hard-failing.
// Returns which backend actually worked, for honest error reporting.
export async function getTokenPreferServiceAccount(scopes: string[]): Promise<{ token: string; via: "service_account" | "oauth"; saError?: string }> {
  if (serviceAccount()) {
    try {
      return { token: await getServiceAccountToken(scopes), via: "service_account" };
    } catch (e: any) {
      const saError = String(e?.message || e);
      try {
        return { token: await getGoogleAccessToken(), via: "oauth", saError };
      } catch (e2: any) {
        throw new Error(`Service account failed (${saError}); OAuth fallback also failed (${String(e2?.message || e2)}).`);
      }
    }
  }
  return { token: await getGoogleAccessToken(), via: "oauth" };
}

const STORE_NAME = "google-oauth";
const TOKEN_KEY = "refresh-token";

export async function saveRefreshToken(refreshToken: string): Promise<void> {
  const store = getStore(STORE_NAME);
  await store.setJSON(TOKEN_KEY, { refreshToken, savedAt: Date.now() });
  // A fresh refresh token means any cached access token is definitely stale.
  cachedAccessToken = null;
  refreshInFlight = null;
}

// In-memory cache, scoped to this function instance's warm lifetime — NOT
// persisted (access tokens are short-lived and don't need to survive a cold
// start). Added 2026-07-20: check-indexed-status was calling this once PER
// PAGE (15 pages = 15 separate token-refresh round-trips in one request,
// serialized with 15 more Search Console calls) and blew Netlify's function
// time limit, crashing with a 502 before it could even respond. One token
// is good for ~1 hour and is identical for every caller (one shared Google
// account backs everything) — fetch it once, reuse it for the rest of the
// invocation, and for any other invocation that happens to reuse the same
// warm instance.
let cachedAccessToken: { token: string; expiresAt: number } | null = null;
// De-dupes concurrent callers (e.g. submitBatchAndLog's Promise.all across
// several URLs) so a burst of simultaneous cache-misses fires ONE refresh
// request, not one per caller, instead of a thundering herd.
let refreshInFlight: Promise<string> | null = null;

// Exchanges the stored refresh token for a short-lived access token. Throws
// with a clear message if no refresh token has been saved yet (i.e. the
// one-time consent flow hasn't been completed).
export async function getGoogleAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAt) return cachedAccessToken.token;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
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
      // Trim 60s off the real expiry as a safety margin so a call that
      // lands right at the edge doesn't get handed a token that expires
      // mid-request.
      cachedAccessToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 - 60_000 };
      return data.access_token;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}
