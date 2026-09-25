import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

// AI autofill for Client Settings: crawls the client's website (homepage +
// contact page if linked) and extracts the business facts that appear
// verbatim on the page — name, phone, street address, city, state, GBP/maps
// link. Accuracy over completeness: the model is told to OMIT any field it
// isn't certain of (especially primaryCategory, which is a GBP taxonomy
// term, not something a website states), and the frontend only fills fields
// that are currently empty — it never overwrites what Anthony typed.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

// Fetch a page with a hard timeout, returning "" on any failure — a broken
// contact-page link shouldn't sink the whole autofill.
async function fetchPage(url: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KailenFlowSuite/1.0)", Accept: "text/html" },
      redirect: "follow",
    });
    if (!res.ok) return "";
    return (await res.text()).slice(0, 400_000);
  } catch {
    return "";
  } finally {
    clearTimeout(t);
  }
}

// Boil HTML down to what matters for extraction: JSON-LD blocks verbatim
// (LocalBusiness schema is the single most reliable source), tel:/maps
// hrefs, then visible text. Keeps the Claude prompt small and focused.
function distill(html: string): string {
  if (!html) return "";
  const jsonLd = Array.from(html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi))
    .map((m) => m[1].trim()).join("\n");
  const tels = Array.from(new Set(Array.from(html.matchAll(/href=["']tel:([^"']+)["']/gi)).map((m) => m[1]))).join(", ");
  const maps = Array.from(new Set(Array.from(html.matchAll(/href=["'](https?:\/\/(?:www\.)?(?:google\.[^"']*\/maps|maps\.google\.[^"']*|g\.page|maps\.app\.goo\.gl)[^"']*)["']/gi)).map((m) => m[1]))).join("\n");
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim().slice(0, 12_000);
  return [jsonLd && `JSON-LD schema:\n${jsonLd.slice(0, 6000)}`, tels && `tel: links: ${tels}`, maps && `Google Maps links:\n${maps}`, `Page text:\n${text}`]
    .filter(Boolean).join("\n\n");
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  let website: string = (body.website || "").toString().trim();
  if (!website) return json({ error: "website is required" }, 400);
  if (!/^https?:\/\//i.test(website)) website = "https://" + website;
  let origin: string;
  try { origin = new URL(website).origin; } catch { return json({ error: "That doesn't look like a valid website URL." }, 400); }

  const anthropicKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) return json({ error: "ANTHROPIC_API_KEY not configured on the server" }, 500);

  const homeHtml = await fetchPage(website);
  if (!homeHtml) return json({ error: "Couldn't load that website — check the URL and try again." }, 502);

  // Contact/about pages usually carry the full NAP — follow the first one linked.
  const contactPath = (homeHtml.match(/href=["'](\/[^"']*(?:contact|about)[^"']*)["']/i) || [])[1];
  const contactHtml = contactPath ? await fetchPage(origin + contactPath) : "";

  const content = [`Homepage (${website}):\n${distill(homeHtml)}`, contactHtml && `Contact/About page (${origin + contactPath}):\n${distill(contactHtml)}`]
    .filter(Boolean).join("\n\n====\n\n");

  const prompt = `You are extracting a local business's contact details from its own website content below. Return ONLY a JSON object — no prose, no markdown fences — with any of these keys:

{
  "name": "the business name as the business itself writes it",
  "phone": "primary phone number, formatted (XXX) XXX-XXXX",
  "address": "street address only, e.g. 1591 Blue Forest Dr",
  "city": "city",
  "state": "two-letter state abbreviation, e.g. TX",
  "gbpUrl": "the business's own Google Maps / g.page listing URL, only if one is linked on the site"
}

STRICT RULES — accuracy over completeness:
- OMIT any key you are not certain of. An omitted field is correct; a guessed field is a bug.
- Only use values that literally appear in the content (JSON-LD schema is the most trustworthy source, then tel:/maps links, then page text).
- If multiple locations/phones appear, use the primary one (the one in the header/footer/schema); if you can't tell which is primary, omit the field.
- Do NOT infer a business category. Do NOT invent an address from a city mention. Do NOT return a Google search URL as gbpUrl.

Website content:
${content}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) throw new Error(`Claude error ${r.status}: ${(await r.text()).slice(0, 150)}`);
    const d = await r.json();
    const text = (d.content?.[0]?.text || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    let extracted: any;
    try { extracted = JSON.parse(text); } catch { return json({ error: "Extraction came back unreadable — try again." }, 502); }

    // Belt-and-braces: only pass through known keys, as non-empty strings.
    const fields: Record<string, string> = {};
    for (const k of ["name", "phone", "address", "city", "state", "gbpUrl"]) {
      const v = extracted?.[k];
      if (typeof v === "string" && v.trim()) fields[k] = v.trim();
    }
    return json({ fields, checkedContactPage: !!contactHtml });
  } catch (e: any) {
    return json({ error: "AI extraction failed.", detail: String(e?.message || e) }, 502);
  }
};

export const config: Config = { path: "/api/autofill-business" };
