# KailenFlow Suite — Project Context

Paste this whole file into a new Claude session's first message if you restart this
project in a different folder. Claude's memory system is scoped to the project
*directory path*, so a new folder means a blank memory slate — this file is the
portable backup of everything that matters.

## What this is

A local-SEO agency management tool: client dashboards, rank tracking, task/activity
logs, content scheduling, and GitHub-integrated auto-publishing/indexing — all in one
app, built for a solo/small agency operator (not a multi-tenant SaaS product).

## Architecture

- **`public/index.html`** — the entire frontend. One file, ~10,800 lines. React 18 via
  UMD `<script>` tags, JSX, no bundler. Tailwind via CDN. Every component is a
  top-level `function ComponentName(){}` — function declarations are hoisted, so
  definition order in the file doesn't matter for calling them from earlier in the
  file (this is why the build uses `sourceType:"script"`; module scoping would
  break it).
- **`build.mjs` — deploy-time compile (added 2026-08-04).** `public/index.html` is
  still the hand-edited source of truth and the local preview still serves it with
  in-browser Babel, so authoring is unchanged. But the DEPLOYED copy is compiled:
  `npm run build` transpiles the JSX to plain JS, drops the babel-standalone
  `<script>`, and writes `dist/` (gitignored), which `netlify.toml` publishes.
  Why: the browser was rebuilding the app on every load — 2.78 MB of
  babel-standalone plus re-transpiling 741 KB of JSX into ~3 MB of ES5, measured at
  **~5.4 s of blocking work per page load**. Now 0 ms; domContentLoaded went
  5,683 ms → 406 ms in production. `preset-react` only, never `preset-env` —
  preset-env is exactly what inflated the output 4x, and the app already relies on
  modern syntax unpolyfilled. Don't "simplify" by pointing `publish` back at
  `public/`; that silently restores the 5.4 s.
- **`netlify/functions/*/index.mts`** — backend, Deno-based Netlify Functions.
- **`netlify/shared/*.mts`** — logic shared across multiple functions (extract here
  whenever 2+ functions need the same logic — established pattern this session:
  `heatmap.mts`, `github-schedule.mts`, `indexing.mts`, `schedule.mts`,
  `firestore-admin.mts`, `auth.mts`, `dataforseo.mts`, `google-auth.mts`).
- **Data store**: Firebase Firestore, single document `appData/main`, entire app
  state as one JSON string in a `json` field. Client writes via `saveData()`
  (in `public/index.html`). Server writes via `readAppData()`/`writeAppData()`
  (`netlify/shared/firestore-admin.mts`) — used only by the two cron functions,
  since nothing else runs without a browser open.
- **Auth**: `isAuthed()`/`unauthorized()` (`netlify/shared/auth.mts`) for
  browser-originated calls. Server-to-server/automation calls use a shared
  `x-automation-key` header checked against `AUTOMATION_API_KEY` env var.
- **Two Netlify cron functions** (only two in the whole repo):
  - `run-scheduled-heatmaps` — every 15 min, handles `client.scheduledHeatMaps[]`
    (rank-map generation) and finalizes pending live heat maps.
  - `publish-page-log` — hourly, reads every client's GitHub `schedule.ts`, and for
    any page whose go-live date just passed: submits it for indexing (Google
    Indexing API + PrimeIndexer), logs a Completed task + an activity entry. See
    "GitHub scheduling & auto-publish pipeline" below.
- **Deploy = two separate steps, always both**: `git push origin main` AND
  `netlify deploy --prod --message "..."`. Pushing to GitHub does NOT auto-deploy —
  this project is not Git-linked to Netlify.

## Design system ("Stitch")

- Font: Manrope (`font-manrope` class). Icons: Material Symbols
  (`material-symbols-outlined`), not emoji, except a few small spots where an emoji
  is more compact (e.g. calendar chips, prompt category badges) — locally consistent
  choices, not a hard rule.
- Brand color: `#C45A30` (terracotta), exposed as Tailwind `brand`/`brand-dark`/
  `brand-hover`/`brand-light` etc. via `tailwind.config` inline in the file.
- Card pattern: `stitch-glass-card rounded-[24px] p-6` (large panels), `rounded-[20px]
  p-4/p-5` (smaller items), `rounded-[32px] p-8` (chart panels). Hover lift:
  `stitch-hover-lift`.
- Touch targets: `.touch-target` class enforces 44×44px minimum — apply to every
  clickable element, especially icon-only buttons.
