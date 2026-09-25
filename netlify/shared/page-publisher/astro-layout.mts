// Derives a GIT_STATIC site's layout/frontmatter/content-directory convention
// by reading REAL existing pages in the repo — never guessed, never assumed
// consistent across clients (page-publisher-build-spec.md §6c). Rankin
// Waste and Anytime Heating & Air are different codebases built at
// different times; this must be sampled fresh per site, not hardcoded.
import { ghHeaders, parseOwnerRepo } from "../github-schedule.mts";
import type { AstroLayoutInfo } from "./firestore.mts";

const MAX_SAMPLES = 5;

// Extracts the YAML frontmatter block between the leading `---` fences and
// parses it with a deliberately simple flat key:value line reader — Astro
// frontmatter in practice is flat (layout/title/description/etc.), and a
// full YAML parser is more than this needs. Nested structures are left as
// their raw string form rather than mis-parsed.
function parseFrontmatter(source: string): Record<string, string> | null {
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export async function deriveAstroLayout(
  owner: string,
  repoName: string,
  ref: string,
  headers: HeadersInit,
  pagesDir: string,
  candidatePaths: string[] // real .astro file paths already known to exist (e.g. from listExistingUrls' repo-tree read) — avoids a second tree fetch
): Promise<AstroLayoutInfo> {
  const astroFiles = candidatePaths.filter((p) => p.endsWith(".astro")).slice(0, MAX_SAMPLES);
  const sampledFrom: string[] = [];
  const samples: { path: string; frontmatter: Record<string, string> }[] = [];

  for (const path of astroFiles) {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/${path}?ref=${encodeURIComponent(ref)}`, { headers, cache: "no-store" });
    if (!res.ok) continue;
    const data = await res.json();
    if (!data.content) continue;
    const content = Buffer.from(data.content, "base64").toString("utf8");
    const frontmatter = parseFrontmatter(content);
    if (!frontmatter) continue;
    samples.push({ path, frontmatter });
    sampledFrom.push(path);
  }

  if (samples.length === 0) {
    return {
      layoutPath: "",
      contentDir: pagesDir,
      frontmatterShape: {},
      sampledFrom: [],
      derivedAt: Date.now(),
      inconsistent: true,
      inconsistencyNote: "No sampled page had a parseable frontmatter block — could not derive a layout convention. Surface this to the operator rather than guessing.",
    };
  }

  const layoutValues = new Set(samples.map((s) => s.frontmatter.layout || "").filter(Boolean));
  const keySets = samples.map((s) => Object.keys(s.frontmatter).sort().join(","));
  const uniqueKeySets = new Set(keySets);

  const inconsistent = layoutValues.size > 1 || uniqueKeySets.size > 1;
  const inconsistencyNote = inconsistent
    ? `Sampled pages don't agree: ${layoutValues.size} distinct "layout" value(s) (${[...layoutValues].join(" | ")}), ${uniqueKeySets.size} distinct frontmatter key set(s) across ${samples.length} samples. Do not pick one silently — confirm the right convention with the operator.`
    : undefined;

  // First sample's shape as the working convention when consistent — when
  // inconsistent, this is still returned as a best-guess default but
  // `inconsistent:true` means callers MUST surface it rather than trust it.
  //
  // inconsistencyNote is spread in conditionally, never assigned `undefined`
  // directly — the Firestore Admin SDK throws on ANY field whose value is
  // literal `undefined` (confirmed live 2026-07-23: this crashed
  // connect-site's saveSite call with "Cannot use undefined as a Firestore
  // value" the first time a real repo actually hit the consistent, non-
  // inconsistent branch in production — every site tested during Stage 1
  // happened to hit the inconsistent/no-samples branches instead, which
  // always set a real string, so this was never exercised until now).
  const first = samples[0];
  return {
    layoutPath: first.frontmatter.layout || "",
    contentDir: pagesDir,
    frontmatterShape: first.frontmatter,
    sampledFrom,
    derivedAt: Date.now(),
    inconsistent,
    ...(inconsistencyNote ? { inconsistencyNote } : {}),
  };
}

// Convenience wrapper for callers that only have owner/repo/branch (not
// pre-fetched candidate paths) — used by the connect-site function.
export async function deriveAstroLayoutForRepo(repo: string, branch: string, pagesDir: string, astroFilePaths: string[]): Promise<AstroLayoutInfo> {
  const token = Netlify.env.get("GITHUB_TOKEN");
  if (!token) throw new Error("GITHUB_TOKEN not configured on the server");
  const parsed = parseOwnerRepo(repo);
  if (!parsed) throw new Error(`Invalid repo format "${repo}"`);
  return deriveAstroLayout(parsed.owner, parsed.repoName, branch, ghHeaders(token), pagesDir, astroFilePaths);
}
