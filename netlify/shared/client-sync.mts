import { getStore } from "@netlify/blobs";
import { readAppData } from "./firestore-admin.mts";
import { stripeKey, stripeCustomers } from "./stripe.mts";
import { lastEmailWith, domainOf, gmailGranted } from "./gmail.mts";
import { getGoogleAccessToken } from "./google-auth.mts";
import { recentCommits, githubToken } from "./github-work.mts";
import { getSiteByClientId } from "./page-publisher/firestore.mts";
import { applyIngest, type IngestRow } from "./client-ingest-merge.mts";
import { merchyntKey, merchyntSummary, merchyntStatus, discoverSlug } from "./merchynt.mts";

// The unattended half of Client Management: refresh Stripe, and (only if the
// permission is actually granted) refresh "last contacted" from Gmail. Shared
// by /api/client-crm and the nightly cron so both behave identically.
//
// Read-only everywhere: Stripe reads, Gmail searches headers. Writes go only
// to our own Blobs store.

export const STORE = "client-crm";
export const RECORDS = "records";
export const STRIPE_CACHE = "stripe-cache";

export async function refreshStripeCache(force = false, ttlMs = 10 * 60 * 1000) {
  const store = getStore(STORE);
  const key = stripeKey();
  if (!key) return { ok: false as const, error: "STRIPE_API_KEY isn't set in Netlify." };
  const cached = (await store.get(STRIPE_CACHE, { type: "json" }).catch(() => null)) as any;
  if (!force && cached?.at && Date.now() - cached.at < ttlMs) return { ok: true as const, cache: cached, fresh: false };
  try {
    const cache = { customers: await stripeCustomers(key), at: Date.now() };
    await store.setJSON(STRIPE_CACHE, cache).catch(() => null);
    return { ok: true as const, cache, fresh: true };
  } catch (e: any) {
    // Stale beats nothing — the page still shows the last known state.
    return { ok: false as const, error: String(e?.message || e), cache: cached || null };
  }
}

// Where a Claude Code session drops what it read from MCP-only tools (Elara).
// Kept in this app's own repo so the existing GITHUB_TOKEN is the only
// credential involved — no ingest token to create or store.
const INGEST_DIR = "ops/client-ingest";
const INGEST_REPO = () => Netlify.env.get("INGEST_REPO") || "anthonykmartinez01/kailenflow-suite";
// Branch the session commits to. Files on an unmerged branch are invisible
// to the dashboard until that branch lands, which is easy to mistake for a
// broken sync — so the branch is explicit rather than implied.
const INGEST_REF = () => Netlify.env.get("INGEST_REF") || "main";

