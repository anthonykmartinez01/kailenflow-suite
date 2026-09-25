// Proves commit messages become something a CLIENT would understand, and that
// noise (merges, CI, dependency bumps) never reaches a client update.
// Run: node scripts/test-github-work.mjs
import { humanize } from "../netlify/shared/github-work.mts";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("PASS ", name); } else { fail++; console.log("FAIL ", name, "\n   got ", g, "\n   want", w); }
};

eq("plain message", humanize("Update the H1 on the services page"), "Update the H1 on the services page");
eq("conventional prefix stripped", humanize("feat(pages): add AC repair in Prosper page"), "Add AC repair in Prosper page");
eq("breaking-change prefix stripped", humanize("fix!: correct phone number in footer"), "Correct phone number in footer");
eq("chore is noise however it's spaced", humanize("chore : tidy up"), null);
eq("first line only", humanize("Add pricing page\n\nLong body explaining everything"), "Add pricing page");
eq("capitalised", humanize("rewrite meta description"), "Rewrite meta description");

eq("merge commits skipped", humanize("Merge pull request #12 from main"), null);
eq("CI skipped", humanize("ci: update workflow"), null);
eq("dependency bumps skipped", humanize("bump astro from 4.1 to 4.2"), null);
eq("chore skipped", humanize("chore: tidy files"), null);
eq("wip skipped", humanize("WIP"), null);
eq("deploy skipped", humanize("deploy site"), null);
eq("skip-ci tag skipped", humanize("[skip ci] regenerate"), null);
eq("empty skipped", humanize(""), null);
eq("whitespace skipped", humanize("   \n  "), null);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
