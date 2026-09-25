import { getGoogleAccessToken } from "./google-auth.mts";

// Gmail reads for Client Management's "last contacted". READ-ONLY: it only
// searches and reads message headers (never bodies, never sends, never
// modifies). Uses the MAIN Google connection, not the rank-and-rent one.
//
// ⚠️ gmail.readonly is a Google "restricted" scope. While the OAuth consent
// screen is unverified/Testing, refresh tokens expire after 7 days — the same
// failure that broke every Google call on 2026-07-30. Manual outreach logging
// stays the dependable path; this is a convenience on top.

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export type LastEmail = { at: string; subject: string; direction: "sent" | "received"; with: string };

function headers(msg: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of msg.payload?.headers || []) out[String(h.name || "").toLowerCase()] = h.value || "";
  return out;
}

/** Domain of a website URL, for clients whose email address we don't know. */
export function domainOf(website: string): string | null {
  const m = String(website || "").match(/^(?:https?:\/\/)?(?:www\.)?([^/?#\s]+)/i);
  const host = m?.[1]?.toLowerCase();
  if (!host || !host.includes(".")) return null;
  // Our own sending domains would match everything — never search on those.
  if (/(gmail|googlemail|outlook|hotmail|yahoo)\./.test(host)) return null;
  return host;
}

/**
 * Most recent message exchanged with an address or domain. `null` when there
 * is none — which is different from "we couldn't look", which throws.
 */
export async function lastEmailWith(target: string, token: string, days = 365): Promise<LastEmail | null> {
  const q = `newer_than:${days}d (to:${target} OR from:${target} OR cc:${target})`;
  const list = await fetch(`${API}/messages?maxResults=1&q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!list.ok) throw new Error(`Gmail ${list.status}: ${(await list.text()).slice(0, 160)}`);
  const data: any = await list.json();
  const id = data.messages?.[0]?.id;
  if (!id) return null;

  const one = await fetch(`${API}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`, { headers: { Authorization: `Bearer ${token}` } });
  if (!one.ok) throw new Error(`Gmail ${one.status}`);
  const msg: any = await one.json();
  const h = headers(msg);
  const at = new Date(Number(msg.internalDate) || Date.parse(h.date) || Date.now()).toISOString();
  const sent = (msg.labelIds || []).includes("SENT");
  return { at, subject: h.subject || "(no subject)", direction: sent ? "sent" : "received", with: sent ? h.to || target : h.from || target };
}

/** True when the stored Google token actually carries the Gmail scope. */
export async function gmailGranted(): Promise<{ granted: boolean; reason?: string }> {
  try {
    const token = await getGoogleAccessToken();
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
    if (!r.ok) return { granted: false, reason: `tokeninfo ${r.status}` };
    const info: any = await r.json();
    return { granted: String(info.scope || "").includes(GMAIL_SCOPE) };
  } catch (e: any) {
    return { granted: false, reason: String(e?.message || e) };
  }
}
