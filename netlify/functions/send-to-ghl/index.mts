import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

const PIPELINE_NAME = "Cold Calling Pipeline Local";
const STAGE_NAME = "New Lead";

// fetch with a hard timeout + auto-retry on rate-limits / transient errors, so a
// single slow GoHighLevel call can never hang the whole "Send to GHL" request.
async function ghlFetch(url: string, init: RequestInit, tries = 3, timeoutMs = 9000): Promise<Response> {
  let lastErr: any;
  for (let attempt = 0; attempt < tries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      if ((res.status === 429 || res.status >= 500) && attempt < tries - 1) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < tries - 1) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error("GHL request timed out");
}

const ghlHeaders = (token: string, json = false) => ({
  Authorization: `Bearer ${token}`,
  Version: GHL_VERSION,
  Accept: "application/json",
  ...(json ? { "Content-Type": "application/json" } : {}),
});

// Look up pipeline + stage IDs by name so the user never deals with raw IDs.
async function resolvePipelineStage(token: string, locationId: string): Promise<{ pipelineId: string; stageId: string } | { error: string }> {
  const res = await ghlFetch(`${GHL_BASE}/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`, {
    headers: ghlHeaders(token),
  });
  if (!res.ok) {
    return { error: `Couldn't load pipelines (${res.status}). Check the GHL token scopes.` };
  }
  const data = await res.json();
  const pipelines: any[] = data.pipelines ?? [];
  const pipeline = pipelines.find(
    (p) => (p.name ?? "").trim().toLowerCase() === PIPELINE_NAME.toLowerCase()
  );
  if (!pipeline) {
    return { error: `Pipeline "${PIPELINE_NAME}" not found in GHL.` };
  }
  const stage = (pipeline.stages ?? []).find(
    (s: any) => (s.name ?? "").trim().toLowerCase() === STAGE_NAME.toLowerCase()
  );
  if (!stage) {
    return { error: `Stage "${STAGE_NAME}" not found in that pipeline.` };
  }
  return { pipelineId: pipeline.id, stageId: stage.id };
}

