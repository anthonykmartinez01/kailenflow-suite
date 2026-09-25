// Proves the Client Management flags: quiet clients, light months, overdue
// check-ins, unfinished setup, past due, and the neglect ranking.
// Run: node scripts/test-client-health.mjs
import { assess, rank, draftUpdate, DEFAULTS } from "../netlify/shared/client-health.mts";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("PASS ", name); } else { fail++; console.log("FAIL ", name, "\n   got ", g, "\n   want", w); }
};

const NOW = Date.parse("2026-09-24T12:00:00Z");
const MONTH = "2026-09";
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const tools = (connected) => [{ key: "ghl", label: "GoHighLevel", connected }, { key: "gbp", label: "Google Business Profile", connected: true }];
const base = (over = {}) => ({
  id: "c1", name: "Anytime Heating & Air", work: [], touches: [], tools: tools(true), openTasks: 0,
  stripeCustomerId: "cus_1", subscriptionStatus: "active", mrr: 500, ...over,
});
const keys = (r) => r.flags.map((f) => f.key);

// A healthy client raises nothing.
const healthy = base({
  work: [{ at: daysAgo(1), kind: "page", text: "Published a page" }, { at: daysAgo(3), kind: "gbp", text: "GBP post" },
         { at: daysAgo(6), kind: "page", text: "Published a page" }, { at: daysAgo(9), kind: "index", text: "Submitted for indexing" }],
  touches: [{ at: daysAgo(5), channel: "email" }],
});
eq("healthy client has no flags", keys(assess(healthy, NOW, MONTH)), []);
eq("healthy client is Active", assess(healthy, NOW, MONTH).status, "Active");

// Quiet: no work in 14+ days.
const quiet = base({ work: [{ at: daysAgo(20), kind: "page", text: "Published a page" }], touches: [{ at: daysAgo(2), channel: "email" }] });
eq("quiet flag raised", keys(assess(quiet, NOW, MONTH)).includes("quiet"), true);
eq("quiet says how long", assess(quiet, NOW, MONTH).flags.find((f) => f.key === "quiet").detail, "No work in 20 days.");
eq("13 days is not yet quiet", keys(assess(base({ work: [{ at: daysAgo(13), kind: "p", text: "x" }], touches: [{ at: daysAgo(1), channel: "email" }] }), NOW, MONTH)).includes("quiet"), false);

// Light month: fewer than the target this month.
eq("light month raised", keys(assess(quiet, NOW, MONTH)).includes("light-month"), true);
eq("default target is 4", DEFAULTS.workPerMonth, 4);
eq("custom target respected", keys(assess(base({
  work: [{ at: daysAgo(1), kind: "p", text: "x" }, { at: daysAgo(2), kind: "p", text: "x" }],
  touches: [{ at: daysAgo(1), channel: "email" }], targets: { workPerMonth: 2 },
}), NOW, MONTH)), []);

// Last month's work doesn't count toward this month.
eq("previous month excluded", assess(base({ work: [{ at: "2026-08-30T10:00:00Z", kind: "p", text: "x" }], touches: [{ at: daysAgo(1), channel: "email" }] }), NOW, MONTH).workThisMonth, 0);

// Outreach.
eq("overdue check-in raised", keys(assess(base({ work: [{ at: daysAgo(1), kind: "p", text: "x" }, { at: daysAgo(2), kind: "p", text: "x" }, { at: daysAgo(3), kind: "p", text: "x" }, { at: daysAgo(4), kind: "p", text: "x" }], touches: [{ at: daysAgo(45), channel: "email" }] }), NOW, MONTH)), ["overdue-checkin"]);
eq("never contacted raised", keys(assess(base({ work: [{ at: daysAgo(1), kind: "p", text: "x" }, { at: daysAgo(2), kind: "p", text: "x" }, { at: daysAgo(3), kind: "p", text: "x" }, { at: daysAgo(4), kind: "p", text: "x" }] }), NOW, MONTH)), ["never-contacted"]);

