# BUILD SPEC — Page Publisher & Scheduler Module (RECONCILED v2)

**For:** Claude Code, adding a new tool to the KailenFlow Suite dashboard app.

**What this is:** A module that lets an agency operator paste in HTML + images for a new
page, preview it, run it through a hard SEO validation gate, and then publish or schedule
it onto a client's existing website — without rebuilding that website.

**Core principle from the checklist this enforces:** *Yoast warns you; a real publishing
system refuses to publish.* This module is a publishing system. The gate blocks.

**v2 changelog:** This is a reconciliation pass against the ACTUAL kailenflow-suite
codebase (Stage 0 inspection + review, 2026-07-20), not a generic app. Changed from v1:
the platform model now leads with GIT_STATIC (the real, only-in-production platform)
instead of WordPress, with its scheduling/commit-batching mechanics fully specified (§1);
the data model is Firestore collections, not Postgres tables, with real 1MiB-headroom math
(§2); a dedicated section maps which checklist items existing code already covers,
correctly distinguishing real reuse from mere adjacency — `l1.crawl.indexnow` is a
confirmed gap, not satisfied, built for real in Stage 3 (§3, §3a); site-scoped Layer 1
checks are rebuilt as whole-site checks by default, not per-page (§5a); the existing
`ScheduledPages` tool is confirmed (in its own code comments) to have no working
auto-publish and is absorbed/retired rather than run alongside (§9); and Content Intake
(§6) is fully specified in this document rather than referenced from v1, grounded against
two real generator outputs (a Rankin Waste location page, an Anytime Heating & Air service
hub page) — the Gutenberg sanitization pipeline (§6a), schema-graph merge (§6b), and
layout/component inheritance (§6c) are all built to their actual observed shape, not an
idealized one. Internal linking (§6d) was elevated to the module's highest-priority
feature: a required, gated three-link-type intake stage (parent/hub, inbound, outbound)
plus a dedicated per-site Link Map view, not a side panel. Everything else — the gate
itself, the hard-block philosophy, no override — is unchanged.

---

## 0. READ THIS FIRST — Context & Constraints (findings from Stage 0)

### What already exists

This is being added to **KailenFlow Suite**, a single-file admin dashboard, not a
conventional framework app. Concretely:

- **No build step, no bundler.** [public/index.html](public/index.html) is one file
  (~9,800+ lines): React loaded via CDN, JSX transpiled live in-browser by Babel standalone.
- **No router.** Navigation is plain React state — a `view` variable for top-level tools
  (Sidebar-driven), a `tab` variable for per-client sub-tabs. Not URL-based.
- **No database, no ORM.** The whole app's data lives in **one Firestore document**
  (`appData/main`), read/written as a single JSON blob via a real-time `onSnapshot`
  listener. `data.clients[]` is the closest existing analog to a "clients/sites" table —
  an array inside that one document, not a SQL table with foreign keys.
- **Backend = Netlify Functions.** Individual `netlify/functions/{name}/index.mts` files,
  one per endpoint. Shared logic lives in `netlify/shared/{name}.mts`, imported by
  multiple functions (`indexing.mts`, `github-schedule.mts`, `firestore-admin.mts`,
  `google-auth.mts`, `heatmap.mts` are the existing examples). Scheduled work uses real
  Netlify cron: `export const config: Config = { schedule: "..." }`.
- **Auth**: Firebase ID-token verification (`shared/auth.mts`'s `isAuthed`, a hand-rolled
  JWT check against Google's public keys) for browser-originated calls, or a static
  `x-automation-key` shared-secret header for server-to-server calls (GitHub Actions
  pinging back into the Suite).
- **Tool registration convention:** a new top-level tool gets a `view` key, a `Sidebar`
  nav entry, and a conditional render line in the main app component — see `LeadFinder`,
  `ScheduledPages`, `IndexingDashboard` for the exact pattern. A new per-client sub-tab
  gets a `tabs` array entry + a `key={client.id}`-remounted render line — see the
  `ClientIndexingTab` addition (2026-07-20) for the current, correct version of that
  pattern (every per-client tab now remounts on client switch; match this, don't regress it).
- **Styling:** Tailwind utility classes inline in JSX via CDN, no compiled stylesheet.
  Reuse `stitch-glass-card` (card container), the pill/badge pattern
  (`text-xs px-2 py-1 rounded-full font-medium bg-{color}-100 text-{color}-700`),
  `font-manrope`, `fade-in`. Do not invent a new visual language.

### The real client base — this drove every decision below

Every actual client site (Rankin Waste, Arbor Care, 360 IV, Inside Prosper, Anytime
Heating & Air) is an **Astro static site in its own GitHub repo**, published via:
`src/lib/schedule.ts` (a path→date registry) + a `scheduleGuard(Astro)` call that redirects
to /404 until the date passes + a GitHub Actions workflow that rebuilds and redeploys to
Netlify daily. **None are WordPress, Wix, GoDaddy, or Vistaprint.** The platform model
below reflects that reality.

### Non-negotiable constraints (unchanged from v1)
- **Never rebuild or migrate a client's existing site.** This module only ADDS pages and,
  where the platform allows, edits internal links on existing pages.
- **Credentials are publishing access to live client sites.** For GIT_STATIC this is the
  existing `GITHUB_TOKEN` Netlify env var (already provisioned, already has Contents +
  Workflows + Secrets + Actions permissions from the indexing work) — no new per-client
  credential storage needed for this tier. Never log tokens. Never return them to the
  frontend.
- **Nothing auto-publishes without passing the gate.** No exceptions, no override flag in v1.

---

## 1. Platform Reality — GIT_STATIC leads, CMS tiers follow

v1 treated GIT_STATIC-equivalent access as a fallback "manual" tier below WordPress. That
was backwards for this business: GIT_STATIC is **more capable** than any CMS tier here —
real programmatic create/edit/list access via the GitHub API (already used all day building
the indexing pipeline), not a paste-and-pray fallback. It leads.

| Platform | Auth | Can create pages? | Can read existing pages? | Can edit existing pages? | Auto-publish? |
|---|---|---|---|---|---|
| **GIT_STATIC** (Astro/GitHub/Netlify — the real client base) | `GITHUB_TOKEN` (existing) | Yes — any path | Yes — full repo tree + schedule.ts | Yes — any file, same-commit | Yes, via schedule.ts date + Actions rebuild |
| **WordPress** | Self-hosted plugin + API key | Yes — pages AND posts | Yes — full list | Yes | Yes |
| **Wix** | Wix App + OAuth | Blog posts only | Limited | Limited | Yes, blog only |
| **Manual** (GoDaddy, Vistaprint, unknown) | None available | No API | No | No | No — paste package |

### GIT_STATIC adapter — the reference implementation

```
{
  canCreatePage: true
  canCreatePost: true          // Astro content-collection posts, same mechanism
  canListExistingUrls: true    // read the repo tree, not a remote crawl
  canEditExistingPage: true    // edit the source file, same commit as the new page
  canSetCanonical: true
  canSetMetaDescription: true
  canInjectSchema: true
  canUploadMedia: true         // commit image files into the repo's assets dir
  autoPublish: true
}
```

- **`publish`** = one commit: the new page file(s) (`.astro`/`.md`) + an added entry in
  `schedule.ts`'s path→date map. Uses the Git Data API (create blob(s) → create tree →
  create commit → update ref), not the simpler single-file Contents API — this is what
  makes a multi-page batch atomic (see below).
- **`listExistingUrls`** = read the repo's file tree (`GET /repos/{o}/{r}/git/trees/{ref}?recursive=1`,
  same call `countPageFiles` in `github-schedule.mts` already makes) plus the parsed
  `schedule.ts` map (reuse `fetchSchedule`/`parseSchedule`, `github-schedule.mts`) — never
  a remote crawl of the live site.
- **`insertInboundLink`** = edit the source file of the existing page that should link to
  the new one, in the **same commit** as the new page's own files. Never a separate commit,
  never a live-site edit.
- **Publishing a batch = one commit, not N.** This mirrors a real lesson from today:
  batching PrimeIndexer submissions into one call (instead of one per page) was the actual
  fix for a rate-limit bug that silently broke indexing for a week. The same reasoning
  applies to commits — N sequential single-file commits are slower, and a failure partway
  leaves the repo in a half-published state. One Git-Trees-API commit for the whole batch
  is both faster and atomic.

#### Scheduling — resolving the dual-layer date, single-source-of-truth

The risk flagged: our scheduler could hold a `scheduled_for` date that drifts from the
date actually written into `schedule.ts`, which is what `scheduleGuard()` checks at
request time. Resolution: **`schedule.ts` owns the date. Firestore never independently
holds an editable one.**

- Approving/scheduling a page in the Suite fires the commit **immediately** — the page
  file(s) *and* the `schedule.ts` entry (with whatever future date the operator picked) go
  into the repo in that one commit, right then. There is no separate later moment where
  "our scheduler" decides to commit — this matches how Anthony already works today
  (schedule pages days or weeks ahead, hidden by `scheduleGuard` until the date, daily
  Actions rebuild does the rest).
- The page's Firestore doc (`pages` collection, see §2) stores `scheduledFor` as a
  **read-through mirror** of exactly what's in that commit's `schedule.ts` entry — set
  once, at commit time, from the same value. It is never edited in isolation.
- **Rescheduling = a new commit.** Drag-to-reschedule on the calendar must re-commit
  `schedule.ts` with the new date (a small, same-shape commit) and only then update the
  Firestore mirror to match the commit that actually landed. If the commit fails, the
  Firestore date does not change. This makes drift structurally impossible — there is
  exactly one place the date is asserted, and Firestore only ever echoes it after a
  successful write there.
- **What "our scheduler" (Netlify cron) actually does**, then, is NOT deciding when to
  commit — it's the exact same job `publish-page-log` already does today: watch for a
  `schedule.ts` date passing, and react. Extend that existing hourly cron (or add a sibling
  function using the same `fetchSchedule`/`isLive` pattern) to also, for Page-Publisher-
  originated pages: **re-run the gate** (the spec's own requirement — the site may have
  changed since approval), flip Firestore status from `scheduled` to `published`, and fire
  the indexing submission (`submitBatchAndLog`, reusing existing code, see §3). Don't build
  a second, parallel "did the page go live" watcher — extend the one that exists.

