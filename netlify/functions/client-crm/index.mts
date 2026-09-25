import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { readAppData } from "../../shared/firestore-admin.mts";
import { stripeKey, stripeCustomers, suggestMatch, type StripeCustomer } from "../../shared/stripe.mts";
import { assess, rank, DEFAULTS, type ClientInput, type WorkItem } from "../../shared/client-health.mts";
import { buildWeeklyUpdate, type Item } from "../../shared/client-update-email.mts";
import { TZ, todayIn, keyStr } from "../../shared/gbp-portfolio-window.mts";
import { gmailGranted } from "../../shared/gmail.mts";
import { gmailSyncAll, githubSyncAll, ingestFromRepo, merchyntSyncAll } from "../../shared/client-sync.mts";
import { merchyntKey, probeSlugs } from "../../shared/merchynt.mts";

// CLIENT MANAGEMENT — one place for every client: who's paying, what tools
// they're connected to, what work has actually been done, when you last
// reached out, and who needs attention.
//
// POST /api/client-crm
//   {action:"list", fresh}                        -> ranked rows + Stripe + pending approvals
//   {action:"link", clientId, stripeCustomerId}   -> approve a Stripe customer onto a client
//   {action:"ignore", stripeCustomerId}           -> keep a Stripe customer out of the list
//   {action:"unignore", stripeCustomerId}
//   {action:"targets", clientId, targets}         -> per-client thresholds / pause
//   {action:"tools", clientId, tools}             -> mark Merchynt / Elara / other tools connected
//   {action:"touch", clientId, channel, note}     -> log that you reached out
//   {action:"untouch", clientId, touchId}
//   {action:"email", clientId, email}             -> address used to match Gmail
//   {action:"gmail-sync"}                         -> read-only Gmail search for last contact
//   {action:"github-sync"}                        -> read-only commit log per client site
//   {action:"merchynt-sync"}                      -> read-only Paige reviews + audit leads
//   {action:"merchynt-slug", clientId, slug}      -> that client's Paige slug
//   {action:"draft", clientId, days}              -> weekly summary email (text + html)
//
// READ-ONLY toward Stripe (the same restricted key the EOD report uses) and
// toward appData — client records are never modified here. CRM extras live in
// their own Blobs store, NOT appData/main (1MiB cap).

const STORE = "client-crm";
const RECORDS = "records";
const IGNORED = "stripe-ignored";
const STRIPE_CACHE = "stripe-cache";
const STRIPE_TTL_MS = 10 * 60 * 1000;

type Rec = {
  stripeCustomerId?: string | null;
  email?: string | null;
  merchyntSlug?: string | null;
  // Reported by a Claude Code session via /api/client-ingest, keyed by source.
  external?: Record<string, { at: number; connected: boolean; status: string | null; fields: any }>;
  externalWork?: Record<string, { at: string; kind: string; text: string }[]>;
  externalTouches?: Record<string, { at: string; channel: string; note: string; direction: string }[]>;
  // Newest email found by Gmail sync. Kept apart from the manual log so a sync
  // can never overwrite something you recorded by hand.
  autoEmail?: { at: string; subject: string; direction: string; with: string } | null;
  targets?: { workPerMonth?: number; quietDays?: number; contactEveryDays?: number; paused?: boolean };
  tools?: Record<string, boolean>;   // manually-tracked tools (merchynt, elara, …)
  touches?: { id: string; at: string; channel: string; note?: string }[];
};

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}
const uid = () => Math.random().toString(36).slice(2, 10);

