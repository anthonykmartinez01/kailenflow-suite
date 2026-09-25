// IndexNow key generation + key-file commit — page-publisher-build-spec.md
// §3a. This is a connect-time action, not gate/publish work: the key file
// must exist on the live domain BEFORE any page is ever published through
// it, so it's generated and committed the moment a GIT_STATIC site is
// connected (Stage 1). The actual ping call to IndexNow's endpoint using
// this key is separate, later work (Stage 3, alongside the rest of the
// gate) — this file only ever creates the key and proves it, never pings.
import { ghHeaders, parseOwnerRepo } from "../github-schedule.mts";

// A hex string is what IndexNow expects — not secret (the whole point of
// the protocol is that anyone can verify it by fetching the public key
// file), so no encryption/special handling needed, unlike a real credential.
export function generateIndexNowKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Commits public/{key}.txt (content = the key itself, IndexNow's own
// verification convention) into the client's repo. One-off single-file
// commit via the Contents API — no batching concern here, this happens
// once per site at connect time, never as part of a page-publish batch.
export async function commitIndexNowKeyFile(repo: string, branch: string, key: string): Promise<{ ok: boolean; detail: string }> {
  const token = Netlify.env.get("GITHUB_TOKEN");
  if (!token) return { ok: false, detail: "GITHUB_TOKEN not configured on the server" };
  const parsed = parseOwnerRepo(repo);
  if (!parsed) return { ok: false, detail: `Invalid repo format "${repo}"` };
  const { owner, repoName } = parsed;
  const headers = ghHeaders(token);
  const path = `public/${key}.txt`;

  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/${path}`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        message: "Add IndexNow verification key (KailenFlow Page Publisher)",
        content: Buffer.from(key, "utf8").toString("base64"),
        branch,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, detail: `GitHub ${res.status} committing ${path}: ${text.slice(0, 200)}` };
    }
    return { ok: true, detail: `Committed ${path}` };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message || e) };
  }
}
