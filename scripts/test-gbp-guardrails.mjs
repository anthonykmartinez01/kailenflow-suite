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

console.log("\n=== CTA OFFERED ONLY WHEN A DESTINATION EXISTS ===");
const noLinks = { website: "anytimeairpros.com" };
const withBooking = { ...noLinks, bookingUrl: "https://anytimeairpros.com/schedule" };
const withBoth = { ...withBooking, orderingUrl: "https://anytimeairpros.com/order" };

t("no booking/ordering URL: only CALL and LEARN_MORE offered",
  rules.allowedCtasFor(noLinks).sort(), ["CALL", "LEARN_MORE"]);
t("booking URL on file: BOOK becomes available",
  rules.allowedCtasFor(withBooking).sort(), ["BOOK", "CALL", "LEARN_MORE"]);
t("both on file: all four available",
  rules.allowedCtasFor(withBoth).sort(), ["BOOK", "CALL", "LEARN_MORE", "ORDER"]);
t("whitespace-only URL does not unlock BOOK",
  rules.allowedCtasFor({ ...noLinks, bookingUrl: "   " }).sort(), ["CALL", "LEARN_MORE"]);

t("BOOK uses the booking URL and needs no review",
  rules.ctaUrlFor("BOOK", withBooking), { url: "https://anytimeairpros.com/schedule", needsReview: false });
t("ORDER uses the ordering URL and needs no review",
  rules.ctaUrlFor("ORDER", withBoth), { url: "https://anytimeairpros.com/order", needsReview: false });
t("LEARN_MORE uses the homepage, no review",
  rules.ctaUrlFor("LEARN_MORE", noLinks), { url: "https://anytimeairpros.com", needsReview: false });
t("CALL carries no link at all",
  rules.ctaUrlFor("CALL", withBoth), { url: "", needsReview: false });
t("safety net: hand-set BOOK without a booking URL falls back and needs review",
  rules.ctaUrlFor("BOOK", noLinks), { url: "https://anytimeairpros.com", needsReview: true });
t("bare domain is normalised to https",
  rules.ctaUrlFor("LEARN_MORE", { website: "anytimeairpros.com" }).url, "https://anytimeairpros.com");

// The point of the whole change: a generated batch for a client with no
// booking URL must contain nothing that trips the review block.
const generatedForNoLinks = rules.allowedCtasFor(noLinks).map((cta) => {
  const link = rules.ctaUrlFor(cta, noLinks);
  return rules.validatePostContent({
    text: "Furnace smells dusty on the first cold night? That is usually burn-off.",
    cta, ctaUrl: link.url, clientWebsite: noLinks.website, ctaUrlNeedsReview: link.needsReview,
  });
});
t("every CTA offered to a client with no booking URL publishes clean",
  generatedForNoLinks.flatMap((v) => v.blocks.map((b) => b.code)), []);

console.log("\n=== CTA DESTINATION REVIEW ===");
// A permit-everything baseline, so a content-level block can be shown to stop
// the whole publish decision and not just the content check.
const ok0 = () => ({
  globalPublishEnabled: true, clientPublishEnabled: true,
  storedLocationId: "847", resolvedLocationId: "847",
  humanConfirmed: true, postsPublishedToday: 0, postsPublishedThisWeek: 0,
  content: base,
});
const booked = { ...base, cta: "BOOK", ctaUrl: "https://anytimeairpros.com" };
t("auto-filled BOOK link blocks until reviewed",
  codes(rules.validatePostContent({ ...booked, ctaUrlNeedsReview: true })), ["cta_url_unreviewed"]);
t("auto-filled ORDER link blocks until reviewed",
  codes(rules.validatePostContent({ ...base, cta: "ORDER", ctaUrl: "https://anytimeairpros.com", ctaUrlNeedsReview: true })), ["cta_url_unreviewed"]);
t("once reviewed, it publishes", codes(rules.validatePostContent({ ...booked, ctaUrlNeedsReview: false })), []);
t("LEARN_MORE is not flagged — a homepage is a fine place to learn more",
  codes(rules.validatePostContent({ ...base, cta: "LEARN_MORE", ctaUrl: "https://anytimeairpros.com", ctaUrlNeedsReview: true })), []);
t("a hand-entered BOOK link is not flagged",
  codes(rules.validatePostContent({ ...base, cta: "BOOK", ctaUrl: "https://anytimeairpros.com/schedule" })), []);
t("review flag does not rescue an http link",
  codes(rules.validatePostContent({ ...base, cta: "BOOK", ctaUrl: "http://anytimeairpros.com/book", ctaUrlNeedsReview: false })), ["cta_not_https"]);
t("an unreviewed link still blocks publishing outright",
  rules.canPublish(rules.evaluatePublish({ ...ok0(), content: { ...booked, ctaUrlNeedsReview: true } })), false);

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

