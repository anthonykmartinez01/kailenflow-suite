// GIT_STATIC adapter — the reference implementation (page-publisher-build-
// spec.md §1). More capable than any CMS tier here: real programmatic
// create/edit/list access via the GitHub API, already proven all through
// the indexing work. Stage 1 only needs verifyConnection + listExistingUrls
// (populating siteGraph.pageIndex's title/path/parentUrl — NOT yet
// linkGraph/schemaGraph, which need full page-content fetches and are
// Stage 3 work). Everything publish/edit-related returns `supported:false`
// until Stage 2/3 build it for real — never a silent no-op, never a throw.
import { ghHeaders, parseOwnerRepo } from "../../github-schedule.mts";
import { canonicalPageUrlFromPath, canonicalUrl } from "../urls.mts";
import { isUnsupported } from "./base-adapter.mts";
import type {
  PlatformAdapter, CapabilityFlags, Credentials, Site, ExistingUrl, VerifyResult,
  SupportResult, AdapterImage, AdapterPage, InboundLinkTask, LinkResult, PublishResult,
} from "./base-adapter.mts";

const NOT_YET = (what: string) => ({ supported: false as const, reason: `${what} isn't built yet — Stage 2/3 of the Page Publisher build order.` });

// Same page-file extensions countPageFiles (github-schedule.mts) already
// matches, kept local here since this adapter needs the actual paths, not
// just a count.
const PAGE_FILE_RE = /\.(astro|md|mdx|html|tsx|jsx|vue)$/i;

