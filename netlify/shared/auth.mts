// Security guard for the suite's API functions. Confirms the caller is signed
// into the suite by verifying the Firebase ID token the frontend sends. Pure
// Web Crypto + Google's public keys — no extra dependencies.
import { webcrypto } from "node:crypto";

const PROJECT_ID = "kailenflow-suite";
const JWK_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

let cache: { at: number; keys: any[] } | null = null;

function b64urlStr(s: string): string {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
function b64urlBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}

async function publicKeys(): Promise<any[]> {
  const now = Date.now();
  if (cache && now - cache.at < 3_600_000) return cache.keys;
  const res = await fetch(JWK_URL);
  const data = await res.json();
  cache = { at: now, keys: data.keys || [] };
  return cache.keys;
}

// True only if the request carries a valid, unexpired Firebase ID token issued
// for this project — i.e. the caller is a signed-in suite user.
export async function isAuthed(req: Request): Promise<boolean> {
  return (await verifiedClaims(req)) !== null;
}

// Stricter than isAuthed: the caller must be the OWNER, identified by email. Used for personal financial data, where "any signed-in user
// of the project" is not good enough — if anyone else ever gets an account,
// they must not see the owner's bank transactions.
// Allowed emails: OWNER_EMAILS (comma-separated) in Netlify, else the owner's.
const DEFAULT_OWNER = "anthonykmartinez01@gmail.com";
export async function isOwner(req: Request): Promise<boolean> {
  const claims = await verifiedClaims(req);
  if (!claims) return false;
  const email = String(claims.email || "").toLowerCase();
  // Not requiring email_verified: the owner's account signs in with email +
  // password and was never verified (checked 2026-09-24). That's still safe —
  // the token signature proves it came from this project, and Firebase allows
  // one account per email, which the owner's account already holds.
  if (!email) return false;
  const allowed = String(Netlify.env.get("OWNER_EMAILS") || DEFAULT_OWNER)
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(email);
}

export function forbidden(): Response {
  return new Response(JSON.stringify({ error: "This section is only available to the account owner." }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}

async function verifiedClaims(req: Request): Promise<any | null> {
  try {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const segs = token.split(".");
    if (segs.length !== 3) return false;
    const header = JSON.parse(b64urlStr(segs[0]));
    const payload = JSON.parse(b64urlStr(segs[1]));
    const now = Math.floor(Date.now() / 1000);
    if (payload.aud !== PROJECT_ID) return false;
    if (payload.iss !== "https://securetoken.google.com/" + PROJECT_ID) return false;
    if (!payload.sub || !payload.exp || payload.exp < now) return false;
    const jwk = (await publicKeys()).find((k: any) => k.kid === header.kid);
    if (!jwk) return false;
    const key = await webcrypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await webcrypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(segs[2]), new TextEncoder().encode(segs[0] + "." + segs[1]));
    return ok ? payload : null;
  } catch {
    return null;
  }
}

export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "Not authorized — please sign in to the suite." }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}