// ─── The scan, v2 ────────────────────────────────────────────────────────
// v1 inspected a window of text around each `fetch(` looking for a host
// literal. That is blind to the normal way URLs are written — assembled from
// variables — and it let a real bypass through in gbp-locations' pagination
// loop, where the call site reads `fetch(url, ...)` and names no host at all.
//
// v2 works at FILE scope instead of call scope: if a file references a
// Business Profile host anywhere, or is itself a gbp-* module, then every bare
// `fetch(` in it is a violation regardless of how the URL was built. That is
// deliberately over-inclusive — a backstop should err toward flagging, and the
// fix (route through gbpRead) is one line.
//
// Escape hatch for a genuine non-Google fetch inside a gbp-* file — e.g. a
// future CTA-link reachability check, which fetches the client's own website:
// put `// gbp-scan-allow: <reason>` on the preceding line. Default is deny,
// and the suppression forces a stated reason.
const GBP_FILE_RE = /(?:^|\/)netlify\/(?:functions|shared)\/gbp-/;

function scanSource(rel, src) {
  const found = [];
  const mentionsHost = GBP_HOSTS.some((h) => src.includes(h));
  const isGbpModule = GBP_FILE_RE.test(rel);
  if (!mentionsHost && !isGbpModule) return found;

  const lines = src.split("\n");
  const re = /\bfetch\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split("\n").length;
    const prev = lines[line - 2] || "";
    if (/gbp-scan-allow:/.test(prev)) continue;

    // Flag unless the target is PROVABLY not a Business Profile URL. A plain
    // string literal with no interpolation can be judged on its face; anything
    // else — a variable, or a template with `${}` in it — cannot be, so it is
    // flagged. That asymmetry is the whole point: the miss in gbp-locations
    // was a template literal, and "I can't tell" has to mean "flag it".
    const arg = src.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const literal = arg.match(/^\s*(['"`])([\s\S]*?)\1/);
    let provablySafe = false;
    if (literal) {
      const body = literal[2];
      // A relative path is same-origin by construction — it cannot reach
      // google.com no matter what gets interpolated into the query string.
      if (body.startsWith("/")) provablySafe = true;
      else if (!body.includes("${") && !GBP_HOSTS.some((h) => body.includes(h))) provablySafe = true;
    }
    if (provablySafe) continue;

    found.push(`${rel}:${line}`);
  }
  return found;
}

const offenders = [];
for (const file of walk(REPO)) {
  const rel = file.replace(REPO, "").replace(/\\/g, "/");
  if (rel === GUARD_FILE) continue;
  if (rel.startsWith("scripts/")) continue; // fixtures + this file name hosts on purpose
  offenders.push(...scanSource(rel, readFileSync(file, "utf8")));
}
t("no direct fetch() to a Business Profile host outside gbp-guard.mts", offenders, []);

// ─── Prove the scan catches constructed URLs, not just literals ──────────
const fx = (name) => {
  const p = fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
  return { rel: `fixtures/${name}`, src: readFileSync(p, "utf8") };
};

const interpolated = fx("bypass-interpolated.mts");
const hostInConst = fx("bypass-host-in-const.mts");
const compliant = fx("compliant.mts");

t("flags a URL built by template interpolation (the miss that started this)",
  scanSource(interpolated.rel, interpolated.src).length > 0, true);
t("flags a host hidden in a const and assembled across functions",
  scanSource(hostInConst.rel, hostInConst.src).length > 0, true);
t("does NOT flag a constructed URL that goes through gbpRead",
  scanSource(compliant.rel, compliant.src), []);

// The v1 logic, kept verbatim, purely to demonstrate that the hole was real
// rather than theoretical — this must MISS the interpolated fixture.
function scanSourceV1(rel, src) {
  const found = [];
  const re = /\bfetch\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const w = src.slice(m.index, m.index + 220);
    const hits = GBP_HOSTS.some((h) => w.includes(h)) ||
      HOST_CONSTANTS.some((c) => new RegExp(`\\$\\{${c}\\}|\\b${c}\\b`).test(w));
    if (hits) found.push(`${rel}:${src.slice(0, m.index).split("\n").length}`);
  }
  return found;
}
t("the previous call-site scan MISSED it (the hole was real, not theoretical)",
  scanSourceV1(interpolated.rel, interpolated.src), []);
t("the previous call-site scan also missed the const-hidden variant",
  scanSourceV1(hostInConst.rel, hostInConst.src), []);

// Regression test against the REAL bug: take the shipped gbp-locations source
// and put the bypass back exactly as it was, then confirm the scan catches it.
// Fixtures prove the scan handles the shape; this proves it would have caught
// the specific line that shipped.
const LOCATIONS_REL = "netlify/functions/gbp-locations/index.mts";
const locationsSrc = readFileSync(join(REPO, LOCATIONS_REL.replace(/\//g, "\\")), "utf8");
t("gbp-locations is currently clean", scanSource(LOCATIONS_REL, locationsSrc), []);
const reintroduced = locationsSrc.replace(
  "const r = await gbpRead(url, token);",
  "const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });"
);
t("...and re-introducing the exact bypass is caught",
  scanSource(LOCATIONS_REL, reintroduced).length, 1);
t("...which the previous scan would have let through",
  scanSourceV1(LOCATIONS_REL, reintroduced), []);

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
