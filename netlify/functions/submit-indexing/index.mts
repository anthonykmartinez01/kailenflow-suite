import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { submitAndLog, findGscPropertyForUrl } from "../../shared/indexing.mts";
import { readAppData } from "../../shared/firestore-admin.mts";

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

// Server-to-server callers (GitHub Actions in a client repo) can't sign in
// as a suite user, so they authenticate with a static shared key instead.
function isAutomationRequest(req: Request): boolean {
  const key = req.headers.get("x-automation-key");
  const expected = Netlify.env.get("AUTOMATION_API_KEY");
  return !!key && !!expected && key === expected;
}

export default async (req: Request, _ctx: Context) => {
  const isAutomation = isAutomationRequest(req);
  if (!(await isAuthed(req)) && !isAutomation) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const pageUrl: string = (body.url || "").trim();
  if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) return json({ error: "A valid http(s) url is required" }, 400);

  const label = (body.label || pageUrl).toString().slice(0, 80);
  // Same gate as publish-page-log's auto-submit path: the Indexing API only
  // works if the calling account is verified for this exact site in Search
  // Console (client.gscProperty is the app's record that's been done) —
  // find it by matching the URL's host against a client's website, since
  // this endpoint only gets a bare URL, not a client id.
  let gscProperty: string | null = null;
  try {
    const data = await readAppData();
    gscProperty = findGscPropertyForUrl(data.clients || [], pageUrl);
  } catch { /* best-effort — proceed without it, submitToGoogle will just report not-connected */ }
  const result = await submitAndLog(pageUrl, label, isAutomation ? "automation" : "manual", gscProperty);
  return json(result);
};

export const config: Config = { path: "/api/submit-indexing" };
