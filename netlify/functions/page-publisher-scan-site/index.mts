import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

// Trigger + poll for the whole-site scan (page-publisher-build-spec.md §5a,
// Stage 3 items 3/4). Follows call-coach's exact convention:
//   POST /api/page-publisher-scan-site {siteId}       → starts the background job (202-style)
//   GET  /api/page-publisher-scan-site?siteId=...     → poll for progress/result
// The actual work lives in page-publisher-scan-site-background (15-min
// ceiling); this function only starts it and reads the status blob.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

const STORE = "pagepublisher-scans";

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();

  const store = getStore(STORE);

  if (req.method === "GET") {
    const siteId = new URL(req.url).searchParams.get("siteId") || "";
    if (!siteId) return json({ error: "siteId is required" }, 400);
    const v = await store.get(`scan:${siteId}`, { type: "json" }).catch(() => null);
    return json(v || { status: "none" });
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({} as any));
    const siteId = (body.siteId || "").toString();
    if (!siteId) return json({ error: "siteId is required" }, 400);

    const key = `scan:${siteId}`;
    const existing = (await store.get(key, { type: "json" }).catch(() => null)) as any;
    // Don't stack concurrent scans of the same site — they'd race on the
    // same siteGraph write. An in-flight scan under 15 minutes old (the
    // background-function ceiling) is left alone to finish.
    if (existing && existing.status === "running" && Date.now() - (existing.startedAt || 0) < 15 * 60000) {
      return json({ started: true, alreadyRunning: true, siteId });
    }

    await store.setJSON(key, { status: "running", startedAt: Date.now() });

    const origin = new URL(req.url).origin;
    const auth = req.headers.get("authorization") || "";
    await fetch(`${origin}/.netlify/functions/page-publisher-scan-site-background`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify({ siteId }),
    }).catch(() => {});

    return json({ started: true, siteId });
  }

  return json({ error: "Method not allowed" }, 405);
};

export const config: Config = { path: "/api/page-publisher-scan-site" };
