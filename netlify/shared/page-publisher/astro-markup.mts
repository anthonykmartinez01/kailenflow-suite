// Converts the operator's sanitized HTML into markup that is SAFE to emit
// directly into a .astro file — the replacement for `<article set:html={...} />`.
//
// ─── Why this has to fail closed ──────────────────────────────────────────
// `set:html` was inert: the HTML went in as a runtime STRING, so no matter how
// malformed it was, the .astro file itself always parsed and the site always
// built. Emitting real markup gives up that safety net. Astro compiles the file
// at build time, so a single unclosed tag or stray `{` doesn't break one page —
// it FAILS THE CLIENT'S WHOLE BUILD, and (because deploys run from a daily
// GitHub Action, not a git push) it fails hours later, unattended, taking the
// entire live site's next deploy with it.
//
// So this module never "does its best". Anything it cannot prove safe becomes a
// blocking problem, and the commit is refused. The old shape was worse-looking
// but unbreakable; the new one is correct but sharp, and that trade is only
// acceptable with a real gate in front of it.
//
// What it must handle, none of which mattered under set:html:
//   • `{` / `}` in TEXT start an Astro expression   -> escape to entities
//   • void elements must be self-closed (<img>, <br>, <hr>, <input>, <meta>)
//   • unbalanced tags break compilation             -> refuse
//   • <script>/<style> must never survive intake    -> refuse
//   • Astro directives look like attributes         -> refuse if present

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
// Elements whose closing tag is optional in HTML but required in Astro/JSX.
const OPTIONAL_CLOSE = new Set(["p", "li", "td", "th", "tr", "thead", "tbody", "option"]);

export interface AstroMarkupResult {
  ok: boolean;
  markup: string;
  problems: string[];   // blocking — refuse the commit
  notes: string[];      // applied automatically, worth reporting
}

export function toAstroMarkup(html: string): AstroMarkupResult {
  const problems: string[] = [];
  const notes: string[] = [];

  if (/<\s*(script|style)\b/i.test(html)) {
    problems.push("Content contains a <script> or <style> tag. Intake sanitization should have removed these — refusing to commit rather than inject executable markup into the client's repo.");
  }
  // Astro treats these as compiler directives, not data.
  const directive = html.match(/\s(set:html|set:text|is:inline|client:(load|idle|visible|only)|define:vars|is:raw)\b/);
  if (directive) {
    problems.push(`Content contains what Astro reads as a compiler directive ("${directive[1]}"). Refusing to commit — this would change build behaviour, not just render text.`);
  }

  // ── Walk the markup, separating tags from text ──
  // Braces are escaped ONLY in text and attribute values; a brace inside a tag
  // name position would already be malformed.
  const tokens = html.split(/(<\/?[A-Za-z][^>]*>|<!--[\s\S]*?-->)/);
  const stack: { tag: string; index: number }[] = [];
  let selfClosedCount = 0;
  let out = "";

  for (const tok of tokens) {
    if (!tok) continue;

    if (tok.startsWith("<!--")) { out += tok; continue; }

    if (!/^<\/?[A-Za-z]/.test(tok)) {
      // TEXT NODE — this is where a stray brace would silently become an
      // Astro expression and either break the build or evaluate something.
      const escaped = tok.replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");
      if (escaped !== tok) notes.push("Escaped { or } in text so Astro doesn't read it as an expression.");
      out += escaped;
      continue;
    }

    const closing = tok.startsWith("</");
    const nameMatch = tok.match(/^<\/?\s*([A-Za-z][A-Za-z0-9-]*)/);
    if (!nameMatch) { problems.push(`Could not parse a tag: ${tok.slice(0, 60)}`); out += tok; continue; }
    const tag = nameMatch[1].toLowerCase();

    if (closing) {
      const top = stack.pop();
      if (!top) {
        problems.push(`Closing </${tag}> with no matching opening tag — the content's tags are unbalanced and would fail the Astro build.`);
      } else if (top.tag !== tag) {
        // Tolerate HTML's optional close (e.g. <p>a<p>b) by unwinding, but only
        // for elements where that's actually legal.
        if (OPTIONAL_CLOSE.has(top.tag)) {
          notes.push(`Implicitly closed <${top.tag}> before </${tag}> (legal in HTML, required explicitly by Astro).`);
        } else {
          problems.push(`Tags are crossed: <${top.tag}> was closed by </${tag}>. Astro requires properly nested markup.`);
        }
      }
      out += tok;
      continue;
    }

    // Opening tag. Escape braces inside attribute values.
    let fixed = tok.replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");
    const alreadySelfClosed = /\/>$/.test(fixed.trim());

    if (VOID_ELEMENTS.has(tag)) {
      if (!alreadySelfClosed) {
        fixed = fixed.replace(/\s*>$/, " />");
        selfClosedCount++;
      }
    } else if (!alreadySelfClosed) {
      stack.push({ tag, index: out.length });
    }
    out += fixed;
  }

  // Anything still open at the end is unbalanced, unless it's an
  // optional-close element that HTML lets you leave dangling.
  for (const left of stack.reverse()) {
    if (OPTIONAL_CLOSE.has(left.tag)) {
      out += `</${left.tag}>`;
      notes.push(`Added the missing </${left.tag}> that HTML allows to be omitted but Astro requires.`);
    } else {
      problems.push(`<${left.tag}> is never closed. Astro requires every element to be closed — refusing to commit markup that would fail the build.`);
    }
  }

  if (selfClosedCount) notes.push(`Self-closed ${selfClosedCount} void element(s) (<img>, <br>, …) as Astro requires.`);

  return { ok: problems.length === 0, markup: out, problems, notes };
}

// The gate treats img_dimensions as BLOCKING, and CLAUDE.md forbids bare <img>.
// Every image must therefore carry width and height before this can commit.
// Reported rather than guessed — inventing dimensions would cause layout shift,
// which is the exact thing the check exists to prevent.
export function checkImageDimensions(html: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    const tag = m[0];
    const hasW = /\swidth\s*=/.test(tag);
    const hasH = /\sheight\s*=/.test(tag);
    if (!hasW || !hasH) {
      const src = tag.match(/\ssrc\s*=\s*["']([^"']*)["']/);
      missing.push(src ? src[1] : tag.slice(0, 70));
    }
  }
  return { ok: missing.length === 0, missing };
}
