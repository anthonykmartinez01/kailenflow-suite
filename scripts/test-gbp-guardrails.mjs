// Guardrail test suite (task #54). Run with: node guardrail-tests.mjs
// Imports the real .mts sources by stripping types — the logic under test is
// plain JS, so this exercises the shipped code rather than a copy of it.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../netlify/shared/", import.meta.url);
const dir = mkdtempSync(join(tmpdir(), "gbp-"));

// Transpile the real .mts sources with the actual TypeScript compiler, so the
// tests exercise the shipped logic rather than a hand-maintained copy (and so
// a fragile regex stripper can't quietly change behaviour under test).
const ts = (await import("typescript")).default;
function toJs(src) {
  return ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
}

const guardPath = join(dir, "guard.mjs");
const rulesPath = join(dir, "rules.mjs");
writeFileSync(guardPath, toJs(readFileSync(new URL("gbp-guard.mts", ROOT), "utf8")));
writeFileSync(rulesPath, toJs(readFileSync(new URL("gbp-post-rules.mts", ROOT), "utf8")));

const guard = await import("file://" + guardPath.replace(/\\/g, "/"));
const rules = await import("file://" + rulesPath.replace(/\\/g, "/"));

let pass = 0, fail = 0;
const t = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
};
const throws = (name, fn) => {
  let threw = false;
  try { fn(); } catch (e) { threw = e?.code === "gbp_forbidden_write"; }
  t(name, threw, true);
};
const allows = (name, fn) => {
  let ok = true;
  try { fn(); } catch { ok = false; }
  t(name, ok, true);
};

console.log("\n=== WRITE GUARD: the one permitted write ===");
allows("POST .../localPosts is allowed", () =>
  guard.assertGbpRequestAllowed("POST", "https://mybusiness.googleapis.com/v4/accounts/123/locations/456/localPosts"));
allows("GET performance data is allowed", () =>
  guard.assertGbpRequestAllowed("GET", "https://businessprofileperformance.googleapis.com/v1/locations/456:fetchMultiDailyMetricsTimeSeries"));
allows("GET localPosts (the probe) is allowed", () =>
  guard.assertGbpRequestAllowed("GET", "https://mybusiness.googleapis.com/v4/accounts/123/locations/456/localPosts?pageSize=1"));

console.log("\n=== WRITE GUARD: listing mutations must be impossible ===");
throws("PATCH locations (hours/phone/name edit)", () =>
  guard.assertGbpRequestAllowed("PATCH", "https://mybusinessbusinessinformation.googleapis.com/v1/locations/456"));
throws("PUT locations", () =>
  guard.assertGbpRequestAllowed("PUT", "https://mybusinessbusinessinformation.googleapis.com/v1/locations/456"));
throws("PATCH v4 location", () =>
  guard.assertGbpRequestAllowed("PATCH", "https://mybusiness.googleapis.com/v4/accounts/123/locations/456"));
throws("PATCH accounts", () =>
  guard.assertGbpRequestAllowed("PATCH", "https://mybusinessaccountmanagement.googleapis.com/v1/accounts/123"));
throws("POST to locations (not localPosts)", () =>
  guard.assertGbpRequestAllowed("POST", "https://mybusiness.googleapis.com/v4/accounts/123/locations/456"));
throws("DELETE a specific post (retract via API)", () =>
  guard.assertGbpRequestAllowed("DELETE", "https://mybusiness.googleapis.com/v4/accounts/123/locations/456/localPosts/789"));
throws("PATCH a specific post", () =>
  guard.assertGbpRequestAllowed("PATCH", "https://mybusiness.googleapis.com/v4/accounts/123/locations/456/localPosts/789"));
throws("POST attributes", () =>
  guard.assertGbpRequestAllowed("POST", "https://mybusinessbusinessinformation.googleapis.com/v1/locations/456/attributes"));
throws("lookalike host does not satisfy the pattern", () =>
  guard.assertGbpRequestAllowed("POST", "https://evil.com/mybusiness.googleapis.com/v4/accounts/1/locations/2/localPosts"));
throws("query string cannot smuggle a different path", () =>
  guard.assertGbpRequestAllowed("POST", "https://mybusiness.googleapis.com/v4/accounts/1/locations/2?x=/localPosts"));

