import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

// AI Call Coach engine:
//   GET  /api/call-coach            → list recent REAL calls (long enough to matter)
//   POST /api/call-coach {messageId} → download recording, transcribe (Deepgram),
//                                      and have Claude coach the call.
// All gated behind the suite login.

const GHL = "https://services.leadconnectorhq.com";
const GHL_V = "2021-07-28";
const MIN_DURATION = 60; // seconds — skip quick/no-answer calls

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

async function ghlGet(path: string, token: string) {
  const r = await fetch(GHL + path, { headers: { Authorization: `Bearer ${token}`, Version: GHL_V, Accept: "application/json" } });
  const t = await r.text();
  let j: any = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t };
}

const toMs = (v: any): number => {
  if (v == null) return 0;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
};

// Fetch a conversation's messages with retries, so a rate-limited request never
// silently drops a call from the list. Returns null only if it truly can't read.
async function ghlMessages(id: string, token: string) {
  for (let a = 0; a < 5; a++) {
    const m = await ghlGet(`/conversations/${id}/messages`, token);
    if (m.status === 200) return m.json?.messages?.messages || m.json?.messages || [];
    if (m.status === 429 || m.status >= 500) await new Promise((r) => setTimeout(r, 700 * (a + 1)));
    else break;
  }
  return null;
}

// Get a recording's total byte size cheaply (Range request) — 0 if no recording.
async function recordingBytes(messageId: string, loc: string, token: string): Promise<number> {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`${GHL}/conversations/messages/${messageId}/locations/${encodeURIComponent(loc)}/recording`, {
        headers: { Authorization: `Bearer ${token}`, Version: GHL_V, Range: "bytes=0-1" },
      });
      if (r.status === 206) { const cr = r.headers.get("content-range"); const tot = cr && cr.split("/")[1]; if (tot) return parseInt(tot, 10); }
      if (r.status === 200) { const cl = r.headers.get("content-length"); if (cl) return parseInt(cl, 10); return (await r.arrayBuffer()).byteLength; }
      if (r.status === 429 || r.status >= 500) { await new Promise((rs) => setTimeout(rs, 500 * (a + 1))); continue; }
      return 0; // 404 etc. = no recording (no-answer)
    } catch { await new Promise((rs) => setTimeout(rs, 400)); }
  }
  return 0;
}

// ---- List recent real calls ----
// Scans ALL conversations active in the last few days (paginated), not just the
// most recent 30 — so a real call made earlier today can't get buried under the
// cold calls dialed after it.
// Run async work over a list with bounded concurrency (keeps us under GHL rate limits).
async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

