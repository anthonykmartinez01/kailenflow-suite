// DESIGN INHERITANCE — derives, from a GIT_STATIC site's REAL repo files, the
// CSS classes a newly generated page's content must carry so it is visually
// indistinguishable from an existing page. Zero AI: file reads + parsing only.
//
// ─── Why exemplar-based and not statistical ───────────────────────────────
// Rankin Waste has two conventions living side by side. Intersecting tokens
// across the whole repo produced an <h2> class matching NEITHER real page,
// and pulled in a third convention that only exists on legal/utility pages
// (privacy-policy, terms-of-service). So a profile is derived from ONE
// exemplar file, and gaps are filled from a NAMED donor — never blended,
// never invented. Every borrow is labeled so the operator sees it.
//
// ─── How the exemplar is chosen (page-type-aware) ─────────────────────────
// NOT by a hardcoded path rule and NOT by guessing from content. By asking:
// "what do the pages that already live in this folder do?"
//
//   1. The new page's repo path is known from its slug (pagesDir/slug.astro).
//   2. Look at the real existing pages in that SAME directory.
//   3. If most of them delegate their whole body to one shared component,
//      that COMPONENT is the exemplar. (A LocationPage-based page like
//      watt.astro contains no inline markup at all — its classes live in
//      LocationPage.astro, so scoring the page file itself would score zero.)
//   4. Otherwise the exemplar is the sibling with the richest content-region
//      coverage — which naturally selects a real content page over 404.astro.
//   5. No siblings at all (brand-new section) → sitewide best-covered file,
//      flagged as a low-confidence guess for the operator to confirm.
//
// For Rankin that resolves correctly in both directions, verified against the
// real repo: slug "service-areas/<town>" lands in src/pages/service-areas/,
// where 6 of 8 siblings delegate to LocationPage.astro -> location
// convention. A root-level slug lands in src/pages/, where nothing delegates
// to a shared component, so the richest sibling wins -> the service-page
// convention. Pasting a service page can therefore never silently inherit
// the location convention.
//
// The result is persisted per site and overridable; `chosenBy` records which
// rule above fired so the choice is always explainable.
import { ghHeaders, parseOwnerRepo } from "../github-schedule.mts";

// Tags an operator's pasted content can realistically contain and that need a
// class to not look bare. Order matters only for report readability.
export const CONTENT_TAGS = ["h2", "h3", "h4", "p", "ul", "ol", "a", "img", "table", "blockquote"] as const;
export type ContentTag = (typeof CONTENT_TAGS)[number];

// <li> is deliberately NOT in CONTENT_TAGS. No page in the sampled repo puts a
// class on a content <li>, and the one classed <li> that does exist
// (index.astro's `flex items-center gap-3 ...`) is an icon-row list — applying
// it to plain bullets would actively look wrong. Bullets inherit list-disc,
// marker colour and spacing from their <ul>/<ol>, so an unclassed <li> is
// CORRECT here, not a gap. Don't "fix" this by inventing an li class.

export interface TagStyle {
  cls: string;
  source: string;          // repo path the class came from
  borrowed: boolean;       // true when it came from a donor, not the exemplar
}

export interface DesignProfile {
  exemplar: string;                     // repo path of the chosen exemplar
  chosenBy: "shared_component" | "richest_sibling" | "sitewide_fallback" | "operator_override";
  chosenNote: string;                   // human-readable justification
  lowConfidence: boolean;               // true for sitewide_fallback
  blockContainer: string | null;        // wrapper class the exemplar puts around its text blocks
  tags: Partial<Record<ContentTag, TagStyle>>;
  gaps: ContentTag[];                   // nothing in the repo styles these
  borrows: ContentTag[];                // filled from a donor
  quirks: string[];                     // real oddities inherited on purpose
  sampledFrom: string[];
  derivedAt: number;
}

const LINK_CHROME = /\b(inline-flex|inline-block|rounded-full|rounded-xl|rounded-2xl|group|px-\d|py-\d)\b/;

// Strips everything that isn't operator-content-shaped markup.
export function contentRegion(src: string): string {
  let s = src.replace(/^---[\s\S]*?\n---/, "");
  // SELF-CLOSING FIRST — this is load-bearing. LocationPage.astro emits its
  // JSON-LD as `<script is:inline ... />`; running the paired strip first
  // matches from there to the NEXT `</script>` 115 lines later and swallows
  // the entire content region. That silently hid the repo's newest convention
  // and made <ol> look unstyled when it has a perfectly good class.
  s = s.replace(/<(script|style)\b[^>]*\/>/g, "");
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "");
  s = s.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/g, ""); // breadcrumbs are chrome, not content
  return s;
}

