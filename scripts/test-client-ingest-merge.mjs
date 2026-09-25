// Proves session-reported data lands on the right client, never on a guess,
// and that re-running replaces instead of duplicating.
// Run: node scripts/test-client-ingest-merge.mjs
import { matchClientId, applyIngest } from "../netlify/shared/client-ingest-merge.mts";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("PASS ", name); } else { fail++; console.log("FAIL ", name, "\n   got ", g, "\n   want", w); }
};

const clients = [
  { id: "c1", name: "Anytime Heating & Air" },
  { id: "c2", name: "Pool Clean" },
  { id: "c3", name: "Higher Power Electric" },
];

// Matching.
eq("exact id wins", matchClientId({ clientId: "c2", match: "Anytime" }, clients), "c2");
eq("unknown id falls through to name", matchClientId({ clientId: "nope", match: "Pool Clean" }, clients), "c2");
eq("exact name", matchClientId({ match: "anytime heating & air" }, clients), "c1");
eq("punctuation ignored", matchClientId({ match: "Anytime Heating and Air" }, clients), null);
eq("single partial match", matchClientId({ match: "Higher Power" }, clients), "c3");
eq("no match", matchClientId({ match: "Someone Else" }, clients), null);
eq("empty row", matchClientId({}, clients), null);
eq("ambiguous partial is refused", matchClientId({ match: "Power" }, [
  { id: "a", name: "Higher Power Electric" }, { id: "b", name: "Power Wash Pros" },
]), null);

// Applying.
const now = Date.parse("2026-09-24T12:00:00Z");
let records = {};
let r = applyIngest(records, clients, "elara", [
  { match: "Pool Clean", status: "Argus: 12 keywords tracked", work: [{ at: "2026-09-20T10:00:00Z", text: "Published 2 pages" }] },
  { match: "Ghost Client", status: "nothing" },
], now);
eq("matched one", r.matched, ["c2"]);
eq("unmatched reported, not guessed", r.unmatched, ["Ghost Client"]);
eq("status stored", records.c2.external.elara.status, "Argus: 12 keywords tracked");
eq("reporting marks the tool connected", records.c2.tools.elara, true);
eq("work stored", records.c2.externalWork.elara.length, 1);

// Re-running replaces that source's work rather than appending.
applyIngest(records, clients, "elara", [
  { match: "Pool Clean", work: [{ at: "2026-09-21T10:00:00Z", text: "Published 1 page" }] },
], now);
eq("re-run replaces", records.c2.externalWork.elara.map((w) => w.text), ["Published 1 page"]);

// A second source doesn't disturb the first.
applyIngest(records, clients, "merchynt", [{ match: "Pool Clean", work: [{ at: "2026-09-22T10:00:00Z", text: "Posted to GBP" }] }], now);
eq("sources kept apart", Object.keys(records.c2.externalWork).sort(), ["elara", "merchynt"]);

// Rubbish is dropped rather than shown as real work.
applyIngest(records, clients, "elara", [{ match: "Pool Clean", work: [
  { at: "not-a-date", text: "Bad" }, { at: "2026-09-23T10:00:00Z", text: "" }, { at: "2026-09-23T11:00:00Z", text: "Good" },
] }], now);
eq("invalid work dropped", records.c2.externalWork.elara.map((w) => w.text), ["Good"]);

// connected:false marks a tool as not connected without inventing work.
applyIngest(records, clients, "elara", [{ match: "Higher Power Electric", connected: false, status: "no account" }], now);
eq("connected false respected", records.c3.external.elara.connected, false);
eq("connected false does not tick the tool", records.c3.tools, undefined);

// Contact history (Paige's automated emails, client replies).
records = {};
applyIngest(records, clients, "paige-email", [{ match: "Pool Clean", touches: [
  { at: "2026-09-22T14:00:00Z", note: "Pool Clean's Weekly Summary" },
  { at: "2026-09-23T09:00:00Z", note: "Re: Pool Clean's Weekly Summary", direction: "from-client" },
  { at: "garbage", note: "bad date" },
] }], now);
eq("touches stored", records.c2.externalTouches["paige-email"].length, 2);
eq("client reply keeps its direction", records.c2.externalTouches["paige-email"][1].direction, "from-client");
eq("default channel is email", records.c2.externalTouches["paige-email"][0].channel, "email");
eq("touches don't count as work", records.c2.externalWork, undefined);
applyIngest(records, clients, "paige-email", [{ match: "Pool Clean", touches: [{ at: "2026-09-24T10:00:00Z", note: "What's new at Pool Clean?" }] }], now);
eq("re-run replaces touches too", records.c2.externalTouches["paige-email"].map((t) => t.note), ["What's new at Pool Clean?"]);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