### WordPress / Wix / Manual

Unchanged in shape from v1 (still real platforms clients may eventually be on) but
**deprioritized** — see Build Order, §9. Keep the adapter interface identical to v1's so
they slot in later without a refactor:

```ts
interface PlatformAdapter {
  readonly platform: Platform
  readonly capabilities: CapabilityFlags
  verifyConnection(creds: Credentials, site: Site): Promise<VerifyResult>
  listExistingUrls(creds: Credentials, site: Site): Promise<ExistingUrl[]>
  fetchPageHtml(creds: Credentials, url: string): Promise<string>
  uploadImage(creds: Credentials, image: PageImage): Promise<{ remoteUrl: string }>
  publish(creds: Credentials, page: Page): Promise<PublishResult>
  update(creds: Credentials, page: Page, platformRef: string): Promise<PublishResult>
  insertInboundLink(creds: Credentials, task: InboundLinkTask): Promise<LinkResult>
}
```
Adapters that can't do something return `{ supported: false, reason: string }`, never throw.
Manual-tier mechanics (paste package, post-paste verification) are unchanged from v1 §4.

---

## 2. Data Model — Firestore collections, not Postgres

No new database. Apply the exact pattern that already fixed a real 1MiB crisis this
project hit three times with rank-map data: `appData/main` holds only light pointers;
heavy per-item records live in their own collections, one document per record.

```
appData/main  (existing document — gets ONLY these new fields per client)
  client.pagePublisher.pageRefs: [{ id, title, status, scheduledFor, siteId }, ...]
    — enough to render the calendar/list views without fetching any page body.

pagePublisherSites          (collection, one doc per connected site — replaces "sites" table)
  id, clientId, domain, platform ('git_static'|'wordpress'|'wix'|'manual')
  repo, branch, pagesDir              // git_static specifics — reuses client.publishing shape
  capabilityFlags, connectionStatus, lastVerifiedAt
  indexNowKey, indexNowKeyFileCommitted           // §3a — public by design, not encrypted
  astroLayout: {                                  // §6c — derived from the repo, never guessed
    layoutPath, contentDir, frontmatterShape: {...},
    sampledFrom: [existingPagePath, ...], derivedAt,
  }
  siteGraph: {                                    // §5's whole-site checks — cached, TTL'd
    updatedAt,
    pageIndex: { [url]: { title, path, parentUrl, lastSeenAt } },   // dup-title + orphan +
                                                                     // sibling lookup (§6d)
    linkGraph: { [url]: [targetUrl, ...] },              // broken-link + orphan detection
    schemaGraph: { [atId]: [url, ...] },                 // @id consistency across pages
    sitemapUrls: [url, ...],                             // sitemap integrity
  }
  liveHostChecks: { checkedAt, real404, hostHonors404, singleHostOk, httpsRedirectOk }

pagePublisherPages          (collection, one doc per page — replaces "pages" table)
  id, siteId, clientId, title, slug, htmlBody, metaDescription, canonicalUrl,
  schemaJsonLd, ogTags, pageType, status, scheduledFor, publishedAt, publishedUrl,
  commitSha,
  parentUrl: string | null,             // §6d — first-class field, not just a link record.
  parentAcknowledgedMissing: boolean,   // operator explicitly confirmed no suitable parent
  internalLinks: [...], inboundLinkTasks: [...]
  // internalLinks/inboundLinkTasks stay embedded arrays here (small, page-scoped —
  // no separate collection needed for those, unlike v1's separate tables).
  // parentUrl drives three things directly: BreadcrumbList generation (§6b), the
  // hub-to-spoke check (l2.links.hub_to_spoke), and the Link Map view (§6d) — it is
  // the source of truth for "what is this page's parent," never re-derived from
  // scanning internalLinks/inboundLinkTasks after the fact.

pagePublisherImages         (collection, one doc per image — replaces "page_images" table)
  id, pageId, originalFilename, storedPath, altText, width, height, isLcp, format,
  uploadedRemoteUrl, sortOrder

pagePublisherGateRuns       (collection, one doc per gate run — replaces "gate_runs" table)
  id, pageId, runAt, layer1Results, layer2Results, blockingFailures, warnings,
  overall, gateVersion
  // layer{1,2}Results store ONLY {itemId, result, evidence} triples — label,
  // severity, scope are looked up client-side from the static checklist-items
  // registry (code, not Firestore), never duplicated per run. This is the single
  // biggest lever on gate-run doc size (see math below).

pagePublisherLog            (collection, one doc per publish attempt — replaces "publish_log")
  id, pageId, attemptedAt, adapter, requestSummary, responseStatus,
  responseBodyExcerpt (capped 2000 chars), outcome, errorMessage (capped 500 chars)
```

Credentials: `GITHUB_TOKEN` (Netlify env, existing) covers 100% of the GIT_STATIC tier —
no new credential storage needed yet. When WordPress/Wix are actually built, their tokens
go in a new `pagePublisherCredentials` collection (encrypted payload, same principle v1
specified), never in `appData/main`, never returned to the frontend.

### 1MiB headroom math (requested — real numbers, not a guess)

Firestore's hard per-document cap is 1,048,576 bytes, for *every* document, not just
`appData/main` — this matters because `pagePublisherPages` and `pagePublisherGateRuns`
are per-item docs now, each with their own full budget, not a shared shrinking pool.

**`pagePublisherPages` doc** (the one with a real variable-size field, `htmlBody`):
- `htmlBody`: a substantial local-SEO service/location page (headings, several hundred to
  ~2,000 words of body copy, an FAQ section) runs roughly 30–60KB of raw HTML in practice;
  call it **50KB typical, ~150KB for an unusually long page** as a pessimistic ceiling.
- `schemaJsonLd` (a connected LocalBusiness+Service+FAQPage+Breadcrumb graph): ~2–5KB.
- `internalLinks` + `inboundLinkTasks` arrays (5–10 links, ~200 bytes each): ~1–3KB.
- Everything else (title, slug, meta, canonical, og tags, status/dates/ids): <2KB.
- **Total: ~35–55KB typical, ~160KB pessimistic** — roughly **7–30x headroom** under the
  1MiB cap even at the high end. Comfortable.

**`pagePublisherGateRuns` doc** (the one that worried me most, since it captures ~65
checklist items with evidence per run):
- Per item, storing only `{itemId, result, evidence}` (NOT the label/description — those
  live in the static `checklist-items` registry in code): id ~20 bytes + result ~10 bytes +
  evidence string ~150 bytes typical (up to ~400 bytes for a verbose explanation) + JSON
  overhead ~30 bytes ≈ **~210 bytes/item typical, ~460 bytes/item pessimistic.**
- ~65 items (45 Layer 1 + 20 Layer 2) × 210 bytes ≈ **13.7KB typical**; × 460 bytes ≈
  **~30KB pessimistic.**
- Plus `blockingFailures`/`warnings` (item-id lists, <1KB) and run metadata (<1KB).
- **Total: ~15–32KB per gate run** — roughly **33–70x headroom** under the cap.

**`pagePublisherLog` and `pagePublisherImages` docs**: both under ~2–3KB (mostly short
strings, ints, capped excerpt fields) — negligible, not worth detailed math.