// Most common literal class string per tag WITHIN ONE FILE.
export function profileFile(src: string): Record<string, { cls: string; count: number; variants: number }> {
  const region = contentRegion(src);
  const out: Record<string, { cls: string; count: number; variants: number }> = {};
  for (const tag of CONTENT_TAGS) {
    const counts = new Map<string, number>();
    for (const m of region.matchAll(new RegExp(`<${tag}(\\s[^>]*)?>`, "g"))) {
      const attrs = m[1] || "";
      if (/class=\{/.test(attrs)) continue; // dynamic expression — can't be reused verbatim
      const cm = attrs.match(/class="([^"]*)"/);
      if (!cm || !cm[1].trim()) continue;
      const cls = cm[1].trim();
      // A button or whole-card <a> is a different concept from an inline text
      // link. Without this the derived <a> class collapses to the useless
      // intersection "transition-colors duration-300".
      if (tag === "a" && LINK_CHROME.test(cls)) continue;
      counts.set(cls, (counts.get(cls) || 0) + 1);
    }
    if (counts.size) {
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      out[tag] = { cls: sorted[0][0], count: sorted[0][1], variants: sorted.length };
    }
  }
  return out;
}

export function coverageOf(prof: Record<string, unknown>): number {
  return Object.keys(prof).length;
}

// The wrapper the exemplar puts around a run of text blocks. LocationPage uses
// `space-y-5 ...` on a parent instead of per-element bottom margins, so
// reproducing it is what makes inherited spacing match rather than merely the
// per-tag classes.
export function detectBlockContainer(src: string): string | null {
  const region = contentRegion(src);
  const m = region.match(/<div\s+class="([^"]*\bspace-y-\d+\b[^"]*)"/);
  return m ? m[1].trim() : null;
}

// Which single component (if any) a page delegates its whole body to.
export function delegatesTo(src: string): string | null {
  const body = src.replace(/^---[\s\S]*?\n---/, "");
  // A delegating page's body is one component element wrapping nothing else of
  // substance, e.g. watt.astro -> <LocationPage ...props />
  const el = body.match(/<([A-Z][A-Za-z0-9]*)\b/);
  if (!el) return null;
  const name = el[1];
  if (name === "Layout" || name === "Fragment") return null;
  const imp = src.match(new RegExp(`import\\s+${name}\\s+from\\s+['"]([^'"]+)['"]`));
  if (!imp) return null;
  // Only treat it as delegation when the page has essentially no markup of its
  // own — otherwise it's a page that merely USES a component.
  const ownTags = (body.match(/<(h2|h3|h4|p|ul|ol|table)\b/g) || []).length;
  if (ownTags > 0) return null;
  return imp[1];
}

export interface RepoFile { path: string; content: string }

