// Content and permission rules for GBP posts. Pure, synchronous, dependency-
// free on purpose: the server enforces them (authoritative) and the composer
// UI mirrors the same logic so an operator sees a problem while writing rather
// than at publish time. Keep both copies in step — the frontend copy lives in
// public/index.html next to GBPPostComposer and is marked as a mirror.
//
// Two severities, and they mean different things:
//   block — publishing is refused. Non-negotiable, no override in the UI.
//   warn  — surfaced to the operator, publishing still allowed.
//
// Validation lives HERE, in code, not in the generation prompt. A prompt is a
// request; this is enforcement. A hand-edited post, a pasted post, or a post
// from a future generator all pass through the same gate.

export type Finding = { code: string; message: string };
export type Verdict = { blocks: Finding[]; warnings: Finding[] };

export const GBP_POST_MAX_CHARS = 1500;

// Hard ceiling per listing per day. Anthony's spec fixed the *warning* line at
// >2 posts/week but left the daily hard cap unstated; 2/day is chosen as the
// block so the two thresholds can't contradict each other (anything tripping
// the weekly warning stays publishable, as specified). Adjust here, not at the
// call sites.
export const MAX_POSTS_PER_LISTING_PER_DAY = 2;
export const WARN_POSTS_PER_LISTING_PER_WEEK = 2;

// Image limits. Under 250x250 or over 5MB is a block; between that and
// Google's recommended 720x720 is a warning.
export const IMAGE_MIN_EDGE = 250;
export const IMAGE_RECOMMENDED_EDGE = 720;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

// Offer language, verbatim from the spec. Promotional claims are the category
// most likely to be false ("50% off" that was never offered), so they need a
// human to affirm the offer is real before they can go out.
const OFFER_RE = /% off|free \w+|discount|sale|limited time/i;

// ™ © ® are legitimate in business copy and are Extended_Pictographic, so they
// are stripped before the emoji test rather than tripping it.
const EMOJI_EXEMPT = /[©®™]/g;
// Built via the RegExp constructor rather than a literal purely so a bare
// `tsc` (which defaults to an ES5 target when there's no tsconfig) doesn't
// report the `u` flag as an error. Runtime behaviour is identical — the
// Netlify/Deno runtime supports Unicode property escapes natively.
const EMOJI_RE = new RegExp("[\\p{Extended_Pictographic}\\u{FE0F}\\u{1F3FB}-\\u{1F3FF}]", "u");

const HASHTAG_RE = /(?:^|\s)#\S/;

const URL_RE = /\bhttps?:\/\/|\bwww\.[a-z0-9-]|\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:com|net|org|co|io|us|biz|info|shop|services|co\.uk)\b/i;

// Ten-digit North American numbers in any common separator style.
const PHONE_RE = /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/;

// Warn-only, so a modest allowlist keeps normal trade vocabulary quiet.
const CAPS_RE = /\b[A-Z]{3,}\b/g;
const CAPS_ALLOWED = new Set([
  "HVAC","LLC","INC","USA","DIY","EPA","NATE","HEPA","PVC","CPVC","LED","GFCI",
  "SEER","BTU","AC","TV","SUV","ADA","OSHA","FAQ","URL","API","PDF",
]);

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return null; }
}
/** Compares the last two labels, so shop.example.com counts as example.com. */
function sameSite(a: string, b: string): boolean {
  const tail = (h: string) => h.split(".").slice(-2).join(".");
  return tail(a) === tail(b);
}

/**
 * Validates one post's content. `offerConfirmed` is the operator ticking
 * "I confirm this offer is real" — absent it, offer language blocks.
 */
export function validatePostContent(input: {
  text: string;
  cta?: string | null;
  ctaUrl?: string | null;
  clientWebsite?: string | null;
  offerConfirmed?: boolean;
}): Verdict {
  const blocks: Finding[] = [];
  const warnings: Finding[] = [];
  const text = (input.text || "").trim();

  if (!text) {
    blocks.push({ code: "empty", message: "The post is empty." });
    return { blocks, warnings };
  }

  if (text.length > GBP_POST_MAX_CHARS) {
    blocks.push({
      code: "too_long",
      message: `${text.length} characters — over Google's ${GBP_POST_MAX_CHARS} limit. Shorten it rather than letting Google truncate it mid-sentence.`,
    });
  }

  if (EMOJI_RE.test(text.replace(EMOJI_EXEMPT, ""))) {
    blocks.push({ code: "emoji", message: "Remove emoji — they render poorly in Maps and read as spam." });
  }

  if (HASHTAG_RE.test(text)) {
    blocks.push({ code: "hashtag", message: "Remove hashtags — they do nothing on Google Business Profile." });
  }

  if (URL_RE.test(text)) {
    blocks.push({
      code: "raw_url",
      message: "Remove the web address from the body. Links belong in the call-to-action button, where Google can track them.",
    });
  }

  if (PHONE_RE.test(text)) {
    blocks.push({
      code: "phone",
      message: "Remove the phone number from the body. The listing already shows it, and the Call button is the tracked path.",
    });
  }

  if (OFFER_RE.test(text) && !input.offerConfirmed) {
    blocks.push({
      code: "unconfirmed_offer",
      message: "This post promises a discount, sale, or something free. Confirm the offer is real before it goes out.",
    });
  }

  const url = (input.ctaUrl || "").trim();
  if (url) {
    if (!/^https:\/\//i.test(url)) {
      blocks.push({ code: "cta_not_https", message: "The button link must start with https:// ." });
    } else {
      const ctaHost = hostOf(url);
      const siteHost = input.clientWebsite ? hostOf(input.clientWebsite.startsWith("http") ? input.clientWebsite : `https://${input.clientWebsite}`) : null;
      if (!ctaHost) {
        blocks.push({ code: "cta_unparseable", message: "The button link isn't a valid web address." });
      } else if (siteHost && !sameSite(ctaHost, siteHost)) {
        warnings.push({
          code: "cta_third_party",
          message: `The button points at ${ctaHost}, not the client's own site (${siteHost}). Intentional?`,
        });
      }
    }
  } else if (input.cta && input.cta !== "CALL") {
    blocks.push({ code: "cta_missing_url", message: `The "${input.cta}" button needs a link.` });
  }

  const caps = (text.match(CAPS_RE) || []).filter((w) => !CAPS_ALLOWED.has(w));
  if (caps.length) {
    warnings.push({
      code: "all_caps",
      message: `Shouty capitals: ${Array.from(new Set(caps)).slice(0, 4).join(", ")}. Google's content policy discourages them.`,
    });
  }

  return { blocks, warnings };
}

