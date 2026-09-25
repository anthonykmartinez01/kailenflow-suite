// Stripe reads for Client Management. Uses the SAME restricted, read-only key
// the End of Day report already uses (STRIPE_API_KEY). Read-only by design:
// nothing here creates, changes, or cancels anything in Stripe.
//
// (eod-report keeps its own copy of these helpers on purpose — it is a working
// cron and isn't worth destabilising for de-duplication.)

const API = "https://api.stripe.com/v1/";

export function stripeKey(): string | null {
  return Netlify.env.get("STRIPE_API_KEY") || null;
}

async function get(path: string, key: string) {
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`Stripe ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

async function all(path: string, key: string, cap = 10): Promise<any[]> {
  let out: any[] = [], after = "", pages = 0;
  while (pages++ < cap) {
    const sep = path.includes("?") ? "&" : "?";
    const page = await get(`${path}${sep}limit=100${after ? `&starting_after=${after}` : ""}`, key);
    out = out.concat(page.data || []);
    if (!page.has_more || !page.data?.length) break;
    after = page.data[page.data.length - 1].id;
  }
  return out;
}

/** Monthly value of a subscription in cents, whatever the billing interval. */
export function subMonthlyCents(sub: any): number {
  let cents = 0;
  for (const it of sub.items?.data || []) {
    const p = it.price || {};
    const amt = (p.unit_amount || 0) * (it.quantity || 1);
    const int = p.recurring?.interval, cnt = p.recurring?.interval_count || 1;
    if (int === "year") cents += amt / (12 * cnt);
    else if (int === "week") cents += (amt * 52) / (12 * cnt);
    else if (int === "day") cents += (amt * 365) / (12 * cnt);
    else cents += amt / cnt;
  }
  return cents;
}

export type StripeCustomer = {
  id: string; name: string | null; email: string | null; created: number;
  status: "active" | "trialing" | "past_due" | "unpaid" | "canceled" | null;
  mrr: number | null;            // dollars per month
  plan: string | null;
  currentPeriodEnd: number | null;
  lastPaymentAt: number | null;
  lastPaymentAmount: number | null;
};

/**
 * Every customer with a subscription, plus their latest payment. One pass over
 * subscriptions (expanded to customers) and one over recent charges.
 */
export async function stripeCustomers(key: string): Promise<StripeCustomer[]> {
  const subs = await all("subscriptions?status=all&expand[]=data.customer", key);
  const charges = await all("charges", key, 5);

  const lastPay = new Map<string, { at: number; amount: number }>();
  for (const c of charges) {
    if (c.status !== "succeeded" || c.refunded) continue;
    const cid = typeof c.customer === "string" ? c.customer : c.customer?.id;
    if (!cid) continue;
    const at = (c.created || 0) * 1000;
    const prev = lastPay.get(cid);
    if (!prev || at > prev.at) lastPay.set(cid, { at, amount: ((c.amount || 0) - (c.amount_refunded || 0)) / 100 });
  }

  // Newest subscription per customer wins, so a re-subscribe reads as active.
  const byCustomer = new Map<string, any>();
  for (const s of subs) {
    const cust = s.customer;
    const cid = typeof cust === "string" ? cust : cust?.id;
    if (!cid) continue;
    const prev = byCustomer.get(cid);
    if (!prev || (s.created || 0) > (prev.created || 0)) byCustomer.set(cid, s);
  }

  const out: StripeCustomer[] = [];
  for (const [cid, s] of byCustomer) {
    const cust = typeof s.customer === "object" ? s.customer : null;
    const pay = lastPay.get(cid) || null;
    const status = ["active", "trialing", "past_due", "unpaid", "canceled"].includes(s.status) ? s.status : null;
    out.push({
      id: cid,
      name: cust?.name || cust?.description || null,
      email: cust?.email || null,
      created: (cust?.created || s.created || 0) * 1000,
      status,
      mrr: Math.round(subMonthlyCents(s)) / 100,
      plan: s.items?.data?.[0]?.price?.nickname || s.items?.data?.[0]?.price?.product || null,
      currentPeriodEnd: s.current_period_end ? s.current_period_end * 1000 : null,
      lastPaymentAt: pay?.at ?? null,
      lastPaymentAmount: pay?.amount ?? null,
    });
  }
  out.sort((a, b) => (b.mrr || 0) - (a.mrr || 0));
  return out;
}

/** Loose match used to SUGGEST a link — never applied without approval. */
export function suggestMatch(cust: StripeCustomer, clients: { id: string; name?: string; email?: string }[]): string | null {
  const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const email = String(cust.email || "").toLowerCase();
  if (email) {
    const byEmail = clients.find((c) => String(c.email || "").toLowerCase() === email);
    if (byEmail) return byEmail.id;
  }
  const cn = norm(cust.name || "");
  if (!cn) return null;
  const exact = clients.find((c) => norm(c.name || "") === cn);
  if (exact) return exact.id;
  const partial = clients.filter((c) => { const n = norm(c.name || ""); return n.length > 4 && (n.includes(cn) || cn.includes(n)); });
  return partial.length === 1 ? partial[0].id : null;
}