// Tools whose connection we can PROVE from the client record, plus ones you
// tick yourself. "Needs setup" is built from these.
function toolsFor(client: any, rec: Rec) {
  const manual = rec.tools || {};
  // Sources a session has reported on are connected by definition.
  const ext = rec.external || {};
  const extra = Object.keys(ext)
    .filter((k) => !["stripe", "ghl", "gbp", "gsc", "website", "merchynt", "elara"].includes(k))
    .map((k) => ({ key: k, label: k.charAt(0).toUpperCase() + k.slice(1), connected: ext[k]?.connected !== false }));
  return [...extra,
    { key: "stripe", label: "Stripe", connected: !!rec.stripeCustomerId },
    { key: "ghl", label: "GoHighLevel", connected: !!(client.ghlLocationId && client.ghlPrivateToken) },
    { key: "gbp", label: "Google Business Profile", connected: !!(client.gbpLocationId || client.placeId) },
    { key: "gsc", label: "Search Console", connected: !!client.gscProperty },
    { key: "website", label: "Website", connected: !!client.website },
    { key: "merchynt", label: "Merchynt (Paige)", connected: !!manual.merchynt || ext.merchynt?.connected === true },
    { key: "elara", label: "Elara", connected: !!manual.elara || ext.elara?.connected === true },
  ];
}

