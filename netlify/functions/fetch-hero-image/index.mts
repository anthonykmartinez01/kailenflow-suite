import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

// Grabs a photo to use as a client's Dashboard background — server-side
// fetch avoids CORS entirely (a client's site has zero reason to allow
// our origin) and lets us set a normal browser UA so we don't get blocked
// as a bot.
//
// HISTORY: originally just read the og:image meta tag (what a site uses
// for link-share previews). Two real problems with that turned out to
// matter: (1) a lot of small-business site builders default og:image to
// the site LOGO when nobody's explicitly set one, and (2) og:image is
// frequently stale — set once when the site was built and never touched
// again, so it can point at an old photo that has nothing to do with
// what's actually live on the page today. Meta tags are metadata ABOUT
// the page, not necessarily a reflection of its current visible content.
//
// Now prioritizes images that are actually IN the page body over meta
// tags: <img> elements and CSS background-images inside anything that
// looks like a hero/banner section, ranked by how strong that signal is,
// with logo-filename and logo-shaped-dimensions filters applied to every
// candidate regardless of source. og:image is only used as a last resort
// if nothing usable turns up in the body. This can't see anything a site
// only renders via client-side JavaScript (a real headless-browser
// screenshot would be needed for that, which costs money) — a plain HTML
// fetch only sees what's actually in the server-rendered markup.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

type Candidate = { src: string; score: number };

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

const HERO_HINT = /hero|banner|jumbotron|masthead|showcase|header-img|headerimage|cover-photo|coverphoto/i;

// <img> tags anywhere in the body — lazy-loaded sites often put the real
// URL in data-src/data-lazy-src instead of src, so check those too.
function extractImgCandidates(html: string): Candidate[] {
  const results: Candidate[] = [];
  const tagRe = /<img\s+[^>]*>/gi;
  let m: RegExpExecArray | null;
  let index = 0;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    const get = (attr: string) => tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1];
    const srcset = get("srcset") || get("data-srcset");
    const src = get("data-src") || get("data-lazy-src") || get("src") || (srcset ? srcset.split(",")[0].trim().split(/\s+/)[0] : undefined);
    if (!src || src.startsWith("data:")) { index++; continue; }
    const classId = `${get("class") || ""} ${get("id") || ""}`;
    let score = HERO_HINT.test(classId) ? 3 : 0;
    if (score === 0 && index < 3) score = 1; // early images in the doc are more likely to be the hero than a footer/gallery image
    results.push({ src, score });
    index++;
  }
  return results;
}

// Elements (div/section/header/etc) with a hero-ish class AND an inline
// background-image — attribute order varies (class-then-style or
// style-then-class), so check both orders.
function extractBgImageCandidates(html: string): Candidate[] {
  const results: Candidate[] = [];
  const tagRe = /<[a-z][a-z0-9]*\s+[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    const classId = `${tag.match(/\bclass\s*=\s*["']([^"']+)["']/i)?.[1] || ""} ${tag.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1] || ""}`;
    if (!HERO_HINT.test(classId)) continue;
    const bgMatch = tag.match(/background(?:-image)?\s*:\s*url\((['"]?)([^'")]+)\1\)/i);
    if (bgMatch) results.push({ src: bgMatch[2], score: 3 });
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
  const timer = setTimeout(() => ctrl.abort(), 10000);
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

    // Need the actual body content now (not just <head>), since the real
    // hero image lives there — cap at ~800KB so a huge page can't drag
    // this out forever.
    const reader = res.body?.getReader();
    let html = "";
    if (reader) {
      const decoder = new TextDecoder();
      let bytesRead = 0;
      while (bytesRead < 800_000) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        bytesRead += value.length;
      }
      reader.cancel().catch(() => {});
    } else {
      html = await res.text();
    }

    // Body content first (reflects what's actually live on the page),
    // meta tags last (can be stale — set once, never updated).
    const bodyCandidates = [...extractBgImageCandidates(html), ...extractImgCandidates(html)];
    const metaCandidates = [
      ...extractMetaContents(html, "property", "og:image"),
      ...extractMetaContents(html, "name", "twitter:image"),
    ].map((src) => ({ src, score: -1 }));

    const allCandidates = [...bodyCandidates, ...metaCandidates]
      .map((c) => { try { return { ...c, src: new URL(c.src, website).toString() }; } catch { return c; } })
      .filter((c) => !looksLikeLogoUrl(c.src))
      .sort((a, b) => b.score - a.score);

    if (!allCandidates.length) return json({ image: null, reason: "No usable image candidates found on the page (all logo-named, or none found at all)" });

    // Dedupe by URL, keeping the highest score, then check dimensions on
    // the top few in parallel (bounded so a page with lots of hero-like
    // markup can't drag this out).
    const seen = new Map<string, number>();
    for (const c of allCandidates) if (!seen.has(c.src)) seen.set(c.src, c.score);
    const ranked = [...seen.keys()];

    const checked = ranked.slice(0, 6);
    const dims = await Promise.all(checked.map((url) => fetchImageDimensions(url)));
    const winner = checked.find((_, i) => !looksLikeLogoDimensions(dims[i]));

    if (!winner) return json({ image: null, reason: "Only logo-shaped images found (near-square or too small) among the top candidates" });
    return json({ image: winner });
  } catch (e: any) {
    clearTimeout(timer);
    return json({ image: null, reason: String(e?.message || e) });
  }
};

export const config: Config = { path: "/api/fetch-hero-image" };
