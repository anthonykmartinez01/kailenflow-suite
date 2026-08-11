// Staged indexing pacing tests (task #56). Runs against the real .mts module,
// transpiled by tsc. `npm run test:index-queue`
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const ts = (await import("typescript")).default;
const dir = mkdtempSync(join(tmpdir(), "iq-"));
const p = join(dir, "iq.mjs");
writeFileSync(p, ts.transpileModule(readFileSync(join(REPO, "netlify/shared/index-queue.mts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText);
const q = await import("file://" + p.replace(/\\/g, "/"));

let pass = 0, fail = 0;
const t = (name, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got ${JSON.stringify(a)} want ${JSON.stringify(e)}`}`);
};

const NOW = Date.parse("2026-08-10T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString();
const pages = (n, prefix = "p", startDay = 1) =>
  Array.from({ length: n }, (_, i) => ({ path: `/${prefix}${i}`, date: `2026-08-${String(startDay + i).padStart(2, "0")}` }));

console.log("=== TRAILING 24h COUNT ===");
t("no history is zero", q.submissionsInLast24h(undefined, NOW), 0);
t("counts only the last 24h", q.submissionsInLast24h({
  a: { submittedAt: hoursAgo(2) },
  b: { submittedAt: hoursAgo(23) },
  c: { submittedAt: hoursAgo(25) },   // outside the window
  d: { submittedAt: hoursAgo(400) },
}, NOW), 2);
t("records with no submittedAt don't count (queued, never sent)",
  q.submissionsInLast24h({ a: { queued: true }, b: { submittedAt: hoursAgo(1) } }, NOW), 1);

console.log("\n=== ALLOWANCE ===");
t("default when unset", q.allowanceFor({}), 5);
t("explicit value wins", q.allowanceFor({ indexPerDay: 12 }), 12);
t("zero disables pacing", q.allowanceFor({ indexPerDay: 0 }), 0);
t("garbage falls back to default", q.allowanceFor({ indexPerDay: "abc" }), 5);
t("negative falls back to default", q.allowanceFor({ indexPerDay: -3 }), 5);

console.log("\n=== THE HEADLINE CASE: a burst spreads across days ===");
const burst = q.selectForSubmission({ newPages: pages(20), retryPages: [], history: {}, publishing: {}, now: NOW });
t("20 pages at once releases only the allowance", burst.release.length, 5);
t("...and defers the rest", burst.deferred.length, 15);
t("...oldest go-live dates go first", burst.release, ["/p0", "/p1", "/p2", "/p3", "/p4"]);

console.log("\n=== THE CASE THAT MUST NOT REGRESS: one page goes out now ===");
const single = q.selectForSubmission({ newPages: pages(1), retryPages: [], history: {}, publishing: {}, now: NOW });
t("a lone page is released immediately, not queued", single.release, ["/p0"]);
t("...with nothing deferred", single.deferred, []);

console.log("\n=== ALLOWANCE ALREADY SPENT ===");
const spent = { a: { submittedAt: hoursAgo(1) }, b: { submittedAt: hoursAgo(2) }, c: { submittedAt: hoursAgo(3) }, d: { submittedAt: hoursAgo(4) }, e: { submittedAt: hoursAgo(5) } };
const blocked = q.selectForSubmission({ newPages: pages(3), retryPages: [], history: spent, publishing: {}, now: NOW });
t("nothing released once the day's cap is used", blocked.release, []);
t("everything deferred", blocked.deferred.length, 3);
t("partial capacity releases only what's left",
  q.selectForSubmission({ newPages: pages(3), retryPages: [], history: { a: { submittedAt: hoursAgo(1) }, b: { submittedAt: hoursAgo(2) }, c: { submittedAt: hoursAgo(3) } }, publishing: {}, now: NOW }).release.length, 2);
t("yesterday's submissions don't count against today",
  q.selectForSubmission({ newPages: pages(3), retryPages: [], history: { a: { submittedAt: hoursAgo(30) }, b: { submittedAt: hoursAgo(40) } }, publishing: {}, now: NOW }).release.length, 3);

console.log("\n=== STARVATION, BOTH DIRECTIONS ===");
// A permanently-failing retry must never block new pages forever.
const manyRetries = q.selectForSubmission({ newPages: pages(4, "new"), retryPages: pages(10, "stuck"), history: {}, publishing: {}, now: NOW });
t("new pages get priority over a pile of stuck retries",
  manyRetries.release.filter((p) => p.startsWith("/new")).length, 4);
t("...but one slot is still reserved for a retry",
  manyRetries.release.filter((p) => p.startsWith("/stuck")).length, 1);
// And a client publishing at exactly the cap must not starve retries entirely.
const atCap = q.selectForSubmission({ newPages: pages(5, "new"), retryPages: pages(3, "stuck"), history: {}, publishing: {}, now: NOW });
t("publishing at the cap still leaves a retry slot",
  atCap.release.filter((p) => p.startsWith("/stuck")).length, 1);
t("...taking one new page's slot, not exceeding the cap", atCap.release.length, 5);

console.log("\n=== PACING DISABLED ===");
const off = q.selectForSubmission({ newPages: pages(30), retryPages: pages(5, "r"), history: {}, publishing: { indexPerDay: 0 }, now: NOW });
t("indexPerDay:0 submits everything", off.release.length, 35);
t("...and defers nothing", off.deferred, []);

console.log("\n=== EDGE CASES ===");
t("nothing in, nothing out", q.selectForSubmission({ newPages: [], retryPages: [], history: {}, publishing: {}, now: NOW }).release, []);
t("retries alone still get released",
  q.selectForSubmission({ newPages: [], retryPages: pages(3, "r"), history: {}, publishing: {}, now: NOW }).release.length, 3);
t("allowance of 1 with retries pending releases exactly one",
  q.selectForSubmission({ newPages: pages(2), retryPages: pages(2, "r"), history: {}, publishing: { indexPerDay: 1 }, now: NOW }).release.length, 1);
const decision = q.selectForSubmission({ newPages: pages(9), retryPages: [], history: {}, publishing: { indexPerDay: 4 }, now: NOW });
t("release + deferred always accounts for every candidate",
  decision.release.length + decision.deferred.length, 9);
t("no page is both released and deferred",
  decision.release.filter((p) => decision.deferred.includes(p)), []);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
