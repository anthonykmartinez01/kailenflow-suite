import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

// Grabs a client's website's og:image (falling back to twitter:image) —
// the same image every site already uses as its "hero" preview for link
// shares, so it's the closest thing to a real hero image we can get
// without a paid screenshot service. Server-side fetch avoids CORS
// entirely (a client's site has zero reason to allow our origin) and lets
// us set a normal browser UA so we don't get blocked as a bot.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  let website: string = (body.website || "").toString().trim();
  if (!website) return json({ error: "Missing website" }, 400);
  if (!/^https?:\/\//i.test(website)) website = "https://" + website;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(website, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html",
      },
    });
    clearTimeout(timer);
    if (!res.ok) return json({ image: null, reason: `Site returned ${res.status}` });

    // Only read the first chunk of HTML — og:image is always in <head>,
    // no need to download the whole page (some sites are multi-MB).
    const reader = res.body?.getReader();
    let html = "";
    if (reader) {
      const decoder = new TextDecoder();
      let bytesRead = 0;
      while (bytesRead < 200_000) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        bytesRead += value.length;
        if (/<\/head>/i.test(html)) break;
      }
      reader.cancel().catch(() => {});
    } else {
      html = await res.text();
    }

    const metaMatch =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);

    if (!metaMatch) return json({ image: null, reason: "No og:image/twitter:image tag found" });

    let imageUrl = metaMatch[1];
    try { imageUrl = new URL(imageUrl, website).toString(); } catch { /* leave as-is */ }

    return json({ image: imageUrl });
  } catch (e: any) {
    clearTimeout(timer);
    return json({ image: null, reason: String(e?.message || e) });
  }
};

export const config: Config = { path: "/api/fetch-hero-image" };
