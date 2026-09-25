// Weekly client update email — modelled on the Paige "Weekly Summary" layout
// Anthony uses: greeting, "What we did the past 7 days", "What we're doing in
// the next 7 days", short sign-off.
//
// ─── Deliverability rules encoded here (not left to chance) ────────────────
// Sent from Anthony's own Gmail to a client who knows him, so the risk isn't
// spam filters hating the sender — it's the MESSAGE looking automated:
// • Always produce a real plain-text version. Gmail compose takes text only,
//   and text-only mail is the most deliverable format there is.
// • Never image-only. The HTML version is text with a small optional logo, so
//   it still reads with images blocked.
// • Cap the links (MAX_LINKS). Long link lists are the strongest spam signal
//   in an otherwise normal email — the example template had 40+.
// • No link shorteners, no tracking pixels, no attachments.
// • No ALL-CAPS, no exclamation pile-ups, no money/urgency words (SPAM_WORDS).
// • Collapse repeats ("publish a post to GBP" ×10) — repetition reads as bulk.
// • Subject stays short, specific, and free of spam triggers.

export type Item = { at: string; text: string; url?: string };

const MAX_LINKS = 12;
const MAX_BULLETS = 14;
const DAY = 86400000;

// Words that push an otherwise-normal email toward the promotions tab or spam.
const SPAM_WORDS = /\b(free|guarantee[d]?|act now|limited time|click here|buy now|cash|discount|earn|income|no obligation|risk[- ]free|urgent|winner|congratulations)\b/gi;

export const escapeHtml = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function firstName(name: string): string {
  const n = String(name || "").trim().split(/\s+/)[0] || "";
  return n && !/^(the|a|an)$/i.test(n) ? n : "there";
}

/** "5 days ago", "yesterday", "today" / "in 3 days", "tomorrow". */
export function whenLabel(atMs: number, nowMs: number, future: boolean): string {
  const days = Math.abs(Math.round((future ? atMs - nowMs : nowMs - atMs) / DAY));
  if (days === 0) return "today";
  if (days === 1) return future ? "tomorrow" : "yesterday";
  return future ? `in ${days} days` : `${days} days ago`;
}

/** Turns an internal work line into something a client reads naturally. */
export function phrase(text: string): string {
  const t = String(text || "").trim();
  if (!t) return "";
  const rules: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^published new page:\s*(.+)$/i, (m) => `published a new page (${m[1]})`],
    [/^submitted for indexing:\s*(.+)$/i, (m) => `submitted ${m[1]} to Google for indexing`],
    [/^website:\s*(.+)$/i, (m) => `updated the website — ${m[1].charAt(0).toLowerCase() + m[1].slice(1)}`],
    [/^completed:\s*(.+)$/i, (m) => `completed ${m[1]}`],
    [/^elara:\s*(.+)$/i, (m) => m[1].charAt(0).toLowerCase() + m[1].slice(1)],
    [/^(published|uploaded|added|created|sent|updated|fixed|wrote|scheduled)\b(.*)$/i,
      (m) => `${m[1].toLowerCase()}${m[2]}`],
  ];
  for (const [re, fn] of rules) { const m = t.match(re); if (m) return fn(m).replace(/\s+/g, " ").trim(); }
  return t.charAt(0).toLowerCase() + t.slice(1);
}

type Bullet = { label: string; body: string; url?: string; count: number };

/** Group identical work on the same day: "×3" instead of three bullets. */
export function groupItems(items: Item[], nowMs: number, future: boolean): Bullet[] {
  const seen = new Map<string, Bullet>();
  const sorted = [...(items || [])]
    .filter((i) => i && i.at && String(i.text || "").trim())
    .sort((a, b) => (future ? Date.parse(a.at) - Date.parse(b.at) : Date.parse(b.at) - Date.parse(a.at)));
  for (const i of sorted) {
    const at = Date.parse(i.at);
    if (!Number.isFinite(at)) continue;
    const body = phrase(i.text);
    if (!body) continue;
    const label = whenLabel(at, nowMs, future);
    const key = `${label}|${body}`;
    const hit = seen.get(key);
    if (hit) { hit.count++; if (!hit.url && i.url) hit.url = i.url; }
    else seen.set(key, { label, body, url: i.url, count: 1 });
  }
  return [...seen.values()].slice(0, MAX_BULLETS);
}

const line = (b: Bullet, future: boolean) =>
  `${b.label.charAt(0).toUpperCase() + b.label.slice(1)} we ${future ? "will " : ""}${b.body}${b.count > 1 ? ` (×${b.count})` : ""}`;

