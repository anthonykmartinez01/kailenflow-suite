// Proves the Paige slug guesses cover the shapes Merchynt actually uses, so
// nobody has to type a slug by hand. A candidate is only ever USED if the API
// answers for it (see discoverSlug) — these are just the things worth trying.
// Run: node scripts/test-merchynt-slug.mjs
import { slugCandidates } from "../netlify/shared/merchynt.mts";

let pass = 0, fail = 0;
const has = (name, list, want) => {
  if (list.includes(want)) { pass++; console.log("PASS ", name); }
  else { fail++; console.log("FAIL ", name, "\n   wanted", want, "in", JSON.stringify(list)); }
};
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("PASS ", name); } else { fail++; console.log("FAIL ", name, "\n   got ", g, "\n   want", w); }
};

has("simple name", slugCandidates("Pool Clean"), "pool-clean");
has("three words", slugCandidates("Higher Power Electric"), "higher-power-electric");
has("ampersand becomes and", slugCandidates("Anytime Heating & Air"), "anytime-heating-and-air");
has("ampersand also dropped", slugCandidates("Anytime Heating & Air"), "anytime-heating-air");
has("LLC dropped", slugCandidates("Rankin Waste Management LLC"), "rankin-waste-management");
has("Inc dropped", slugCandidates("Arbor Care Tree Solutions Inc."), "arbor-care-tree-solutions");
has("punctuation dropped", slugCandidates("360 IV Infusion & Wellness"), "360-iv-infusion-and-wellness");
has("apostrophes dropped", slugCandidates("Brandon's Pool Clean"), "brandons-pool-clean");

eq("first candidate is the obvious one", slugCandidates("Pool Clean")[0], "pool-clean");
eq("empty name gives nothing", slugCandidates(""), []);
eq("whitespace only gives nothing", slugCandidates("   "), []);
eq("no duplicates", (() => { const l = slugCandidates("Pool Clean"); return l.length === new Set(l).size; })(), true);
eq("no leading or trailing hyphens", slugCandidates("  & Pool Clean LLC  ").every((s) => !/^-|-$/.test(s)), true);
eq("no double hyphens", slugCandidates("Anytime  Heating  &  Air").every((s) => !s.includes("--")), true);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
