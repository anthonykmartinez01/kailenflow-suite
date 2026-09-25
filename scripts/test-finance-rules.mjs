// Proves the finance rules: only real spending counts as an expense, income
// comes only from Stripe, and business vs personal lands where it should.
// Run: node scripts/test-finance-rules.mjs
import { classify, merchantKey, monthTotals, typicalMonth } from "../netlify/shared/finance-rules.mts";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("PASS ", name); } else { fail++; console.log("FAIL ", name, "\n   got ", g, "\n   want", w); }
};
let n = 0;
const t = (over) => ({ id: `t${++n}`, date: "2026-09-10", amount: 10, name: "", merchant: null, category: "GENERAL_MERCHANDISE", detailed: null, ...over });

// ---- What is NOT an expense ----
eq("transfer between own accounts", classify(t({ name: "Online Transfer to SAV ...4411", category: "TRANSFER_OUT" })).counts, false);
eq("transfer caught by wording alone", classify(t({ name: "ONLINE TRANSFER TO CHK 1234", category: null })).counts, false);
eq("credit card payment", classify(t({ name: "Payment Thank You", category: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" })).counts, false);
eq("chase card autopay", classify(t({ name: "CHASE CREDIT CRD AUTOPAY", category: null })).counts, false);
eq("stripe payout is not income from the bank", classify(t({ amount: -1200, name: "STRIPE TRANSFER", category: "INCOME" })).reason, "Stripe payout — income already counted from Stripe");
eq("any deposit is not an expense", classify(t({ amount: -50, name: "Venmo cashout" })).counts, false);
eq("pending is not counted yet", classify(t({ pending: true, name: "GoHighLevel" })).counts, false);
eq("zero amount ignored", classify(t({ amount: 0, name: "Auth hold" })).counts, false);

// ---- Business vs personal from the Notion list ----
eq("GoHighLevel is business", classify(t({ name: "HIGHLEVEL INC", merchant: "HighLevel" })).kind, "business");
eq("Claude is business", classify(t({ name: "ANTHROPIC CLAUDE.AI SUBSCRIPTION" })).kind, "business");
eq("Elara is business", classify(t({ name: "ELARA DIGITAL" })).kind, "business");
eq("Paige is business", classify(t({ name: "MERCHYNT INC" })).kind, "business");
eq("Netlify is business", classify(t({ merchant: "Netlify" })).kind, "business");
eq("Origami misspelling still matches", classify(t({ name: "ORAGAMI APP" })).kind, "business");
eq("gym is personal", classify(t({ name: "PLANET FITNESS" })).kind, "personal");
eq("minecraft is personal", classify(t({ name: "MINECRAFT REALMS" })).kind, "personal");
eq("unknown merchant is unsorted, not guessed", classify(t({ name: "TACO BELL #1234" })).kind, "unsorted");
eq("unsorted still counts as spending", classify(t({ name: "TACO BELL #1234" })).counts, true);

// ---- Tags win over defaults and stick to the merchant ----
const key = merchantKey({ name: "TACO BELL #1234", merchant: null });
eq("merchant key ignores store numbers", merchantKey({ name: "TACO BELL #9876", merchant: null }), key);
eq("tag applies", classify(t({ name: "TACO BELL #9876" }), { [key]: { kind: "personal", label: "Food" } }).kind, "personal");
eq("tag can override a default", classify(t({ merchant: "Netlify" }), { [merchantKey({ merchant: "Netlify", name: "" })]: { kind: "personal" } }).kind, "personal");

// ---- Month totals ----
const txns = [
  classify(t({ date: "2026-09-02", amount: 316, name: "HIGHLEVEL" })),
  classify(t({ date: "2026-09-05", amount: 25, name: "PLANET FITNESS" })),
  classify(t({ date: "2026-09-06", amount: 40, name: "TACO BELL #12" })),
  classify(t({ date: "2026-09-07", amount: 500, name: "Online Transfer to SAV", category: "TRANSFER_OUT" })),
  classify(t({ date: "2026-09-08", amount: -1200, name: "STRIPE TRANSFER", category: "INCOME" })),
  classify(t({ date: "2026-08-30", amount: 999, name: "HIGHLEVEL" })),
];
const sep = monthTotals("2026-09", txns, 1693, 52.1);
eq("business includes Stripe fees", sep.business, 368.1);
eq("personal", sep.personal, 25);
eq("unsorted kept separate", sep.unsorted, 40);
eq("transfers and payouts excluded from total", sep.totalExpenses, 433.1);
eq("business profit = income − business", sep.businessProfit, 1324.9);
eq("net = income − everything", sep.net, 1259.9);
eq("other months' spending not included", monthTotals("2026-09", txns, 0, 0).business, 316);

// ---- Typical month excludes the unfinished current month ----
const months = [
  monthTotals("2026-06", [], 1500, 0), monthTotals("2026-07", [], 1600, 0),
  monthTotals("2026-08", [], 1700, 0), monthTotals("2026-09", [], 100, 0),
];
eq("typical month averages complete months only", typicalMonth(months, "2026-09").income, 1600);
eq("typical month labels its window", typicalMonth(months, "2026-09").month, "avg of 3 months");
eq("no complete months -> no typical month", typicalMonth([monthTotals("2026-09", [], 1, 0)], "2026-09"), null);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
