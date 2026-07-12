// Timezone-aware "next run" math for recurring heat maps. Kept in one place
// and mirrored verbatim in public/index.html (browser has no bundler here,
// so the schedule-creation UI needs the same logic client-side to compute an
// accurate initial nextRunAt) — if you change the algorithm, update both.
export type Frequency = "once" | "weekly" | "biweekly" | "monthly";
export interface ScheduleTiming {
  frequency: Frequency;
  dayOfWeek?: number; // 0=Sun..6=Sat, used for weekly/biweekly
  timeOfDay: string; // "HH:mm", 24h, in `timezone`
  timezone: string; // IANA zone, e.g. "America/Chicago"
}

function zonedParts(ms: number, timeZone: string) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
  });
  const parts: any = {};
  for (const p of dtf.formatToParts(new Date(ms))) parts[p.type] = p.value;
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +parts.year, mo: +parts.month, d: +parts.day, h: +parts.hour, mi: +parts.minute, s: +parts.second, dow: weekdayMap[parts.weekday] };
}

// Converts a wall-clock time in `timeZone` to the UTC instant it represents.
// Single-iteration DST correction — accurate except exactly at a DST
// transition instant, which is an acceptable edge case for this feature.
function zonedWallTimeToUtcMs(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const p = zonedParts(guess, timeZone);
  const asIfUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return guess - (asIfUtc - guess);
}

function addDaysToYmd(y: number, mo: number, d: number, days: number) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

// Used for a "once" schedule: a specific calendar date (not a recurrence
// rule) at the chosen time, converted from `timezone` to a UTC instant.
export function computeOnceRunAt(dateStr: string, timeOfDay: string, timezone: string): number {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeOfDay.split(":").map(Number);
  return zonedWallTimeToUtcMs(y, mo, d, hh, mm, timezone);
}

// Used once, when a schedule is created: the next occurrence of the chosen
// day-of-week (or today, for monthly) at the chosen time, strictly after now.
export function computeInitialNextRunAt(nowMs: number, sched: ScheduleTiming): number {
  const [hh, mm] = sched.timeOfDay.split(":").map(Number);
  const now = zonedParts(nowMs, sched.timezone);
  if (sched.frequency === "monthly") {
    let candidate = zonedWallTimeToUtcMs(now.y, now.mo, now.d, hh, mm, sched.timezone);
    if (candidate <= nowMs) {
      let mo = now.mo + 1, y = now.y; if (mo > 12) { mo = 1; y++; }
      candidate = zonedWallTimeToUtcMs(y, mo, now.d, hh, mm, sched.timezone);
    }
    return candidate;
  }
  const targetDow = sched.dayOfWeek ?? now.dow;
  const delta = (targetDow - now.dow + 7) % 7;
  let next = addDaysToYmd(now.y, now.mo, now.d, delta);
  let candidate = zonedWallTimeToUtcMs(next.y, next.mo, next.d, hh, mm, sched.timezone);
  if (candidate <= nowMs) {
    next = addDaysToYmd(now.y, now.mo, now.d, delta + 7);
    candidate = zonedWallTimeToUtcMs(next.y, next.mo, next.d, hh, mm, sched.timezone);
  }
  return candidate;
}

// Used after a scheduled run fires: anchors on the run's own scheduled date
// (not "now", which may be a few minutes later due to the 15min poll
// granularity) so the cadence never drifts off the chosen day/time.
export function advanceNextRunAt(prevNextRunAt: number, sched: ScheduleTiming): number {
  const [hh, mm] = sched.timeOfDay.split(":").map(Number);
  const p = zonedParts(prevNextRunAt, sched.timezone);
  if (sched.frequency === "monthly") {
    let mo = p.mo + 1, y = p.y; if (mo > 12) { mo = 1; y++; }
    return zonedWallTimeToUtcMs(y, mo, p.d, hh, mm, sched.timezone);
  }
  const days = sched.frequency === "weekly" ? 7 : 14;
  const nd = addDaysToYmd(p.y, p.mo, p.d, days);
  return zonedWallTimeToUtcMs(nd.y, nd.mo, nd.d, hh, mm, sched.timezone);
}