// ─── The chooser ──────────────────────────────────────────────────────────
export function chooseExemplar(
  targetRepoPath: string,
  files: RepoFile[]
): { exemplar: RepoFile; chosenBy: DesignProfile["chosenBy"]; note: string; lowConfidence: boolean } | null {
  const dir = targetRepoPath.replace(/\/[^/]+$/, "");
  const byPath = new Map(files.map((f) => [f.path, f]));
  const siblings = files.filter((f) => f.path.replace(/\/[^/]+$/, "") === dir && f.path !== targetRepoPath && f.path.endsWith(".astro"));

  // 1. Do the siblings mostly delegate to one shared component?
  const delegateCounts = new Map<string, number>();
  for (const s of siblings) {
    const rel = delegatesTo(s.content);
    if (!rel) continue;
    // Resolve the relative import against the sibling's own directory.
    const resolved = resolveImport(s.path, rel);
    if (resolved) delegateCounts.set(resolved, (delegateCounts.get(resolved) || 0) + 1);
  }
  if (delegateCounts.size) {
    const [topPath, n] = [...delegateCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const comp = byPath.get(topPath);
    if (comp && n >= 2) {
      return {
        exemplar: comp,
        chosenBy: "shared_component",
        note: `${n} of ${siblings.length} existing page(s) in ${dir}/ delegate their whole body to ${topPath} — inheriting that component's convention, which is what new pages in this folder should match.`,
        lowConfidence: false,
      };
    }
  }

  // 2. Richest sibling in the same directory.
  const scored = siblings
    .map((f) => ({ f, cov: coverageOf(profileFile(f.content)) }))
    .filter((x) => x.cov > 0)
    .sort((a, b) => b.cov - a.cov || b.f.content.length - a.f.content.length);
  if (scored.length) {
    return {
      exemplar: scored[0].f,
      chosenBy: "richest_sibling",
      note: `No shared body component in ${dir}/. Using ${scored[0].f.path}, the sibling page that styles the most content elements (${scored[0].cov}/${CONTENT_TAGS.length}).`,
      lowConfidence: false,
    };
  }

  // 3. Nothing in this directory — fall back sitewide and say so loudly.
  const anywhere = files
    .filter((f) => f.path.endsWith(".astro"))
    .map((f) => ({ f, cov: coverageOf(profileFile(f.content)) }))
    .filter((x) => x.cov > 0)
    .sort((a, b) => b.cov - a.cov || b.f.content.length - a.f.content.length);
  if (!anywhere.length) return null;
  return {
    exemplar: anywhere[0].f,
    chosenBy: "sitewide_fallback",
    note: `${dir}/ has no existing pages to match, so there is no local convention to inherit. Falling back to ${anywhere[0].f.path} (richest in the repo). CONFIRM this is the right look for a new section.`,
    lowConfidence: true,
  };
}

function resolveImport(fromPath: string, rel: string): string | null {
  if (!rel.startsWith(".")) return null;
  const parts = fromPath.split("/").slice(0, -1);
  for (const seg of rel.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

// ─── Build the profile, with a labeled donor chain for gaps ────────────────
export function buildDesignProfile(targetRepoPath: string, files: RepoFile[]): DesignProfile | null {
  const chosen = chooseExemplar(targetRepoPath, files);
  if (!chosen) return null;

  const exProf = profileFile(chosen.exemplar.content);
  const tags: Partial<Record<ContentTag, TagStyle>> = {};
  const borrows: ContentTag[] = [];
  const gaps: ContentTag[] = [];
  const quirks: string[] = [];

  // Donor order: prefer the richest OTHER real file, so a borrow comes from a
  // page the operator can actually go look at.
  const donors = files
    .filter((f) => f.path !== chosen.exemplar.path && f.path.endsWith(".astro"))
    .map((f) => ({ f, prof: profileFile(f.content) }))
    .sort((a, b) => coverageOf(b.prof) - coverageOf(a.prof));

  for (const tag of CONTENT_TAGS) {
    if (exProf[tag]) {
      tags[tag] = { cls: exProf[tag].cls, source: chosen.exemplar.path, borrowed: false };
      continue;
    }
    const donor = donors.find((d) => d.prof[tag]);
    if (donor) {
      tags[tag] = { cls: donor.prof[tag].cls, source: donor.f.path, borrowed: true };
      borrows.push(tag);
    } else {
      gaps.push(tag);
    }
  }

  // Inherit real oddities rather than silently "improving" them — a page that
  // looks better than the rest of the site still doesn't MATCH the site, which
  // defeats the point of inheritance. Surface them instead.
  if (tags.h2 && tags.h3 && tags.h2.cls === tags.h3.cls) {
    quirks.push(`<h2> and <h3> carry identical classes in ${tags.h3.source} ("${tags.h3.cls}"), so subheadings render the same size as headings. Inherited as-is to match the site — fix it in the repo if you want it changed.`);
  }
  for (const tag of CONTENT_TAGS) {
    const v = exProf[tag]?.variants;
    if (v && v > 1) quirks.push(`<${tag}> has ${v} different class strings in ${chosen.exemplar.path}; took the most common (${exProf[tag].count}x).`);
  }

  return {
    exemplar: chosen.exemplar.path,
    chosenBy: chosen.chosenBy,
    chosenNote: chosen.note,
    lowConfidence: chosen.lowConfidence,
    blockContainer: detectBlockContainer(chosen.exemplar.content),
    tags, gaps, borrows, quirks,
    sampledFrom: files.map((f) => f.path),
    derivedAt: Date.now(),
  };
}

// ─── Applying the profile to the operator's sanitized HTML ─────────────────
// Adds the inherited class to each content element. Never touches an element
// that already carries a class (the operator's own intent wins), and never
// invents a class for a tag in `gaps` — those block at intake instead.
export function applyDesignProfile(html: string, profile: DesignProfile): { html: string; applied: Record<string, number>; untouched: Record<string, number> } {
  const applied: Record<string, number> = {};
  const untouched: Record<string, number> = {};
  let out = html;

  // The exemplar may keep typography on a PARENT container (LocationPage does:
  // `space-y-5 text-text-muted text-base sm:text-lg leading-relaxed`). Free-form
  // pasted HTML nests headings inside its own section divs, so a wrapper
  // carrying `text-text-muted` inevitably swallows them and renders headings
  // muted grey where the real site renders them white. So the container's
  // typography tokens are pushed down onto the text elements themselves — the
  // same tokens, from the same exemplar, just applied per element (which is
  // exactly what the service-page exemplar already does). Nothing invented.
  const split = profile.blockContainer ? splitContainerTokens(profile.blockContainer) : { layout: "", typo: "" };

  for (const tag of CONTENT_TAGS) {
    const style = profile.tags[tag];
    if (!style) continue;
    const effective = TEXT_TAGS.has(tag) && split.typo
      ? mergeClasses(style.cls, split.typo)
      : style.cls;
    out = out.replace(new RegExp(`<${tag}(\\s[^>]*)?>`, "g"), (full, attrs) => {
      const a = attrs || "";
      if (/\bclass\s*=/.test(a)) { untouched[tag] = (untouched[tag] || 0) + 1; return full; }
      applied[tag] = (applied[tag] || 0) + 1;
      return `<${tag}${a} class="${effective}">`.replace(/\s+>/, ">");
    });
  }

  // Reproduce the exemplar's block wrapper so inherited SPACING matches too —
  // LocationPage relies on a parent `space-y-*` rather than per-element bottom
  // margins, so per-tag classes alone would leave the rhythm wrong.
  //
  // CRITICAL: wrap only RUNS OF TEXT BLOCKS, never headings. That container
  // carries `text-text-muted`, and LocationPage deliberately keeps its <h2>
  // OUTSIDE it. Wrapping everything made headings inherit muted grey
  // (rgba(255,255,255,0.6)) where the real site renders them white — verified
  // against the live page, and exactly the kind of subtle mismatch that makes
  // an inherited page look almost-but-not-quite right.
  // Only the LAYOUT half of the container remains as a wrapper (e.g. space-y-5),
  // which is safe around headings because it sets no inherited text appearance.
  if (split.layout) out = `<div class="${split.layout}">\n${out}\n</div>`;
  return { html: out, applied, untouched };
}

// Text tags that should carry the container's typography themselves.
const TEXT_TAGS = new Set(["p", "ul", "ol"]);
// Tokens that set inherited text appearance — these must NOT sit on a wrapper
// that also contains headings.
//
// Variant prefixes must be stripped before testing. Missing that left
// `sm:text-lg` behind on the wrapper while `text-base` moved onto the elements,
// so <ul> computed 16px against <p>'s 18px — a real, visible mismatch caught
// only by comparing computed styles against the live page.
const TYPO_TOKEN = /^(text-|leading-|font-|tracking-)/;
const isTypoToken = (tok: string) => TYPO_TOKEN.test(tok.replace(/^(?:[a-z0-9-]+:)+/, ""));

// Union of two class strings, keeping `base` order and dropping duplicates.
export function mergeClasses(base: string, extra: string): string {
  const seen = new Set(base.split(/\s+/).filter(Boolean));
  for (const t of extra.split(/\s+/).filter(Boolean)) seen.add(t);
  return [...seen].join(" ");
}

export function splitContainerTokens(containerCls: string): { layout: string; typo: string } {
  const toks = containerCls.split(/\s+/).filter(Boolean);
  return {
    layout: toks.filter((t) => !isTypoToken(t)).join(" "),
    typo: toks.filter((t) => isTypoToken(t)).join(" "),
  };
}

// Which gap tags does this specific content actually use? Those are what block
// at intake — the operator adds the component once, rather than publishing an
// unstyled table.
export function gapsUsedByContent(html: string, profile: DesignProfile): ContentTag[] {
  return profile.gaps.filter((t) => new RegExp(`<${t}[\\s>]`).test(html));
}

export async function fetchDesignSourceFiles(repo: string, branch: string, pagesDir = "src/pages"): Promise<RepoFile[]> {
  const token = Netlify.env.get("GITHUB_TOKEN");
  if (!token) throw new Error("GITHUB_TOKEN not configured on the server");
  const parsed = parseOwnerRepo(repo);
  if (!parsed) throw new Error(`Invalid repo format "${repo}"`);
  const { owner, repoName } = parsed;
  const headers = ghHeaders(token);
  const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers, cache: "no-store" });
  if (!treeRes.ok) throw new Error(`GitHub ${treeRes.status} reading repo tree`);
  const tree = await treeRes.json();
  const wanted = (tree.tree || []).filter(
    (n: any) => n.type === "blob" && /\.astro$/.test(n.path) && (n.path.startsWith(pagesDir) || n.path.startsWith("src/components/") || n.path.startsWith("src/layouts/"))
  );
  const files: RepoFile[] = [];
  for (const n of wanted) {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/${n.path}?ref=${encodeURIComponent(branch)}`, { headers, cache: "no-store" });
    if (!r.ok) continue;
    const d = await r.json();
    if (!d.content) continue;
    files.push({ path: n.path, content: Buffer.from(d.content, "base64").toString("utf8") });
  }
  return files;
}
