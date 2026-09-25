# Mobile-only CSV filtering — ClearoutPhone

Requested by Anthony 2026-08-03. Not built yet.
Renamed from twilio-mobile-filter-spec.md — provider switched to ClearoutPhone
after verifying pricing and capabilities 2026-08-03. Twilio is now the fallback
only; see "Why not Twilio" below.

## Goal
Paste a CSV of leads in, get the SAME CSV back with non-mobile rows removed.
Same columns, same order, same values — only rows dropped. Anthony was explicit:
"the new output gives me the same CSV just with all of those other numbers and
contacts removed that shouldn't be there."

## Why this is needed
US line type CANNOT be derived from the number itself — area codes stopped
mapping to line type when number portability arrived. Only a carrier lookup
resolves it. The existing Lead Finder stores a `lineType` field when it happens
to have one, but the CSV export includes every lead with a phone number
regardless; there is no mobile filter today.

## PROVIDER: ClearoutPhone
Anthony already has an account with ~4,087 credits as of 2026-08-03.
Credentials: generate an API token in the ClearoutPhone dashboard (API tab) and
store as CLEAROUTPHONE_API_TOKEN in Netlify env vars, alongside the other keys.
Anthony creates the account/billing himself — Claude must not enter payment
details or create accounts.

### Real-time endpoint (verified 2026-08-03)
  POST https://api.clearoutphone.io/v1/phonenumber/validate
  Authorization: Bearer <token>
  Body: JSON with the phone number and an optional country code

### Response fields
  status        valid | invalid | unknown
  phone         original number submitted
  carrier       network operator
  line_type     Mobile | Landline | Fixed line or mobile | VoIP | Toll-free |
                Premium rate | Shared cost | Personal number | Pager
  country_code
  e164_format   standardized international

Note this returns MORE than Twilio's line-type package: a validity status AND
type AND E.164 normalisation in one call. It therefore doubles as the number
cleaner this feature needs anyway.

### ⚠️ USE THE BULK API, NOT A LOOP
ClearoutPhone has a Bulk API: upload a file of numbers, it processes
asynchronously, you download results with validation data appended per row.
That maps almost exactly onto the requirement (CSV in, CSV out) and is the main
reason for choosing this provider.
DO NOT implement this as N real-time calls in a loop. Confirm the exact bulk
endpoints from https://docs.clearoutphone.io/ (JS-rendered — the docs page will
not fetch as plain HTML; open it in a browser or use the browser tools).
Expect roughly: create/upload job -> poll status -> download result.

### Credits
Standard validation = 1 credit per number. "Smart Validation" consumes 1 credit
for most numbers and UP TO 5 when deeper validation is needed — CHECK WHICH MODE
THE API DEFAULTS TO before running a large list, and surface the mode in the UI.
Effective cost ~$0.0046–0.0096 per credit depending on tier. Credits never
expire ("Remaining credits never expire and will be carried forward").

## Why not Twilio (kept as fallback only)
Twilio Lookup v2 line_type_intelligence is comparable per-number (~$0.005–0.01)
but has NO BULK ENDPOINT — one HTTP request per number, so 5,000 rows = 5,000
billable calls. ClearoutPhone is cheaper at volume, returns more fields, has
bulk, and Anthony already holds unexpired credits. Only fall back to Twilio if
ClearoutPhone's line_type proves unreliable in the accuracy spot-check below.

## ⚠️ ACCURACY SPOT-CHECK — DO THIS FIRST, BEFORE BUILDING
Run 20–30 numbers with KNOWN answers through Quick Validation in the dashboard
(Anthony's own mobile, a client's mobile, a known business landline). ~30
credits. This is the one thing that cannot be verified from documentation: how
fresh and correct the line_type data actually is. If it misclassifies known
numbers, stop and reconsider the provider.

## Caching — required
Cache every result in its OWN Firestore collection keyed by the E.164 number.
A number's line type effectively never changes, so cache indefinitely.
Re-running the same list must cost ZERO credits. Without this, every re-export
re-bills the whole list — the most likely way this quietly gets expensive.
De-dupe the input before submitting anything.

## Cost controls
- Before any run, show: total rows, how many are already cached, how many
  credits the run will actually consume, and remaining account balance.
  Require confirmation.
- Configurable hard cap per run.
- Log every paid validation (number, result, timestamp, credits used) to its own
  collection so spend is auditable.

## CSV behaviour — exact requirements
- Input: any CSV with a phone column. Detect by header name (phone, phone
  number, mobile, cell, tel); if ambiguous, ask rather than guess.
- Output: SAME headers, SAME column order, SAME cell values. Only whole rows
  removed. Do not reformat, reorder, retype or "clean" any other column.
- Normalise to E.164 for the lookup ONLY. Do NOT rewrite the phone value in the
  output unless Anthony asks — he may be re-importing somewhere that expects the
  original format. (Offer e164_format as an OPTIONAL extra column.)
- Report per run: kept / removed-landline / removed-VoIP / unknown /
  invalid / already-cached, with counts.

## KEEP-AND-FLAG, never silently drop
Default: KEEP rows whose result is `unknown`, `Fixed line or mobile`, or whose
lookup failed. Mark them in the report. Never delete a lead because a lookup was
inconclusive — that is silent data loss and it contradicts the standing rule in
this project that missing data stays visible rather than being guessed at (cf.
rank-map "?" points never filled with an invented rank, empty CSV cells,
"Calls from Google" naming, task #48's improvement-% flag).
"Fixed line or mobile" is a REAL return value here and will occur — it belongs
in the keep bucket, not the delete bucket.
Always emit a SECOND file containing the removed rows, so nothing is
unrecoverable.
Make "also drop VoIP" a toggle — some businesses legitimately use VoIP mobiles.

## Storage
Lookup cache and run logs in their OWN Firestore collections. NEVER appData/main
(1MiB cap; inline rank-map data filled it to 95% on 2026-07-26 and silently
failed saves until two clients were lost).

## File constraints
public/index.html ~11,400 lines, Babel-in-browser, no build step. Run
scratchpad/syntax-check.mjs and hooks-audit.mjs before deploy. Every hook above
any early return (React #300 took the app down 2026-07-30). Keep the
ErrorBoundary. 375px no horizontal scroll, 44px tap targets.

## Sources
https://clearoutphone.io/blog/automate-phone-validation-clearoutphone-api/
https://clearoutphone.io/pricing/
https://docs.clearoutphone.io/  (JS-rendered; needs a browser to read)
