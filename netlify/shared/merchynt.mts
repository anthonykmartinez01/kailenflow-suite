// Merchynt (Paige) reads for Client Management.
//
// API: https://www.localmarketingmanager.com/api, header `x-api-key`.
//   GET /reviews?slug=<client-slug>          — that client's Google reviews
//   GET /gbp-audit-leads?slug=<client-slug>  — leads from the white-label audit tool
//
// READ-ONLY: only GETs. Nothing here enrolls anyone in a campaign, sends a
// message, or changes a listing — Paige can do all of those, and this must not.
//
// Each client needs its Paige slug stored once (Client Management → details).
// Without it we can't ask Paige about that client, and we say so rather than
// guessing a slug from the business name.

// The help centre documents www.localmarketingmanager.com/api, but that host
// serves the marketing site and answers with an HTML 404 page for every API
// path (confirmed 2026-09-24). The app host answers the API, so both are tried
// and the one that actually returns JSON is remembered for the rest of the run.
const BASES = [
  "https://app.localmarketingmanager.com/api",
  "https://www.localmarketingmanager.com/api",
];
export const API = BASES[0];
let workingBase: string | null = null;

export function merchyntKey(): string | null {
  return Netlify.env.get("MERCHYNT_API_KEY") || null;
}

/** An HTML body means we hit a web page, not the API — never treat it as data. */
function looksLikeHtml(body: string): boolean {
  return /^\s*<(?:!doctype|html)/i.test(body);
}

async function fetchApi(base: string, path: string, key: string): Promise<{ status: number; body: string }> {
  const r = await fetch(`${base}${path}`, { headers: { "x-api-key": key, Accept: "application/json" } });
  return { status: r.status, body: (await r.text()).slice(0, 4000) };
}

async function get(path: string, key: string): Promise<any> {
  const bases = workingBase ? [workingBase] : BASES;
  let sawJson404 = false;
  for (const base of bases) {
    const { status, body } = await fetchApi(base, path, key);
    if (status === 401 || status === 403) throw new Error("Merchynt rejected the API key.");
    if (looksLikeHtml(body)) continue;              // wrong host — try the next
    if (status === 404) { sawJson404 = true; workingBase = base; continue; } // right host, unknown slug
    if (status >= 400) throw new Error(`Merchynt ${status}: ${body.slice(0, 160)}`);
    workingBase = base;
    try { return JSON.parse(body); } catch { throw new Error(`Merchynt returned a non-JSON body: ${body.slice(0, 120)}`); }
  }
  if (sawJson404) return null;
  throw new Error("No Merchynt API host answered — check the base URL.");
}

/**
 * Slug candidates for a business name, best first. Paige slugs look like
 * "higher-power-electric": lowercase, hyphenated, punctuation dropped.
 * "&" becomes "and" in some accounts and disappears in others, so both are
 * tried, as are versions without a trailing LLC / Inc / Co.
 */
export function slugCandidates(name: string): string[] {
  const base = String(name || "").trim().toLowerCase();
  if (!base) return [];
  // Apostrophes vanish rather than becoming a separator: "Brandon's" is
  // "brandons", not "brandon-s". The split form is tried too, further down.
  const clean = (s: string) => s.replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  const cleanSplit = (s: string) => s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  const noSuffix = base.replace(/\b(llc|l\.l\.c\.?|inc\.?|co\.?|corp\.?|ltd\.?)\b/g, " ").trim();
  const out = [
    clean(base.replace(/&/g, "and")),
    clean(base.replace(/&/g, " ")),
    clean(noSuffix.replace(/&/g, "and")),
    clean(noSuffix.replace(/&/g, " ")),
    clean(base.split(/\s+(?:heating|air|electric|plumbing|roofing|cleaning)\b/)[0]),
    cleanSplit(base.replace(/&/g, "and")),
  ].filter(Boolean);
  return [...new Set(out)];
}

/**
 * The slug Paige actually answers for, or null. A candidate only counts if the
 * API returns a real response for it — never a guess that merely looks right,
 * because a wrong slug would hang another client's reviews on this tile.
 */
export async function discoverSlug(name: string, key: string): Promise<string | null> {
  for (const candidate of slugCandidates(name)) {
    try {
      const data = await get(`/reviews?slug=${encodeURIComponent(candidate)}`, key);
      if (data === null) continue;                    // 404 — not this one
      const arr = asArray(data);
      const looksReal = arr.length > 0 || typeof (data as any)?.total === "number";
      if (looksReal) return candidate;
    } catch { /* 401 etc. — stop guessing, the caller reports it */ }
  }
  return null;
}

