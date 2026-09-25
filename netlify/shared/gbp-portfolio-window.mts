// Date-window math for GBP Portfolio, kept pure (no Google calls, no clock
// reads, no host timezone) so scripts/test-gbp-portfolio-window.mjs can prove
// every number lands in the right month.
//
// Days are plain integers yyyymmdd. Using Date objects in local time here was
// the source of real bugs: Netlify runs in UTC, so after 7pm Central "yesterday"
// was already tomorrow's yesterday.

export const TZ = "America/Chicago";

const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (y: number, m: number, d: number) => y * 10000 + m * 100 + d;
export const keyParts = (k: number) => ({ y: Math.floor(k / 10000), m: Math.floor(k / 100) % 100, d: k % 100 });
export const keyStr = (k: number) => { const p = keyParts(k); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
export const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const addDays = (k: number, n: number) => {
  const p = keyParts(k);
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return dayKey(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};

/** Today's date in Anthony's timezone, whatever the server's clock zone is. */
export function todayIn(tz: string, now: Date = new Date()): number {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [y, m, d] = s.split("-").map(Number);
  return dayKey(y, m, d);
}

/** "YYYY-MM" -> {y, m}; anything malformed falls back to today's month. */
export function parseMonth(input: unknown, today: number): { y: number; m: number; month: string } {
  const t = keyParts(today);
  const s = String(input ?? "");
  const ok = /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
  const y = ok ? Number(s.slice(0, 4)) : t.y;
  const m = ok ? Number(s.slice(5, 7)) : t.m;
  return { y, m, month: `${y}-${pad(m)}` };
}

export type MonthPlan = {
  y: number; m: number;
  monthsBack: number;
  isCurrentMonth: boolean;
  start: number;
  monthEnd: number;
  nominalEnd: number;   // yesterday for the live month, month end otherwise
  prevY: number; prevM: number;
  prevStart: number;
  prevMonthEnd: number;
  requestStart: number; // one Google request covers both windows
  requestEnd: number;
  settled: boolean;     // month ended 8+ days ago: Google's numbers are final
};

export function planMonth(y: number, m: number, today: number): MonthPlan {
  const t = keyParts(today);
  const monthsBack = (t.y - y) * 12 + (t.m - m);
  const start = dayKey(y, m, 1);
  const monthEnd = dayKey(y, m, daysIn(y, m));
  const yesterday = addDays(today, -1);
  const isCurrentMonth = monthsBack === 0;
  const nominalEnd = isCurrentMonth ? yesterday : monthEnd;
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const prevStart = dayKey(prevY, prevM, 1);
  const prevMonthEnd = dayKey(prevY, prevM, daysIn(prevY, prevM));
  return {
    y, m, monthsBack, isCurrentMonth, start, monthEnd, nominalEnd,
    prevY, prevM, prevStart, prevMonthEnd,
    requestStart: prevStart,
    requestEnd: Math.min(nominalEnd, yesterday),
    settled: monthEnd <= addDays(today, -8),
  };
}

export type Windows = {
  empty: boolean;                        // nothing reported for this month yet
  cur: { start: number; end: number };
  prev: { start: number; end: number };
  trimmedForLag: boolean;                // end pulled back to Google's last filled-in day
};

/**
 * Final windows once we know the latest day Google actually has data for
 * (across all selected listings). Google fills in the last ~2–3 days late;
 * counting those half-empty days against a complete last month made every
 * month look like a drop. So until a month is settled, it ends on the last day
 * with data, and last month is cut to the SAME number of days.
 */
export function finalizeWindows(plan: MonthPlan, lastDataKey: number | null): Windows {
  let end = plan.nominalEnd;
  let empty = end < plan.start; // e.g. the 1st of the month
  if (!empty && !plan.settled && lastDataKey != null) {
    if (lastDataKey < plan.start) empty = true;          // month started, Google has nothing yet
    else if (lastDataKey < end) end = lastDataKey;
  }
  if (empty) {
    return { empty: true, cur: { start: plan.start, end: plan.start - 1 }, prev: { start: plan.prevStart, end: plan.prevStart - 1 }, trimmedForLag: false };
  }
  const prevEnd = end === plan.monthEnd
    ? plan.prevMonthEnd
    : dayKey(plan.prevY, plan.prevM, Math.min(keyParts(end).d, daysIn(plan.prevY, plan.prevM)));
  return { empty: false, cur: { start: plan.start, end }, prev: { start: plan.prevStart, end: prevEnd }, trimmedForLag: end < plan.nominalEnd };
}

/** Which window a day belongs to. Days between the two windows count for neither. */
export function classify(w: Windows, day: number): "cur" | "prev" | null {
  if (day >= w.cur.start && day <= w.cur.end) return "cur";
  if (day >= w.prev.start && day <= w.prev.end) return "prev";
  return null;
}
