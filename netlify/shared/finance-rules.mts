// Finance rules — what counts as income, what counts as an expense, and
// whether an expense is business or personal. Pure (no I/O) so
// scripts/test-finance-rules.mjs can prove every classification.
//
// SOURCES OF TRUTH (decided with Anthony):
//   • Income   = Stripe. Money in is never taken from the bank, so a Stripe
//                payout landing in Chase can't be counted twice.
//   • Expenses = the bank (Chase via Plaid). Notion is reference only — it
//                teaches us which merchants are business vs personal.
//
// What is NOT an expense, even though money leaves an account:
//   • transfers between his own accounts
//   • credit-card payments (the purchases on the card already count)
//   • money coming IN (deposits, refunds are handled separately)
//
// Plaid sign convention: amount > 0 = money OUT of the account,
// amount < 0 = money IN.

export type Txn = {
  id: string;
  date: string;                 // YYYY-MM-DD
  amount: number;               // Plaid convention: + out, - in
  name: string;                 // raw description
  merchant?: string | null;     // Plaid merchant_name
  category?: string | null;     // Plaid personal_finance_category.primary
  detailed?: string | null;     // Plaid personal_finance_category.detailed
  accountId?: string;
  pending?: boolean;
};

export type Kind = "business" | "personal" | "unsorted";
export type Classified = Txn & { counts: boolean; kind: Kind | null; reason: string; label: string };

// Categories Plaid uses for money that moves but isn't spending.
const NOT_SPENDING_PRIMARY = new Set(["TRANSFER_IN", "TRANSFER_OUT", "INCOME"]);
const NOT_SPENDING_DETAILED = /LOAN_PAYMENTS_CREDIT_CARD_PAYMENT|TRANSFER_(IN|OUT)_ACCOUNT_TRANSFER|TRANSFER_OUT_SAVINGS|TRANSFER_IN_SAVINGS/i;
const TRANSFER_WORDS = /\b(online transfer|transfer (to|from)|xfer|zelle to (self|me)|payment thank you|autopay|credit card payment|card payment|epay|chase card|ach pmt.*chase)\b/i;
// Stripe payouts land in the bank as deposits; income is already counted from Stripe.
const STRIPE_PAYOUT = /\bstripe\b/i;

// Seeded from his Notion "Expenses" lists (merchant keywords only — never
// amounts). Business = tools that run the agency; personal = everything he'd
// pay for anyway. Anything unmatched is "unsorted" and he tags it once.
export const DEFAULT_RULES: { match: RegExp; kind: Kind; label: string }[] = [
  { match: /gohighlevel|highlevel|\bghl\b|leadconnector/i, kind: "business", label: "GoHighLevel" },
  { match: /\belara\b/i, kind: "business", label: "Elara" },
  { match: /anthropic|claude/i, kind: "business", label: "Claude" },
  { match: /netlify/i, kind: "business", label: "Netlify" },
  { match: /merchynt|localmarketingmanager|\bpaige\b/i, kind: "business", label: "Paige (Merchynt)" },
  { match: /calendly/i, kind: "business", label: "Calendly" },
  { match: /lovable/i, kind: "business", label: "Lovable" },
  { match: /heysegment|segment\.io|\bsegment\b/i, kind: "business", label: "HeySegment" },
  { match: /multilogin/i, kind: "business", label: "Multilogin" },
  { match: /\bnifty\b/i, kind: "business", label: "Nifty" },
  { match: /seo ?utils/i, kind: "business", label: "SEO Utils" },
  { match: /openai|chatgpt/i, kind: "business", label: "ChatGPT" },
  { match: /crm ?connector/i, kind: "business", label: "CRM Connector" },
  { match: /or[ia]gami/i, kind: "business", label: "Origami" },
  { match: /dataforseo|data for seo/i, kind: "business", label: "DataForSEO" },
  { match: /chamber of commerce|prosper chamber/i, kind: "business", label: "Chamber of Commerce" },
  { match: /ai mastery/i, kind: "business", label: "AI Mastery Pro" },
  { match: /google.*(workspace|gsuite)|google \*gsuite/i, kind: "business", label: "Google Workspace" },
  { match: /\bgym\b|fitness|planet fitness|la fitness|24 hour fitness|anytime fitness/i, kind: "personal", label: "Gym" },
  { match: /minecraft|apex hosting|shockbyte/i, kind: "personal", label: "Minecraft server" },
];

