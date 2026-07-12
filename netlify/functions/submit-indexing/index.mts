import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { submitAndLog } from "../../shared/indexing.mts";

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
  const result = await submitAndLog(pageUrl, label, isAutomation ? "automation" : "manual");
  return json(result);
};

export const config: Config = { path: "/api/submit-indexing" };
