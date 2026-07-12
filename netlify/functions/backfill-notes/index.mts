import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

// TEMP one-time helper to backfill a "Found via search" note onto contacts that
// were added by Lead Finder before we started recording the search term.
//   POST {action:"list", days?:N}                      → recent Lead Finder contacts
//   POST {action:"apply", niche:"...", ids:[...]}      → add the note to those ids
const GHL = "https://services.leadconnectorhq.com";
const GHL_V = "2021-07-28";

async function ghlGet(path: string, token: string) {
  const r = await fetch(GHL + path, { headers: { Authorization: `Bearer ${token}`, Version: GHL_V, Accept: "application/json" } });
  const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t };
}

const toMs = (v: any): number => {
  if (v == null) return 0;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v); return isNaN(t) ? 0 : t;
};

// Pull the city + state out of a formatted address like
// "202 S Coleman St Ste 300, Prosper, TX 75078".
function cityStateOf(addr: string): { city: string; state: string } {
  const parts = (addr || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return { city: "", state: "" };
  const city = parts[parts.length - 2] || "";
  const state = (parts[parts.length - 1] || "").split(/\s+/)[0] || "";
  return { city, state };
}

async function listLeadFinderContacts(token: string, loc: string, days: number) {
  const cutoff = Date.now() - days * 86400000;
  const out: any[] = [];
  let startAfter = "", startAfterId = "", pages = 0;
  while (pages++ < 8) {
    const cursor = startAfter ? `&startAfter=${startAfter}&startAfterId=${encodeURIComponent(startAfterId)}` : "";
    const r = await ghlGet(`/contacts/?locationId=${encodeURIComponent(loc)}&limit=100${cursor}`, token);
    if (r.status !== 200) return { error: `GHL ${r.status}: ${(r.text || "").slice(0, 150)}` };
    const batch: any[] = r.json?.contacts || [];
    if (!batch.length) break;
    for (const c of batch) {
      const added = toMs(c.dateAdded);
      const src = (c.source || "").toString();
      if (src === "Lead Finder" && added >= cutoff) {
        const addr = (c.address1 || c.fullAddress || "").toString();
        const { city, state } = cityStateOf(addr);
        const phone = (c.phone || "").toString().replace(/\D/g, "").slice(-10);
        out.push({ id: c.id, name: c.contactName || c.name || c.companyName || c.firstName || "?", phone, city, state, addr, dateAdded: new Date(added).toISOString().slice(0, 16).replace("T", " ") });
      }
    }
    const last = batch[batch.length - 1];
    startAfter = String(toMs(last.dateAdded));
    startAfterId = last.id;
    if (batch.length < 100) break;
    // Stop paging once we're clearly past the window.
    if (toMs(last.dateAdded) < cutoff) break;
  }
  out.sort((a, b) => (a.dateAdded < b.dateAdded ? 1 : -1));
  return { contacts: out };
}

export default async (req: Request, _ctx: Context) => {
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  if (!(await isAuthed(req))) return unauthorized();

  const token = Netlify.env.get("GHL_API_TOKEN");
  const loc = Netlify.env.get("GHL_LOCATION_ID");
  if (!token || !loc) return new Response(JSON.stringify({ error: "GHL not configured" }), { status: 500 });

  const body = await req.json().catch(() => ({} as any));
  const action = (body.action || "list").toString();

  if (action === "list") {
    const days = Math.min(parseInt(body.days || "7", 10) || 7, 60);
    const res = await listLeadFinderContacts(token, loc, days);
    return new Response(JSON.stringify(res), { status: ("error" in res ? 502 : 200), headers: { "content-type": "application/json" } });
  }

  if (action === "apply") {
    const niche = (body.niche || "").toString().trim();
    const targets: any[] = Array.isArray(body.targets) ? body.targets : [];
    if (!niche) return new Response(JSON.stringify({ error: "Missing niche" }), { status: 400 });
    if (!targets.length) return new Response(JSON.stringify({ error: "No targets" }), { status: 400 });
    const updated: string[] = [];
    const failed: string[] = [];
    for (const t of targets) {
      const loc2 = t.city ? `${niche} in ${t.city}${t.state ? " " + t.state : ""}` : niche;
      try {
        const r = await fetch(`${GHL}/contacts/${t.id}/notes`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, Version: GHL_V, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ body: `LEAD FINDER\nFound via search: "${loc2}"` }),
        });
        if (r.ok) updated.push(t.name || t.id); else failed.push((t.name || t.id) + " (" + r.status + ")");
      } catch (e: any) { failed.push((t.name || t.id) + " (err)"); }
    }
    return new Response(JSON.stringify({ updatedCount: updated.length, updated, failed }), { status: 200, headers: { "content-type": "application/json" } });
  }

  return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400 });
};

export const config: Config = { path: "/api/backfill-notes" };
