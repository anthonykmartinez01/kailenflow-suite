// HTML -> LocationSection[] extraction, for GIT_STATIC sites that have a real
// location-page component. Location pages stop being class-mapped HTML and
// instead FEED the site's own component, so they come out byte-identical to
// every other town page — real two-column image/text layout, breadcrumb, and
// the Google Reviews block, all for free from the component.
//
// This is extraction, not inference: verified against the real repo, the
// generator's output has the same shape and order the component expects
// (hero title, intro, titled sections each with one image, FAQ, CTA).
//
// TARGET SHAPE (src/components/location-types.ts, read from the real repo):
//   interface LocationSection { heading; img; imgAlt; lead; blocks }
//   type Block = {type:'p';text} | {type:'ul'|'ol';items[]}
// Component props: town, county, slug, title, h1, description, subtitle,
// heroAlt, intro, sections, faqs. NOTE there is no cta/areaServed/breadcrumb/
// heroImage prop — the component derives all of those from town/county/slug,
// which is why the draft's own CTA and schema are dropped rather than mapped.
//
// Only applies where a component exists. Service pages keep class mapping.

export interface LocBlock { type: "p" | "ul" | "ol"; text?: string; items?: string[] }
export interface LocSection { heading: string; img: string; imgAlt: string; lead: string; blocks: LocBlock[] }

export interface ParseIssue { kind: string; detail: string }

export interface LocationParseResult {
  ok: boolean;
  blockers: ParseIssue[];   // refuse to commit
  lossy: ParseIssue[];      // dropped on purpose — show before committing
  props: {
    town: string; county: string; slug: string;
    title: string; h1: string; description: string; subtitle: string;
    heroAlt: string; intro: string;
  };
  sections: LocSection[];
  faqs: { q: string; a: string }[];
  imageMap: { originalSrc: string; targetBasename: string; alt: string }[];
  heroRequired: { basename: string; mobileBasename: string; present: boolean };
}

const strip = (s: string) => s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/&#39;|&rsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&mdash;/g, "—")
  .replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

// A heading that ends a content run rather than starting a section.
const isFaqHeading = (t: string) => /frequently asked|^faqs?$/i.test(t);
const isCtaHeading = (t: string) => /ready to get started|call (us|now)|get a quote|contact us today/i.test(t);

