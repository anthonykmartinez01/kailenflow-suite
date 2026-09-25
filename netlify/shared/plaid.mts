import { getStore } from "@netlify/blobs";

// Plaid — reads bank transactions (Chase) for the Finance tool.
//
// Env: PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV ("sandbox" | "production").
// Sandbox uses fake banks; switch PLAID_ENV + the secret once Production is
// approved. Nothing else changes.
//
// SECURITY
// • The bank login never touches this app: the user signs into Chase inside
//   Plaid's own Link window, and we only ever receive an access token.
// • Access tokens live ONLY in the "finance" Blobs store, server-side. They are
//   never returned to the browser, logged, or committed.
// • READ-ONLY: transactions and account names. Nothing here moves money.

export const FINANCE_STORE = "finance";
const ITEMS = "plaid-items";
const TXNS = "plaid-txns";

export function plaidConfig() {
  const clientId = Netlify.env.get("PLAID_CLIENT_ID");
  const secret = Netlify.env.get("PLAID_SECRET");
  const env = (Netlify.env.get("PLAID_ENV") || "sandbox").toLowerCase();
  const base = env === "production" ? "https://production.plaid.com" : "https://sandbox.plaid.com";
  return { ok: !!(clientId && secret), clientId, secret, env, base };
}

async function plaid(path: string, body: Record<string, any>) {
  const cfg = plaidConfig();
  if (!cfg.ok) throw new Error("Plaid isn't set up — add PLAID_CLIENT_ID, PLAID_SECRET and PLAID_ENV in Netlify.");
  const r = await fetch(cfg.base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: cfg.clientId, secret: cfg.secret, ...body }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Plaid ${j.error_code || r.status}: ${j.error_message || "request failed"}`);
  return j;
}

type Item = { itemId: string; accessToken: string; institution: string | null; cursor: string | null; addedAt: number; lastSyncAt?: number; error?: string | null };

const store = () => getStore(FINANCE_STORE);
const loadItems = async (): Promise<Item[]> => ((await store().get(ITEMS, { type: "json" }).catch(() => null)) || []) as Item[];

/** Public view of connected banks — never includes the access token. */
export async function connectedBanks() {
  return (await loadItems()).map((i) => ({ itemId: i.itemId, institution: i.institution, addedAt: i.addedAt, lastSyncAt: i.lastSyncAt || null, error: i.error || null }));
}

export async function createLinkToken(userId: string) {
  const j = await plaid("/link/token/create", {
    client_name: "KailenFlow",
    user: { client_user_id: userId },
    products: ["transactions"],
    country_codes: ["US"],
    language: "en",
    // Two years of history so the dashboard has real months to average.
    transactions: { days_requested: 730 },
  });
  return j.link_token as string;
}

export async function exchangePublicToken(publicToken: string, institution: string | null) {
  const j = await plaid("/item/public_token/exchange", { public_token: publicToken });
  const items = await loadItems();
  const next = items.filter((i) => i.itemId !== j.item_id);
  next.push({ itemId: j.item_id, accessToken: j.access_token, institution, cursor: null, addedAt: Date.now() });
  await store().setJSON(ITEMS, next);
  return { itemId: j.item_id };
}

export async function removeBank(itemId: string) {
  const items = await loadItems();
  const item = items.find((i) => i.itemId === itemId);
  if (item) { try { await plaid("/item/remove", { access_token: item.accessToken }); } catch { /* forget it locally regardless */ } }
  await store().setJSON(ITEMS, items.filter((i) => i.itemId !== itemId));
  // Drop that bank's transactions too, so its numbers disappear with it.
  const txns = await loadTxns();
  for (const [id, t] of Object.entries(txns)) if ((t as any).itemId === itemId) delete txns[id];
  await store().setJSON(TXNS, txns);
}

export type StoredTxn = {
  id: string; itemId: string; accountId: string; date: string; amount: number;
  name: string; merchant: string | null; category: string | null; detailed: string | null; pending: boolean;
};

export async function loadTxns(): Promise<Record<string, StoredTxn>> {
  return ((await store().get(TXNS, { type: "json" }).catch(() => null)) || {}) as Record<string, StoredTxn>;
}

/**
 * Incremental sync via /transactions/sync. Added and modified transactions are
 * upserted, removed ones deleted, and the cursor saved — so re-running is cheap
 * and never duplicates anything.
 */
export async function syncTransactions() {
  const items = await loadItems();
  const txns = await loadTxns();
  let added = 0, modified = 0, removed = 0;
  const errors: string[] = [];

  for (const item of items) {
    try {
      let cursor = item.cursor || undefined;
      let hasMore = true, pages = 0;
      while (hasMore && pages++ < 50) {
        const j = await plaid("/transactions/sync", { access_token: item.accessToken, cursor, count: 500 });
        for (const t of [...(j.added || []), ...(j.modified || [])]) {
          const isNew = !txns[t.transaction_id];
          txns[t.transaction_id] = {
            id: t.transaction_id,
            itemId: item.itemId,
            accountId: t.account_id,
            date: t.date,
            amount: Number(t.amount),
            name: String(t.name || ""),
            merchant: t.merchant_name || null,
            category: t.personal_finance_category?.primary || null,
            detailed: t.personal_finance_category?.detailed || null,
            pending: !!t.pending,
          };
          isNew ? added++ : modified++;
        }
        for (const r of j.removed || []) { if (txns[r.transaction_id]) { delete txns[r.transaction_id]; removed++; } }
        cursor = j.next_cursor;
        hasMore = !!j.has_more;
      }
      item.cursor = cursor || null;
      item.lastSyncAt = Date.now();
      item.error = null;
    } catch (e: any) {
      item.error = String(e?.message || e).slice(0, 200);
      errors.push(`${item.institution || item.itemId}: ${item.error}`);
    }
  }
  await store().setJSON(TXNS, txns);
  await store().setJSON(ITEMS, items);
  return { added, modified, removed, total: Object.keys(txns).length, errors };
}