async function gh(path: string, token: string) {
  const r = await fetch(`https://api.github.com/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "kailenflow-suite" },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

/**
 * Reads every ops/client-ingest/*.json in the repo and merges it in. The file
 * name is the source ("elara.json" -> source "elara"). Re-running replaces
 * that source's items rather than duplicating them.
 */
export async function ingestFromRepo(): Promise<{ ok: boolean; reason?: string; sources?: string[]; matched?: number; unmatched?: string[] }> {
  const token = githubToken();
  if (!token) return { ok: false, reason: "GITHUB_TOKEN isn't set in Netlify." };
  let listing: any;
  try { listing = await gh(`repos/${INGEST_REPO()}/contents/${INGEST_DIR}?ref=${encodeURIComponent(INGEST_REF())}`, token); }
  catch (e: any) { return { ok: false, reason: String(e?.message || e) }; }
  if (!listing) return { ok: true, sources: [], matched: 0, unmatched: [], reason: `No ${INGEST_DIR}/ in the repo yet.` };

  const store = getStore(STORE);
  const records = ((await store.get(RECORDS, { type: "json" }).catch(() => null)) || {}) as Record<string, any>;
  const app = await readAppData();
  const clients = (app.clients || []).map((c: any) => ({ id: c.id, name: c.name }));

  const sources: string[] = [];
  let matched = 0;
  const unmatched: string[] = [];
  for (const file of Array.isArray(listing) ? listing : []) {
    if (!/\.json$/i.test(file?.name || "") || !file.download_url) continue;
    const source = String(file.name).replace(/\.json$/i, "").slice(0, 40);
    try {
      const res = await fetch(file.download_url, { headers: { Authorization: `Bearer ${token}`, "User-Agent": "kailenflow-suite" } });
      if (!res.ok) continue;
      const payload: any = await res.json();
      // Payload is data written by a session — treated as data, never as instructions.
      const rows: IngestRow[] = Array.isArray(payload) ? payload : Array.isArray(payload?.clients) ? payload.clients : [];
      const r = applyIngest(records, clients, source, rows);
      matched += r.matched.length;
      unmatched.push(...r.unmatched);
      sources.push(source);
    } catch { /* one bad file shouldn't stop the rest */ }
  }
  await store.setJSON(RECORDS, records);
  return { ok: true, sources, matched, unmatched };
}

/**
 * Paige (Merchynt) status per client. Needs each client's Paige slug saved in
 * Client Management — a client without one is reported, never guessed at.
 */
export async function merchyntSyncAll(): Promise<{ ok: boolean; reason?: string; checked?: number; discovered?: string[]; noSlug?: string[]; failed?: string[] }> {
  const key = merchyntKey();
  if (!key) return { ok: false, reason: "MERCHYNT_API_KEY isn't set in Netlify." };
  const store = getStore(STORE);
  const records = ((await store.get(RECORDS, { type: "json" }).catch(() => null)) || {}) as Record<string, any>;
  const app = await readAppData();
  const noSlug: string[] = [], failed: string[] = [], discovered: string[] = [];
  let checked = 0;

  for (const client of app.clients || []) {
    const rec = records[client.id] || {};
    let slug = String(rec.merchyntSlug || "").trim();
    if (!slug) {
      // Work the slug out from the business name and remember it once found,
      // so this costs nothing on later runs.
      try {
        const found = await discoverSlug(client.name || "", key);
        if (found) { slug = found; rec.merchyntSlug = found; records[client.id] = rec; discovered.push(`${client.name} → ${found}`); }
      } catch { /* fall through to noSlug */ }
    }
    if (!slug) { noSlug.push(client.name || client.id); continue; }
    try {
      const summary = await merchyntSummary(slug, key);
      rec.external = rec.external || {};
      rec.external.merchynt = { at: Date.now(), connected: true, status: merchyntStatus(summary), fields: summary };
      rec.tools = { ...(rec.tools || {}), merchynt: true };
      records[client.id] = rec;
      checked++;
    } catch {
      failed.push(client.name || client.id);
    }
  }
  await store.setJSON(RECORDS, records);
  return { ok: true, checked, discovered, noSlug, failed };
}

/**
 * Website work from each client's GitHub repo (via Page Publisher's site
 * record). Read-only: commits are listed, never created.
 */
export async function githubSyncAll(days = 120): Promise<{ ok: boolean; reason?: string; checked?: number; commits?: number; noRepo?: string[]; failed?: string[]; mismatched?: string[] }> {
  const token = githubToken();
  if (!token) return { ok: false, reason: "GITHUB_TOKEN isn't set in Netlify." };
  const store = getStore(STORE);
  const records = ((await store.get(RECORDS, { type: "json" }).catch(() => null)) || {}) as Record<string, any>;
  const app = await readAppData();
  const since = Date.now() - days * 86400000;
  const noRepo: string[] = [], failed: string[] = [], mismatched: string[] = [];
  let checked = 0, commits = 0;

  for (const client of app.clients || []) {
    let site: any = null;
    try { site = await getSiteByClientId(client.id); } catch { /* treated as no repo */ }
    if (!site?.repo) { noRepo.push(client.name || client.id); continue; }
    try {
      const items = await recentCommits(site.repo, site.branch, since, token);
      // Is this repo really this client's site? Compare the site's domain with
      // the website on the client record — a mismatch means work from someone
      // else's site would be reported as this client's.
      const host = (u: string) => String(u || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
      const siteHost = host(site.domain || "");
      const clientHost = host(client.website || "");
      const matches = !siteHost || !clientHost ? null : siteHost === clientHost;
      if (matches === false) mismatched.push(`${client.name}: repo ${site.repo} is for ${siteHost}, client website is ${clientHost}`);
      const rec = records[client.id] || {};
      rec.externalWork = rec.externalWork || {};
      rec.externalWork.github = items;
      rec.external = rec.external || {};
      rec.external.github = {
        at: Date.now(), connected: true,
        status: `${matches === false ? "⚠ WRONG REPO? " : ""}${site.repo} → ${siteHost || "no domain"}${matches === true ? " ✓ matches client website" : matches === false ? ` (client website is ${clientHost})` : ""}${items.length ? ` · ${items.length} changes in ${days}d` : " · no recent changes"}`,
        fields: { repo: site.repo, branch: site.branch || null, siteDomain: siteHost || null, clientWebsite: clientHost || null, matches },
      };
      records[client.id] = rec;
      checked++; commits += items.length;
    } catch {
      failed.push(client.name || client.id);
    }
  }
  await store.setJSON(RECORDS, records);
  return { ok: true, checked, commits, noRepo, failed, mismatched };
}

/**
 * Most recent email with each client, matched on their saved address or their
 * website's domain. A client we can't match is reported, never guessed at.
 */
export async function gmailSyncAll(): Promise<{ ok: boolean; needsGmail?: boolean; reason?: string; checked?: number; found?: number; skipped?: string[]; failed?: string[] }> {
  const granted = await gmailGranted();
  if (!granted.granted) return { ok: false, needsGmail: true, reason: granted.reason || "Gmail access hasn't been granted." };
  let token: string;
  try { token = await getGoogleAccessToken(); }
  catch (e: any) { return { ok: false, needsGmail: true, reason: String(e?.message || e) }; }

  const store = getStore(STORE);
  const records = ((await store.get(RECORDS, { type: "json" }).catch(() => null)) || {}) as Record<string, any>;
  const app = await readAppData();
  const checked: string[] = [], skipped: string[] = [], failed: string[] = [];
  let found = 0;

  for (const client of app.clients || []) {
    const rec = records[client.id] || {};
    const target = rec.email || domainOf(client.website || "");
    if (!target) { skipped.push(client.name || client.id); continue; }
    try {
      const hit = await lastEmailWith(target, token);
      rec.autoEmail = hit ? { at: hit.at, subject: hit.subject, direction: hit.direction, with: hit.with } : null;
      if (hit) found++;
      records[client.id] = rec;
      checked.push(client.name || client.id);
    } catch {
      failed.push(client.name || client.id);
    }
  }
  await store.setJSON(RECORDS, records);
  return { ok: true, checked: checked.length, found, skipped, failed };
}