/** Image rules, when a post carries one. */
export function validatePostImage(img: { width: number; height: number; bytes: number }): Verdict {
  const blocks: Finding[] = [];
  const warnings: Finding[] = [];
  if (img.width < IMAGE_MIN_EDGE || img.height < IMAGE_MIN_EDGE) {
    blocks.push({ code: "image_too_small", message: `Image is ${img.width}x${img.height}. Google rejects anything under ${IMAGE_MIN_EDGE}x${IMAGE_MIN_EDGE}.` });
  } else if (img.width < IMAGE_RECOMMENDED_EDGE || img.height < IMAGE_RECOMMENDED_EDGE) {
    warnings.push({ code: "image_small", message: `Image is ${img.width}x${img.height}; ${IMAGE_RECOMMENDED_EDGE}x${IMAGE_RECOMMENDED_EDGE} or larger looks better in Maps.` });
  }
  if (img.bytes > IMAGE_MAX_BYTES) {
    blocks.push({ code: "image_too_large", message: `Image is ${(img.bytes / 1024 / 1024).toFixed(1)}MB. Google's limit is 5MB.` });
  }
  return { blocks, warnings };
}

/**
 * The full publish decision. Composes the kill switches, listing identity,
 * human confirmation, rate limits, and content rules.
 *
 * `resolvedLocationId` is what the listing check returned AT PUBLISH TIME —
 * not what was stored when the post was written. Passing the stored value for
 * both defeats the mismatch check, which exists because a client's listing
 * mapping can change between composing and publishing.
 */
export function evaluatePublish(input: {
  globalPublishEnabled: boolean;
  clientPublishEnabled: boolean;
  storedLocationId?: string | null;
  resolvedLocationId?: string | null;
  humanConfirmed: boolean;
  postsPublishedToday: number;
  postsPublishedThisWeek: number;
  content: Parameters<typeof validatePostContent>[0];
  image?: { width: number; height: number; bytes: number } | null;
}): Verdict {
  const blocks: Finding[] = [];
  const warnings: Finding[] = [];

  // Kill switches first — cheapest check, and the most likely deliberate stop.
  if (!input.globalPublishEnabled) {
    blocks.push({ code: "kill_switch_global", message: "Publishing to Google is switched off globally. Composing and saving still work." });
  }
  if (!input.clientPublishEnabled) {
    blocks.push({ code: "kill_switch_client", message: "Publishing to Google is switched off for this client. Composing and saving still work." });
  }

  if (!input.storedLocationId) {
    blocks.push({ code: "no_location", message: "This client has no GBP Location ID set, so there is no listing to publish to." });
  } else if (!input.resolvedLocationId) {
    blocks.push({ code: "location_unresolvable", message: "The saved GBP Location ID doesn't resolve to a listing this Google account manages." });
  } else if (String(input.resolvedLocationId) !== String(input.storedLocationId)) {
    // The whole point of re-checking at publish time rather than trusting
    // what was stored when the post was written.
    blocks.push({
      code: "location_mismatch",
      message: `The listing changed since this post was written (saved ${input.storedLocationId}, now ${input.resolvedLocationId}). Re-check the client's Location ID before publishing.`,
    });
  }

  if (!input.humanConfirmed) {
    blocks.push({ code: "not_confirmed", message: "A person has to confirm this specific post before it can go to a live listing." });
  }

  if (input.postsPublishedToday >= MAX_POSTS_PER_LISTING_PER_DAY) {
    blocks.push({
      code: "rate_limit_day",
      message: `${input.postsPublishedToday} posts already published to this listing today (limit ${MAX_POSTS_PER_LISTING_PER_DAY}).`,
    });
  }
  if (input.postsPublishedThisWeek > WARN_POSTS_PER_LISTING_PER_WEEK) {
    warnings.push({
      code: "rate_warn_week",
      message: `${input.postsPublishedThisWeek} posts to this listing in the last 7 days. More than ${WARN_POSTS_PER_LISTING_PER_WEEK} a week tends to look automated.`,
    });
  }

  const content = validatePostContent(input.content);
  blocks.push(...content.blocks);
  warnings.push(...content.warnings);

  if (input.image) {
    const img = validatePostImage(input.image);
    blocks.push(...img.blocks);
    warnings.push(...img.warnings);
  }

  return { blocks, warnings };
}

/** Convenience: publishing is permitted only when nothing blocks. */
export function canPublish(v: Verdict): boolean {
  return v.blocks.length === 0;
}