**`pagePublisherSites.siteGraph`** (new, for §5's whole-site checks — one doc per site, no
fanout, but worth checking since it scales with the client's total page count): for a
site with 100 pages, `pageIndex` ≈ 100 × ~80 bytes ≈ 8KB; `linkGraph` at ~5 outbound links/
page average ≈ 100 × 5 × ~80 bytes ≈ 40KB; `schemaGraph` ≈ 100 × ~50 bytes ≈ 5KB;
`sitemapUrls` ≈ 100 × ~60 bytes ≈ 6KB. **Total ≈ 60KB for a 100-page site** — would need
roughly 15,000+ pages before approaching the 1MiB cap. No agency client is close to that
scale; no separate collection needed for this, a field on the existing per-site doc is fine.

**The one thing that still needs a cap, even under this design:** `client.pagePublisher.
pageRefs` inside `appData/main` grows by one small pointer (~150–250 bytes) per page,
forever, across every client, in the one shared document. At even a generous 500
accumulated pages across the whole agency that's ~100KB — fine today, but it's linear,
unbounded growth in the exact document that already hit its ceiling once. **Recommendation:
prune pointers for pages published more than ~6–12 months ago** (the full record is safe
forever in `pagePublisherPages`; the pointer only needs to exist for calendar/list
rendering of current and recent activity). Build this pruning in from the start, don't
wait for it to become a second incident.

---

## 3. Reuse Map — what existing code already covers (requested, explicit)

`netlify/shared/indexing.mts` (built earlier today, fixing a real multi-client incident)
covers real ground here. Being precise about *degree* of overlap, not just "yes/no":

| Checklist item | Status | Existing code |
|---|---|---|
| `l1.crawl.indexnow` | **A real gap, not satisfied — correcting the earlier draft's soft framing.** IndexNow is a specific protocol (a hosted key file + a ping to `api.indexnow.org`/Bing's/Yandex's mirrors); Google does not participate in it at all. `submitToGoogle` calls Google's own separate Indexing API; `submitToPrimeIndexer` calls a third-party SaaS of unknown internal mechanism. Neither hosts a key file or calls IndexNow's endpoint. Building this for real is Stage 3 work — see §3a below. | none — build fresh |
| `l1.url.trailing_slash`, `l1.url.single_host`, `l1.http.real_301` | **Reusable low-level plumbing, not an implemented check.** `resolveCanonicalUrl` already does exactly the HTTP-level work these items need — a HEAD request with `redirect:"manual"`, inspecting the status code and `Location` header to distinguish a real redirect from a direct 200. It was built to *work around* exactly the trailing-slash inconsistency these items exist to catch (found and fixed live on two real clients today). The gate's Layer 1 URL/redirect checks should be built directly on this function rather than writing a second HTTP-redirect-inspection routine. | `resolveCanonicalUrl` |
| *(no explicit checklist id — a capability beyond the checklist's own scope)* | **Bonus, wire in as post-publish verification.** Real confirmed-indexed status via Search Console's URL Inspection API (not just "did we submit," but "is Google actually showing it as indexed") already exists and runs on a daily cron. The spec's own manual-tier "post-paste verification job" (§1) is conceptually the same idea — extend it to GIT_STATIC too as an extra confidence signal after a scheduled page goes live. | `checkPageIndexed`, `inspectUrl`, `check-indexed-status` function |
| Everything else in Layer 1 (rendering/performance, HTML doc fundamentals, sitemap/robots/llms.txt *existence* checks, HTTP status integrity beyond redirects, the seven build-time-blocking items) and all of Layer 2 (titles/meta, internal linking architecture, schema depth, image alt/filenames, E-E-A-T trust content) | **Not covered — genuinely new work for Stage 3.** This is the majority of the checklist. Don't overstate the overlap: three items get real reuse, one capability is a bonus extension: everything else needs building. | — |

### 3a. Real IndexNow — Stage 3, centralized, not a one-off

Arbor Care's repo already has a working reference implementation
(`scripts/indexnow-ping.mjs`, a per-repo script) — read it, then centralize the same
pattern into `netlify/shared/page-publisher/indexnow.mts` so every GIT_STATIC site gets it
through the pipeline, not through a bespoke script someone has to remember to copy into
each new repo.

**This is not just a code change — the key file has to be hosted per domain.** IndexNow's
verification model requires `https://{client-domain}/{key}.txt` to actually exist and
return the key, matching the key sent in the ping request. Concretely:

- At GIT_STATIC site-connect time, generate a random IndexNow key (not secret — it's
  deliberately public, that's how the protocol verifies you) and store it on the
  `pagePublisherSites` doc (`indexNowKey`, `indexNowKeyFileCommitted: boolean`).
- The key file itself must be **committed into that client's repo** (`public/{key}.txt`,
  or wherever the Astro site serves static files from) — this is a real, one-time,
  per-client setup step, not something that happens purely server-side. Do it as part of
  connecting a GIT_STATIC site (one extra file in the same first commit that verifies the
  connection), not a manual step Anthony has to remember per client.
- Once the key file is live, every subsequent publish (GIT_STATIC's `publish()`, and the
  scheduler's re-check when a scheduled date passes) calls the real IndexNow endpoint with
  that site's key. Retire Arbor Care's standalone script once this lands — one
  implementation, not two doing the same job differently.

---

## 4. Module Architecture — fits the real file layout

v1's `/modules/page-publisher/` tree assumed a conventional multi-file app. Route the same
pieces through the file organization that actually exists:

```
netlify/shared/page-publisher/
  adapters/
    base-adapter.mts
    git-static-adapter.mts     # the reference implementation — build this first
    manual-adapter.mts
    index.mts                  # registry: platform -> adapter instance
  gate/
    checklist-items.mts        # single source of truth: item ids, labels, severities
    layer1.mts
    layer2.mts
    build-time-gate.mts        # the seven hard-fail items
    gate-runner.mts            # orchestrates, writes a pagePublisherGateRuns doc
  publisher.mts                 # approved page -> resolves adapter -> commits -> logs
  link-applier.mts

netlify/functions/
  page-publisher-connect-site/index.mts     # verify + register a site
  page-publisher-list-urls/index.mts        # site_url_index equivalent, on demand
  page-publisher-run-gate/index.mts         # POST, runs the gate, returns the report
  page-publisher-publish/index.mts          # commits now (immediate or "schedule now")
  page-publisher-scheduler/index.mts        # Netlify cron — extends publish-page-log's
                                             # pattern: watch schedule.ts dates, re-gate,
                                             # flip status, submit for indexing

public/index.html
  — new `view` key ('pagepublisher'), Sidebar entry, conditional render line
  — components added inline: PagePublisherCalendar, PagePublisherIntake,
    PagePublisherGateReport, PagePublisherPreview, PagePublisherLinkMap (§6d —
    per-site hub/spoke/orphan graph view, reads siteGraph, no new fetch) —
    following the exact stitch-glass-card / pill / font-manrope conventions
    already in use, each per-client piece remounted via key={client.id} the
    same way ClientIndexingTab is.

wordpress-plugin/               # unchanged from v1, built only when Stage 6 starts
```

---

## 5. THE GATE — unchanged, still non-negotiable

Everything in v1 §5 stands as written: Layer 1 before Layer 2, `unverifiable` never counts
as pass, the seven build-time items hard-block with zero override, platform-conditional
evaluation (host-level items like compression/HSTS are `unverifiable` with a reason on
platforms that don't expose them). Read `references/layer1-site.md` and
`references/layer2-content.md` from the `ai-website-seo-checklist` skill for per-item
verification guidance, and mirror `scripts/audit.py`'s logic for the mechanical checks it
already implements — don't reinvent those. Gate runs write to `pagePublisherGateRuns`
(Firestore), item results are the minimal `{itemId, result, evidence}` shape from §2's
size math, joined against the code-side `checklist-items.mts` registry for display.

### 5a. Whole-site checks are the default on GIT_STATIC, not the exception

This is the actual point of building GIT_STATIC first. A CMS integration can only ever
check what's already live, one page (or one API call) at a time. A git-static repo's
**entire source is readable via the GitHub API at commit time** — every page, every link,
every schema block, before a single commit lands. That's a stronger position than any CMS
adapter gives you, and the gate should use it: these five checks run against the **whole
site**, not just the page being published —

- **Orphan detection** across every page in the repo, not just the new one — a new page
  isn't the only thing that can create (or fix) an orphan; a changed internal link
  anywhere can too.
- **Duplicate title detection** across the full site.
- **Broken internal link detection** sitewide.
- **Sitemap integrity** against the actual set of pages that will exist after this commit
  (not just the sitemap file's own syntax).
- **Schema `@id` graph consistency** across pages — the connected entity graph is a
  sitewide property, not a per-page one.

**Mechanism — two passes, matching the confirmed split:**
1. **Source-read checks, fresh on every gate run.** Built from the exact same GitHub API
   calls `listExistingUrls` already makes (repo tree + `schedule.ts`) plus fetching each
   page's own source to extract title/links/schema — no *extra* network cost, since the
   URL index is already being pulled for the internal-link picker anyway. Maintained as
   `pagePublisherSites.siteGraph` (§2): updated incrementally the moment *our own* commit
   changes something (we know exactly what changed, no need to rescan the whole repo), and
   on a 24h TTL otherwise to catch changes made outside the tool (a client's own commit, a
   manual edit). Manual "rescan site" button available regardless, matching v1's original
   instruction not to recrawl on every save.
2. **Live-host checks, cached and separate.** `real_404`, `host_honors`, `https_redirect`,
   `single_host` genuinely can't be verified from source alone — they're runtime/CDN
   behavior. These reuse `resolveCanonicalUrl`'s HEAD-request-with-manual-redirect approach
   (the exact plumbing that found and fixed the trailing-slash bug live today), cached in
   `pagePublisherSites.liveHostChecks` on the same 24h TTL + manual-rescan pattern.

**Page-scoped checking is the exception, reserved only for items that are genuinely about
this one page alone** — single H1, this page's own meta description non-emptiness, this
page's own image alt text, this page's own canonical tag pointing at itself. Everything
that's actually a property of the site as a whole gets checked as a whole-site fact, once,
shared across every page's gate report rather than recomputed per page.

### 5c. Firestore `set(merge:true)` audit — ON RECORD, do not re-discover

**Audited app-wide 2026-07-26** at Anthony's instruction, after a deep-merge bug produced a
phantom duplicate-title gate finding. The concern was that deep-merge (removed keys survive
forever) is the same silent-unbounded-growth pattern behind the original 1MiB `appData/main`
crisis, and might be a habit across the app.

**Conclusion: it is NOT a habit. The pre-existing core is clean.**
- `writeAppData`, `mutateAppData`, `saveRankMapGrid` (all in `shared/firestore-admin.mts`)
  use `set()` **without** merge → full replace → no key accumulation possible.
- **Every** `merge:true` call in the entire `netlify/` tree is in
  `shared/page-publisher/firestore.mts` — code written during this build, not legacy.

**Fixed:** `siteGraph` (the one that actually bit). Rebuilt indexes now go through
`replaceSiteGraph()`, which uses `update()` with a whole-map value — that replaces the field
rather than deep-merging it, so keys for deleted/renamed pages actually disappear.

**Known-benign exposures, deliberately left in place (Anthony's call — "don't fix beyond
Page Publisher without showing me first"):**
1. `naGateItems` — would retain stale keys if a platform's permanently-N/A list ever
   *shrinks*. Bounded (a few keys), only grows when platform facts change, and a stale N/A
   entry fails safe (an item wrongly marked N/A shows in the collapsed section rather than
   silently passing).
2. `schemaJsonLd` — a future page-edit flow that REMOVES a schema field would leave the old
   field behind. Unreachable while intake is create-only; becomes real the moment editing
   exists. `page-publisher-update-page` (built 2026-07-26) currently replaces the whole
   `schemaJsonLd` value, so this is latent, not active.

Arrays are not affected: Firestore treats them as atomic values and replaces them wholesale.

### 5b. Full checklist audit — every item, no tier for "unaudited"

**Audited 2026-07-23** after several rounds of reconciliation, to confirm nothing quietly
fell out. IDs are provisional (no `checklist-items.mts` registry exists yet — Stage 3 builds
the real one). "Implemented" means real code in this build enforces or verifies it today,
not that it's abstractly true of some site. Full status for every Layer 1/Layer 2 item is
tracked here going forward — **there is no "out of scope" tier**: every real checklist item
either has a concrete Stage 3 mechanism below, is permanently N/A on a specific platform
(`platform-limitations.mts`), or is explicitly reused from an existing part of this app
(named, not hand-waved).

**Resolved 2026-07-23 — the five `l2.trust.*` items and `l1.crawl.gsc_verification` are
real Stage 3 site-scoped checks, not out of scope, with a concrete mechanism each:**
- `l2.trust.about_page` / `l2.trust.privacy_terms` — trivially checkable: scan
  `siteGraph.pageIndex` for a page whose title/path matches (about/privacy/terms). No new
  data needed, just a Stage 3 gate query against data Stage 1 already populates.
- `l2.trust.contact_nap` — two parts: contact-page *existence* is the same `pageIndex` scan
  as above; NAP *match* needs the page's real content fetched (`adapter.fetchPageHtml`,
  already built for MANUAL, still a `NOT_YET` stub for GIT_STATIC) and compared against the
  client's own NAP fields already stored in `appData/main` — no separate NAP system needed,
  reuse what's already there.
- `l2.trust.author_pages` — same `pageIndex` scan, conditional: only relevant at all if the
  site has any `pageType: 'blog'` pages to begin with.
- `l1.crawl.gsc_verification` — **reuse, don't rebuild.** This is already a real, working
  check elsewhere in the app: `client.gscProperty` (set via the existing `GSCSection`/
  `gsc-data.mts` integration, Part A work, already deployed). Stage 3's gate just reads that
  existing field — it does not need Page Publisher to build its own GSC verification.
- `l2.trust.content_depth` — the one genuine exception, and it's not a mechanical
  pass/fail: "trust content that answers what buyers actually ask" is a qualitative
  judgment, not an existence check. **Not this tool's job** — that's what the
  `content-ranker` skill (or manual review) is for. Page Publisher's gate should not attempt
  to auto-score this; flagging it as a reminder in the report (not a pass/fail item) is the
  honest ceiling here.

**Confirmed 2026-07-23 — `l1.crawl.llms_txt` is actually planned, not forgotten.** Given a
real data-model slot the same day this was asked: `PagePublisherSite.liveHostChecks` gained
an `llmsTxtPresent: boolean` field, same fetch-once-cache-it shape as `real404`/
`hostHonors404`/etc. — Stage 3 populates it via a plain `fetch(domain + '/llms.txt')`, no new
mechanism required.

**Registered 2026-07-23 — external link validation, MY OWN ADDITION, not a checklist item.**
Anthony asked about this and it's real scope creep worth tracking deliberately rather than
losing: the original checklist only covers *internal* linking architecture. Checking that
*external* links (to other sites, citations, partner pages) are actually live — not 404,
not dead — is something I'm adding because it's an obvious real-world content-quality gap,
not something the checklist asked for. Given its own ID prefix (`x.`, not `l1.`/`l2.`) so it
is never mistaken for a real checklist item during any future reconciliation:
- `x.links.external_reachable` — periodic live-check of every external URL found in a
  page's outbound-link table (same `resolveCanonicalUrl`-style HEAD-request pattern already
  proven for indexing), flagging dead ones. Stage 3 work, not started. Needs a new
  `externalLinks: {targetUrl, lastCheckedAt, statusCode}[]`-shaped field (not yet added to
  `PagePublisherPage` — planned, not built).

Full item-by-item status (Layer 1 then Layer 2):

| ID | Status |
|---|---|
| `l1.render.static_html` | Stage 3 |
| `l1.render.no_spa` | Stage 3 |
| `l1.render.minimal_css` | Stage 3 |
| `l1.render.no_blocking_js` | Stage 3 |
| `l1.render.font_display_swap` | Stage 3 |
| `l1.render.lcp_preload` | Stage 3 |
| `l1.render.img_dimensions` | **Implemented** |
| `l1.render.lazy_below_fold` | **Implemented** |
| `l1.render.modern_img_formats` | **Implemented** |
| `l1.render.compression` | Stage 3 (host-level) |
| `l1.render.cache_headers` | Stage 3 (host-level) |
| `l1.url.single_host` | Stage 3 (`liveHostChecks.singleHostOk`) |
| `l1.url.https_redirect` | Stage 3 (`liveHostChecks.httpsRedirectOk`) |
| `l1.url.trailing_slash` | Implemented elsewhere (`indexing.mts`'s `resolveCanonicalUrl`) — not yet wired into this gate |
| `l1.url.lowercase_hyphens` | Stage 3 |
| `l1.url.canonical_self_ref` | Stage 3 (GIT_STATIC); permanently N/A on MANUAL (`l1.url.canonical_custom`) |
| `l1.url.slug_redirect` | Stage 3 |
| `l1.url.mixed_content_hsts` | Stage 3 (host-level) |
| `l1.http.real_404` | Stage 3 (`liveHostChecks.real404`) |
| `l1.http.real_301` | Stage 3 |
| `l1.http.no_fake_200` | Stage 3 |
| `l1.http.host_honors` | Stage 3 (`liveHostChecks.hostHonors404`) |
| `l1.crawl.sitemap_present` | **Implemented** (MANUAL); GIT_STATIC uses `schedule.ts` |
| `l1.crawl.sitemap_inclusion` | Stage 3 |
| `l1.crawl.sitemap_lastmod` | Stage 3 |
| `l1.crawl.robots_present` | Satisfied by default on GoDaddy (confirmed); Stage 3 to verify generally |
| `l1.crawl.robots_custom` | Permanently N/A on MANUAL |
| `l1.crawl.ai_crawler_policy` | Permanently N/A on MANUAL; Stage 3 for GIT_STATIC |
| `l1.crawl.llms_txt` | Stage 3 — `liveHostChecks.llmsTxtPresent` field added 2026-07-23 |
| `l1.crawl.noindex_utility` | Permanently N/A on MANUAL (confirmed by platform documentation, 2026-07-23 — Custom Code only reaches `<body>`, noindex needs `<head>`) |
| `l1.crawl.indexnow` | **Partially implemented** (key-gen done, ping is Stage 3); permanently N/A on MANUAL |
| `l1.crawl.gsc_verification` | Stage 3 site-scoped — reuses existing `client.gscProperty` |
| `l1.doc.lang_attribute` | Stage 3 |
| `l1.doc.viewport_charset` | Stage 3 |
| `l1.doc.favicon_set` | Stage 3 |
| `l1.doc.og_twitter_tags` | Permanently N/A on MANUAL (confirmed by platform documentation, 2026-07-23 — same `<head>`-only-vs-`<body>`-only reason) |
| `l1.doc.semantic_html` | Stage 3 |
| `l1.doc.breadcrumb_website_schema` | Stage 3 (GIT_STATIC, §6b merge); permanently N/A on MANUAL |
| `l1.doc.schema_dates` | Same split |
| `l1.gate.broken_internal_links` | **Implemented** |
| `l1.gate.orphan_pages` | Partial (per-page gate only); full sitewide scan Stage 3 |
| `l1.gate.missing_duplicate_titles` | Stage 3 |
| `l1.gate.missing_canonical` | Stage 3 |
| `l1.gate.missing_alt` | **Implemented** |
| `l1.gate.schema_invalid` | **Implemented** (parse check); real validation Stage 3; permanently N/A on MANUAL |
| `l1.gate.sitemap_integrity` | Stage 3 |
| `l2.meta.unique_title` | Stage 3 |
| `l2.meta.unique_description` | Stage 3 |
| `l2.meta.single_h1` | **Implemented** |
| `l2.meta.heading_hierarchy` | Stage 3 |
| `l2.links.zero_orphans` | Partial (same as `l1.gate.orphan_pages`) |
| `l2.links.contextual_siblings` | Not built this round — deprioritized suggestion feature |
| `l2.links.hub_to_spoke` | **Implemented** |
| `l2.links.descriptive_anchors` | **Implemented** |
| `l2.schema.local_business` | Stage 3; permanently N/A on MANUAL |
| `l2.schema.service` | Stage 3; permanently N/A on MANUAL |
| `l2.schema.article` | Stage 3; permanently N/A on MANUAL |
| `l2.schema.faq` | Stage 3; permanently N/A on MANUAL |
| `l2.schema.entity_graph` | Stage 3; permanently N/A on MANUAL |
| `l2.img.alt_descriptive` | **Implemented** |
| `l2.img.filenames` | **Implemented** |
| `l2.trust.about_page` | Stage 3 site-scoped (`pageIndex` scan) |
| `l2.trust.contact_nap` | Stage 3 site-scoped (`pageIndex` scan + content fetch + reuse client NAP data) |
| `l2.trust.privacy_terms` | Stage 3 site-scoped (`pageIndex` scan) |
| `l2.trust.author_pages` | Stage 3 site-scoped (`pageIndex` scan, conditional on blog pages) |
| `l2.trust.content_depth` | Not this tool's job — `content-ranker` skill / manual review |
| `x.links.external_reachable` | My own addition, not a checklist item. Stage 3, not started |

**Resolved 2026-07-23 — by platform documentation, not a hands-on probe.** Anthony skipped
the planned probe: GoDaddy's own Custom Code panel states it injects "HTML, CSS, & JavaScript
into your site between the `<Body>` tags." Meta/link tags only function in `<head>` — so
even in the hypothetical where they'd survive unencoded (never actually tested — the schema
probe only confirmed `<script>` entity-encoding, not tag placement), landing in `<body>`
makes them non-functional regardless. This is a **placement** problem, independent of and in
addition to the encoding problem, and would hold even if GoDaddy ever fixed the encoding.
Marked permanently N/A on this evidence: `l1.doc.og_twitter_tags`, `l1.crawl.noindex_utility`,
and `l1.url.canonical_custom` (already N/A for a separate reason — this independently
confirms it too). **Flagged explicitly as inference from platform UI copy, not a probe
result**, in case anyone wants to verify directly later — see `platform-limitations.mts`.

---

## 6. The Content Intake & Preview — fully specified (this is the daily workflow)

Grounded against two real generator outputs read in full: a Rankin Waste location page
(`echlos--tx--location-page.html`) and an Anytime Heating & Air service hub page
(`air-conditioning-contractor.html`). Both confirmed the same generator shape — build the
pipeline below as the required path every paste goes through, not as edge-case handling.

### 6a. Sanitization pipeline — required on every paste

The pasted HTML is WordPress Gutenberg markup, not clean HTML. Verified in both files:

1. **Strip every `<!-- wp:* -->` / `<!-- /wp:* -->` comment pair** (e.g. the
   `<!-- wp:image {"align":"left","sizeSlug":"medium"} -->` / `<!-- /wp:image -->` pair
   wrapping every content image in both files) **and unwrap the `<!-- wp:html -->` /
   `<!-- /wp:html -->` pair** the whole document is wrapped in.
2. **Strip `wp-block-*` classes** (`wp-block-image`, `alignleft`/`alignright`,
   `size-medium`) from the `<figure>` elements they're found on.
3. **Translate the alignleft/alignright intent, don't discard it.** Both files alternate
   left/right image floats section by section — that's deliberate layout intent from the
   generator, not noise. Map it to whatever the target site's own existing components
   already use for a floated content image (see §6c) rather than dropping the signal
   entirely.
4. **Strip ALL HTML comments, unconditionally** — not a blocklist of known-bad patterns.
   This one rule handles three different real cases in these two files at once: the
   `wp:*` block comments above; the plain section-divider comments (`<!-- Hero Section -->`,
   `<!-- Table of Contents -->`, `<!-- FAQ Section -->`, etc.) that are harmless but serve
   no purpose once parsed; and the genuinely leaked one found live in the service page's
   intro — `<!-- Note: introHtml contains intentional HTML formatting from AI content
   pipeline -->` — sitting inside a visible content `<div>`. There is no comment that needs
   to survive into a published page. Strip the class, not the instance.
5. **Preserve every section/FAQ `id` attribute exactly as authored.** The generator's own
   table of contents links to them by exact anchor (`#how-singlefamily-homes-near-echlos-tx-
   handle-weekly-pickup`, `#faq-0`, etc., confirmed in both files) — sanitization must never
   regenerate or slugify these independently of what the TOC already points at, or the
   in-page anchor links silently break.

**The six confirmed fixes, built as required pipeline steps:**

1. **`[FUTURE_SERVICE_PAGE_LINK: ...]`-style placeholders.** Confirmed six in the service
   hub page, each sitting alone in its own visible `<p>` tag (meaning if shipped unresolved
   they render as literal bracket text to real site visitors) — confirmed zero in the
   location page, so **detection must be presence-based, never assumed.** Detect
   generically: any `\[[A-Z_]+:\s*[^\]]*\]`-shaped bracketed-all-caps token, not a hardcoded
   match on this exact string — the next generator run may use a different placeholder
   name. Surface every match at intake as a required decision: resolve it to a real target
   URL picked from `pagePublisherSites.siteGraph.pageIndex` (rewriting the paragraph into a
   real link), or delete the line entirely. **Hard block** — the page cannot proceed past
   intake to gate/scheduling with any unresolved match remaining, full stop.
2. **Images point at `/api/temp-images/*.webp`** — confirmed on every single image in both
   files (8 total across the two), all temp paths from the generator's own pipeline, none
   are real hosted URLs. Intake must download each one, upload it to the client repo
   (§6c's `pagePublisherImages` flow), and rewrite every `src` to the resulting committed
   path before anything is previewed or published.
3. **Every image has `loading="lazy"`, including ones that could be above the fold** —
   confirmed on all 8. Whichever image the operator marks LCP (§2's data model: **at most
   one, zero is valid** — neither real example has an image anywhere in its hero section,
   so it's plausible a given page has no LCP-image candidate at all; never force-mark one)
   must have `lazy` removed and a `<link rel="preload">` added. Every other image keeps
   `loading="lazy"` only if it's actually below the fold.
4. **Images have `width="480"` but no `height"` at all** — confirmed on all 8, no
   exceptions. Do not just fill in the missing height and trust the generator's stated
   width either — **re-derive BOTH width and height from the actual downloaded file's real
   pixel dimensions** at the same point step 2 downloads it. The generator's stated
   `width="480"` is a hint, not a fact; width alone doesn't satisfy `l1.render.img_dimensions`
   regardless, and trusting a possibly-stale generator value for one dimension while
   deriving the other from the real file risks the two disagreeing.
5. **No `<h1>` exists in either file.** The hero title in both real examples sits in a bare,
   childless, text-only `<div>` — the first such div inside the hero section wrapper
   (`<div><div>Echlos, TX- Location Page...</div><p>subtitle</p>...</div>` and identically
   shaped in the service page). Detection heuristic: the first child of the hero wrapper
   that is a `<div>` containing only a text node, no nested elements — promote it to
   `<h1>`, preserving its text content exactly, and flag it in the intake UI as "auto-
   promoted, your generator should emit this as h1 directly." Enforce exactly one H1 after
   promotion (`l2.meta.single_h1`).
6. **Schema injection** — see §6b, its own subsection given the complexity.

### 6b. Schema merge — verified against both real graph shapes, don't assume a fixed one

The two real files' `@graph` arrays are shaped differently from each other, which is the
point: **the merge logic must work by finding/adding nodes via `@id`, never by assuming a
fixed graph shape.**

- **Location page** (`echlos--tx--location-page.html`): graph already has a top-level
  `Service` node (with a nested, `@id`-less `provider` object typed `LocalBusiness`, and a
  separately-declared top-level `#business` node typed `Organization` — two different
  representations of the same business that don't cross-reference each other by `@id`; the
  whole-site schema-graph check, §5a, should flag exactly this kind of inconsistency), plus
  `WebSite`, `FAQPage`, `Person`. The `Service.areaServed.geo` node inlines a `containedInPlace`
  with its own `@id` (`#hubbard`) — likely meant to be a shared "parent place" referenced
  consistently by *other* nearby location pages too; whether it actually is, sitewide, is
  exactly the kind of thing `pagePublisherSites.siteGraph.schemaGraph` (§5a) should verify
  once more than one location page exists. **Missing here:** `BreadcrumbList`,
  `datePublished`/`dateModified` (absent from every node in both files, no exceptions).
- **Service hub page** (`air-conditioning-contractor.html`): NO top-level `Service` nodes at
  all — confirmed business-level only, per the original ask. The six services live as
  anonymous, `@id`-less `Service` objects nested inside `#business.hasOfferCatalog.
  itemListElement[].itemOffered`. **Missing here:** real per-service `Service` nodes
  (promote each catalog item's inline `itemOffered` into its own top-level graph node with
  a stable `@id`, e.g. `#service-ductless-mini-split-installation`, keeping the
  `OfferCatalog` entry as a `{"@id": "..."}` reference instead of an inline duplicate),
  `BreadcrumbList`, `datePublished`/`dateModified`.

**Merge algorithm, general enough for both shapes and whatever comes next:** parse the
existing `@graph` array; for each thing the checklist requires (`BreadcrumbList` from the
parent page's own URL, `Service` schema on service-type pages, dates), check whether a node
of that `@type` already exists **anywhere in the graph** — add it if not, leave it alone if
it does (never duplicate). Reference other graph members via their existing `@id` strings
exactly as found (never invent a new `@id` scheme). **Merge into the one existing
`<script type="application/ld+json">` block — never add a second script tag.**

### Intake

The operator pastes HTML (already run through 6a/6b) into an editor, into a new
`pagePublisherPages` draft doc. Alongside it:
- Title, slug, meta description, page type (`service`|`location`|`blog`|`other`).
- **Image uploads — drag/drop, multiple** (plus the ones §6a's step 2 already pulled in
  from temp URLs). For each image the UI **requires alt text before save** — this is a
  blocking gate item (`l1.gate.missing_alt` / `l2.img.alt_descriptive`), but it's caught
  here, at intake, not left to fail later at gate time. The save action for an image is
  simply disabled until alt text is present. Both real files already had real, descriptive
  alt text on every image — when that's true, carry it through untouched; the requirement
  exists for the cases where it isn't.
- **Auto-convert uploaded JPEG/PNG to WebP**, generate `srcset` sizes for responsive
  images, and **rename files** from whatever they arrived as (both real examples already
  used descriptive filenames in their `title` attribute, e.g.
  `residential-street-trash-service-echlos-tx` — reuse that as the rename target when
  present rather than re-deriving a worse one from the slug) — this is what satisfies
  `l2.img.filenames` automatically.
- **Mark exactly one image as LCP.** Enforce that it does NOT get `loading="lazy"` and
  DOES get a `<link rel="preload">` tag — the two most common ways a real LCP image
  quietly tanks a page's performance score. Every other image gets `loading="lazy"` only
  if it's below the fold.

Each uploaded image becomes its own `pagePublisherImages` doc (§2) — `isLcp` boolean,
`format`, `width`/`height`, `altText`, `sortOrder`.

### 6c. Design & layout inheritance — no custom design work

Both real files confirm why this matters: **every wrapper `<div>` in both documents has
zero classes** — no styling hooks of any kind survive from the generator. Dumped as raw
HTML into an Astro layout, this renders as unstyled default-browser boxes regardless of
how good the copy is. "The site's layout wraps it" only works if intake actually maps the
generator's semantic sections onto the site's own real components — it isn't automatic
just because the layout exists.

- **Per-client layout setting**, stored on `pagePublisherSites.astroLayout` (§2): which
  layout new pages use, which content directory they're written to, and the frontmatter
  shape that layout expects.
- **Derive all three by reading existing pages in the repo — never guess, never assume
  one convention across clients.** At site-connect time, sample several real `.astro`
  files from likely content directories, parse their frontmatter blocks (the YAML between
  `---` fences) and note which `layout:` import they use and where they live. Confirm the
  sample is actually consistent before trusting it — if two sampled pages use different
  layouts or frontmatter shapes, surface that to the operator instead of picking one
  silently. Rankin Waste and Anytime Heating & Air are different codebases built at
  different times; do not assume they share a convention.
- **Map generator sections onto real existing components where the repo has one**, rather
  than passing raw div soup through. Concretely, for each of the generator's recurring
  section types (hero, TOC, CTA banner, FAQ, floated content image) — check whether the
  site's own existing pages already render that kind of section via a named component
  (e.g. a `<Hero title={...} subtitle={...}>`, an `<Faq items={...}>`). If one exists,
  populate its props from the parsed section instead of inlining the bare HTML. This is
  also where §6a's alignleft/alignright intent gets translated — into whatever prop or
  class the site's own existing floated-image pattern actually uses, discovered the same
  way, never invented fresh.
- **Publishing = write a file to the derived content directory, frontmatter matching the
  derived layout, body = the sanitized (6a) and schema-merged (6b) HTML** — mapped into
  real components per the above wherever a match exists, falling back to sanitized raw
  HTML passthrough for anything that doesn't match a known component.
- **If the pasted HTML has structures the site has no styling or component for, flag it in
  preview rather than inventing CSS.** No new visual language, no new stylesheet, ever —
  matching the module's own non-negotiable constraint from §0.
- Preview always renders against the site's real, cached stylesheet (unchanged from the
  Preview subsection below) — this is also where an unmapped/unstyled structure actually
  becomes visible to the operator before anything commits.

### 6d. Internal linking — the highest-priority feature in this module

**Built 2026-07-23** — required stage in intake, enforced by both the client (immediate
feedback) and the server (`page-publisher-create-page`, never trusting the client alone,
same pattern as the placeholder/alt-text gates). New `page-publisher-get-site` endpoint
exposes `siteGraph.pageIndex` to the intake form (parent picker, inbound-link source picker,
outbound validation all read it — no new backend computation, just exposing what Stage 1's
connect/refresh already populated).

- **Parent/hub**: searchable filter-as-you-type list from `pageIndex`, or an explicit
  "no suitable parent exists" acknowledgment — Save is blocked until one or the other is set.
- **Inbound links — the orphan gate, resolved as a single rule**: minimum 2 total accepted
  inbound links (the auto-proposed hub→spoke link counts as one if accepted, so a parent
  reduces it to "1 more needed") — **this was ambiguous in the original wording ("zero, or
  exactly one when parent was acknowledged-missing, blocks") and resolved as: the real rule
  is uniformly 2, always; a parent just supplies one of the two for free.** One real gap
  the spec didn't address, filled by Anthony's own judgment call, flagged as such in code:
  the requirement is waived entirely when the site's `pageIndex` has zero other pages at all
  (a genuinely new site's first page can't possibly link from pages that don't exist yet).
- **Outbound links**: extracted from the final (post-resolution) HTML via `<a>` tag
  scanning. Anything that looks like an internal page link (same-domain absolute URL, or
  relative) but doesn't match `pageIndex` is broken and blocks. `tel:`/`mailto:`/`#anchor`/
  external links are never checked. Non-descriptive anchor text ("click here" etc.) warns,
  doesn't block. Resolved `[FUTURE_SERVICE_PAGE_LINK]` placeholders (§6a) feed into this
  same table automatically once resolved to a real link — confirmed working, one mechanism,
  not two.
- **Not built**: actually *applying* the inbound-link edits (§6d's "same commit as the new
  page" atomicity rule) — `inboundLinkTasks` persist with `status:'pending'`, never
  `'applied'`, because no platform has a real "commit a page + edit an existing page's
  source" mechanism yet (GIT_STATIC's own publish mechanism is a separate, still-open gap).
  Sibling-suggestion (other pages sharing the same parent, surfaced as candidate outbound
  targets) was also not built this round — a nice-to-have suggestion feature, not a blocking
  gate requirement, deprioritized under time constraints.
- **Link Map — deliberately scoped down**, per the spec's own framing below ("becomes
  meaningful... Stage 3... stays useful as more pages accumulate"): shows only pages created
  through Page Publisher itself (from `pagePublisherPages`, using `parentUrl`/
  `inboundLinkTasks` already captured at intake), orphans (0 inbound links) highlighted red.
  **Not the sitewide hub/spoke/orphan graph over the whole live site** — that needs
  `siteGraph.linkGraph`, which needs every existing page's content scanned, which is Stage 3.

Not a side panel checked at gate time — a **required stage of intake itself**, enforced
before the operator can move on. Three link types, each with a distinct job:

**1. Parent / hub link — required, exactly one.**
Stored as `pagePublisherPages.parentUrl` (§2), a real first-class field, not just an entry
buried in a generic link array — it's read directly by three different things: breadcrumb
schema generation (§6b builds `BreadcrumbList` from this field, not from scanning links),
the `l2.links.hub_to_spoke` check, and the Link Map view below. Presented as a searchable
dropdown of the site's real URLs (`pagePublisherSites.siteGraph.pageIndex`). The operator
cannot proceed past intake without either picking one or explicitly checking "no suitable
parent exists" (`parentAcknowledgedMissing: true`) — an acknowledged absence is allowed,
but it is never silent: the gate report surfaces it as a flagged, visible fact on every
run, not a quietly-passed check.

**2. Inbound links — required, at least one beyond the parent.**
Choosing a parent auto-proposes (not auto-commits) a hub→spoke inbound link task: the
parent page gets edited to link down to this new page — the concrete mechanism behind
`l2.links.hub_to_spoke`. That's link #1 toward the requirement. The operator must add **at
least one more**, from a page other than the parent — suggested by matching the new page's
title against existing page titles in `siteGraph.pageIndex` (a similarity suggestion only;
the operator always chooses, nothing is auto-added without a look). **This is the orphan
gate, enforced here at intake, before the operator has done all the other work** — zero
total inbound links (or exactly one when parent was acknowledged-missing, i.e. still
truly alone) blocks progression to scheduling outright. On GIT_STATIC, every accepted
inbound link task becomes a same-file edit to that existing page's source, applied via
`insertInboundLink` (§1).

**3. Outbound links — parsed from the pasted HTML itself.**
Every `<a>` tag already in the sanitized (6a) HTML is extracted into a table: target URL,
anchor text. Each target is validated against `siteGraph.pageIndex`; anything not found
(or that live-host-checks as a non-200, §5a) is flagged as broken and **blocks** — this is
`l1.gate.broken_internal_links` surfacing at intake time, not just at the final gate run.
Non-descriptive anchors ("click here") get a warning, not a block
(`l2.links.descriptive_anchors`). **Siblings of the chosen parent** — other pages sharing
the same `parentUrl` — are surfaced as suggested outbound targets, directly serving
`l2.links.contextual_siblings`. **Resolved `FUTURE_SERVICE_PAGE_LINK`-class placeholders
(§6a, fix 1) feed straight into this same outbound table** once resolved to a real URL —
one mechanism for "a link this page makes to another page," not two.

**Application on GIT_STATIC (restating §1's atomicity rule for this specific case):**
inbound link edits (the parent's hub→spoke edit, plus any additional accepted inbound
tasks) go into the **same commit** as the new page's own file(s) — never a page commit
followed by separate link-edit commits. One commit, atomic, full stop.

**Link Map view — a dedicated per-site view, not folded into the intake flow.**
Visualizes `pagePublisherSites.siteGraph` (already cached, §5a/§2 — no new backend fetch)
as a graph: hubs, their spokes, orphans, and pages sitting on thin inbound-link counts.
**Orphans rendered in red** — this is the tool for spotting sitewide internal-linking
architecture problems at a glance, independent of any single page's intake flow. Add
`PagePublisherLinkMap` to §4's UI component list; it becomes meaningful as soon as
`siteGraph` exists in earnest (Stage 3, alongside the whole-site gate checks it shares
data with) and stays useful indefinitely after, as more pages accumulate.

### Preview

- Fetch and cache the client site's stylesheet(s) at connect time (and on demand
  afterward), stored alongside the site's other connection metadata.
- Render the pasted page HTML in a sandboxed iframe with those styles applied, so the
  operator sees roughly what it'll look like on the real site before committing anything.
- Desktop / mobile viewport toggle.
- A "source" tab showing the exact HTML that will actually be committed — including the
  generated schema, OG tags, and canonical tag, not just the pasted body.
- Preview is illustrative, not a guarantee — label it as such explicitly in the UI,
  especially important for any future Wix/manual-tier site where the platform's own
  builder wraps content in its own template and the real rendered result can differ.

---

## 7. The Scheduler & Calendar

- **Scheduler = Netlify cron**, matching the existing convention exactly
  (`export const config: Config = { schedule: "0 * * * *" }`, same shape as
  `publish-page-log`/`check-indexed-status`) — not a new queue, not node-cron, not Vercel
  Cron. For GIT_STATIC, per §1, this cron's job is re-gate + status flip + indexing
  submission on a date that already passed in `schedule.ts`, not deciding when to commit.
- **Calendar UI** reads `client.pagePublisher.pageRefs` (the light pointers in
  `appData/main`) for fast rendering; clicking an entry fetches the full
  `pagePublisherPages` doc on demand for the detail/preview/gate-report view — same
  lazy-load-the-heavy-doc pattern already used for rank-map grids (`useRankMapGrid`).
  Once the ScheduledPages migration (§9, Stage 1) is confirmed, this is the ONLY calendar
  data source for scheduled pages — no more reading `data.scheduledPages[]` alongside it.
- Month/week/list views, color-coded by status (`scheduled`, `gate_failed`, `publishing`,
  `published`, `publish_failed`, `ready_to_paste`), drag-to-reschedule = re-commit (§1),
  filter by client and by site — unchanged in spirit from v1.

---

## 8. WordPress Companion Plugin

Unchanged from v1 §8. Not built until Stage 6 (see below) — a client needs to actually be
on WordPress before this gets written.

---

## 9. Build Order — GIT_STATIC first, MANUAL adapter's paste-package moved up

**Revised 2026-07-23 (Anthony) — client base changed.** Two real clients onboarded on
non-git platforms: one GoDaddy (confirmed genuinely no content API — developer.godaddy.com
covers Domains/Certificates/Shoppers only, nothing content-related; the Oct 2024 "Website
Builder API" is a private reseller deal, not public access), one Vistaprint Digital.

**Vistaprint Digital resolved 2026-07-23 (Anthony's hands-on check): it IS the real Wix
dashboard, not a locked-down white-label.** Evidence: the site is literally named "My Vxw
Site S6hatq" (Vxw = Vistaprint's Wix-powered product), and "Manage this site" opens a
standard Wix dashboard — App Market, Manage Apps, and Insert Code (Wix's own Custom Code
feature) all present in the left sidebar, standard Wix nav throughout (Site & Mobile App,
Getting Paid, Inbox). **Classified as WIX tier, not MANUAL** — the private/unlisted-app
install path (§9 point 3 below) is open for this client. Still unconfirmed, not blocking:
whether the App Market is fully searchable vs. a curated subset, and whether Insert Code
accepts a `<script type="application/ld+json">` tag. This means Wix serves ONE real client
(not two), and doesn't change the priority order — GoDaddy/MANUAL still goes first.

Revised priority:
1. **MANUAL/paste adapter (GoDaddy only, now that Vistaprint resolved to WIX tier)** —
   cheapest to build, unblocks a real client immediately. Foundation (adapter,
   `connect-manual-site`, permanently-N/A classification) built 2026-07-23; the
   paste-package generator and post-paste verification are its actual value and now open
   **Stage 2** (moved ahead of GIT_STATIC intake — see Stage 2 below), not deferred to a
   later stage.
2. GIT_STATIC intake + gate + scheduler — unchanged, Stages 2b–4.
3. **Wix — Blog API only, confirmed 2026-07-23. One real client (Vistaprint Digital),
   private/unlisted-app install path confirmed open.** No Velo: dynamic per-client Velo
   code for page-level SEO fields was assessed and explicitly rejected (real per-client
   maintenance burden — no central place to patch a breaking `wix-seo-frontend` change,
   every client site drifts independently, a client poking Dev Mode can break it). Blog
   posts publish via the real Blog API (its `DraftPost.seoData`/`seoSlug` fields cover SEO
   without Velo). Real Wix *pages* (not blog posts) go through the same MANUAL/paste flow as
   GoDaddy — Wix's API can't create arbitrary new pages either, so there's no reason to
   build a second paste-package mechanism for it.

**Permanently-N/A gate classification (built 2026-07-23):** `platform-limitations.mts`'s
static `PLATFORM_NA_ITEMS` map, applied once at connect time onto
`PagePublisherSite.naGateItems` — never re-derived per page or per gate run. Stage 3's gate
report must filter these item keys out of the main pass/fail list and show them once in a
separate collapsed section with the platform reason, instead of repeating a structural
platform fact (e.g. "GoDaddy has no robots.txt editing") as a warning on every single page.

**Hands-on test CONFIRMED FAILED 2026-07-23 — JSON-LD schema is impossible on GoDaddy via
Custom Code. Do not re-attempt without re-testing this exact platform first** (GoDaddy could
change the editor's sanitizer in a future update — this finding has an expiration date, it's
not permanent physics).

*Procedure:* pasted a minimal `<script type="application/ld+json">{"@type":"Thing",...}</script>`
probe into GoDaddy's HTML/Custom-Code block on a live page, published for real (not preview
— preview and published output can sanitize differently). Checked two ways:
1. View-source (Ctrl+U, not DevTools' Elements tab — Elements shows the post-JS DOM, which
   can hide server-side stripping) on the live published URL, incognito window. Result: the
   tag was HTML-entity-encoded (`&quot;` instead of `"`, `&lt;/script&gt;` instead of
   `</script>`) — it renders as **visible text on the page**, never executes as a script tag.
2. Google's Rich Results Test (search.google.com/test/rich-results) against the live
   published page (`https://poolclean.us/privacy-policy`): **"No items detected."** The page
   crawled successfully — Google reached it and found no structured data at all. This is the
   authoritative result; view-source alone could theoretically be misread, Google's own
   parser can't be.

*Applied to the N/A map* (`platform-limitations.mts`, `manual` platform): every schema-related
checklist item — `l1.doc.breadcrumb_website_schema`, `l1.doc.schema_dates`,
`l1.gate.schema_invalid`, and the whole Layer 2 schema-depth section via a `l2.schema.*`
wildcard entry (see `isItemNA()`, added the same day, for how Stage 3's gate report should
consume wildcard N/A keys) — all carry this test as their reason, with the date.

*Paste-package design consequence:* the generator still ALWAYS builds the schema JSON-LD
block from a page's `schemaJsonLd` field — it is never silently dropped. It's handed to the
operator as its own separate, clearly labeled artifact marked "not applicable on this
platform" rather than folded into the paste instructions, so the work already exists intact
the moment this client ever migrates to a platform that can actually use it.

*Side finding, unrelated to schema, worth keeping:* GoDaddy's Custom Code block reserves
visible space on the page even when it renders nothing (as here, entity-encoded text that's
effectively invisible/broken) — there's a **"Forced Height" field, where setting it to 0
hides the section on the published page.** Irrelevant to the schema finding itself, but note
it for any future embed on this platform that needs to render invisibly (a tracking pixel,
a hidden marker, etc.).

**Stage 1 — Foundation, including the ScheduledPages retirement**
Firestore collections (§2) with the light-pointer/heavy-collection split from day one —
do not build a v1-shaped "everything in appData/main" version and migrate later. Adapter
interface + registry (GIT_STATIC, plus MANUAL added 2026-07-23 per the revised priority
above — both at the same foundation depth: connect + read what already exists, nothing
publish-related yet). New tool registered in the Sidebar
following existing conventions. No gate yet, no intake, no publish flow — just: connect a
site (reuses `client.publishing.repo`/`branch` already on the client record), populate
`siteGraph.pageIndex` only (title/path/parentUrl from the repo tree + `schedule.ts` —
`linkGraph`/`schemaGraph`/`sitemapUrls` need full page-content fetches and are Stage 3),
derive `astroLayout` by sampling real existing pages (flag if inconsistent, never guess),
and generate + commit that site's IndexNow key file (§3a — connect-time action; the actual
ping call is Stage 3).

**Confirmed: `ScheduledPages` (`data.scheduledPages[]`) is absorbed and replaced, not run
alongside.** Verified directly in the current code — its own `toggleStatus` function's
comment reads *"TEMPORARY manual status toggle — lets you preview the two visual states
before the auto-publish robot (FUTURE STEP 1) is built. Safe to remove later,"* confirming
nothing there ever actually publishes anything; it's an intake queue with no working back
half. `publish-page-log` only *reacts* to whatever's already committed to a repo's
`schedule.ts` by hand — neither existing piece performs the actual "commit this to the
client's repo" step Page Publisher's GIT_STATIC adapter fills for real. Migration, as part
of Stage 1, in this order:
1. Write a one-time migration that reads every `data.scheduledPages[]` entry and creates a
   corresponding `pagePublisherPages` doc in `draft` status (title, client, content,
   goLiveDate carried over as-is) — nothing silently dropped, everything becomes reviewable
   in the new tool.
2. Confirm the migration with a count check (every source entry has a matching draft doc)
   before touching anything else.
3. Only then: remove the `ScheduledPages` component, stop writing to
   `data.scheduledPages[]`, and repoint `CalendarView`'s scheduled-page rendering at
   `client.pagePublisher.pageRefs` (§7) instead of `data.scheduledPages`.

   **Done 2026-07-23.** Migration confirmed via `dryRun:true` first (count: 1 real entry,
   `marketing-agency-prosper-tx` / Inside Prosper, already `published` — `skipped_no_site`
   since Inside Prosper has no connected Page Publisher site — never actually migrated to
   `pagePublisherPages`), full raw array backed up to
   `backups/scheduledPages-backup-2026-07-23.json` before any code changed, then
   `ScheduledPages`/`SCHEDULED_PAGE_STATUS`/the Sidebar entry/the render line/the
   `migrateData` seed line all removed from `public/index.html`, and `CalendarView`
   repointed to `client.pagePublisher.pageRefs`.

   **`data.scheduledPages` itself was deliberately NOT cleared from the live Firestore
   document (Anthony's explicit call, 2026-07-23).** No code anywhere reads or writes it
   anymore, but the field — one record, the same one already in the backup above — was left
   in place on purpose: it costs nothing (nowhere near the 1MiB ceiling), and it's the last
   in-system copy to cross-check against the backup file if that's ever needed. **If you're
   reading this and considering deleting it as unused cruft: don't, without checking with
   Anthony first** — it's inert by design, not an oversight.
4. Leave `publish-page-log` and the existing Indexing tab entirely alone — they operate on
   `schedule.ts`/`client.publishing` directly and have nothing to do with the
   `scheduledPages` array being retired.

**Stage 2 — MANUAL paste-package first, then GIT_STATIC end to end**
**Reordered 2026-07-23:** the MANUAL adapter's paste-package generator and post-paste
verification come first — a real GoDaddy client is waiting, and this is genuinely the
cheapest remaining piece.

**Paste-package generator + post-paste verification: built 2026-07-23.**
`paste-package.mts`'s `buildPastePackage(page, images, site)` — platform-agnostic (Wix's
real pages route through this exact same builder per the Blog-API-only decision, not a
second mechanism). Package = title, meta description, body content (straight passthrough of
`htmlBody` — the Gutenberg-sanitization pipeline, §6a, is intake work and isn't built yet,
so don't treat this as sanitized), images with alt text, and a schema block that's **always**
generated from `schemaJsonLd` when present, labeled `applicable`/`notApplicableReason` from
the site's `naGateItems` rather than silently dropped on GoDaddy (confirmed N/A above — the
work still exists for a future migration). `page-publisher-generate-paste-package`
{pageId} returns the package and marks the page `ready_to_paste` (never regresses an
already-`paste_confirmed`/`published` page). `page-publisher-verify-paste` {pageId, url} —
the operator supplies the live URL by hand (no reliable way to auto-derive one on a MANUAL
site) — fetches it via `adapter.fetchPageHtml` (genuinely just a GET, confirmed working
2026-07-23 against real client sites) and checks title/meta landed; schema is checked ONLY
when not marked N/A, and the check requires an actual parseable
`<script type="application/ld+json">` tag, not a substring match — verified against both a
synthetic valid case and the real GoDaddy entity-encoding failure mode to confirm it
correctly distinguishes them. Passes patch the page to `paste_confirmed`.

**Not yet built, and this is the real remaining gap before this can run end to end against a
real page:** the intake UI itself — there's still no way to paste raw HTML and create a
`pagePublisherPages` doc with real content through the app. §6a's sanitization pipeline
(strip `wp:*` comments, resolve `[FUTURE_SERVICE_PAGE_LINK]` placeholders, promote a bare
hero `<div>` to `<h1>`, etc.) — **built 2026-07-23, the intake UI along with it.**

**Intake UI + §6a sanitization pipeline: built 2026-07-23.** `sanitizePastedHtml(rawHtml)`
in `public/index.html` — runs client-side against a REAL browser `DOMParser`, not
regex-only parsing (more robust for structural operations like H1 detection, since it's the
same parsing model a real browser uses to render the pasted content). Covers: strip every
`<!--...-->` comment (one operation handles both wp:* pairs and standalone/leaked comments —
confirmed correct against reconstructed fixtures of both real files); strip
`wp-block-*`/`alignleft`/`alignright`/`alignwide`/`alignfull`/`size-*` classes, preserving
left/right float intent as a `data-align` attribute (§6c's site-specific component mapping
isn't built yet, so this is a normalized marker, not a final rendering decision); detect
`[ALL_CAPS: text]`-shaped placeholders generically (never a hardcoded token name); promote a
bare, childless, text-only hero `<div>` to `<h1>` when none exists, or flag for manual fix
when there's no obvious candidate; extract every `<img>` and flag temp-URLs/missing-height/
all-`loading="lazy"`; parse (not yet merge — that's §6b, still separate) any existing
`<script type="application/ld+json">`.

New UI: `PagePublisherView`'s "Pages" section (list + New Page) and `PageIntakeForm` — paste
raw HTML, get the sanitize report, resolve every placeholder (link it or remove the bracketed
text) and give every image alt text before Save enables — the same two hard-block rules
`page-publisher-create-page` re-checks server-side rather than trusting the client alone.
Images: real WebP conversion + up to 3 srcset sizes via Canvas (client-side — no server image
library, avoids a native-binary dependency like sharp in a Netlify Function), descriptive
filename from alt text, LCP marking (removes `loading="lazy"` from the marked image's tag),
uploaded to Firebase Storage (`kailenflow-suite.firebasestorage.app`, confirmed provisioned
via the client SDK's own config) via a new `page-publisher-upload-image` endpoint.

**Tested against RECONSTRUCTED fixtures, not the literal original files** — the two real
uploads (`echlos--tx--location-page.html`, `air-conditioning-contractor.html`) were no longer
in context after this conversation's compaction. Fixtures were rebuilt faithfully from every
structural detail already documented above in this file (wp:image comment pairs, alternating
alignleft/alignright, the leaked "introHtml contains intentional HTML formatting" comment,
zero placeholders on the location page vs. six `[FUTURE_SERVICE_PAGE_LINK: ...]` on the
service page, both real schema graph shapes) and run through the sanitizer via a live browser
session. Results matched every documented pattern exactly — correct comment counts, correct
class stripping + align preservation, correct H1 promotion, correct placeholder detection
(0 vs. 6, with exact token text), correct image flags, and correct schema parsing for both
graph shapes (top-level `Service` node for the location page; business-level-only with nested
`Service` objects under `hasOfferCatalog` for the service hub page).

**Re-tested 2026-07-23 against the literal original files** (re-attached: `air-conditioning-
contractor.html`, `echlos--tx--location-page.html`) — confirms the fixture-based validation
above was sound, but surfaced one real bug the idealized reconstructions couldn't have caught,
plus one genuine detail the spec never captured precisely:

- **Real bug found and fixed**: the promoted `<h1>`'s text carried raw newline/indentation
  whitespace straight through from the real files' hero div (`"\n    Air conditioning
  contractor in Providence Village\n  "`) — the hand-built reconstructions happened to have
  no whitespace in their hero text, so this never surfaced against them. Fixed with a
  `.trim()` on the promoted text.
- **Everything else matched exactly**: comment/class stripping, all 6 `[FUTURE_SERVICE_PAGE_
  LINK: ...]` placeholders on the service page with exact token text (0 on the location page,
  correct), every image flagged (temp-URL/missing-height/all-lazy — 5 images on the AC page, 3
  on the location page), and both schema graph shapes.
- **Detail the spec described generically but never pinned down**: the AC page's business
  node's `@type` is the specific `HVACBusiness` (a real schema.org subtype), not a generic
  `Organization`/`LocalBusiness` as "business-level only" implied. Worth keeping in mind if a
  future generator run or gate check assumes a specific `@type` string.
- **Confirmed, not assumed**: neither real file has a `<title>` or `<meta name="description">`
  tag at all — both are body fragments. This directly informed the auto-fill feature below.

**Auto-fill + file upload, added 2026-07-23 (Anthony's request, discovered while testing
against the real files)**: `sanitizePastedHtml` now also returns `suggestedTitle` (the H1
text, promoted or already-present) and `suggestedMetaDescription` (the first paragraph over
40 characters, truncated to ~160 chars) — auto-filled into the intake form's Title/Meta
description fields on sanitize, but never overwriting something the operator already typed,
and explicitly labeled as inferred/reviewable, not literal tags (confirmed above that neither
real file has one). Interesting real-file result: on both real files, the 40-char threshold
picked the HERO SUBTITLE paragraph (e.g. "Expert HVAC installation, repair & maintenance —
residential and commercial") rather than the long rambling intro paragraph later in the page —
which reads like genuine ad copy and turned out to be a better meta-description candidate than
truncating the intro mid-sentence would have been. The paste step also gained a "Load from
file" option (FileReader-based) so the operator can select the `.html` file directly instead
of copy-pasting its contents, and the Sanitize button no longer requires Title to be typed
first, since title now typically comes FROM sanitizing, not before it.

**Page delete: built 2026-07-23** (Anthony deleted a real test page created via intake). No
delete mechanism existed — added `deletePage`/`deleteImageDocsForPage` (firestore.mts),
`deletePageImageFile` (storage.mts, best-effort Storage cleanup, never blocks the delete on a
missing/already-gone file), a `page-publisher-delete-page` endpoint, and a Delete button per
row in the Pages list. **Found and fixed a real crash while using it**: `listImagesForPage`'s
`.where("pageId","==",...).orderBy("sortOrder")` needs a Firestore composite index that was
never created — this query path had never actually run in production before
`generate-paste-package`/`delete-page` existed to call it. Fixed by sorting in memory instead
of relying on Firestore's own `.orderBy()`, removing the index dependency entirely rather than
requiring a manual step in the Firebase Console. **This means `generate-paste-package` was
ALSO broken until this fix** — worth knowing if it was tried before this date and appeared to
fail for no clear reason.

**Not built, deliberately**: §6b's schema MERGE (adding `BreadcrumbList`/dates, promoting
nested `Service` nodes to top-level, reconciling duplicate business-entity representations) —
schema is parsed and ready for it, but the merge itself needs sitewide `siteGraph.schemaGraph`
(§5a), which is Stage 3 work. Internal linking UI (parent/hub/inbound/outbound, Link Map) —
explicitly deferred to its own round, next, per Anthony's instruction not to rush it at the
end of this one. Editing an existing draft page — this round is paste-to-create only.

Once GIT_STATIC's own turn in Stage 2 comes: intake, paste HTML, upload/convert images,
preview, commit immediately (single Git-Trees-API commit, page file + schedule.ts entry).
Proves the whole chain against a real client repo.

**Stage 3 — The gate**
Port every checklist item per §5, including the whole-site checks (§5a) — this is where
`siteGraph.linkGraph`/`schemaGraph`/`sitemapUrls` start being populated (Stage 1 only ever
built `pageIndex`). Wire in the actual IndexNow *ping* call using the key already generated
and committed back in Stage 1 (§3a) — the key/key-file setup is a connect-time action, not
gate work; only the runtime call itself belongs here. Retire Arbor Care's one-off script
once this lands. Wire the reuse map (§3) in rather than reimplementing. Build the gate
report UI, and the Link Map view (§6d) alongside it — both read the same `siteGraph`.
Budget real time — this is the largest piece.

**Stage 4 — Scheduling & calendar**
Extend `publish-page-log`'s cron (or add a sibling function using its exact
`fetchSchedule`/`isLive` pattern) to re-gate + flip status + submit for indexing when a
`schedule.ts` date passes. Calendar UI, drag-to-reschedule (= re-commit, §1), retry logic,
publish-hour windows.

**Stage 5 — (moved) Manual adapter's paste-package + verification now open Stage 2 above**
Left here only as a pointer for anyone reading top-to-bottom — see Stage 2. The adapter
foundation itself (connect + read existing pages) was built at Stage 1 depth, 2026-07-23.

**Stage 6 — Wix (Blog API only, confirmed 2026-07-23), then WordPress**
Wix moved behind MANUAL in priority — build only when the Blog-API-only scope above is
ready to start. WordPress: only when an actual client is on it. Unchanged from v1 otherwise.

---

## 10. Things That Will Go Wrong — unchanged from v1, plus one addition

All of v1's §10 stands (slug collisions, mangled manual-paste HTML, timezone display,
optimistic locking, gate-passes-at-approval-fails-at-publish). One GIT_STATIC-specific
addition: **a commit can succeed on GitHub but the Actions rebuild can fail or never run**
— this is exactly what `workflowHealth` (built today, `fetchLatestWorkflowRun`) already
detects for the existing Scheduled Pages flow. Reuse it here too: after a Page Publisher
commit, the same GitHub Actions health check should cover it, so a broken client-repo
pipeline shows up the same way it already does on the Indexing tab, not as a second,
separate blind spot.

---

## 11. Definition of Done — unchanged in spirit, GIT_STATIC-first in wording

- A GIT_STATIC client site can be connected (reusing `client.publishing.repo`), its file
  tree + `schedule.ts` pulled as the existing-URL index, a page composed from pasted HTML
  plus images, previewed, run through the full two-layer checklist, scheduled (one commit,
  `schedule.ts` as the single date authority), and confirmed live with inbound links
  applied in the same commit and an indexing submission fired via existing code.
- A GoDaddy/Vistaprint client goes through the identical flow up to the final step, where
  it produces a paste package and a task, then verifies the live URL after confirmation.
- No page reaches `published` without a `pagePublisherGateRuns` doc with `overall = 'pass'`.
- Every checklist item appears in the gate report with pass/fail/reasoned-unverifiable.
  Nothing silently skipped.
- `appData/main` only ever grows by light pointers for this feature, with a pruning policy
  in place from Stage 1 — not a second version of the crisis already fixed once this month.
- Every `data.scheduledPages[]` entry has a matching `pagePublisherPages` draft doc,
  confirmed by count before the old component/array is removed; `CalendarView` reads only
  the new pointers afterward.
- Every GIT_STATIC site has a committed, verified IndexNow key file before its gate is
  considered to cover `l1.crawl.indexnow` for real.
- Orphan/duplicate-title/broken-link/sitemap-integrity/schema-graph checks run against the
  whole site, not just the page being published, on every gate run.
- No page can be scheduled without a `parentUrl` set (or explicitly acknowledged missing)
  and at least one accepted inbound link beyond the parent — enforced at intake, not
  discovered later at gate time.
- On GIT_STATIC, a scheduled page's own file and every accepted inbound link edit land in
  exactly one commit — never a page commit followed by separate link commits.
- The Link Map view renders every connected site's hub/spoke/orphan structure from
  `siteGraph` with zero additional fetches, orphans visually distinct (red).
- Both real generator files this spec was reconciled against — a Rankin Waste location
  page and an Anytime Heating & Air service hub page — pass intake cleanly: every
  Gutenberg artifact stripped, every placeholder resolved or deleted, every image
  re-hosted with real dimensions and correct lazy/LCP treatment, exactly one H1, and a
  schema graph with `BreadcrumbList` + dates added without a second script block.