export type MerchyntSummary = {
  reviews: number | null;
  rating: number | null;
  latestReviewAt: string | null;
  latestReviewText: string | null;
  auditLeads: number | null;
};

const asArray = (d: any): any[] =>
  Array.isArray(d) ? d : Array.isArray(d?.reviews) ? d.reviews : Array.isArray(d?.data) ? d.data : Array.isArray(d?.leads) ? d.leads : [];

/** One client's Paige snapshot. Shapes vary, so every field is best-effort. */
export async function merchyntSummary(slug: string, key: string): Promise<MerchyntSummary> {
  const out: MerchyntSummary = { reviews: null, rating: null, latestReviewAt: null, latestReviewText: null, auditLeads: null };

  const reviewsRaw = await get(`/reviews?slug=${encodeURIComponent(slug)}`, key);
  const reviews = asArray(reviewsRaw);
  if (reviewsRaw) {
    out.reviews = typeof reviewsRaw?.total === "number" ? reviewsRaw.total : reviews.length;
    const ratings = reviews.map((r: any) => Number(r?.rating ?? r?.starRating)).filter((n: number) => Number.isFinite(n) && n > 0);
    if (ratings.length) out.rating = Math.round((ratings.reduce((a: number, b: number) => a + b, 0) / ratings.length) * 10) / 10;
    const dated = reviews
      .map((r: any) => ({ at: Date.parse(r?.createTime || r?.publishedAt || r?.date || r?.createdAt || ""), text: String(r?.comment || r?.text || "").slice(0, 200) }))
      .filter((r) => Number.isFinite(r.at))
      .sort((a, b) => b.at - a.at);
    if (dated.length) { out.latestReviewAt = new Date(dated[0].at).toISOString(); out.latestReviewText = dated[0].text || null; }
  }

  // Audit leads are a bonus; a failure here must not lose the review data.
  try {
    const leadsRaw = await get(`/gbp-audit-leads?slug=${encodeURIComponent(slug)}&limit=100`, key);
    if (leadsRaw) out.auditLeads = typeof leadsRaw?.total === "number" ? leadsRaw.total : asArray(leadsRaw).length;
  } catch { /* leave null */ }

  return out;
}

/**
 * What Paige actually says for each candidate — status code and response
 * shape, no key, no guessing. Used by the Diagnose button when discovery
 * finds nothing, so the reason is visible instead of assumed.
 */
export async function probeSlugs(name: string, key: string, extra: string[] = []): Promise<{ candidate: string; status: number | "error"; shape: string }[]> {
  const out: { candidate: string; status: number | "error"; shape: string }[] = [];
  for (const candidate of [...new Set([...extra.filter(Boolean), ...slugCandidates(name)])].slice(0, 6)) {
    for (const base of BASES) {
      const host = new URL(base).host.split(".")[0];
      try {
        const { status, body } = await fetchApi(base, `/reviews?slug=${encodeURIComponent(candidate)}`, key);
        let shape = body ? body.slice(0, 120) : "(empty body)";
        if (looksLikeHtml(body)) shape = "HTML page (not the API)";
        else {
          try {
            const parsed = JSON.parse(body);
            shape = Array.isArray(parsed) ? `array(${parsed.length})` : `object{${Object.keys(parsed).slice(0, 8).join(",")}}`;
          } catch { /* keep the raw snippet */ }
        }
        out.push({ candidate: `${host}:${candidate}`, status, shape });
      } catch (e: any) {
        out.push({ candidate: `${host}:${candidate}`, status: "error", shape: String(e?.message || e).slice(0, 120) });
      }
    }
  }
  return out;
}

/** The status line shown on the client's tile. */
export function merchyntStatus(s: MerchyntSummary): string {
  const bits: string[] = [];
  if (s.reviews != null) bits.push(`${s.reviews} review${s.reviews === 1 ? "" : "s"}${s.rating ? ` · ★ ${s.rating}` : ""}`);
  if (s.latestReviewAt) bits.push(`latest ${new Date(s.latestReviewAt).toISOString().slice(0, 10)}`);
  if (s.auditLeads != null) bits.push(`${s.auditLeads} audit lead${s.auditLeads === 1 ? "" : "s"}`);
  return bits.length ? `Paige: ${bits.join(" · ")}` : "Paige: connected, nothing reported yet";
}
