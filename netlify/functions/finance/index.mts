import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { isAuthed, isOwner, unauthorized, forbidden } from "../../shared/auth.mts";
import { stripeKey, stripeMonthlyIncome } from "../../shared/stripe.mts";
import { plaidConfig, connectedBanks, createLinkToken, exchangePublicToken, removeBank, syncTransactions, loadTxns, FINANCE_STORE } from "../../shared/plaid.mts";
import { classify, merchantKey, monthTotals, typicalMonth, type Override, type Kind } from "../../shared/finance-rules.mts";
import { TZ, todayIn, keyStr } from "../../shared/gbp-portfolio-window.mts";

// FINANCE — income (Stripe), expenses (bank via Plaid), business vs personal,
// profit, per month and as a typical month.
//
// POST /api/finance
//   {action:"summary", month?}                -> everything the dashboard shows
//   {action:"link-token"}                     -> token for Plaid Link (connect a bank)
//   {action:"exchange", publicToken, institution}
//   {action:"remove-bank", itemId}
//   {action:"sync"}                           -> pull new bank transactions now
//   {action:"tag", key, kind, label?}         -> business / personal for a merchant
//
// Personal financial data: stays in its own Blobs store, behind app login,
// never in appData, never in git.

const OVERRIDES = "overrides";
const STRIPE_CACHE = "stripe-income";
const STRIPE_TTL_MS = 60 * 60 * 1000;
const HISTORY_MONTHS = 13;

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

const monthsBack = (fromMonth: string, n: number) => {
  const [y, m] = fromMonth.split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
};

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  // Personal financial data: signed in is not enough, it must be the owner.
  if (!(await isOwner(req))) return forbidden();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* empty is fine */ }
  const action = String(body.action || "summary");
  const store = getStore(FINANCE_STORE);

  try {
    if (action === "link-token") return json({ linkToken: await createLinkToken("kailenflow-owner") });

    if (action === "exchange") {
      if (!body.publicToken) return json({ error: "publicToken is required" }, 400);
      const r = await exchangePublicToken(String(body.publicToken), body.institution ? String(body.institution).slice(0, 80) : null);
      const s = await syncTransactions();
      return json({ ok: true, ...r, sync: s });
    }

    if (action === "remove-bank") {
      if (!body.itemId) return json({ error: "itemId is required" }, 400);
      await removeBank(String(body.itemId));
      return json({ ok: true });
    }

    if (action === "sync") return json({ ok: true, ...(await syncTransactions()) });

    if (action === "tag") {
      const key = String(body.key || "").trim();
      const kind = String(body.kind || "") as Kind;
      if (!key || !["business", "personal", "unsorted"].includes(kind)) return json({ error: "key and a valid kind are required" }, 400);
      const overrides = ((await store.get(OVERRIDES, { type: "json" }).catch(() => null)) || {}) as Record<string, Override>;
      if (kind === "unsorted") delete overrides[key];
      else overrides[key] = { kind, ...(body.label ? { label: String(body.label).slice(0, 60) } : {}) };
      await store.setJSON(OVERRIDES, overrides);
      return json({ ok: true });
    }

    if (action !== "summary") return json({ error: `Unknown action "${action}"` }, 400);

    // ---------------- summary ----------------
    const today = keyStr(todayIn(TZ));
    const currentMonth = today.slice(0, 7);
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(body.month || "")) ? String(body.month) : currentMonth;
    const months = monthsBack(currentMonth, HISTORY_MONTHS);

    // Income from Stripe (cached an hour).
    let stripe: { months: Record<string, { income: number; fees: number | null }>; feesAvailable: boolean } | null = null;
    let stripeError: string | null = null;
    const sk = stripeKey();
    if (!sk) stripeError = "STRIPE_API_KEY isn't set.";
    else {
      const cached = (await store.get(STRIPE_CACHE, { type: "json" }).catch(() => null)) as any;
      if (!body.fresh && cached?.at && Date.now() - cached.at < STRIPE_TTL_MS) stripe = cached.data;
      else {
        try {
          const oldest = months[months.length - 1];
          const since = Date.UTC(Number(oldest.slice(0, 4)), Number(oldest.slice(5, 7)) - 1, 1);
          stripe = await stripeMonthlyIncome(sk, since);
          await store.setJSON(STRIPE_CACHE, { at: Date.now(), data: stripe }).catch(() => null);
        } catch (e: any) {
          stripeError = String(e?.message || e);
          if (cached?.data) stripe = cached.data;
        }
      }
    }

    // Expenses from the bank.
    const overrides = ((await store.get(OVERRIDES, { type: "json" }).catch(() => null)) || {}) as Record<string, Override>;
    const raw = Object.values(await loadTxns());
    const classified = raw.map((t) => classify(t, overrides));

    const perMonth = months.map((m) =>
      monthTotals(m, classified, stripe?.months[m]?.income || 0, stripe?.months[m]?.fees || 0));
    const selected = perMonth.find((m) => m.month === month) || monthTotals(month, classified, 0, 0);
    const typical = typicalMonth(perMonth, currentMonth, 3);

    // Where the money went this month, biggest first.
    const inMonth = classified.filter((t) => t.counts && t.date.startsWith(month));
    const groups: Record<string, { label: string; kind: string; total: number; count: number; key: string }> = {};
    for (const t of inMonth) {
      const k = `${t.kind}|${t.label}`;
      const g = (groups[k] ||= { label: t.label, kind: t.kind || "unsorted", total: 0, count: 0, key: merchantKey(t) });
      g.total += t.amount; g.count++;
    }
    const breakdown = Object.values(groups)
      .map((g) => ({ ...g, total: Math.round(g.total * 100) / 100 }))
      .sort((a, b) => b.total - a.total);

    // Things to tag: unsorted merchants across the whole history, biggest first.
    const unsortedAgg: Record<string, { key: string; label: string; total: number; count: number; lastDate: string }> = {};
    for (const t of classified) {
      if (!t.counts || t.kind !== "unsorted") continue;
      const key = merchantKey(t);
      const u = (unsortedAgg[key] ||= { key, label: t.label, total: 0, count: 0, lastDate: t.date });
      u.total += t.amount; u.count++; if (t.date > u.lastDate) u.lastDate = t.date;
    }
    const toTag = Object.values(unsortedAgg).map((u) => ({ ...u, total: Math.round(u.total * 100) / 100 }))
      .sort((a, b) => b.total - a.total).slice(0, 40);

    const excludedThisMonth = classified.filter((t) => !t.counts && t.date.startsWith(month) && t.amount > 0);

    return json({
      month, currentMonth, isCurrentMonth: month === currentMonth,
      selected, typical, history: perMonth.slice().reverse(),
      breakdown, toTag,
      excluded: { count: excludedThisMonth.length, total: Math.round(excludedThisMonth.reduce((s, t) => s + t.amount, 0) * 100) / 100 },
      banks: await connectedBanks(),
      plaid: { configured: plaidConfig().ok, env: plaidConfig().env },
      stripe: { ok: !!stripe, error: stripeError, feesAvailable: stripe?.feesAvailable ?? null },
      transactions: raw.length,
    });
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, 500);
  }
};

export const config: Config = { path: "/api/finance" };