export type UpdateInput = {
  clientName: string;
  contactName?: string;
  done: Item[];
  upcoming?: Item[];
  signOff?: string;      // e.g. "KailenFlow"
  logoUrl?: string;      // optional, small; email still reads without it
  nowMs?: number;
};

export function buildWeeklyUpdate(input: UpdateInput) {
  const now = input.nowMs ?? Date.now();
  const name = firstName(input.contactName || "");
  const client = String(input.clientName || "your business").trim();
  const signOff = input.signOff || "KailenFlow";
  const done = groupItems(input.done || [], now, false);
  const upcoming = groupItems(input.upcoming || [], now, true);

  const subject = `${client}'s Weekly Summary`;
  const intro = upcoming.length
    ? `Here's a quick overview of what we completed last week, and what we'll be doing this week for ${client}:`
    : `Here's a quick overview of what we completed last week for ${client}:`;

  // ---- plain text (what Gmail compose gets) ----
  const textParts = [`Hi ${name},`, "", intro, ""];
  textParts.push("What we did the past 7 days:", "");
  textParts.push(...(done.length ? done.map((b) => `• ${line(b, false)}`) : ["• Groundwork behind the scenes — nothing client-facing went live this week."]));
  if (upcoming.length) {
    textParts.push("", "What we're doing in the next 7 days:", "");
    textParts.push(...upcoming.map((b) => `• ${line(b, true)}`));
  }
  textParts.push("", "If you'd like anything prioritised differently, just reply and let me know.", "", "Thank you!", "", signOff);
  const text = textParts.join("\n");

  // ---- HTML (for "Copy formatted" — same words, light markup) ----
  let linkBudget = MAX_LINKS;
  const li = (b: Bullet, future: boolean) => {
    const label = escapeHtml(line(b, future));
    const useLink = b.url && linkBudget > 0 && /^https:\/\//i.test(b.url);
    if (useLink) linkBudget--;
    return `      <li style="margin:0 0 6px">${useLink ? `<a href="${escapeHtml(b.url!)}" style="color:#1a73e8">${label}</a>` : label}</li>`;
  };
  const html = [
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#202124;max-width:640px">`,
    input.logoUrl ? `  <p style="margin:0 0 20px"><img src="${escapeHtml(input.logoUrl)}" alt="${escapeHtml(signOff)}" width="64" height="64" style="display:block;border:0"></p>` : "",
    `  <p style="margin:0 0 14px">Hi ${escapeHtml(name)},</p>`,
    `  <p style="margin:0 0 18px">${escapeHtml(intro)}</p>`,
    `  <p style="margin:0 0 8px"><b>What we did the past 7 days:</b></p>`,
    `  <ul style="margin:0 0 18px;padding-left:20px">`,
    ...(done.length ? done.map((b) => li(b, false)) : [`      <li style="margin:0 0 6px">Groundwork behind the scenes — nothing client-facing went live this week.</li>`]),
    `  </ul>`,
    ...(upcoming.length ? [
      `  <p style="margin:0 0 8px"><b>What we're doing in the next 7 days:</b></p>`,
      `  <ul style="margin:0 0 18px;padding-left:20px">`,
      ...upcoming.map((b) => li(b, true)),
      `  </ul>`,
    ] : []),
    `  <p style="margin:0 0 14px">If you'd like anything prioritised differently, just reply and let me know.</p>`,
    `  <p style="margin:0 0 14px">Thank you!</p>`,
    `  <p style="margin:0">${escapeHtml(signOff)}</p>`,
    `</div>`,
  ].filter(Boolean).join("\n");

  return { subject, text, html, doneCount: done.length, upcomingCount: upcoming.length, ...deliverability(subject, text, html) };
}

/** Honest self-check, surfaced in the UI rather than assumed. */
export function deliverability(subject: string, text: string, html: string) {
  const warnings: string[] = [];
  const spam = [...`${subject} ${text}`.matchAll(SPAM_WORDS)].map((m) => m[0]);
  if (spam.length) warnings.push(`Wording that can trip spam filters: ${[...new Set(spam.map((s) => s.toLowerCase()))].join(", ")}`);
  const links = (html.match(/<a /g) || []).length;
  if (links > MAX_LINKS) warnings.push(`${links} links — keep it under ${MAX_LINKS}.`);
  if (/\b[A-Z]{5,}\b/.test(subject + " " + text)) warnings.push("ALL-CAPS words read as shouting to filters.");
  if ((text.match(/!/g) || []).length > 2) warnings.push("Several exclamation marks — trim to one.");
  if (subject.length > 70) warnings.push("Subject is long; under 70 characters lands better.");
  if (/bit\.ly|tinyurl|t\.co\//i.test(text + html)) warnings.push("Link shorteners look like spam — use full URLs.");
  return { warnings, links };
}
