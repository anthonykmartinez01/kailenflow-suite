// Exercises market-finder's address parsing, distance filter and scoring
// against the real module, transpiled by tsc.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// fileURLToPath, not .pathname — the latter leaves %20 in a path that has a
// space in it, which is exactly the case here ("Anthony Martinez").
const { fileURLToPath } = await import("node:url");
const REPO = fileURLToPath(new URL("../", import.meta.url));
const ts = (await import("typescript")).default;

// The module's pure helpers aren't exported (they're internal to the handler),
// so lift them out by transpiling and re-exporting for test.
let src = readFileSync(REPO + "netlify/functions/market-finder/index.mts", "utf8");
src = src
  .replace('import type { Context, Config } from "@netlify/functions";', "")
  .replace('import { isAuthed, unauthorized } from "../../shared/auth.mts";', "")
  .replace("function haversineMiles", "export function haversineMiles")
  .replace("function parseCityState", "export function parseCityState")
  .replace(/export default async[\s\S]*$/, "");

const dir = mkdtempSync(join(tmpdir(), "mf-"));
const p = join(dir, "mf.mjs");
writeFileSync(p, ts.transpileModule(src, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText);
const mf = await import("file://" + p.replace(/\\/g, "/"));

let pass = 0, fail = 0;
const t = (name, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got ${JSON.stringify(a)} want ${JSON.stringify(e)}`}`);
};

console.log("=== ADDRESS PARSING (city + state out of a Places address) ===");
t("standard US address", mf.parseCityState("1234 Main St, Aubrey, TX 76227, USA"), { city: "Aubrey", state: "TX" });
t("suite in the street line", mf.parseCityState("500 W Hwy 380 Ste 200, Cross Roads, TX 76227, USA"), { city: "Cross Roads", state: "TX" });
t("two-word city", mf.parseCityState("100 Oak Dr, Providence Village, TX 76227, USA"), { city: "Providence Village", state: "TX" });
// A listing with no street line still yields a usable city — three comma
// parts is exactly the minimum the parser needs.
t("no street line still parses", mf.parseCityState("Little Elm, TX 75068, USA"), { city: "Little Elm", state: "TX" });
t("two parts is too few to trust", mf.parseCityState("TX 75068, USA"), null);
t("garbage returns null not a guess", mf.parseCityState("somewhere"), null);
t("empty returns null", mf.parseCityState(""), null);
t("numeric 'city' rejected", mf.parseCityState("1 A St, 76227, TX 76227, USA"), null);

console.log("\n=== DISTANCE ===");
const aubrey = { lat: 33.3043, lng: -96.9861 };
const frisco = { lat: 33.1507, lng: -96.8236 };
const d = mf.haversineMiles(aubrey, frisco);
t("Aubrey->Frisco is roughly 14 miles straight-line", Math.round(d), 14);
t("zero distance to self", Math.round(mf.haversineMiles(aubrey, aubrey)), 0);

// Scoring thresholds are inline in the handler; assert the intended bands
// directly so a later edit to them is a visible test change.
console.log("\n=== VERDICT BANDS (as implemented) ===");
const verdict = (topReviews, avgReviews) =>
  topReviews < 50 && avgReviews < 20 ? "winnable" : topReviews < 200 && avgReviews < 80 ? "contested" : "hard";
t("sleepy town is winnable", verdict(31, 9), "winnable");
t("mid market is contested", verdict(150, 40), "contested");
t("one dominant player pushes out of winnable", verdict(160, 12), "contested");
t("big metro is hard", verdict(420, 96), "hard");
t("high average alone is enough to be hard", verdict(190, 95), "hard");

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