// Work = what this app (and you) actually logged for the client.
function workFor(client: any, rec: Rec = {}): WorkItem[] {
  const out: WorkItem[] = [];
  for (const a of client.activities || []) {
    if (!a?.date) continue;
    out.push({ at: a.date, kind: a.category || "other", text: a.text || "Work logged" });
  }
  for (const t of client.tasks || []) {
    // Completed tasks already write an activity; only count ones that didn't.
    if (t?.status === "Completed" && t.completedAt && !(client.activities || []).some((a: any) => a.taskId === t.id)) {
      out.push({ at: t.completedAt, kind: "task", text: `Completed: ${t.title || "task"}` });
    }
  }
  // Work reported by a session (Elara and friends) counts the same as work
  // done in this app — it's real work for the client either way.
  for (const [source, items] of Object.entries(rec.externalWork || {})) {
    for (const w of items || []) if (w?.at && w.text) out.push({ at: w.at, kind: w.kind || source, text: w.text, url: (w as any).url || undefined });
  }
  return out;
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* empty is fine */ }
  const action = String(body.action || "list");
  const store = getStore(STORE);

  const loadRecords = async (): Promise<Record<string, Rec>> =>
    ((await store.get(RECORDS, { type: "json" }).catch(() => null)) || {}) as Record<string, Rec>;
  const saveRecords = (r: Record<string, Rec>) => store.setJSON(RECORDS, r);
  const loadIgnored = async (): Promise<string[]> =>
    ((await store.get(IGNORED, { type: "json" }).catch(() => null)) || []) as string[];

  try {
    const records = await loadRecords();

    // ---- writes (our own store only; never Stripe, never client records) ----
    if (action === "link" || action === "targets" || action === "tools" || action === "touch" || action === "untouch" || action === "email" || action === "merchynt-slug") {
      const clientId = String(body.clientId || "");
      if (!clientId) return json({ error: "clientId is required" }, 400);
      const rec: Rec = records[clientId] || {};
      if (action === "link") {
        const cid = body.stripeCustomerId ? String(body.stripeCustomerId) : null;
        // One Stripe customer can only belong to one client.
        if (cid) for (const [id, r] of Object.entries(records)) if (id !== clientId && r.stripeCustomerId === cid) r.stripeCustomerId = null;
        rec.stripeCustomerId = cid;
      }
      if (action === "merchynt-slug") rec.merchyntSlug = String(body.slug || "").trim().slice(0, 120) || null;
      if (action === "email") rec.email = String(body.email || "").trim().slice(0, 200) || null;
      if (action === "targets") rec.targets = { ...(rec.targets || {}), ...(body.targets || {}) };
      if (action === "tools") rec.tools = { ...(rec.tools || {}), ...(body.tools || {}) };
      if (action === "touch") {
        rec.touches = [{ id: uid(), at: new Date().toISOString(), channel: String(body.channel || "note"), note: String(body.note || "").slice(0, 500) }, ...(rec.touches || [])].slice(0, 200);
      }
      if (action === "untouch") rec.touches = (rec.touches || []).filter((t) => t.id !== String(body.touchId));
      records[clientId] = rec;
      await saveRecords(records);
      return json({ ok: true });
    }

    if (action === "ignore" || action === "unignore") {
      const cid = String(body.stripeCustomerId || "");
      if (!cid) return json({ error: "stripeCustomerId is required" }, 400);
      const ignored = new Set(await loadIgnored());
      action === "ignore" ? ignored.add(cid) : ignored.delete(cid);
      await store.setJSON(IGNORED, [...ignored]);
      return json({ ok: true });
    }

    // ---- reads ----
    const app = await readAppData();
    const clients: any[] = app.clients || [];

    // Gmail sync: read-only search for the most recent message with each
    // client. Never sends, never modifies, never reads message bodies.
    if (action === "merchynt-probe") {
      const key = merchyntKey();
      if (!key) return json({ error: "MERCHYNT_API_KEY isn't set in Netlify." }, 400);
      const names = (clients || []).map((c: any) => c.name).filter(Boolean).slice(0, 4);
      const results: any[] = [];
      for (const n of names) results.push({ client: n, tried: await probeSlugs(n, key, [String(body.slug || "")]) });
      return json({ results });
    }

    if (action === "merchynt-sync") {
      const r = await merchyntSyncAll();
      if (!r.ok) return json({ error: r.reason }, 400);
      return json(r);
    }

    if (action === "repo-ingest") {
      const r = await ingestFromRepo();
      if (!r.ok) return json({ error: r.reason }, 400);
      return json(r);
    }

    if (action === "github-sync") {
      const r = await githubSyncAll();
      if (!r.ok) return json({ error: r.reason }, 400);
      return json(r);
    }

    if (action === "gmail-sync") {
      // Same code path as the nightly cron (shared/client-sync.mts).
      const r = await gmailSyncAll();
      if (r.needsGmail) return json({ needsGmail: true, reason: r.reason });
      return json(r);
    }

    if (action === "draft") {
      const client = clients.find((c) => c.id === String(body.clientId));
      if (!client) return json({ error: "Client not found" }, 404);
      const days = Math.max(1, Math.min(90, Number(body.days) || 7));
      const now = Date.now();
      const since = now - days * 86400000;

      const done: Item[] = workFor(client, records[client.id] || {})
        .filter((w) => { const t = Date.parse(w.at); return Number.isFinite(t) && t >= since && t <= now; })
        .map((w) => ({ at: w.at, text: w.text, url: (w as any).url }));

      // What's already scheduled for the coming week — never invented, only
      // things with a real date on them.
      const ahead = now + 7 * 86400000;
      const upcoming: Item[] = [];
      for (const t of client.tasks || []) {
        const due = Date.parse(t?.dueDate || t?.date || "");
        if (t?.status !== "Completed" && Number.isFinite(due) && due >= now && due <= ahead) {
          upcoming.push({ at: new Date(due).toISOString(), text: String(t.title || "task") });
        }
      }
      for (const p of client.generatedPages || []) {
        const at = Date.parse(p?.scheduledFor || p?.publishDate || "");
        if (Number.isFinite(at) && at >= now && at <= ahead) {
          upcoming.push({ at: new Date(at).toISOString(), text: `Publish a new page${p.title ? `: ${p.title}` : ""}` });
        }
      }

      const built = buildWeeklyUpdate({
        clientName: client.name || "your business",
        contactName: client.contactName || client.ownerName || "",
        done, upcoming, nowMs: now,
      });
      return json({ ...built, days });
    }

    if (action !== "list") return json({ error: `Unknown action "${action}"` }, 400);

    // Stripe: cached briefly so opening the page repeatedly doesn't re-poll.
    let stripe: { customers: StripeCustomer[]; at: number } | null = null;
    let stripeError: string | null = null;
    const key = stripeKey();
    if (!key) stripeError = "STRIPE_API_KEY isn't set in Netlify.";
    else {
      const cached = (await store.get(STRIPE_CACHE, { type: "json" }).catch(() => null)) as any;
      if (!body.fresh && cached?.at && Date.now() - cached.at < STRIPE_TTL_MS) stripe = cached;
      else {
        try {
          stripe = { customers: await stripeCustomers(key), at: Date.now() };
          await store.setJSON(STRIPE_CACHE, stripe).catch(() => null);
        } catch (e: any) {
          stripeError = String(e?.message || e);
          if (cached?.customers) stripe = cached; // stale beats nothing
        }
      }
    }
    const byCustomer = new Map((stripe?.customers || []).map((c) => [c.id, c]));

    const today = keyStr(todayIn(TZ));
    const monthPrefix = today.slice(0, 7);
    const now = Date.now();

    const rows = clients.map((client) => {
      const rec: Rec = records[client.id] || {};
      const sc = rec.stripeCustomerId ? byCustomer.get(rec.stripeCustomerId) : undefined;
      const input: ClientInput = {
        id: client.id,
        name: client.name || "Untitled client",
        work: workFor(client, rec),
        // Manual log + whatever Gmail found, merged for "last contacted".
        touches: [
          ...(rec.touches || []),
          // Contact reported by a session (Paige's automated emails, client replies).
          ...Object.entries(rec.externalTouches || {}).flatMap(([src, list]) =>
            (list || []).map((t, i) => ({ id: `${src}-${i}`, at: t.at, channel: t.channel, note: `${t.direction === "from-client" ? "Client replied: " : ""}${t.note}` }))),
          ...(rec.autoEmail ? [{ id: "auto-email", at: rec.autoEmail.at, channel: "email", note: rec.autoEmail.subject }] : []),
        ],
        tools: toolsFor(client, rec),
        openTasks: (client.tasks || []).filter((t: any) => t?.status !== "Completed").length,
        stripeCustomerId: rec.stripeCustomerId || null,
        subscriptionStatus: sc?.status ?? null,
        mrr: sc?.mrr ?? null,
        targets: rec.targets,
      };
      const a = assess(input, now, monthPrefix);
      return {
        ...a,
        city: client.city || "",
        website: client.website || "",
        tools: input.tools,
        targets: { ...DEFAULTS, ...(rec.targets || {}) },
        touches: [
          ...(rec.touches || []),
          ...Object.entries(rec.externalTouches || {}).flatMap(([src, list]) =>
            (list || []).map((t, i) => ({ id: `${src}-${i}`, at: t.at, channel: `${t.channel} (${src})`, note: `${t.direction === "from-client" ? "Client replied: " : ""}${t.note}` }))),
        ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 10),
        autoEmail: rec.autoEmail || null,
        merchyntSlug: rec.merchyntSlug || null,
        external: rec.external || null,
        email: rec.email || null,
        recentWork: input.work.sort((x, y) => Date.parse(y.at) - Date.parse(x.at)).slice(0, 8),
        stripe: sc ? { id: sc.id, plan: sc.plan, lastPaymentAt: sc.lastPaymentAt, lastPaymentAmount: sc.lastPaymentAmount, currentPeriodEnd: sc.currentPeriodEnd } : null,
      };
    });

    // Stripe customers not attached to any client yet — your approval queue.
    const linked = new Set(Object.values(records).map((r) => r.stripeCustomerId).filter(Boolean) as string[]);
    const ignored = new Set(await loadIgnored());
    const slim = clients.map((c) => ({ id: c.id, name: c.name, email: c.email }));
    const pending = (stripe?.customers || [])
      .filter((c) => !linked.has(c.id) && !ignored.has(c.id))
      .map((c) => ({ ...c, suggestedClientId: suggestMatch(c, slim) }));

    const ranked = rank(rows as any);
    return json({
      clients: ranked,
      needsAttention: ranked.filter((r: any) => r.attention > 0).slice(0, 8).map((r: any) => r.id),
      pending,
      ignoredCount: ignored.size,
      gmail: await gmailGranted(),
      stripeAt: stripe?.at || null,
      stripeError,
      totals: {
        clients: rows.length,
        active: rows.filter((r) => r.status === "Active").length,
        needsSetup: rows.filter((r) => r.status === "Needs setup").length,
        pastDue: rows.filter((r) => r.status === "Past due").length,
        churned: rows.filter((r) => r.status === "Churned").length,
        mrr: Math.round(rows.reduce((t, r) => t + (r.mrr || 0), 0) * 100) / 100,
      },
      today,
    });
  } catch (e: any) {
    return json({ error: "Couldn't load client management.", detail: String(e?.message || e) }, 500);
  }
};

export const config: Config = { path: "/api/client-crm" };