async function listCalls(token: string, loc: string, debug = false, days = 2, deadline = Date.now() + 22000) {
  const WINDOW_DAYS = days, MAX_CONVS = 160, cutoff = Date.now() - WINDOW_DAYS * 86400000;
  let timedOut = false;

  // 1. Page through recent conversations within the window (newest first).
  const convs: any[] = [];
  let startAfterDate = "", startAfter = "", pages = 0, done = false;
  while (pages++ < 12 && !done && convs.length < MAX_CONVS && Date.now() < deadline) {
    const cursor = startAfterDate ? `&startAfterDate=${startAfterDate}&startAfter=${startAfter}` : "";
    const r = await ghlGet(`/conversations/search?locationId=${encodeURIComponent(loc)}&limit=100&sortBy=last_message_date&sort=desc${cursor}`, token);
    if (r.status !== 200) { if (convs.length) break; return { error: `Couldn't read conversations from GHL (${r.status}). ${(r.text || "").slice(0, 150)}` }; }
    const batch: any[] = r.json?.conversations || [];
    if (!batch.length) break;
    for (const c of batch) {
      if (toMs(c.lastMessageDate || c.dateUpdated || c.dateAdded) >= cutoff) convs.push(c);
      else { done = true; break; }
    }
    const last = batch[batch.length - 1];
    startAfterDate = String(toMs(last.lastMessageDate || last.dateUpdated || last.dateAdded));
    startAfter = last.id;
    if (batch.length < 100) break;
  }

  // 2. Read each conversation's messages (concurrently) and gather every call.
  // Stop early if we hit the time budget so the function always returns in time.
  const raw: any[] = [];
  const failedContacts: string[] = [];
  await pool(convs, 8, async (c) => {
    if (Date.now() > deadline) { timedOut = true; return; }
    const arr = await ghlMessages(c.id, token);
    if (arr === null) { failedContacts.push(c.fullName || c.contactName || c.name || c.phone || c.id); return; }
    for (const m of arr) {
      if (!/call/i.test((m.messageType || m.type || "").toString())) continue;
      raw.push({
        messageId: m.id,
        conversationId: c.id,
        contact: c.fullName || c.contactName || c.name || c.email || c.phone || "Unknown contact",
        date: m.dateAdded || m.dateUpdated || null,
        durationSec: m.meta?.call?.duration ?? null,
        estimated: false,
        direction: m.direction || m.meta?.call?.direction || "",
        status: m.meta?.call?.status,
      });
    }
  });

  // 3. For calls GHL didn't time, derive the real length from the recording size
  // (~15.9 KB/sec audio) — done in parallel only for the no-duration ones. If we
  // run out of time, keep the call (flagged) rather than dropping it, so a real
  // long call is never lost; the background refresh will time it on the next pass.
  await pool(raw.filter((c) => c.durationSec == null), 6, async (c) => {
    if (Date.now() > deadline) { timedOut = true; c.durationSec = MIN_DURATION; c.estimated = true; c.untimed = true; return; }
    const bytes = await recordingBytes(c.messageId, loc, token);
    c.durationSec = bytes > 0 ? Math.round(bytes / 15900) : 0;
    c.estimated = true;
  });

  // 4. Keep real conversations only (>= 60s), dedupe, newest first.
  const kept = debug ? raw : raw.filter((c) => (c.durationSec || 0) >= MIN_DURATION);
  const seen = new Set();
  const unique = kept.filter((c) => (seen.has(c.messageId) ? false : (seen.add(c.messageId), true)));
  unique.sort((a, b) => (toMs(a.date) < toMs(b.date) ? 1 : -1));
  return { calls: unique.slice(0, 40), partial: (timedOut || failedContacts.length) ? true : undefined };
}