console.log("\n=== CONTENT: hard blocks ===");
const codes = (v) => v.blocks.map((b) => b.code).sort();
const warns = (v) => v.warnings.map((w) => w.code).sort();
const base = { text: "Spring is when heat pumps start showing their age. Book a tune-up before July.", clientWebsite: "anytimeairpros.com" };

t("clean post has no blocks", codes(rules.validatePostContent(base)), []);
t("over 1500 chars blocks", codes(rules.validatePostContent({ ...base, text: "x".repeat(1501) })), ["too_long"]);
t("emoji blocks", codes(rules.validatePostContent({ ...base, text: "Great service today 🔥" })), ["emoji"]);
t("registered trademark does NOT count as emoji", codes(rules.validatePostContent({ ...base, text: "We install CoolMax® systems." })), []);
t("hashtag blocks", codes(rules.validatePostContent({ ...base, text: "Tune-ups now #HVAC" })), ["hashtag"]);
t("raw https URL blocks", codes(rules.validatePostContent({ ...base, text: "Book at https://example.com now" })), ["raw_url"]);
t("bare domain blocks", codes(rules.validatePostContent({ ...base, text: "Visit anytimeairpros.com to book" })), ["raw_url"]);
t("phone number blocks", codes(rules.validatePostContent({ ...base, text: "Call us at (910) 555-0142 today" })), ["phone"]);
t("dotted phone blocks", codes(rules.validatePostContent({ ...base, text: "Reach us 910.555.0142" })), ["phone"]);
t("offer language blocks when unconfirmed", codes(rules.validatePostContent({ ...base, text: "Get 20% off a tune-up" })), ["unconfirmed_offer"]);
t("offer language passes when confirmed", codes(rules.validatePostContent({ ...base, text: "Get 20% off a tune-up", offerConfirmed: true })), []);
t("'free estimate' counts as an offer", codes(rules.validatePostContent({ ...base, text: "Ask about a free estimate" })), ["unconfirmed_offer"]);
t("http CTA blocks", codes(rules.validatePostContent({ ...base, cta: "BOOK", ctaUrl: "http://anytimeairpros.com/book" })), ["cta_not_https"]);
t("https CTA on own domain is clean", codes(rules.validatePostContent({ ...base, cta: "BOOK", ctaUrl: "https://anytimeairpros.com/book" })), []);
t("CTA without a link blocks", codes(rules.validatePostContent({ ...base, cta: "BOOK" })), ["cta_missing_url"]);
t("CALL needs no link", codes(rules.validatePostContent({ ...base, cta: "CALL" })), []);
t("multiple violations all reported", codes(rules.validatePostContent({ ...base, text: "🔥 Call 910-555-0142 or visit example.com #deal" })), ["emoji", "hashtag", "phone", "raw_url"]);

console.log("\n=== CONTENT: warnings (publish still allowed) ===");
t("third-party CTA warns, does not block", warns(rules.validatePostContent({ ...base, cta: "BOOK", ctaUrl: "https://calendly.com/x" })), ["cta_third_party"]);
t("third-party CTA produces no block", codes(rules.validatePostContent({ ...base, cta: "BOOK", ctaUrl: "https://calendly.com/x" })), []);
t("subdomain of own site is not third-party", warns(rules.validatePostContent({ ...base, cta: "BOOK", ctaUrl: "https://book.anytimeairpros.com/x" })), []);
t("ALL CAPS warns", warns(rules.validatePostContent({ ...base, text: "URGENT REPAIRS available now" })), ["all_caps"]);
t("HVAC is not flagged as shouting", warns(rules.validatePostContent({ ...base, text: "Our HVAC team handles SEER upgrades" })), []);

console.log("\n=== IMAGES ===");
t("tiny image blocks", codes(rules.validatePostImage({ width: 200, height: 200, bytes: 1000 })), ["image_too_small"]);
t("oversized file blocks", codes(rules.validatePostImage({ width: 1000, height: 1000, bytes: 6 * 1024 * 1024 })), ["image_too_large"]);
t("small-but-legal image warns only", warns(rules.validatePostImage({ width: 400, height: 400, bytes: 1000 })), ["image_small"]);
t("good image is clean", codes(rules.validatePostImage({ width: 1200, height: 900, bytes: 500000 })), []);

