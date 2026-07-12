import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

// Grabs a client's website's og:image (falling back to twitter:image) —
// the same image every site already uses as its "hero" preview for link
// shares, so it's the closest thing to a real hero image we can get
// without a paid screenshot service. Server-side fetch avoids CORS
// entirely (a client's site has zero reason to allow our origin) and lets
// us set a normal browser UA so we don't get blocked as a bot.
//
// PROBLEM: a lot of small-business site builders/CMS default og:image to
// the site LOGO when nobody's explicitly set a social-share image — that
// looked wrong as a big background photo. Filters that out two ways: (1)
// the filename/path containing "logo", and (2) the image's actual pixel
// dimensions — a logo is near-square and/or small, a real hero photo is
// wide and large. Both checks run against every og:image/twitter:image
// candidate found, picking the first one that survives both.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

function extractMetaContents(html: string, attr: string, value: string): string[] {
  const results: string[] = [];
  const tagRe = /<meta\s+[^>]*>/gi;
  const attrRe = new RegExp(`${attr}\\s*=\\s*["']${value}["']`, "i");
  const contentRe = /content\s*=\s*["']([^"']+)["']/i;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    if (attrRe.test(tag)) {
      const c = tag.match(contentRe);
      if (c) results.push(c[1]);
    }
  }
  return results;
}

function looksLikeLogoUrl(url: string): boolean {
  let path = url;
  try { path = new URL(url).pathname; } catch { /* use raw string */ }
  return /(^|[\/_\-.])logo([\/_\-.]|$)/i.test(path);
}

function readU16BE(buf: Uint8Array, off: number) { return (buf[off] << 8) | buf[off + 1]; }
function readU32BE(buf: Uint8Array, off: number) { return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0; }

function pngDimensions(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) return null;
  return { width: readU32BE(buf, 16), height: readU32BE(buf, 20) };
}

function jpegDimensions(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) { offset++; continue; }
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }
    if (offset + 4 > buf.length) break;
    const segLen = readU16BE(buf, offset + 2);
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) return { height: readU16BE(buf, offset + 5), width: readU16BE(buf, offset + 7) };
    offset += 2 + segLen;
  }
  return null;
}

async function fetchImageDimensions(url: string): Promise<{ width: number; height: number } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Range: "bytes=0-131071" } });
    clearTimeout(timer);
    const buf = new Uint8Array(await res.arrayBuffer());
    return pngDimensions(buf) || jpegDimensions(buf);
  } catch {
    clearTimeout(timer);
    return null; // unknown format (webp/svg/etc) — dimension check just can't rule it out either way
  }
}

function looksLikeLogoDimensions(dim: { width: number; height: number } | null): boolean {
  if (!dim || !dim.width || !dim.height) return false;
  const maxSide = Math.max(dim.width, dim.height);
  const ratio = dim.width / dim.height;
  if (maxSide < 400) return true; // too small to be a real hero photo
  if (ratio > 0.75 && ratio < 1.34) return true; // roughly square = logo/icon shape
  return false;
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

    const rawCandidates = [
      ...extractMetaContents(html, "property", "og:image"),
      ...extractMetaContents(html, "name", "twitter:image"),
    ];
    if (!rawCandidates.length) return json({ image: null, reason: "No og:image/twitter:image tag found" });

    const candidates = rawCandidates
      .map((raw) => { try { return new URL(raw, website).toString(); } catch { return raw; } })
      .filter((url) => !looksLikeLogoUrl(url));

    if (!candidates.length) return json({ image: null, reason: "Only logo-named images found (filename contains \"logo\")" });

    // Check dimensions in parallel (bounded to the first few candidates so
    // this can't drag on for a site with a dozen meta tags), then pick the
    // first one — in original priority order — that isn't logo-shaped.
    const checked = candidates.slice(0, 4);
    const dims = await Promise.all(checked.map((url) => fetchImageDimensions(url)));
    const winner = checked.find((_, i) => !looksLikeLogoDimensions(dims[i]));

    if (!winner) return json({ image: null, reason: "Only logo-shaped images found (near-square or too small)" });
    return json({ image: winner });
  } catch (e: any) {
    clearTimeout(timer);
    return json({ image: null, reason: String(e?.message || e) });
  }
};

export const config: Config = { path: "/api/fetch-hero-image" };
