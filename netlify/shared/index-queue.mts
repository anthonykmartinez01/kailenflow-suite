// Staged indexing (task #56) — paces how many pages are submitted for
// indexing per client per day, instead of firing a whole batch at once.
//
// ─── Why a rate limit, not a scheduled batch ─────────────────────────────
// The obvious design is "release N pages once a day". That would be a
// REGRESSION for the common case: a single page going live would wait up to
// 24 hours for the next drain, where today it goes out within the hour. So
// this is a rolling allowance checked on the EXISTING hourly cron — one page
// still goes out immediately, a burst of twenty spreads across days, and no
// new scheduled function is needed.
//
// ─── Why there is no separate queue store ────────────────────────────────
// `client.publishing.indexHistory` already records `submittedAt` per path, so
// the last 24 hours of submissions can be counted from data that is already
// written. A page that is held back simply doesn't get a submission record
// yet, which makes it indistinguishable from "not yet indexed" — and the
// existing retry sweep in publish-page-log already picks those up on the next
// run. The queue is therefore implicit: no new collection, no second source
// of truth that can drift from reality.

export const DEFAULT_INDEX_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export type QueueDecision = {
  release: string[];      // paths to submit on this run
  deferred: string[];     // paths held back for pacing
  usedToday: number;      // submissions already made in the trailing 24h
  allowance: number;      // configured per-day cap
  remaining: number;      // slots left when this run started
};

/** How many distinct pages this client had submitted in the trailing 24h. */
export function submissionsInLast24h(history: Record<string, any> | undefined, now: number): number {
  if (!history) return 0;
  let n = 0;
  for (const rec of Object.values(history)) {
    const t = Date.parse((rec as any)?.submittedAt || "");
    if (Number.isFinite(t) && now - t < DAY_MS) n++;
  }
  return n;
}

/** Reads the per-client cap, falling back to the default. 0 disables pacing. */
export function allowanceFor(publishing: any): number {
  const raw = publishing?.indexPerDay;
  if (raw === 0) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_INDEX_PER_DAY;
}

/**
 * Decides which of this run's candidate pages actually get submitted.
 *
 * newPages are pages that just went live; retryPages are ones already logged
 * whose indexing hasn't fully succeeded. NEW PAGES TAKE PRIORITY, because a
 * permanently-failing retry (a client with no Search Console connected, say)
 * would otherwise consume the allowance every single day and starve every new
 * page behind it forever. One slot is still reserved for retries whenever
 * there is room, so the reverse starvation — a client publishing at exactly
 * the cap, so nothing is ever retried — can't happen either.
 *
 * Within each group, oldest go-live date first, so the backlog drains in the
 * order the pages were meant to be published.
 */
export function selectForSubmission(opts: {
  newPages: { path: string; date?: string }[];
  retryPages: { path: string; date?: string }[];
  history?: Record<string, any>;
  publishing?: any;
  now: number;
}): QueueDecision {
  const allowance = allowanceFor(opts.publishing);
  const usedToday = submissionsInLast24h(opts.history, opts.now);

  const byDate = (a: { date?: string }, b: { date?: string }) => String(a.date || "").localeCompare(String(b.date || ""));
  const news = opts.newPages.slice().sort(byDate);
  const retries = opts.retryPages.slice().sort(byDate);

  // allowance 0 means "no pacing" — submit everything, preserving the old
  // behaviour for anyone who wants it back.
  if (allowance === 0) {
    return {
      release: [...news, ...retries].map((p) => p.path),
      deferred: [], usedToday, allowance: 0, remaining: Infinity,
    };
  }

  const remaining = Math.max(0, allowance - usedToday);
  const reserveForRetry = retries.length > 0 && remaining > 1 ? 1 : 0;

  const releasedNew = news.slice(0, Math.max(0, remaining - reserveForRetry));
  const releasedRetry = retries.slice(0, Math.max(0, remaining - releasedNew.length));
  const release = [...releasedNew, ...releasedRetry].map((p) => p.path);
  const releasedSet = new Set(release);
  const deferred = [...news, ...retries].map((p) => p.path).filter((p) => !releasedSet.has(p));

  return { release, deferred, usedToday, allowance, remaining };
}