console.log("\n=== PUBLISH DECISION ===");
const ok = {
  globalPublishEnabled: true, clientPublishEnabled: true,
  storedLocationId: "847", resolvedLocationId: "847",
  humanConfirmed: true, postsPublishedToday: 0, postsPublishedThisWeek: 0,
  content: base,
};
t("all clear permits publishing", rules.canPublish(rules.evaluatePublish(ok)), true);
t("global kill switch blocks", codes(rules.evaluatePublish({ ...ok, globalPublishEnabled: false })), ["kill_switch_global"]);
t("per-client kill switch blocks", codes(rules.evaluatePublish({ ...ok, clientPublishEnabled: false })), ["kill_switch_client"]);
t("missing confirmation blocks", codes(rules.evaluatePublish({ ...ok, humanConfirmed: false })), ["not_confirmed"]);
t("missing location blocks", codes(rules.evaluatePublish({ ...ok, storedLocationId: null })), ["no_location"]);
t("unresolvable location blocks", codes(rules.evaluatePublish({ ...ok, resolvedLocationId: null })), ["location_unresolvable"]);
t("listing changed since compose blocks", codes(rules.evaluatePublish({ ...ok, resolvedLocationId: "999" })), ["location_mismatch"]);
t("daily cap blocks", codes(rules.evaluatePublish({ ...ok, postsPublishedToday: 2 })), ["rate_limit_day"]);
t("weekly volume warns only", warns(rules.evaluatePublish({ ...ok, postsPublishedThisWeek: 3 })), ["rate_warn_week"]);
t("weekly volume does not block", rules.canPublish(rules.evaluatePublish({ ...ok, postsPublishedThisWeek: 3 })), true);
t("new client defaults (both switches off) cannot publish",
  rules.canPublish(rules.evaluatePublish({ ...ok, globalPublishEnabled: false, clientPublishEnabled: false })), false);

console.log("\n=== BYPASS: no code may reach GBP without the guard ===");
// The runtime guard only protects calls that go THROUGH it. If any other file
// can build its own fetch() to a Business Profile host, the guard is
// decorative. This walks the source and fails if one exists — so a future
// "sync hours to Google" feature hits a wall at test time even if its author
// never heard of gbp-guard.mts.
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const GBP_HOSTS = [
  "mybusiness.googleapis.com",
  "mybusinessbusinessinformation.googleapis.com",
  "mybusinessaccountmanagement.googleapis.com",
  "businessprofileperformance.googleapis.com",
];
// The guard itself must name these hosts — that's its job.
const GUARD_FILE = "netlify\\shared\\gbp-guard.mts".replace(/\\/g, "/");
// Host *constants* are fine to declare; what matters is that the fetch call
// next to them goes through the guard.
const HOST_CONSTANTS = ["ACCOUNTS_API", "INFO_API", "PERF_API", "POSTS_API_V4"];

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "dist" || name === "backups") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(mts|ts|js|mjs|html)$/.test(name)) acc.push(full);
  }
  return acc;
}

const offenders = [];
for (const file of walk(REPO)) {
  const rel = file.replace(REPO, "").replace(/\\/g, "/");
  if (rel === GUARD_FILE) continue;
  if (rel.startsWith("scripts/")) continue; // this test names the hosts on purpose
  const src = readFileSync(file, "utf8");
  // Every `fetch(` in the file: does its argument region mention a GBP host
  // (literally, or via one of the host constants)?
  const re = /\bfetch\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const window = src.slice(m.index, m.index + 220);
    const hitsHost = GBP_HOSTS.some((h) => window.includes(h)) ||
      HOST_CONSTANTS.some((c) => new RegExp(`\\$\\{${c}\\}|\\b${c}\\b`).test(window));
    if (hitsHost) {
      const line = src.slice(0, m.index).split("\n").length;
      offenders.push(`${rel}:${line}`);
    }
  }
}
t("no direct fetch() to a Business Profile host outside gbp-guard.mts", offenders, []);

// And the headline case, stated plainly: the exact call that gets listings
// suspended, refused by the shared helper.
let patchErr = null;
try {
  guard.assertGbpRequestAllowed("PATCH", "https://mybusinessbusinessinformation.googleapis.com/v1/locations/847?updateMask=regularHours");
} catch (e) { patchErr = e; }
t("locations.patch (edit hours) throws", patchErr?.code, "gbp_forbidden_write");
t("...and the error explains why", /suspended/i.test(patchErr?.message || ""), true);
console.log(`\n      ${String(patchErr?.message || "").split("\n")[0]}`);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
