// Client Management health rules — pure, so scripts/test-client-health.mjs can
// prove every flag. No I/O, no clock reads (today is always passed in).
//
// The point of this module: a paying client who quietly gets no work is the one
// who churns. These rules surface them instead of letting them sit at the
// bottom of an alphabetical list.

export type WorkItem = { at: string; kind: string; text: string; url?: string }; // completed work, ISO timestamps
export type Touch = { at: string; channel: string; note?: string };  // outreach you logged

export type ToolLink = { key: string; label: string; connected: boolean };

export type ClientInput = {
  id: string;
  name: string;
  work: WorkItem[];
  touches: Touch[];
  tools: ToolLink[];
  openTasks: number;
  // Stripe, when linked
  stripeCustomerId?: string | null;
  subscriptionStatus?: "active" | "trialing" | "past_due" | "unpaid" | "canceled" | null;
  mrr?: number | null;
  // Per-client overrides (all optional; defaults below)
  targets?: { workPerMonth?: number; quietDays?: number; contactEveryDays?: number; paused?: boolean };
};

export const DEFAULTS = { workPerMonth: 4, quietDays: 14, contactEveryDays: 30 };

export type Flag = { key: string; label: string; detail: string; weight: number };

const DAY = 86400000;
const ms = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
export const daysBetween = (fromMs: number, toMs: number) => Math.floor((toMs - fromMs) / DAY);

export function latest(items: { at: string }[]): number | null {
  let best: number | null = null;
  for (const i of items || []) { const t = ms(i.at); if (t != null && (best == null || t > best)) best = t; }
  return best;
}

export function countInMonth(items: { at: string }[], monthPrefix: string): number {
  return (items || []).filter((i) => String(i.at).slice(0, 7) === monthPrefix).length;
}

/**
 * Assessment for one client. `nowMs` is "now"; `monthPrefix` is "YYYY-MM" in
 * the operator's timezone (so "this month" matches what they see on a calendar).
 */
export function assess(c: ClientInput, nowMs: number, monthPrefix: string) {
  const t = { ...DEFAULTS, ...(c.targets || {}) };
  const lastWorkAt = latest(c.work);
  const lastTouchAt = latest(c.touches);
  const workThisMonth = countInMonth(c.work, monthPrefix);
  const daysSinceWork = lastWorkAt == null ? null : daysBetween(lastWorkAt, nowMs);
  const daysSinceTouch = lastTouchAt == null ? null : daysBetween(lastTouchAt, nowMs);
  const missingTools = (c.tools || []).filter((x) => !x.connected).map((x) => x.label);

  const paying = c.subscriptionStatus === "active" || c.subscriptionStatus === "trialing";
  const churned = c.subscriptionStatus === "canceled";
  const pastDue = c.subscriptionStatus === "past_due" || c.subscriptionStatus === "unpaid";

  const flags: Flag[] = [];
  // Paused clients are deliberately quiet — never nag about work for them.
  const watchWork = !t.paused && !churned;

  if (pastDue) flags.push({ key: "past-due", label: "Past due", detail: "Stripe says the last payment failed.", weight: 100 });

  if (paying && missingTools.length) {
    flags.push({ key: "needs-setup", label: "Needs setup", detail: `Paying, but not connected to ${missingTools.join(", ")}.`, weight: 90 });
  }

  if (watchWork) {
    if (lastWorkAt == null) {
      flags.push({ key: "no-work", label: "No work yet", detail: "Nothing has been logged for this client.", weight: 80 });
    } else if (daysSinceWork! >= t.quietDays) {
      flags.push({ key: "quiet", label: "Quiet", detail: `No work in ${daysSinceWork} days.`, weight: 40 + Math.min(daysSinceWork! - t.quietDays, 40) });
    }
    if (lastWorkAt != null && workThisMonth < t.workPerMonth) {
      flags.push({ key: "light-month", label: "Light month", detail: `${workThisMonth} of ${t.workPerMonth} items done this month.`, weight: 20 + (t.workPerMonth - workThisMonth) * 5 });
    }
  }

  if (!t.paused && !churned) {
    if (lastTouchAt == null) {
      flags.push({ key: "never-contacted", label: "Never contacted", detail: "No outreach logged yet.", weight: 35 });
    } else if (daysSinceTouch! >= t.contactEveryDays) {
      flags.push({ key: "overdue-checkin", label: "Overdue check-in", detail: `No outreach in ${daysSinceTouch} days.`, weight: 30 + Math.min(daysSinceTouch! - t.contactEveryDays, 30) });
    }
  }

  // A bigger account being neglected matters more than a small one.
  const revenueWeight = 1 + Math.min((c.mrr || 0) / 1000, 1);
  const attention = churned || t.paused ? 0 : Math.round(flags.reduce((s, f) => s + f.weight, 0) * revenueWeight);

  const status = churned ? "Churned"
    : pastDue ? "Past due"
    : t.paused ? "Paused"
    : paying && missingTools.length ? "Needs setup"
    : paying ? "Active"
    : c.stripeCustomerId ? "No subscription"
    : "Not linked";

  return {
    id: c.id, name: c.name, status, flags, attention,
    lastWorkAt, lastTouchAt, daysSinceWork, daysSinceTouch,
    workThisMonth, workTarget: t.workPerMonth, openTasks: c.openTasks || 0,
    missingTools, mrr: c.mrr ?? null, subscriptionStatus: c.subscriptionStatus ?? null,
  };
}

/** Worst first. Ties break on revenue, then name, so the order is stable. */
export function rank(rows: ReturnType<typeof assess>[]) {
  return [...rows].sort((a, b) => b.attention - a.attention || (b.mrr || 0) - (a.mrr || 0) || a.name.localeCompare(b.name));
}

/** Plain-English update draft built ONLY from work actually logged. */
export function draftUpdate(name: string, work: WorkItem[], sinceMs: number, nowMs: number): string {
  const recent = (work || []).filter((w) => { const t = ms(w.at); return t != null && t >= sinceMs && t <= nowMs; })
    .sort((a, b) => (ms(b.at) || 0) - (ms(a.at) || 0));
  const first = String(name || "").trim().split(/\s+/)[0] || "there";
  if (!recent.length) return `Hi ${first},\n\nQuick check-in — wanted to see how things are going on your end and whether there's anything you'd like us to prioritize next.\n\nThanks!`;
  const lines = recent.slice(0, 12).map((w) => `• ${w.text}`).join("\n");
  const more = recent.length > 12 ? `\n…and ${recent.length - 12} more.` : "";
  return `Hi ${first},\n\nHere's what we've completed recently:\n\n${lines}${more}\n\nHappy to walk through any of it — just reply here.\n\nThanks!`;
}