- Mobile-first: sticky mobile header (`lg:hidden`) + fixed bottom nav (`lg:hidden`) +
  slide-in `<aside>` drawer, `lg:` breakpoint switches to the persistent left sidebar.

## Key data models

- `client.publishing = { repo, branch, pagesDir, buildHook, notifiedPaths[] }` —
  GitHub integration. `repo` is `"owner/repo-name"` format, set in Settings. Powers:
  dashboard's Scheduled/Generated Pages tiles, Calendar integration, auto-publish
  task/activity logging, auto-indexing. `notifiedPaths` tracks which `schedule.ts`
  entries have already been logged, so the hourly cron never double-logs.
- `client.rankMaps[]` — heat-map snapshots. `generatedBy:'live'` (DataForSEO,
  async submit/poll) or legacy manual/screenshot uploads. Each live entry can carry
  `competitors[]` (top-20 competitors' own per-point ranks, free — reuses data
  DataForSEO already returns per grid point, no extra API cost).
- `client.trackedKeywords[]` — Focus/Tracked keyword list (Rankings tab), separate
  from the raw `rankMaps[]` history.
- `client.tasks[]` — `{id (number, Date.now()), date ('YYYY-MM-DD'), title,
  description, phase (one of PHASES const), status ('Pending'|'In Progress'|
  'Completed'), createdAt (ISO), completedAt (null|ISO)}`.
- `client.activities[]` — `{id (string, uid()), taskId (number|''), date (ISO),
  text, autoGenerated (bool), createdAt (ISO)}`. Rendered in ActivityLog and the
  Monthly SEO Report's "Activity This Month".
- `data.scheduledPages[]` — **top-level, not per-client** (each entry carries its
  own `clientId`). The in-app "paste content, pick a go-live date" pipeline — a
  DIFFERENT thing from `client.publishing`'s GitHub `schedule.ts` integration. Not
  yet wired to actually auto-commit/publish (see Pending below).
- `data.prompts[]` — Prompts library (Tools nav). `{id, name, category, text,
  fileName (optional, adds a Download button), createdAt, updatedAt}`.
- `data.calendarEvents[]` — manual calendar events, merged at render time with
  `data.scheduledPages` (as read-only chips) in `CalendarView`.

## GitHub scheduling & auto-publish pipeline

