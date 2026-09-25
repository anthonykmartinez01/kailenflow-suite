// Pure review-history math for the GBP Portfolio Reviews section. No I/O, so
// scripts/test-portfolio-reviews-math.mjs can prove every number.
//
// Model: each scan observes the public review count of every selected listing.
// Per Central-time day we keep, per listing:
//   first  — the count at the start of the day (the last known count before
//            the day's first scan, so a 3am scan still measures "since midnight")
//   last   — the latest count observed that day
//   gained — sum of every UPWARD step between consecutive observations
//   lost   — sum of every DOWNWARD step (reviews that dropped / didn't stick)
// Gains and losses are tracked separately so a +3/−1 day reads as 3 gained,
// 1 lost — never silently as "+2".
//
// A listing whose scan failed is simply absent from that observation; totals
// carry its last known count forward so a failed scan never looks like a drop.

export type Counts = Record<string, number>;
export type DayRec = { first: Counts; last: Counts; gained: Counts; lost: Counts };
export type Daily = Record<string, DayRec>; // key "YYYY-MM-DD" (Central)

const emptyDay = (): DayRec => ({ first: {}, last: {}, gained: {}, lost: {} });

export function addDaysStr(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysStr(d, 1)) out.push(d);
  return out;
}

/** Latest known count per listing, using only days strictly before `beforeDay` (or all days). */
export function latestKnown(daily: Daily, beforeDay?: string): Counts {
  const out: Counts = {};
  for (const d of Object.keys(daily).sort()) {
    if (beforeDay && d >= beforeDay) break;
    Object.assign(out, daily[d].last);
  }
  return out;
}

/** Records one scan into `daily` (mutates). Returns every per-listing drop it saw. */
export function applyObservation(daily: Daily, day: string, counts: Counts): { drops: { id: string; from: number; to: number }[] } {
  const prev = latestKnown(daily); // includes earlier scans today
  const rec = (daily[day] ||= emptyDay());
  const drops: { id: string; from: number; to: number }[] = [];
  for (const [id, count] of Object.entries(counts)) {
    if (!Number.isFinite(count) || count < 0) continue;
    const before = prev[id];
    if (rec.first[id] === undefined) rec.first[id] = before ?? count;
    if (before !== undefined) {
      const delta = count - before;
      if (delta > 0) rec.gained[id] = (rec.gained[id] || 0) + delta;
      else if (delta < 0) {
        rec.lost[id] = (rec.lost[id] || 0) - delta;
        drops.push({ id, from: before, to: count });
      }
    }
    rec.last[id] = count;
  }
  return { drops };
}

const sumIds = (c: Counts, ids: string[]) => ids.reduce((t, id) => t + (c[id] ?? 0), 0);
const anyKnown = (c: Counts, ids: string[]) => ids.some((id) => c[id] !== undefined);

/** One point per calendar day in [from, to]: the portfolio total at end of day, carried forward. */
export function dailySeries(daily: Daily, ids: string[], from: string, to: string): { day: string; total: number }[] {
  const known: Counts = {};
  const before = latestKnown(daily, from);
  for (const id of ids) if (before[id] !== undefined) known[id] = before[id];
  const out: { day: string; total: number }[] = [];
  for (const d of dayRange(from, to)) {
    const rec = daily[d];
    if (rec) for (const id of ids) if (rec.last[id] !== undefined) known[id] = rec.last[id];
    if (anyKnown(known, ids)) out.push({ day: d, total: sumIds(known, ids) });
  }
  return out;
}

/** Intraday points (for the 1D view), carried forward from the last count before `day`. */
export function intradaySeries(
  daily: Daily, ids: string[], day: string, observations: { at: number; day: string; counts: Counts }[],
): { at: number; total: number }[] {
  const known: Counts = {};
  const before = latestKnown(daily, day);
  for (const id of ids) if (before[id] !== undefined) known[id] = before[id];
  const out: { at: number; total: number }[] = [];
  for (const o of observations.filter((x) => x.day === day).sort((a, b) => a.at - b.at)) {
    for (const id of ids) if (o.counts[id] !== undefined) known[id] = o.counts[id];
    if (anyKnown(known, ids)) out.push({ at: o.at, total: sumIds(known, ids) });
  }
  return out;
}

/** Gained / lost / net over [from, to], summed per listing so gains never mask losses. */
export function periodStats(daily: Daily, ids: string[], from: string, to: string) {
  let gained = 0, lost = 0;
  const perListing: Record<string, { gained: number; lost: number }> = {};
  for (const id of ids) perListing[id] = { gained: 0, lost: 0 };
  for (const [d, rec] of Object.entries(daily)) {
    if (d < from || d > to) continue;
    for (const id of ids) {
      const g = rec.gained[id] || 0, l = rec.lost[id] || 0;
      gained += g; lost += l;
      perListing[id].gained += g; perListing[id].lost += l;
    }
  }
  return { gained, lost, net: gained - lost, perListing };
}

export function earliestDay(daily: Daily): string | null {
  const days = Object.keys(daily).sort();
  return days[0] || null;
}
