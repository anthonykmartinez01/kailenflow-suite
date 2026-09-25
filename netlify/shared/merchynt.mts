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

const API = "https://www.localmarketingmanager.com/api";

export function merchyntKey(): string | null {
  return Netlify.env.get("MERCHYNT_API_KEY") || null;
}

async function get(path: string, key: string): Promise<any> {
  const r = await fetch(`${API}${path}`, { headers: { "x-api-key": key, Accept: "application/json" } });
  if (r.status === 401 || r.status === 403) throw new Error("Merchynt rejected the API key.");
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Merchynt ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
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

/** The status line shown on the client's tile. */
export function merchyntStatus(s: MerchyntSummary): string {
  const bits: string[] = [];
  if (s.reviews != null) bits.push(`${s.reviews} review${s.reviews === 1 ? "" : "s"}${s.rating ? ` · ★ ${s.rating}` : ""}`);
  if (s.latestReviewAt) bits.push(`latest ${new Date(s.latestReviewAt).toISOString().slice(0, 10)}`);
  if (s.auditLeads != null) bits.push(`${s.auditLeads} audit lead${s.auditLeads === 1 ? "" : "s"}`);
  return bits.length ? `Paige: ${bits.join(" · ")}` : "Paige: connected, nothing reported yet";
}