export function parseLocationDraft(
  html: string,
  opts: { expectedTown: string; county: string; slug: string; heroPresent?: boolean }
): LocationParseResult {
  const blockers: ParseIssue[] = [];
  const lossy: ParseIssue[] = [];

  const body = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1]) ?? html;
  const docTitle = strip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const metaDesc = (html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] || "").trim();

  // The generator's own JSON-LD is always discarded: the component emits
  // Service + FAQPage + BreadcrumbList + LocalBusiness itself, and two graphs
  // would conflict. (The draft's block also doesn't parse — separate generator
  // bug, still worth fixing for page types that have no component.)
  const ld = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  if (ld.length) {
    let parses = 0;
    for (const m of ld) { try { JSON.parse(m[1]); parses++; } catch { /* malformed */ } }
    lossy.push({
      kind: "schema_discarded",
      detail: `Dropped ${ld.length} JSON-LD block(s) from the draft — the component owns schema for location pages (Service + FAQPage + BreadcrumbList + LocalBusiness).` +
        (parses < ld.length ? ` Note: ${ld.length - parses} of them did not parse as valid JSON, which is a generator bug that matters for page types WITHOUT a component.` : ""),
    });
  }

  // ── Split the body into <h2>-delimited runs ──
  // Everything before the first h2 is preamble; the FAQ and CTA headings end
  // the content sections.
  const h2Re = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
  const marks: { text: string; start: number; end: number }[] = [];
  for (const m of body.matchAll(h2Re)) marks.push({ text: strip(m[1]), start: m.index!, end: m.index! + m[0].length });

  if (marks.length === 0) blockers.push({ kind: "no_sections", detail: "No <h2> found — cannot split the draft into LocationSections." });

  const preamble = marks.length ? body.slice(0, marks[0].start) : body;

  // ── Preamble: subtitle / intro, and the bits with nowhere to go ──
  const pre = [...preamble.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => strip(m[1])).filter(Boolean);
  const preLists = [...preamble.matchAll(/<(ul|ol)\b[^>]*>[\s\S]*?<\/\1>/gi)];
  if (preLists.length) {
    lossy.push({ kind: "toc_dropped", detail: `Dropped a "what's covered on this page" list (${preLists.length}) from the preamble — LocationPage has no table-of-contents slot; the real town pages don't have one.` });
  }
  const ctaish = pre.filter((t) => /call now|need .* page\?|get a quote/i.test(t));
  if (ctaish.length) {
    lossy.push({ kind: "top_cta_dropped", detail: `Dropped ${ctaish.length} lead-in CTA line(s) ("${ctaish[0].slice(0, 48)}…") — the component renders its own CTA from town/county.` });
  }
  const usable = pre.filter((t) => !ctaish.includes(t) && t.length > 0);
  const subtitle = usable[0] && usable[0].length < 120 ? usable[0] : `Serving ${opts.expectedTown} & Rural ${opts.county}, TX`;
  const intro = usable.find((t) => t !== subtitle && t.length >= 80) || "";
  if (!intro) lossy.push({ kind: "intro_missing", detail: "No intro paragraph found before the first heading — the real town pages open with one. Falling back to empty; supply an intro or the hero will run straight into the first section." });

  // ── Content sections ──
  const sections: LocSection[] = [];
  const faqs: { q: string; a: string }[] = [];
  const imageMap: { originalSrc: string; targetBasename: string; alt: string }[] = [];

  for (let i = 0; i < marks.length; i++) {
    const heading = marks[i].text;
    const chunk = body.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : body.length);

    if (isFaqHeading(heading)) {
      // FAQ: h3 question followed by its paragraph(s).
      const qs = [...chunk.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)];
      for (let k = 0; k < qs.length; k++) {
        const q = strip(qs[k][1]);
        const after = chunk.slice(qs[k].index! + qs[k][0].length, k + 1 < qs.length ? qs[k + 1].index! : chunk.length);
        const a = [...after.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => strip(m[1])).filter(Boolean).join(" ");
        if (q && a) faqs.push({ q, a });
      }
      if (qs.length === 0) lossy.push({ kind: "faq_unparsed", detail: `Found a "${heading}" heading but no <h3> questions under it — no FAQs extracted, so the component's FAQ section and FAQPage schema will be empty.` });
      continue;
    }
    if (isCtaHeading(heading)) {
      lossy.push({ kind: "bottom_cta_dropped", detail: `Dropped the closing CTA section ("${heading}") — the component renders its own, personalised with the town name.` });
      continue;
    }

    // Images: exactly one per section is what the component supports.
    const imgs = [...chunk.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
    if (imgs.length === 0) {
      blockers.push({ kind: "section_missing_image", detail: `Section "${heading}" has no image. LocationPage renders every section as a two-column image/text pair — a section without one cannot render.` });
    } else if (imgs.length > 1) {
      lossy.push({ kind: "extra_images_dropped", detail: `Section "${heading}" has ${imgs.length} images; LocationPage supports ONE per section. Keeping the first, dropping ${imgs.length - 1}.` });
    }
    const firstImg = imgs[0] || "";
    const src = firstImg.match(/\ssrc\s*=\s*["']([^"']+)["']/i)?.[1] || "";
    const alt = firstImg.match(/\salt\s*=\s*["']([^"']*)["']/i)?.[1] || "";
    if (firstImg && !alt) blockers.push({ kind: "image_missing_alt", detail: `The image in "${heading}" has no alt text (Layer 1 requirement, and the component passes it straight through).` });
    const targetBasename = `section-${sections.length + 1}`;
    if (src) imageMap.push({ originalSrc: src, targetBasename, alt });

    // Paragraphs / lists, in document order. The FIRST paragraph is the lead.
    const parts = [...chunk.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>|<(ul|ol)\b[^>]*>([\s\S]*?)<\/\2>/gi)];
    const blocks: LocBlock[] = [];
    let lead = "";
    for (const p of parts) {
      if (p[1] !== undefined) {
        const t = strip(p[1]);
        if (!t) continue;
        if (!lead) { lead = t; continue; }
        blocks.push({ type: "p", text: t });
      } else {
        const items = [...p[3].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => strip(m[1])).filter(Boolean);
        if (items.length) blocks.push({ type: p[2].toLowerCase() as "ul" | "ol", items });
      }
    }
    if (!lead) blockers.push({ kind: "section_missing_lead", detail: `Section "${heading}" has no paragraph text to use as its lead.` });
    sections.push({ heading, img: targetBasename, imgAlt: alt, lead, blocks });
  }

  // ── Town-name check: REFUSE, never auto-correct ──────────────────────────
  // Auto-correcting would hide a generator bug that also lands in filenames,
  // alt text, and body copy the parser doesn't touch. The whole point of a
  // location page is ranking for that town's name.
  const townsSeen = new Set<string>();
  for (const s of [...sections.map((x) => x.heading), ...sections.map((x) => x.lead), ...faqs.map((f) => f.q)]) {
    for (const m of s.matchAll(/\b(?:near|around|in|to|of)\s+([A-Z][a-zA-Z]{2,})\s*,?\s*TX\b/g)) townsSeen.add(m[1]);
  }
  const wrong = [...townsSeen].filter((t) => t.toLowerCase() !== opts.expectedTown.toLowerCase());
  if (wrong.length) {
    blockers.push({
      kind: "town_name_mismatch",
      detail: `The draft names the town as ${wrong.map((w) => `"${w}"`).join(", ")} but the target is "${opts.expectedTown}". REFUSING rather than auto-correcting — the misspelling is also in image filenames, alt text and body copy this parser doesn't rewrite, and a location page whose job is ranking for "${opts.expectedTown}" must not publish with the name wrong. Fix it at the generator, then re-import.`,
    });
  }

  // ── Hero: required, cannot be synthesised ────────────────────────────────
  const heroPresent = !!opts.heroPresent;
  if (!heroPresent) {
    blockers.push({
      kind: "hero_image_missing",
      detail: `No hero image supplied. LocationPage requests /images/${opts.slug}/hero.webp and hero-mobile.webp unconditionally — without them the top of the page 404s. A section image can't be resized into a hero (different crop and aspect), so this is a required per-page asset.`,
    });
  }

  return {
    ok: blockers.length === 0,
    blockers, lossy,
    props: {
      town: opts.expectedTown, county: opts.county, slug: opts.slug,
      title: docTitle || `Waste Management Service Near ${opts.expectedTown}, TX | Rankin Waste`,
      h1: `Waste Management Service Near ${opts.expectedTown}, TX`,
      description: metaDesc, subtitle,
      heroAlt: `Rankin Waste pickup near ${opts.expectedTown}, TX`,
      intro,
    },
    sections, faqs, imageMap,
    heroRequired: { basename: "hero", mobileBasename: "hero-mobile", present: heroPresent },
  };
}