The user runs their own Astro projects with a WordPress-style scheduling setup
(built from a saved prompt in the Prompts library: "WordPress-Style Scheduled
Publishing for a Static Site") — a `src/lib/schedule.ts` registry keyed by URL path
→ go-live date, a GitHub Action that deploys daily. This app reads that file
directly via GitHub's Contents/Trees API (`GITHUB_TOKEN` env var, agency-wide PAT) —
it does NOT write to client repos except via the one-time "Enable Auto-Indexing"
setup (below).

- `netlify/shared/github-schedule.mts` — `parseSchedule()`, `fetchSchedule()`,
  `countPageFiles()` (lists real page files in the repo's `pagesDir` via git trees
  API — this is deliberately independent of `schedule.ts`, so a page published by
  hand, skipping the registry entirely, still counts).
- `/api/scheduled-pages-status` — per-client (or cross-client for
  `IndexingDashboard`) live read of `schedule.ts` + real page count.
- `publish-page-log` (hourly cron) — the important one. For every page whose
  `schedule.ts` date has passed and isn't yet in `notifiedPaths`: submits it for
  indexing (`netlify/shared/indexing.mts` → `submitAndLog()`, Google Indexing API +
  PrimeIndexer in parallel) AND logs a Completed task + activity, fully automatic,
  no per-client opt-in needed.
- **Separately**, `enable-indexing-automation` is an older, still-functional,
  OPT-IN-per-client mechanism: installs a script + GitHub Actions step + repo secret
  directly into a client's OWN repo, so their own daily deploy action also pings
  `/api/submit-indexing`. Redundant with `publish-page-log` now but harmless to
  leave both running for clients who already have it installed.

## Established conventions / feedback (apply these without being asked again)

- **Verify every UI change via isolated `ReactDOM.createRoot().render()` mounts**
  with mock data in the browser preview before shipping — the `computer` screenshot
  tool is unreliable in this environment (frequent 30s timeouts), so DOM assertions
  (`innerHTML.includes(...)`, `getBoundingClientRect()`, computed styles) are the
  reliable verification method, not screenshots.
- **Type-check every `.mts` change**: `npx tsc --noEmit <file>`. Expect ~7 standard
  pre-existing environment-only errors every time (`Cannot find module
  '@netlify/functions'`, `.mts extension` resolution, `Cannot find name 'Netlify'`,
  firebase-admin `esModuleInterop`, `node_modules` private-identifier errors) — these
  are NOT real bugs, ignore them; only flag genuinely NEW error types.
- **JSX comment gotcha (caused 2 real production-breaking bugs this session)**:
  `{/* comment */}` is only valid INSIDE a JSX element's children, never as a
  sibling before the single root element of a `return(...)`. If commenting right
  before a `return(`'s JSX, use a plain `//` comment ABOVE `return`, not inside the
  parens.
- **CSS `mix-blend-mode` gotcha**: `mix-blend-mode:'color'` derives its result from
  `SetLum(overlayHue, backdropLuminosity)` — it CANNOT inject brightness into
  near-black backdrops (like the CARTO dark map tiles), only re-hue within the
  existing luminosity. Use `mix-blend-mode:'screen'` (additive) to reliably lighten/
  tint near-black content instead.
- **Leaflet z-index leak gotcha**: Leaflet assigns internal panes z-index 200–700
  for its own layering. A wrapper without `isolation:isolate` (or
  `relative isolate` Tailwind classes) lets those values leak past ancestor
  stacking contexts and paint over page-level UI like modals opened above an
  already-mounted map. Always isolate map wrapper components.
- **Deploy every shipped change immediately** (git push + netlify deploy --prod) —
  established norm this session, don't wait to batch multiple fixes.
- **Detailed commit messages**: root cause + what changed + how it was verified.
  Trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- **Use `AskUserQuestion` when genuinely ambiguous** rather than guessing — e.g.
  which of two dashboard tiles should show which number, whether to keep an
  existing label vs. rename it. Several features in this session were correctly
  gated behind a clarifying question first.
- **Google Business Profile API access is APPROVED** (case 7-3208000041254,
  requested 2026-07-10, confirmed 2026-08-02 — `businessprofileperformance`
  shows 300 req/min, and a quota of 0 is Google's own tell for "never
  granted"). Nothing GBP-related is gated any more; do not re-request access,
  and do not treat a 403/429 from it as "still pending" — that now means a
  wrong account, wrong location ID, or real rate limiting.
- **GBP must stay on user-OAuth** (`getGoogleAccessToken`), unlike
  Indexing/GSC/GA4 which moved to the service account. Business Profile does
  not support service accounts at all — it needs consent from an account that
  manages the listing, so an SA gets 403. See `netlify/shared/google-auth.mts`.
- **There are more GBP listings than app clients** (The Red Roofer, Doodoo
  Dude, Pool Clean have no client record), so a client's listing is always an
  explicit stored pick (`client.gbpLocationId`, chosen in Settings) — never
  fuzzy-matched by name, which would mis-assign silently.

## Pending / deferred (known gaps, not yet built)

- **Calls from Google** counts call-button TAPS on the listing (GBP's
  `CALL_CLICKS`), not connected phone calls. Real per-client inbound call
  tracking still doesn't exist — `CallCoach` is the AGENCY's own outbound
  cold-call log, not a client's inbound calls — so the card is named for what
  it actually measures rather than implying every tap became a conversation.
- `data.scheduledPages[]` (the in-app paste-and-schedule pipeline) still has the
  original "FUTURE STEP: AUTO-PUBLISH ROBOT" TODO in `ScheduledPages` component
  comments — it was never wired to actually commit content to a repo. The
  GitHub-`schedule.ts`-based pipeline (above) is what's actually live/automatic
  today; these are two parallel, not-yet-unified systems.
- Manual status toggle for `data.scheduledPages[].status` exists only as a
  temporary testing affordance (`toggleStatus`), not a real publish flow.

## Where to look first for anything else

- Memory files (if this new folder inherits/can access them):
  `C:\Users\Anthony Martinez\.claude\projects\<project-hash>\memory\MEMORY.md` and
  its linked files — covers app architecture, Netlify deploy workflow gotchas,
  Scheduled Pages feature status, monthly reporting integrations, the indexing tool,
  and the heat map generator, in more narrative detail than this file.
- Git log (`git log --oneline`) — every commit message this session is a detailed
  root-cause writeup, effectively a running changelog.
