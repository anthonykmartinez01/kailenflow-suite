// Proves the GBP Portfolio Reviews numbers: gained vs lost, "since midnight",
// failed scans, and the chart series.
// Run: node scripts/test-portfolio-reviews-math.mjs
import { applyObservation, dailySeries, intradaySeries, periodStats, latestKnown, dayRange } from "../netlify/shared/portfolio-reviews-math.mts";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("PASS ", name); } else { fail++; console.log("FAIL ", name, "\n   got ", g, "\n   want", w); }
};

// Day 1: first ever scan — establishes counts, no fake gain.
const daily = {};
applyObservation(daily, "2026-09-08", { a: 10, b: 3 });
eq("first scan is baseline, not a gain", periodStats(daily, ["a", "b"], "2026-09-08", "2026-09-08"), { gained: 0, lost: 0, net: 0, perListing: { a: { gained: 0, lost: 0 }, b: { gained: 0, lost: 0 } } });

// Day 2 at 3am: a gained 2 overnight -> counts for day 2 ("since midnight" baseline = end of day 1).
applyObservation(daily, "2026-09-09", { a: 12, b: 3 });
eq("baseline carries from previous day", daily["2026-09-09"].first, { a: 10, b: 3 });
eq("overnight gain counted", periodStats(daily, ["a", "b"], "2026-09-09", "2026-09-09").gained, 2);

// Later day 2: a gains 3 but also loses 1 (net +2) — gains must not mask the loss.
applyObservation(daily, "2026-09-09", { a: 15, b: 3 });
const r = applyObservation(daily, "2026-09-09", { a: 14, b: 3 });
eq("drop is reported", r.drops, [{ id: "a", from: 15, to: 14 }]);
eq("day 2 gained / lost / net", (({ gained, lost, net }) => ({ gained, lost, net }))(periodStats(daily, ["a", "b"], "2026-09-09", "2026-09-09")), { gained: 5, lost: 1, net: 4 });

// Day 3: b's scan FAILED (absent). Its total must carry forward, not fall to 0.
applyObservation(daily, "2026-09-10", { a: 14 });
eq("failed scan does not dip the chart", dailySeries(daily, ["a", "b"], "2026-09-08", "2026-09-10"), [
  { day: "2026-09-08", total: 13 }, { day: "2026-09-09", total: 17 }, { day: "2026-09-10", total: 17 },
]);
eq("failed scan is not a loss", periodStats(daily, ["a", "b"], "2026-09-10", "2026-09-10").lost, 0);

// Day 5 with no scan on day 4: the gap day still gets a carried point.
applyObservation(daily, "2026-09-12", { a: 14, b: 1 });
eq("gap day carried forward", dailySeries(daily, ["a", "b"], "2026-09-10", "2026-09-12").map((p) => p.total), [17, 17, 15]);
eq("b dropped 2 reviews", periodStats(daily, ["b"], "2026-09-08", "2026-09-12").perListing.b, { gained: 0, lost: 2 });

// Range starting after data: chart starts from the carried value, not 0.
eq("range start carries prior counts", dailySeries(daily, ["a", "b"], "2026-09-11", "2026-09-11"), [{ day: "2026-09-11", total: 17 }]);

// Only the selected listings count.
eq("unselected listing excluded", dailySeries(daily, ["a"], "2026-09-12", "2026-09-12"), [{ day: "2026-09-12", total: 14 }]);

// A newly added listing's first scan is a baseline, not a gain.
applyObservation(daily, "2026-09-12", { c: 40 });
eq("new listing not counted as gained", periodStats(daily, ["a", "b", "c"], "2026-09-12", "2026-09-12").gained, 0);

// Intraday series for the 1D view.
const obs = [
  { at: 1, day: "2026-09-13", counts: { a: 14, b: 1 } },
  { at: 2, day: "2026-09-13", counts: { a: 16 } },
  { at: 3, day: "2026-09-12", counts: { a: 99 } },
];
eq("intraday carries and ignores other days", intradaySeries(daily, ["a", "b"], "2026-09-13", obs), [{ at: 1, total: 15 }, { at: 2, total: 17 }]);

eq("latestKnown before a day", latestKnown(daily, "2026-09-10"), { a: 14, b: 3 });
eq("dayRange across month end", dayRange("2026-08-30", "2026-09-02"), ["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"]);
eq("ignores invalid counts", applyObservation({}, "2026-09-01", { a: NaN, b: -1 }).drops, []);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
