// THE single chokepoint for every Google Business Profile HTTP call.
//
// ─── Why this file exists ────────────────────────────────────────────────
// Google suspends listings for MUTATED LISTING DATA — business name, address,
// phone, categories, hours, website — and it punishes automated edits hardest.
// It does NOT suspend listings for post content: a bad post is rejected and
// the listing survives. So the dangerous surface is not "writing to Google",
// it's "writing to the listing record".
//
// Therefore: creating a post is the ONLY write this codebase may ever make.
// Not `locations.patch`, not `locations.update`, not `accounts.update`, not
// any attribute write — not behind a feature flag, not "temporarily", not
// later. A future "sync hours from the CRM" or "fix the phone number" feature
// must hit a wall HERE, at runtime, rather than depend on someone catching it
// in code review.
//
// The enforcement is deliberately doubled:
//   1. `gbpCreatePost()` never accepts a URL. It BUILDS the only allowed
//      write URL from an account + location. A caller cannot express
//      "PATCH this location" through it, however hard they try.
//   2. `assertGbpRequestAllowed()` re-checks method+URL against an explicit
//      whitelist and throws otherwise. Anything routed through the shared
//      fetch helper is checked, so a hand-rolled URL fails too.
//
// If you are here because a legitimate feature needs a listing edit: the
// answer is that a human edits it in the Google Business Profile UI. Do not
// widen ALLOWED_WRITES. Widening it is the exact mistake this file exists to
// make impossible.

export class GbpForbiddenWriteError extends Error {
  readonly code = "gbp_forbidden_write";
  constructor(method: string, url: string) {
    super(
      `BLOCKED by the GBP write guard: ${method} ${url}\n` +
      `The only permitted Business Profile write in this codebase is creating a post ` +
      `(POST .../localPosts). Listing mutations (name, address, phone, categories, hours, ` +
      `website) are what get profiles suspended and are permanently disallowed — including ` +
      `behind a flag. A human must make listing edits in the Google Business Profile UI.`
    );
    this.name = "GbpForbiddenWriteError";
  }
}

// The complete set of non-GET requests this codebase may make to Google
// Business Profile. Exactly one entry, by design.
//
// Anchored at both ends: a trailing `$` is what stops
// `.../localPosts/{postId}` (delete/patch a specific post) from matching.
// That is intentional — retracting a post is a human action in the GBP UI,
// not an API call this codebase can make.
const ALLOWED_WRITES: ReadonlyArray<{ method: string; pattern: RegExp; what: string }> = [
  {
    method: "POST",
    pattern: /^https:\/\/mybusiness\.googleapis\.com\/v4\/accounts\/[^/?#]+\/locations\/[^/?#]+\/localPosts$/,
    what: "localPosts.create",
  },
];

/**
 * Throws unless the request is a read, or is the one permitted write.
 * Call this before EVERY Business Profile request.
 */
export function assertGbpRequestAllowed(method: string, url: string): void {
  const m = (method || "GET").toUpperCase();
  // Reads cannot mutate a listing, so they are unrestricted. This is the only
  // reason the performance/accounts/locations GETs elsewhere keep working.
  if (m === "GET" || m === "HEAD") return;

  const bare = url.split("?")[0];
  const allowed = ALLOWED_WRITES.some((w) => w.method === m && w.pattern.test(bare));
  if (!allowed) throw new GbpForbiddenWriteError(m, bare);
}

/** Read helper — asserts the call really is a read before making it. */
export async function gbpRead(url: string, token: string): Promise<Response> {
  assertGbpRequestAllowed("GET", url);
  return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
}

/**
 * The ONLY write this codebase can perform against Google Business Profile.
 *
 * Takes an account + location rather than a URL precisely so that no caller
 * can point it at a different endpoint. `summary`, `cta`, and `ctaUrl` are the
 * post's own content — none of them touch the listing record.
 *
 * NOTE: this does not itself decide whether publishing is *permitted* — that
 * is `evaluatePublish()` in gbp-post-rules.mts (kill switch, confirmation,
 * validation, rate limits). Both must pass. This function only guarantees
 * that whatever is sent cannot be a listing mutation.
 */
export async function gbpCreatePost(opts: {
  accountName: string;   // "accounts/123"
  locationId: string;    // bare id, no "locations/" prefix
  token: string;
  summary: string;
  cta?: string;
  ctaUrl?: string;
}): Promise<Response> {
  const account = opts.accountName.replace(/^\/+|\/+$/g, "");
  if (!/^accounts\/[^/?#]+$/.test(account)) {
    throw new Error(`Refusing to build a post URL from a malformed account name: ${opts.accountName}`);
  }
  const location = opts.locationId.replace(/^locations\//, "").trim();
  if (!location || /[/?#]/.test(location)) {
    throw new Error(`Refusing to build a post URL from a malformed location id: ${opts.locationId}`);
  }

  const url = `https://mybusiness.googleapis.com/v4/${account}/locations/${encodeURIComponent(location)}/localPosts`;
  // Belt and braces: the URL was built from validated parts, and is still
  // checked against the whitelist before it goes anywhere.
  assertGbpRequestAllowed("POST", url);

  const payload: Record<string, unknown> = {
    languageCode: "en-US",
    summary: opts.summary,
    topicType: "STANDARD",
  };
  if (opts.cta && opts.ctaUrl) {
    payload.callToAction = { actionType: opts.cta, url: opts.ctaUrl };
  }

  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