export type Override = { kind: Kind; label?: string };

/** Stable key for a merchant, so a tag applies to every future charge from it. */
export function merchantKey(t: Pick<Txn, "merchant" | "name">): string {
  const raw = String(t.merchant || t.name || "").toLowerCase();
  return raw
    .replace(/\d{3,}/g, " ")            // strip reference numbers / card digits
    .replace(/\b(pos|debit|purchase|recurring|card|ach|web|ppd|id|pmt|payment|online)\b/g, " ")
    .replace(/[^a-z]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(" ");
}

export function classify(t: Txn, overrides: Record<string, Override> = {}): Classified {
  const text = `${t.merchant || ""} ${t.name || ""}`;
  const out = (counts: boolean, kind: Kind | null, reason: string, label = t.merchant || t.name): Classified =>
    ({ ...t, counts, kind, reason, label });

  if (t.pending) return out(false, null, "pending — counted once it posts");
  if (!Number.isFinite(t.amount) || t.amount === 0) return out(false, null, "zero amount");

  // Money in: income comes from Stripe, so bank deposits never count as income.
  if (t.amount < 0) {
    return out(false, null, STRIPE_PAYOUT.test(text) ? "Stripe payout — income already counted from Stripe" : "money in — not an expense");
  }

  if (NOT_SPENDING_PRIMARY.has(String(t.category || "")) || NOT_SPENDING_DETAILED.test(String(t.detailed || "")) || TRANSFER_WORDS.test(text)) {
    return out(false, null, "transfer or card payment between your own accounts");
  }

  const key = merchantKey(t);
  const o = overrides[key];
  if (o) return out(true, o.kind, "your tag", o.label || t.merchant || t.name);

  for (const r of DEFAULT_RULES) if (r.match.test(text)) return out(true, r.kind, "matched your Notion list", r.label);

  return out(true, "unsorted", "not tagged yet");
}

export type MonthTotals = {
  month: string;
  income: number;
  stripeFees: number;
  business: number;        // includes Stripe fees — a real cost of doing business
  personal: number;
  unsorted: number;
  totalExpenses: number;
  businessProfit: number;  // income − business expenses
  net: number;             // income − everything (what's actually left)
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * One month's numbers. `income` and `stripeFees` come from Stripe; expenses
 * come from the classified bank transactions dated in that month.
 */
export function monthTotals(month: string, classified: Classified[], income: number, stripeFees: number): MonthTotals {
  let business = 0, personal = 0, unsorted = 0;
  for (const t of classified) {
    if (!t.counts || !t.date.startsWith(month)) continue;
    if (t.kind === "business") business += t.amount;
    else if (t.kind === "personal") personal += t.amount;
    else unsorted += t.amount;
  }
  business += stripeFees;
  const totalExpenses = business + personal + unsorted;
  return {
    month,
    income: r2(income),
    stripeFees: r2(stripeFees),
    business: r2(business),
    personal: r2(personal),
    unsorted: r2(unsorted),
    totalExpenses: r2(totalExpenses),
    businessProfit: r2(income - business),
    net: r2(income - totalExpenses),
  };
}

/**
 * A "typical month": the average of the last N COMPLETE months. The current,
 * unfinished month is excluded — half a month of spending would make the
 * average look better than reality.
 */
export function typicalMonth(months: MonthTotals[], currentMonth: string, n = 3): MonthTotals | null {
  const done = months.filter((m) => m.month < currentMonth).sort((a, b) => b.month.localeCompare(a.month)).slice(0, n);
  if (!done.length) return null;
  const avg = (k: keyof MonthTotals) => r2(done.reduce((s, m) => s + (m[k] as number), 0) / done.length);
  return {
    month: `avg of ${done.length} month${done.length === 1 ? "" : "s"}`,
    income: avg("income"), stripeFees: avg("stripeFees"), business: avg("business"),
    personal: avg("personal"), unsorted: avg("unsorted"), totalExpenses: avg("totalExpenses"),
    businessProfit: avg("businessProfit"), net: avg("net"),
  };
}