// Emits the page file in the SAME shape as the real town pages (watt.astro):
// typed const arrays in frontmatter, then a single <LocationPage ... /> call.
export function buildLocationPageFile(r: LocationParseResult, scheduleRel: string | null): string {
  const tpl = (s: string) => "`" + String(s ?? "").replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`";
  const blocks = (bs: LocBlock[]) => bs.map((b) => b.type === "p"
    ? `      { type: 'p', text: ${tpl(b.text)} },`
    : `      { type: '${b.type}', items: [\n${(b.items || []).map((i) => `        ${tpl(i)},`).join("\n")}\n      ] },`).join("\n");
  const guard = scheduleRel ? `import { scheduleGuard } from '${scheduleRel}';\n\nconst guard = scheduleGuard(Astro);\nif (guard) return guard;\n` : "";
  return `---
// Generated by KailenFlow Page Publisher — fed through the site's own
// LocationPage component so it renders identically to every other town page.
import LocationPage from '../../components/LocationPage.astro';
import type { LocationSection, Faq } from '../../components/location-types';
${guard}
const sections: LocationSection[] = [
${r.sections.map((s) => `  {
    heading: ${tpl(s.heading)},
    img: '${s.img}',
    imgAlt: ${tpl(s.imgAlt)},
    lead: ${tpl(s.lead)},
    blocks: [
${blocks(s.blocks)}
    ],
  },`).join("\n")}
];

const faqs: Faq[] = [
${r.faqs.map((f) => `  { q: ${tpl(f.q)}, a: ${tpl(f.a)} },`).join("\n")}
];
---

<LocationPage
  town="${r.props.town}"
  county="${r.props.county}"
  slug="${r.props.slug}"
  title="${r.props.title.replace(/"/g, "&quot;")}"
  h1="${r.props.h1.replace(/"/g, "&quot;")}"
  description="${r.props.description.replace(/"/g, "&quot;")}"
  subtitle="${r.props.subtitle.replace(/"/g, "&quot;")}"
  heroAlt="${r.props.heroAlt.replace(/"/g, "&quot;")}"
  intro={${tpl(r.props.intro)}}
  sections={sections}
  faqs={faqs}
/>
`;
}
