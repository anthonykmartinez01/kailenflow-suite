import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

// LIVE End of Day — pulls numbers straight from the sources in real time:
//   • Cold calls today  → GoHighLevel (outbound calls dialed today)
//   • Booked calls      → Calendly (bookings made)
//   • MRR / clients / new clients / revenue → Stripe
// No Slack dependency. Day boundaries use America/Chicago (the user's timezone).

const TZ = "America/Chicago";
const dayStr = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(ms)); // YYYY-MM-DD
const toMs = (v: any): number => {
  if (v == null) return 0;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
};
function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store, max-age=0" },
  });
}

// ---------- Stripe ----------
async function stripeGet(path: string, key: string) {
  const r = await fetch("https://api.stripe.com/v1/" + path, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`Stripe ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return r.json();
}
async function stripeAll(path: string, key: string, cap = 5) {
  let out: any[] = [], starting_after = "", pages = 0;
  while (pages++ < cap) {
    const sep = path.includes("?") ? "&" : "?";
    const page = await stripeGet(`${path}${sep}limit=100${starting_after ? `&starting_after=${starting_after}` : ""}`, key);
    out = out.concat(page.data || []);
    if (!page.has_more || !page.data?.length) break;
    starting_after = page.data[page.data.length - 1].id;
  }
  return out;
}
function subMonthlyCents(sub: any): number {
  let cents = 0;
  for (const it of (sub.items?.data || [])) {
    const p = it.price || {};
    const amt = (p.unit_amount || 0) * (it.quantity || 1);
    const int = p.recurring?.interval, cnt = p.recurring?.interval_count || 1;
    if (int === "year") cents += amt / (12 * cnt);
    else if (int === "week") cents += (amt * 52) / (12 * cnt);
    else if (int === "day") cents += (amt * 365) / (12 * cnt);
    else cents += amt / cnt; // month
  }
  return cents;
}
async function fromStripe(key: string, todayStr: string, monthStr: string) {
  const subs = (await stripeAll("subscriptions?status=all", key)).filter((s: any) => ["active", "trialing", "past_due"].includes(s.status));
  let mrr = 0;
  for (const s of subs) mrr += subMonthlyCents(s);
  const newToday = subs.filter((s: any) => dayStr(toMs(s.created)) === todayStr).length;
  const newMonth = subs.filter((s: any) => dayStr(toMs(s.created)).slice(0, 7) === monthStr).length;

  const charges = await stripeAll("charges", key);
  let revToday = 0, revMonth = 0;
  for (const c of charges) {
    if (c.status !== "succeeded" || c.refunded) continue;
    const net = (c.amount || 0) - (c.amount_refunded || 0);
    const d = dayStr(toMs(c.created));
    if (d === todayStr) revToday += net;
    if (d.slice(0, 7) === monthStr) revMonth += net;
  }
  return {
    mrr: Math.round(mrr) / 100, activeClients: subs.length,
    newClientsToday: newToday, newClientsMonth: newMonth,
    revenueToday: Math.round(revToday) / 100, revenueMonth: Math.round(revMonth) / 100,
  };
}

// ---------- Calendly ----------
// A "booked call" = a NEW booking on this specific Calendly event type only.
const BOOKED_EVENT_NAME = "kailenflow strategy session";

async function calGet(url: string, token: string) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Calendly ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return r.json();
}

// Run async work with bounded concurrency.
async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

// Pull the invitee's identity (name / email / phone / business) for one event.
// Cached in Blobs by event UUID — an event's invitee never changes, so we fetch
// it once and reuse forever. Used to spot rebookings by the same person.
async function inviteeIdentity(eventUri: string, token: string, store: any) {
  const uuid = eventUri.split("/").pop() || eventUri;
  const key = "cinv:" + uuid;
  try { const cached = await store.get(key, { type: "json" }); if (cached) return cached; } catch {}
  const id: any = { name: "", email: "", phone: "", business: "" };
  try {
    const d = await calGet(`${eventUri}/invitees?count=10`, token);
    const inv = (d.collection || [])[0];
    if (inv) {
      id.name = (inv.name || "").trim().toLowerCase();
      id.email = (inv.email || "").trim().toLowerCase();
      id.phone = (inv.text_reminder_number || "").replace(/\D/g, "").slice(-10);
      for (const qa of (inv.questions_and_answers || [])) {
        const q = (qa.question || "").toLowerCase(), a = (qa.answer || "").toString().trim();
        if (!id.phone && /phone|mobile|cell|number/.test(q)) id.phone = a.replace(/\D/g, "").slice(-10);
        if (/business|company|organization|org\b/.test(q)) id.business = a.toLowerCase();
      }
    }
  } catch {}
  try { await store.setJSON(key, id); } catch {}
  return id;
}

async function fromCalendly(token: string, todayStr: string, weekStartStr: string, monthStr: string, store: any) {
  const me = await calGet("https://api.calendly.com/users/me", token);
  const userUri = me.resource?.uri;
  // Look back 60 days so a rebooking whose ORIGINAL booking is a bit old still
  // gets recognized as a repeat (and not counted again). Forward 120 days for
  // upcoming meetings.
  const minStart = new Date(Date.now() - 60 * 86400000).toISOString();
  const maxStart = new Date(Date.now() + 120 * 86400000).toISOString();
  let url = `https://api.calendly.com/scheduled_events?user=${encodeURIComponent(userUri)}&status=active&min_start_time=${encodeURIComponent(minStart)}&max_start_time=${encodeURIComponent(maxStart)}&count=100`;

  // 1) Gather only the "KailenFlow Strategy Session" events.
  const events: any[] = [];
  let pages = 0;
  while (url && pages++ < 6) {
    const d = await calGet(url, token);
    for (const ev of (d.collection || [])) {
      if ((ev.name || "").trim().toLowerCase() === BOOKED_EVENT_NAME) events.push(ev);
    }
    url = d.pagination?.next_page || "";
  }

  // 2) Get each booking's invitee identity (cached).
  await pool(events, 8, async (ev) => { ev._id = await inviteeIdentity(ev.uri, token, store); });

  // 3) Dedupe rebookings: oldest booking per person wins; later ones (same phone /
  //    email / name / business) are treated as reschedules, not new meetings.
  events.sort((a, b) => toMs(a.created_at) - toMs(b.created_at));
  const seenPhone = new Set<string>(), seenEmail = new Set<string>(), seenName = new Set<string>(), seenBiz = new Set<string>();
  let bookedToday = 0, bookedWeek = 0, bookedMonth = 0;
  for (const ev of events) {
    const id = ev._id || {};
    const repeat =
      (id.phone && seenPhone.has(id.phone)) ||
      (id.email && seenEmail.has(id.email)) ||
      (id.name && seenName.has(id.name)) ||
      (id.business && seenBiz.has(id.business));
    if (repeat) continue;
    if (id.phone) seenPhone.add(id.phone);
    if (id.email) seenEmail.add(id.email);
    if (id.name) seenName.add(id.name);
    if (id.business) seenBiz.add(id.business);
    const day = dayStr(toMs(ev.created_at));
    if (day === todayStr) bookedToday++;
    if (day >= weekStartStr && day <= todayStr) bookedWeek++;
    if (day.slice(0, 7) === monthStr) bookedMonth++;
  }
  return { bookedToday, bookedWeek, bookedMonth };
}

// ---------- GoHighLevel (cold calls dialed today) ----------
async function ghlGet(path: string, token: string) {
  const r = await fetch("https://services.leadconnectorhq.com" + path, {
    headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`GHL ${r.status}`);
  return r.json();
}
async function coldCallsCount(token: string, loc: string, todayStr: string, weekStartStr: string) {
  // Count conversations whose latest activity is a call, both for TODAY and for
  // THIS WEEK. Reads only the conversation LIST (not each conversation's
  // messages) — stable and rate-limit-safe. Conversations sort by last activity,
  // so we page from newest until we pass the start of the week.
  let today = 0, week = 0, startAfterDate = "", startAfter = "", pages = 0, done = false;
  while (pages++ < 20 && !done) {
    const cursor = startAfterDate ? `&startAfterDate=${startAfterDate}&startAfter=${startAfter}` : "";
    const r = await ghlGet(`/conversations/search?locationId=${encodeURIComponent(loc)}&limit=100&sortBy=last_message_date&sort=desc${cursor}`, token);
    const batch: any[] = r.conversations || [];
    if (!batch.length) break;
    for (const c of batch) {
      const d = dayStr(toMs(c.lastMessageDate || c.dateUpdated || c.dateAdded));
      if (d > todayStr) continue;
      if (d < weekStartStr) { done = true; break; }
      if (/call/i.test((c.lastMessageType || c.type || "").toString())) {
        week++;
        if (d === todayStr) today++;
      }
    }
    const last = batch[batch.length - 1];
    startAfterDate = String(toMs(last.lastMessageDate || last.dateUpdated || last.dateAdded));
    startAfter = last.id;
    if (batch.length < 100) break;
  }
  return { today, week };
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();

  const now = Date.now();
  const todayStr = dayStr(now);
  const monthStr = todayStr.slice(0, 7);
  // Start of this week (Monday) in the user's timezone.
  const weekdayShort = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(new Date(now));
  const wdIdx = ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[weekdayShort] ?? 0;
  const wsDate = new Date(todayStr + "T12:00:00Z");
  wsDate.setUTCDate(wsDate.getUTCDate() - wdIdx);
  const weekStartStr = wsDate.toISOString().slice(0, 10);
  const fmtMD = (s: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(s + "T12:00:00Z"));
  const weekLabel = `${fmtMD(weekStartStr)} – ${fmtMD(todayStr)}`;
  const errors: Record<string, string> = {};

  const stripeKey = Netlify.env.get("STRIPE_API_KEY");
  const calToken = Netlify.env.get("CALENDLY_API_TOKEN");
  const ghlToken = Netlify.env.get("GHL_API_TOKEN");
  const ghlLoc = Netlify.env.get("GHL_LOCATION_ID");
  const calStore = getStore("calendly");

  const [stripeRes, calRes, ghlRes] = await Promise.all([
    stripeKey ? fromStripe(stripeKey, todayStr, monthStr).catch((e) => { errors.stripe = String(e.message || e); return null; }) : (errors.stripe = "no key", null),
    calToken ? fromCalendly(calToken, todayStr, weekStartStr, monthStr, calStore).catch((e) => { errors.calendly = String(e.message || e); return null; }) : (errors.calendly = "no key", null),
    (ghlToken && ghlLoc) ? coldCallsCount(ghlToken, ghlLoc, todayStr, weekStartStr).catch((e) => { errors.ghl = String(e.message || e); return null; }) : (errors.ghl = "no key", null),
  ]);

  // One-off manual booked-call adjustments (e.g. a real booking made on the wrong
  // Calendly calendar so it isn't caught automatically). Dated, so each counts in
  // the right today/week/month bucket and naturally ages out afterward. Remove an
  // entry once it's no longer needed.
  const MANUAL_BOOKINGS: { date: string; note?: string }[] = [
    { date: "2026-07-07", note: "booked on wrong calendar" },
  ];
  let manToday = 0, manWeek = 0, manMonth = 0;
  for (const mb of MANUAL_BOOKINGS) {
    if (mb.date === todayStr) manToday++;
    if (mb.date >= weekStartStr && mb.date <= todayStr) manWeek++;
    if (mb.date.slice(0, 7) === monthStr) manMonth++;
  }

  const dateLabel = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "long", day: "numeric", year: "numeric" }).format(new Date(now));
  return json({
    live: true,
    generatedAt: now,
    today: {
      dateLabel,
      coldCalls: ghlRes?.today ?? null,
      bookedCalls: calRes ? calRes.bookedToday + manToday : null,
      newClients: stripeRes?.newClientsToday ?? null,
      revenue: stripeRes?.revenueToday ?? null,
      mrr: stripeRes?.mrr ?? null,
      activeClients: stripeRes?.activeClients ?? null,
    },
    week: {
      label: weekLabel,
      coldCalls: ghlRes?.week ?? null,
      bookedCalls: calRes ? calRes.bookedWeek + manWeek : null,
    },
    month: {
      label: new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "long", year: "numeric" }).format(new Date(now)),
      bookedCalls: calRes ? calRes.bookedMonth + manMonth : null,
      newClients: stripeRes?.newClientsMonth ?? null,
      revenue: stripeRes?.revenueMonth ?? null,
    },
    errors: Object.keys(errors).length ? errors : undefined,
  });
};

export const config: Config = { path: "/api/eod-report" };