// Turn a file path into a rough human title — a PLACEHOLDER until Stage 3
// fetches each page's real content and reads its actual <h1>/frontmatter
// title. Never presented as authoritative; siteGraph.pageIndex entries this
// populates should be treated as "we know this URL exists," not "we know
// what it says."
export function titleFromPath(path: string): string {
  const base = path.replace(/^.*\//, "").replace(/\.(astro|md|mdx|html|tsx|jsx|vue)$/i, "");
  return base.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || path;
}

export const gitStaticCapabilities: CapabilityFlags = {
  canCreatePage: true,
  canCreatePost: true,
  canListExistingUrls: true,
  canEditExistingPage: true,
  canSetCanonical: true,
  canSetMetaDescription: true,
  canInjectSchema: true,
  canUploadMedia: true,
  autoPublish: true,
};

export const gitStaticAdapter: PlatformAdapter = {
  platform: "git_static",
  capabilities: gitStaticCapabilities,

  async verifyConnection(_creds: Credentials, site: Site): Promise<VerifyResult> {
    const token = Netlify.env.get("GITHUB_TOKEN");
    if (!token) return { ok: false, detail: "GITHUB_TOKEN not configured on the server" };
    if (!site.repo) return { ok: false, detail: "No repo configured for this site" };
    const parsed = parseOwnerRepo(site.repo);
    if (!parsed) return { ok: false, detail: `Invalid repo format "${site.repo}" — expected "owner/name"` };
    const { owner, repoName } = parsed;
    const ref = site.branch || "main";
    const headers = ghHeaders(token);
    try {
      const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, { headers, cache: "no-store" });
      if (!repoRes.ok) return { ok: false, detail: `GitHub ${repoRes.status} reading repo "${site.repo}"` };
      const branchRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/branches/${encodeURIComponent(ref)}`, { headers, cache: "no-store" });
      if (!branchRes.ok) return { ok: false, detail: `GitHub ${branchRes.status} reading branch "${ref}"` };
      return { ok: true, detail: `Connected to ${site.repo}@${ref}` };
    } catch (e: any) {
      return { ok: false, detail: String(e?.message || e) };
    }
  },

  async listExistingUrls(_creds: Credentials, site: Site): Promise<SupportResult<ExistingUrl[]>> {
    const files = await listRepoPageFiles(site);
    if (isUnsupported(files)) return files;
    return files.map((f) => ({
      url: canonicalPageUrlFromPath(site.domain, f.urlPath),
      title: titleFromPath(f.repoPath),
      path: f.urlPath,
      // parentUrl is unknown at this stage — Stage 1 only reads the file
      // tree, it doesn't fetch each page's actual content yet. Left null
      // rather than guessed; Stage 3's full siteGraph build fills it in.
      parentUrl: null,
    }));
  },

  // Built 2026-07-23 (Stage 3 item 2) — the whole-site content scan needs
  // to read every existing page's real source, so this could no longer stay
  // a stub. Note what this returns: the page's SOURCE (.astro/.md/etc. as
  // committed), NOT rendered HTML — for a git-static site the source is
  // what's inspectable at commit time, which is the whole point of §5a's
  // "the repo is a stronger position than any CMS integration" argument.
  // Link/schema extraction works fine against source; anything that
  // genuinely needs post-build rendered output would need a different
  // mechanism entirely (and is not what this is for).
  //
  // Resolves url → repoPath by fetching the repo tree, so this costs TWO
  // requests when called standalone. Callers looping over many pages should
  // use fetchRepoFileContent directly after one listRepoPageFiles call —
  // same one-fetch-two-consumers pattern already established here.
  async fetchPageHtml(_creds: Credentials, site: Site, url: string): Promise<SupportResult<string>> {
    const files = await listRepoPageFiles(site);
    if (isUnsupported(files)) return files;
    const wanted = canonicalUrl(url);
    const target = files.find((f) => canonicalPageUrlFromPath(site.domain, f.urlPath) === wanted || f.urlPath === url);
    if (!target) return { supported: false, reason: `No repo file maps to "${url}" in ${site.repo}` };
    return fetchRepoFileContent(site, target.repoPath);
  },
  async uploadImage(_creds: Credentials, _site: Site, _image: AdapterImage): Promise<SupportResult<{ remoteUrl: string }>> { return NOT_YET("Image upload"); },
  async publish(_creds: Credentials, _site: Site, _page: AdapterPage): Promise<SupportResult<PublishResult>> { return NOT_YET("Publishing"); },
  async update(_creds: Credentials, _site: Site, _page: AdapterPage, _platformRef: string): Promise<SupportResult<PublishResult>> { return NOT_YET("Updating a published page"); },
  async insertInboundLink(_creds: Credentials, _site: Site, _task: InboundLinkTask): Promise<SupportResult<LinkResult>> { return NOT_YET("Inserting an inbound link"); },
};

// Fetches one file's decoded source by its RAW repo path. Exported for the
// whole-site scan, which already has every repoPath from one
// listRepoPageFiles call and must not re-fetch the tree per page.
//
// The 1MB guard matters more than it looks: GitHub's Contents API silently
// returns an EMPTY content field for files over ~1MB rather than erroring.
// Treating that as "" would make the scan see a page with no links and no
// schema — i.e. report a false orphan, exactly the failure mode Anthony
// called out as worse than failing cleanly. So it returns unsupported with
// a real reason instead, and the scan records it as an explicit skip.
export async function fetchRepoFileContent(site: Site, repoPath: string): Promise<SupportResult<string>> {
  const token = Netlify.env.get("GITHUB_TOKEN");
  if (!token) return { supported: false, reason: "GITHUB_TOKEN not configured on the server" };
  if (!site.repo) return { supported: false, reason: "No repo configured for this site" };
  const parsed = parseOwnerRepo(site.repo);
  if (!parsed) return { supported: false, reason: `Invalid repo format "${site.repo}"` };
  const { owner, repoName } = parsed;
  const ref = site.branch || "main";
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/contents/${repoPath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
      { headers: ghHeaders(token), cache: "no-store" }
    );
    if (!res.ok) return { supported: false, reason: `GitHub ${res.status} fetching ${repoPath}` };
    const data = await res.json();
    if (typeof data.content !== "string" || data.content === "") {
      return { supported: false, reason: `${repoPath} returned no inline content (likely over GitHub's ~1MB Contents API limit — size ${data.size ?? "unknown"})` };
    }
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (e: any) {
    return { supported: false, reason: `Could not fetch ${repoPath}: ${String(e?.message || e)}` };
  }
}

// Shared tree-fetch, exported so callers that need RAW repo file paths (not
// just the derived site-relative URLs) — namely connect-site's astroLayout
// sampling — don't have to fetch the tree a second time. One fetch, two
// consumers.
export async function listRepoPageFiles(site: Site): Promise<SupportResult<{ repoPath: string; urlPath: string }[]>> {
  const token = Netlify.env.get("GITHUB_TOKEN");
  if (!token) return { supported: false, reason: "GITHUB_TOKEN not configured on the server" };
  if (!site.repo) return { supported: false, reason: "No repo configured for this site" };
  const parsed = parseOwnerRepo(site.repo);
  if (!parsed) return { supported: false, reason: `Invalid repo format "${site.repo}"` };
  const { owner, repoName } = parsed;
  const ref = site.branch || "main";
  const headers = ghHeaders(token);
  const dir = (site.pagesDir || "src/pages").replace(/^\/+|\/+$/g, "");

  const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { headers, cache: "no-store" });
  if (!res.ok) return { supported: false, reason: `GitHub ${res.status} listing ${dir}` };
  const data = await res.json();
  const tree: any[] = Array.isArray(data.tree) ? data.tree : [];
  const prefix = dir + "/";

  const out: { repoPath: string; urlPath: string }[] = [];
  for (const t of tree) {
    if (t.type !== "blob" || typeof t.path !== "string") continue;
    if (!t.path.startsWith(prefix) || !PAGE_FILE_RE.test(t.path)) continue;
    const relPath = t.path.slice(prefix.length).replace(PAGE_FILE_RE, "");
    // index files map to their DIRECTORY, not a literal "/index" path.
    // The bare root case (src/pages/index.astro) needs its own branch: the
    // old `replace(/\/index$/,"")` only matched a SLASH-prefixed "index",
    // so the homepage came out as "/index" while the whole site links to
    // "/" — which made the homepage look like an orphan in the first real
    // scan (Rankin Waste, 2026-07-26). Real bug, found by the scan.
    const rel = relPath === "index" ? "" : relPath.replace(/\/index$/, "");
    const urlPath = "/" + rel;
    out.push({ repoPath: t.path, urlPath });
  }
  return out;
}