// Check whether this business already exists as a contact in GHL.
// Returns the contact id if found, or null. Used to guarantee we never
// create duplicates or touch an existing contact/opportunity.
async function findExistingContact(
  token: string,
  locationId: string,
  phone: string,
  name: string
): Promise<string | null> {
  // Try phone first (most reliable unique key), then fall back to name.
  const queries: string[] = [];
  if (phone) queries.push(phone);
  if (name) queries.push(name);

  for (const q of queries) {
    try {
      const res = await ghlFetch(`${GHL_BASE}/contacts/search`, {
        method: "POST",
        headers: ghlHeaders(token, true),
        body: JSON.stringify({ locationId, query: q, pageLimit: 5 }),
      }, 2, 7000);
      if (!res.ok) continue;
      const data = await res.json();
      const contacts: any[] = data.contacts ?? [];
      if (!contacts.length) continue;

      // For a phone query, any hit is a real match. For a name query, require
      // the name to match closely so we don't false-positive on similar names.
      if (q === phone) {
        return contacts[0].id ?? null;
      } else {
        const target = name.trim().toLowerCase();
        const match = contacts.find((c) => {
          const cn = (c.contactName ?? c.name ?? c.companyName ?? "").toString().trim().toLowerCase();
          return cn === target;
        });
        if (match) return match.id ?? null;
      }
    } catch {
      // ignore and try next query
    }
  }
  return null;
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }
  if (!(await isAuthed(req))) return unauthorized();

  const token = Netlify.env.get("GHL_API_TOKEN");
  const locationId = Netlify.env.get("GHL_LOCATION_ID");

  if (!token) {
    return new Response(
      JSON.stringify({ error: "Server is missing GHL_API_TOKEN. Add it in Netlify env vars." }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
  if (!locationId) {
    return new Response(
      JSON.stringify({ error: "Server is missing GHL_LOCATION_ID. Add it in Netlify env vars." }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }

  const name: string = (body.name ?? "").toString().trim();
  const phone: string = (body.phone ?? "").toString().trim();
  const address: string = (body.address ?? "").toString().trim();
  const website: string = (body.website ?? "").toString().trim();
  if (!name) {
    return new Response(JSON.stringify({ error: "Missing business name" }), { status: 400 });
  }

  // Go High Level requires a phone OR email to create a contact. This tool only
  // has phone numbers, so a business with no phone on Google can't be imported.
  // Catch it here and explain plainly instead of showing a vague GHL error.
  if (!phone) {
    return new Response(
      JSON.stringify({ error: `${name} has no phone number — Go High Level needs a phone or email to save a contact, so this lead can't be imported. Hit Skip.` }),
      { status: 422, headers: { "content-type": "application/json" } }
    );
  }

  // Extra detail for the call-prep note (all optional).
  const rating = body.rating;
  const reviews = body.reviews;
  const age = body.oldestReviewYearsAgo;
  const lastReview = body.lastReviewDaysAgo;
  const maturity: string = (body.maturity ?? "").toString();
  const maturityNote: string = (body.maturityNote ?? "").toString();
  const ownerName: string = (body.ownerName ?? "").toString();
  const ownerSource: string = (body.ownerSource ?? "").toString();
  const ownerConfidence: string = (body.ownerConfidence ?? "").toString();
  const lineType: string = (body.lineType ?? "").toString();
  const carrierName: string = (body.carrierName ?? "").toString();
  const websiteFlag: string = (body.websiteFlag ?? "").toString();
  const score = body.score;
  const scoreReasons: string[] = Array.isArray(body.scoreReasons) ? body.scoreReasons : [];
  const marketLabel: string = (body.marketLabel ?? "").toString();
  const marketScore = body.marketScore;
  const marketReason: string = (body.marketReason ?? "").toString();
  const mapsUrl: string = (body.mapsUrl ?? "").toString();
  const searchTerm: string = (body.searchTerm ?? "").toString().trim();

  // Build a readable call-prep note.
  function buildNote(): string {
    const lines: string[] = ["LEAD FINDER — CALL PREP", ""];
    if (searchTerm) { lines.push(`Found via search: "${searchTerm}"`); lines.push(""); }
    if (ownerName) {
      const label = ownerConfidence === "low" ? "POSSIBLE OWNER" : "LIKELY OWNER";
      const confText =
        ownerConfidence === "high" ? "HIGH confidence — consistently named across reviews"
        : ownerConfidence === "low" ? "LOW confidence — NOT verified, double-check on the call"
        : "MEDIUM confidence — named in a couple reviews";
      lines.push(`${label}: ${ownerName}`);
      lines.push(`  Verification: ${confText}`);
      if (ownerSource) lines.push(`  Basis: ${ownerSource}`);
      lines.push("");
    } else {
      lines.push(`OWNER: not identified from reviews (no consistent name found)`);
      lines.push("");
    }
    if (lineType) {
      const lt = lineType === "mobile" ? `\ud83d\udcf1 MOBILE/CELL${carrierName ? ` (${carrierName})` : ""} \u2014 good shot at the owner directly`
        : lineType === "landline" ? "\u260e Landline \u2014 may reach a receptionist/office"
        : lineType === "voip" ? "🔀 VoIP — may ring the owner's cell (Google Voice/app) or an office"
        : "";
      if (lt) lines.push(`Phone type: ${lt}`);
    }
    if (rating != null && reviews != null) lines.push(`Rating: ${rating}\u2605  (${reviews} reviews)`);
    const ageBits: string[] = [];
    if (maturity) ageBits.push(maturityNote || maturity);
    else if (age != null) ageBits.push(`review history ~${age} yrs (rough)`);
    if (lastReview != null) ageBits.push(lastReview <= 90 ? "active review <90d ago" : `last review ${lastReview}d ago`);
    if (ageBits.length) lines.push(ageBits.join("  \u00b7  "));
    if (websiteFlag) {
      const wf = websiteFlag === "none" ? "NO website (prime target)"
        : websiteFlag === "weak" ? "Weak web presence (good target)"
        : websiteFlag === "ok" ? "Has a real website" : "Website unknown";
      lines.push(`Web: ${wf}`);
    }
    if (marketLabel && marketScore != null) lines.push(`Market: ${marketLabel} (${marketScore}) \u2014 ${marketReason}`);
    if (score != null) lines.push(`Fit score: ${score}`);
    if (scoreReasons.length) lines.push(`Why: ${scoreReasons.join(", ")}`);
    lines.push("");
    if (address) lines.push(`Address: ${address}`);
    if (phone) lines.push(`Phone: ${phone}`);
    if (website) lines.push(`Website: ${website}`);
    if (mapsUrl) lines.push(`Google: ${mapsUrl}`);
    return lines.join("\n");
  }

  try {
    // 1. Resolve pipeline + stage IDs from their names.
    const resolved = await resolvePipelineStage(token, locationId);
    if ("error" in resolved) {
      return new Response(JSON.stringify({ error: resolved.error }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }

    // 1b. SAFETY: if this business already exists in GHL, do nothing at all.
    // No new opportunity, no stage change, no contact update. Just report it.
    const existingId = await findExistingContact(token, locationId, phone, name);
    if (existingId) {
      return new Response(
        JSON.stringify({ ok: true, alreadyExisted: true, contactId: existingId }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    // 2. Create the contact (only reached when it's genuinely new).
    const contactRes = await ghlFetch(`${GHL_BASE}/contacts/upsert`, {
      method: "POST",
      headers: ghlHeaders(token, true),
      body: JSON.stringify({
        locationId,
        name,
        companyName: name,
        phone: phone || undefined,
        address1: address || undefined,
        website: website || undefined,
        source: "Lead Finder",
      }),
    });

    if (!contactRes.ok) {
      const t = await contactRes.text();
      // Translate GHL's "needs a phone or email" rejection into plain language.
      const friendly = /at least one of number, email/i.test(t)
        ? `${name} has no phone or email Go High Level can use, so it can't be imported. Hit Skip.`
        : "Couldn't create contact in GHL";
      return new Response(
        JSON.stringify({ error: friendly, detail: t.slice(0, 200) }),
        { status: 502, headers: { "content-type": "application/json" } }
      );
    }
    const contactData = await contactRes.json();
    const contactId = contactData.contact?.id ?? contactData.id;

    // 2b. Attach the call-prep note to the contact (best-effort; don't fail the whole send if it errors).
    if (contactId) {
      try {
        await ghlFetch(`${GHL_BASE}/contacts/${contactId}/notes`, {
          method: "POST",
          headers: ghlHeaders(token, true),
          body: JSON.stringify({ body: buildNote() }),
        }, 1, 6000);
      } catch {
        // Note is a nice-to-have; ignore failures so the lead still lands.
      }
    }

    // 3. Create the opportunity in the chosen pipeline + stage.
    const oppRes = await ghlFetch(`${GHL_BASE}/opportunities/`, {
      method: "POST",
      headers: ghlHeaders(token, true),
      body: JSON.stringify({
        locationId,
        pipelineId: resolved.pipelineId,
        pipelineStageId: resolved.stageId,
        name,
        status: "open",
        contactId,
      }),
    });

    if (!oppRes.ok) {
      const t = await oppRes.text();
      return new Response(
        JSON.stringify({ error: "Contact created, but opportunity failed", detail: t.slice(0, 200) }),
        { status: 502, headers: { "content-type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ ok: true, contactId }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const friendly = /abort|timed out/i.test(msg)
      ? "Go High Level didn't respond in time. It may still have saved — check GHL, or hit Send again."
      : "Couldn't reach Go High Level. Try Send again in a moment.";
    return new Response(
      JSON.stringify({ error: friendly, detail: msg }),
      { status: 502, headers: { "content-type": "application/json" } }
    );
  }
};

export const config: Config = {
  path: "/api/send-to-ghl",
};
