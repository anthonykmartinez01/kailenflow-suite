import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

// Proxies Google's PageSpeed Insights v5 API with a real server-side API
// key. The previous version called this endpoint directly from the
// browser with NO key at all — Google's unauthenticated quota for that
// endpoint is extremely low (a handful of requests before 429s start),
// which is exactly why it "didn't work" under any real usage. A key
// raises that to 25,000 requests/day (free tier) and is the same
// mechanism the actual pagespeed.web.dev tool uses under the hood.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const apiKey = Netlify.env.get("GOOGLE_PAGESPEED_API_KEY");
  if (!apiKey) {
    return json({ error: "Server is missing GOOGLE_PAGESPEED_API_KEY. Add it in Netlify env vars — enable \"PageSpeed Insights API\" on a Google Cloud project and create an API key." }, 500);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const url: string = (body.url || "").toString().trim();
  const strategy = body.strategy === "desktop" ? "desktop" : "mobile";
  if (!url) return json({ error: "Missing url" }, 400);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000); // Lighthouse runs are slow — give it real room
  try {
    const psiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(psiUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    const data = await res.json();
    if (!res.ok || data.error) {
      return json({ error: data.error?.message || `PageSpeed API returned ${res.status}` }, 502);
    }
    return json(data);
  } catch (e: any) {
    clearTimeout(timer);
    const msg = String(e?.message || e);
    const friendly = /abort/i.test(msg) ? "PageSpeed test timed out — the site may be slow to load. Try again." : "Couldn't reach the PageSpeed API.";
    return json({ error: friendly, detail: msg }, 502);
  }
};

export const config: Config = { path: "/api/pagespeed" };