// ---- Transcribe one recording with Deepgram (speaker-labeled) ----
// Returns the transcript plus speaker stats so we can tell a real two-way
// conversation from a one-sided voicemail / no-answer.
async function transcribe(audio: ArrayBuffer, contentType: string, dgKey: string) {
  const url = "https://api.deepgram.com/v1/listen?model=nova-2-phonecall&diarize=true&punctuate=true&utterances=true&smart_format=true";
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Token ${dgKey}`, "Content-Type": contentType || "audio/wav" },
    body: audio,
  });
  if (!r.ok) throw new Error(`Deepgram error ${r.status}: ${(await r.text()).slice(0, 150)}`);
  const d = await r.json();
  const utts = d.results?.utterances || [];
  if (utts.length) {
    const transcript = utts.map((u: any) => `Speaker ${u.speaker}: ${u.transcript}`).join("\n");
    const wordsBy: Record<string, number> = {};
    for (const u of utts) {
      const w = (u.transcript || "").split(/\s+/).filter(Boolean).length;
      wordsBy[u.speaker] = (wordsBy[u.speaker] || 0) + w;
    }
    const counts = Object.values(wordsBy).sort((a, b) => b - a);
    return { transcript, speakers: counts.length, totalWords: counts.reduce((a, b) => a + b, 0), secondSpeakerWords: counts[1] || 0 };
  }
  const flat = d.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
  return { transcript: flat, speakers: flat ? 1 : 0, totalWords: flat.split(/\s+/).filter(Boolean).length, secondSpeakerWords: 0 };
}

// ---- Coach the call with Claude ----
async function coach(transcript: string, anthropicKey: string) {
  const prompt = `You are an elite cold-calling coach. Below is a diarized transcript of a phone call. The sales rep was cold-calling local businesses to offer local SEO / marketing services.

FIRST, classify the call honestly:
- "real conversation": a genuine two-way talk between the rep and a live person (prospect or gatekeeper who engaged).
- "voicemail": the rep reached/left a voicemail, or it's a voicemail greeting — NOT a live two-way talk.
- "no answer": ringing, silence, or no real human exchange.
Set isRealConversation=false for voicemail/no answer, and in that case leave the coaching arrays empty.

Return ONLY valid JSON (no markdown, no commentary) with exactly this shape:
{
  "isRealConversation": true,
  "callType": "real conversation",
  "repSpeaker": "Speaker 0",
  "score": 7,
  "summary": "2-3 sentence honest read (for voicemail/no-answer, just say what it was)",
  "wentWell": ["specific things the rep did well"],
  "mistakes": ["specific mistakes, quoting moments"],
  "missedOpportunities": ["openings/objections the rep missed"],
  "nextTime": ["concrete, specific things to do differently next time"]
}

Transcript:
${transcript}`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(`Claude error ${r.status}: ${(await r.text()).slice(0, 150)}`);
  const d = await r.json();
  const text = (d.content?.[0]?.text || "").trim();
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(cleaned); } catch { return { summary: text, score: null, wentWell: [], mistakes: [], missedOpportunities: [], nextTime: [] }; }
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();

  const token = Netlify.env.get("GHL_API_TOKEN");
  const loc = Netlify.env.get("GHL_LOCATION_ID");
  if (!token || !loc) return json({ error: "GHL is not configured." }, 500);

  try {
    if (req.method === "GET") {
      const sp = new URL(req.url).searchParams;
      // Poll for a finished/in-progress analysis (written by the background job).
      if (sp.has("result")) {
        const id = sp.get("result") || "";
        const store = getStore("callcoach");
        const v = await store.get(`a:${id}`, { type: "json" }).catch(() => null);
        return json(v || { status: "none" });
      }
      const debug = sp.has("debug");
      const days = Math.min(parseInt(sp.get("days") || "2", 10) || 2, 30);
      const res = await listCalls(token, loc, debug, days, Date.now() + 22000);
      return ("error" in res) ? json(res, 502) : json(res);
    }

    if (req.method === "POST") {
      // Analysis of a long recording can exceed the request time limit, so the
      // work runs in a background job. This just starts it; the page polls
      // /api/call-coach?result=<id> for the outcome. (No more sync timeouts.)
      const body = await req.json().catch(() => ({}));
      const messageId = (body.messageId || "").toString();
      if (!messageId) return json({ error: "Missing messageId" }, 400);

      const store = getStore("callcoach");
      const key = `a:${messageId}`;
      const existing = (await store.get(key, { type: "json" }).catch(() => null)) as any;
      // Already finished — hand it back, don't re-run (or re-pay for) it.
      if (existing && existing.status === "done") return json({ started: false, status: "done", result: existing.result });
      // Already running recently — let the page keep polling the existing job.
      if (existing && existing.status === "pending" && Date.now() - (existing.at || 0) < 5 * 60000) return json({ started: true, messageId });

      await store.setJSON(key, { status: "pending", at: Date.now() });

      // Fire the background job (returns 202 immediately and keeps running).
      const origin = new URL(req.url).origin;
      const auth = req.headers.get("authorization") || "";
      await fetch(`${origin}/.netlify/functions/call-coach-analyze-background`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth },
        body: JSON.stringify({ messageId }),
      }).catch(() => {});

      return json({ started: true, messageId });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e: any) {
    return json({ error: "Request failed: " + String(e?.message ?? e) }, 500);
  }
};

export const config: Config = { path: "/api/call-coach" };