// Paying but not set up — the "unresolved client" case.
const unresolved = assess(base({ tools: tools(false), work: [{ at: daysAgo(1), kind: "p", text: "x" }], touches: [{ at: daysAgo(1), channel: "email" }] }), NOW, MONTH);
eq("needs setup status", unresolved.status, "Needs setup");
eq("needs setup names the gap", unresolved.flags[0].detail, "Paying, but not connected to GoHighLevel.");

// Payment problems and churn.
eq("past due status", assess(base({ subscriptionStatus: "past_due" }), NOW, MONTH).status, "Past due");
const churned = assess(base({ subscriptionStatus: "canceled", work: [{ at: daysAgo(90), kind: "p", text: "x" }] }), NOW, MONTH);
eq("churned is not nagged", [churned.status, churned.flags.length, churned.attention], ["Churned", 0, 0]);
const paused = assess(base({ targets: { paused: true }, work: [{ at: daysAgo(60), kind: "p", text: "x" }] }), NOW, MONTH);
eq("paused is not nagged", [paused.status, paused.flags.length], ["Paused", 0]);
eq("unlinked client", assess(base({ stripeCustomerId: null, subscriptionStatus: null, work: [{ at: daysAgo(1), kind: "p", text: "x" }], touches: [{ at: daysAgo(1), channel: "email" }], targets: { workPerMonth: 1 } }), NOW, MONTH).status, "Not linked");

// Ranking: worst first; bigger accounts break ties upward.
const rows = [
  assess(base({ id: "ok", name: "Fine Co", work: [{ at: daysAgo(1), kind: "p", text: "x" }, { at: daysAgo(2), kind: "p", text: "x" }, { at: daysAgo(3), kind: "p", text: "x" }, { at: daysAgo(4), kind: "p", text: "x" }], touches: [{ at: daysAgo(2), channel: "email" }] }), NOW, MONTH),
  assess(base({ id: "neglected", name: "Neglected Co", work: [{ at: daysAgo(40), kind: "p", text: "x" }], touches: [{ at: daysAgo(60), channel: "email" }] }), NOW, MONTH),
  assess(base({ id: "small", name: "Small Co", mrr: 100, work: [{ at: daysAgo(40), kind: "p", text: "x" }], touches: [{ at: daysAgo(60), channel: "email" }] }), NOW, MONTH),
];
eq("worst first", rank(rows).map((r) => r.id), ["neglected", "small", "ok"]);
eq("healthy scores zero", rank(rows)[2].attention, 0);

// Traffic light.
eq("healthy is green", assess(healthy, NOW, MONTH).health, "green");
eq("quiet client is yellow", assess(quiet, NOW, MONTH).health, "yellow");
eq("past due is red", assess(base({ subscriptionStatus: "past_due" }), NOW, MONTH).health, "red");
eq("never had work is red", assess(base({ touches: [{ at: daysAgo(1), channel: "email" }] }), NOW, MONTH).health, "red");
eq("badly neglected is red", assess(base({ work: [{ at: daysAgo(70), kind: "p", text: "x" }], touches: [{ at: daysAgo(90), channel: "email" }] }), NOW, MONTH).health, "red");
eq("churned is grey", assess(base({ subscriptionStatus: "canceled" }), NOW, MONTH).health, "grey");
eq("paused is grey", assess(base({ targets: { paused: true } }), NOW, MONTH).health, "grey");

// Draft update uses only real logged work.
const d = draftUpdate("Anthony Martinez", [{ at: daysAgo(3), kind: "p", text: "Published: AC Repair in Prosper" }, { at: daysAgo(40), kind: "p", text: "Too old" }], NOW - 30 * 86400000, NOW);
eq("draft greets by first name", d.startsWith("Hi Anthony,"), true);
eq("draft includes recent work", d.includes("• Published: AC Repair in Prosper"), true);
eq("draft excludes older work", d.includes("Too old"), false);
eq("no work -> check-in note", draftUpdate("Sam Jones", [], NOW - 30 * 86400000, NOW).includes("Quick check-in"), true);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
