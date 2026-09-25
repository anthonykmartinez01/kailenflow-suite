// Proves GBP Portfolio's month windows: every Google data point must land in
// exactly the right month, and comparisons must be like-for-like.
// Run: node scripts/test-gbp-portfolio-window.mjs
import { dayKey as k, keyStr, todayIn, parseMonth, planMonth, finalizeWindows, classify } from "../netlify/shared/gbp-portfolio-window.mts";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("PASS ", name); }
  else { fail++; console.log("FAIL ", name, "\n   got ", g, "\n   want", w); }
};
const win = (w) => w.empty ? "empty" : `${keyStr(w.cur.start)}..${keyStr(w.cur.end)} vs ${keyStr(w.prev.start)}..${keyStr(w.prev.end)}`;

// Month parsing — the original bug: a regex that lost its backslashes made
// EVERY requested month silently fall back to the current month.
const today = k(2026, 9, 15);
eq("parses a past month", parseMonth("2026-08", today).month, "2026-08");
eq("parses a month last year", parseMonth("2025-12", today).month, "2025-12");
eq("bad input -> current month", parseMonth("garbage", today).month, "2026-09");
eq("month 13 rejected", parseMonth("2026-13", today).month, "2026-09");

// Timezone: 03:00 UTC on Sep 16 is still Sep 15 in Texas.
eq("Chicago today, late evening", keyStr(todayIn("America/Chicago", new Date("2026-09-16T03:00:00Z"))), "2026-09-15");
eq("Chicago today, morning", keyStr(todayIn("America/Chicago", new Date("2026-09-15T14:00:00Z"))), "2026-09-15");

// Live month, Google data through the 12th -> Sep 1–12 vs Aug 1–12.
let p = planMonth(2026, 9, today);
eq("live month is current", [p.isCurrentMonth, p.monthsBack], [true, 0]);
eq("live month asks Google through yesterday", keyStr(p.requestEnd), "2026-09-14");
eq("live month trimmed to Google's last day", win(finalizeWindows(p, k(2026, 9, 12))), "2026-09-01..2026-09-12 vs 2026-08-01..2026-08-12");
eq("trim is flagged", finalizeWindows(p, k(2026, 9, 12)).trimmedForLag, true);
eq("live month, data through yesterday", win(finalizeWindows(p, k(2026, 9, 14))), "2026-09-01..2026-09-14 vs 2026-08-01..2026-08-14");

// A settled past month: whole month vs whole month, regardless of data.
p = planMonth(2026, 8, today);
eq("August is settled by Sep 15", p.settled, true);
eq("settled month is whole vs whole", win(finalizeWindows(p, k(2026, 8, 20))), "2026-08-01..2026-08-31 vs 2026-07-01..2026-07-31");

// A month that JUST ended isn't final yet: viewed Sep 3 with data through Aug 30.
p = planMonth(2026, 8, k(2026, 9, 3));
eq("just-ended month not settled", p.settled, false);
eq("just-ended month trimmed like-for-like", win(finalizeWindows(p, k(2026, 8, 30))), "2026-08-01..2026-08-30 vs 2026-07-01..2026-07-30");

// Short months and year boundaries.
p = planMonth(2026, 3, k(2026, 3, 31));
eq("Mar 1–30 vs all of Feb (28 days)", win(finalizeWindows(p, k(2026, 3, 30))), "2026-03-01..2026-03-30 vs 2026-02-01..2026-02-28");
p = planMonth(2026, 1, k(2026, 3, 1));
eq("January compares to December last year", win(finalizeWindows(p, null)), "2026-01-01..2026-01-31 vs 2025-12-01..2025-12-31");
eq("Feb 2028 is a leap month", win(finalizeWindows(planMonth(2028, 2, k(2028, 6, 1)), null)), "2028-02-01..2028-02-29 vs 2028-01-01..2028-01-31");

// First of the month: nothing to report, never a fake 100% drop.
p = planMonth(2026, 10, k(2026, 10, 1));
eq("1st of month is empty", finalizeWindows(p, k(2026, 9, 29)).empty, true);
p = planMonth(2026, 10, k(2026, 10, 3));
eq("Google has nothing for the new month yet -> empty", finalizeWindows(p, k(2026, 9, 30)).empty, true);

// Classification: each day counts once, in the right window.
const w = finalizeWindows(planMonth(2026, 9, today), k(2026, 9, 12));
eq("Sep 1 -> current", classify(w, k(2026, 9, 1)), "cur");
eq("Sep 12 -> current", classify(w, k(2026, 9, 12)), "cur");
eq("Sep 13 (not yet filled in) -> neither", classify(w, k(2026, 9, 13)), null);
eq("Aug 12 -> previous", classify(w, k(2026, 8, 12)), "prev");
eq("Aug 13 (outside the like-for-like range) -> neither", classify(w, k(2026, 8, 13)), null);
eq("Jul 31 -> neither", classify(w, k(2026, 7, 31)), null);

// End-to-end sum over a fake daily series: 1 call every day Jul 1 – Sep 14.
let cur = 0, prev = 0;
for (let d = k(2026, 7, 1); d <= k(2026, 9, 14); ) {
  const c = classify(w, d);
  if (c === "cur") cur++; else if (c === "prev") prev++;
  const t = new Date(Date.UTC(Math.floor(d / 10000), Math.floor(d / 100) % 100 - 1, d % 100 + 1));
  d = k(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
eq("daily series sums 12 vs 12", [cur, prev], [12, 12]);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
