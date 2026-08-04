// Deploy-time compile step. Added 2026-08-04 after measuring the live app:
// domInteractive landed at ~265ms but domContentLoaded at ~5,683ms — i.e.
// ~5.4 SECONDS of blocking work on every single page load, on a fast local
// server with everything already cached. All of it was the browser rebuilding
// the app from source at runtime:
//
//   • 2.78 MB of babel-standalone downloaded and parsed, every load
//   • 741 KB of JSX re-transpiled, every load
//   • which expanded to ~3 MB of ES5 (babel-standalone downlevels by
//     default, inlining a helper for every class/spread/etc.) that the
//     engine then had to parse and execute
//
// This script does that work ONCE, here, so the browser receives plain JS.
//
// ─── Why public/index.html is still the source of truth ──────────────────
// The app is deliberately a single hand-edited file with no bundler (see
// PROJECT_CONTEXT.md). That property is kept: you still edit
// public/index.html exactly as before, and the local preview
// (.claude/launch.json serves public/) still uses in-browser Babel, so
// nothing about authoring or previewing changes. Only the DEPLOYED copy is
// compiled, into dist/.
//
// ─── Why preset-react ONLY, and no preset-env ────────────────────────────
// preset-env is what turned 741 KB into 3 MB. Every browser this app
// supports (it already relies on optional chaining, nullish coalescing and
// async/await at runtime today, unpolyfilled) handles modern syntax
// natively, so downleveling buys nothing and costs 4x the bytes. This
// converts JSX and leaves everything else alone.

import { readFile, writeFile, mkdir, readdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { transformAsync } from "@babel/core";

const SRC_DIR = "public";
const OUT_DIR = "dist";
const BABEL_TAG_RE = /<script\s+src="[^"]*babel-standalone[^"]*"[^>]*>\s*<\/script>\s*/i;
const OPEN_TAG = '<script type="text/babel">';

const kb = (s) => Math.round(s.length / 1024);

async function build() {
  const started = Date.now();
  const html = await readFile(join(SRC_DIR, "index.html"), "utf8");

  const open = html.indexOf(OPEN_TAG);
  if (open === -1) throw new Error(`No ${OPEN_TAG} found in ${SRC_DIR}/index.html — nothing to compile.`);

  // The app's own source contains `</script>` inside regex literals, but
  // always ESCAPED as `<\/script>` — which is exactly why the browser's
  // parser doesn't end the block early there either. So the first LITERAL
  // `</script` after the opening tag is the real terminator. Verified: there
  // is exactly one. If that ever stops being true this throws rather than
  // silently truncating half the app.
  const bodyStart = open + OPEN_TAG.length;
  const close = html.indexOf("</script", bodyStart);
  if (close === -1) throw new Error("Unterminated <script type=\"text/babel\"> block.");
  if (html.indexOf("</script", close + 1) !== -1) {
    throw new Error(
      "Found more than one literal '</script' after the babel block. A new unescaped occurrence " +
      "would make this script compile only part of the app. Escape it as '<\\/script>' in the source."
    );
  }

  const jsx = html.slice(bodyStart, close);
  const result = await transformAsync(jsx, {
    presets: [["@babel/preset-react", { runtime: "classic" }]],
    babelrc: false,
    configFile: false,
    compact: false,
    sourceType: "script", // top-level function declarations must stay hoisted globals
    filename: "index.jsx",
  });
  if (!result?.code) throw new Error("Babel returned no output.");

  // Defensive: if compiled output ever contains a literal `</script`, the
  // browser would end the tag early and silently truncate the app. Neutralise
  // it the same way the source already does.
  const code = result.code.replace(/<\/script/gi, "<\\/script");

  let out = html.slice(0, open) + "<script>\n" + code + "\n</script>" + html.slice(close + "</script>".length);

  // The compiler is now dead weight — 2.78 MB the browser no longer fetches,
  // parses, or runs.
  if (!BABEL_TAG_RE.test(out)) throw new Error("Could not find the babel-standalone <script> tag to remove.");
  out = out.replace(BABEL_TAG_RE, "");

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, "index.html"), out);

  // Carry across anything else that lives in public/ (favicons, robots.txt,
  // future assets) so adding a file there never silently fails to deploy.
  let copied = 0;
  for (const entry of await readdir(SRC_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === "index.html") continue;
    await copyFile(join(SRC_DIR, entry.name), join(OUT_DIR, entry.name));
    copied++;
  }

  console.log(
    `built ${OUT_DIR}/index.html in ${Date.now() - started}ms\n` +
    `  JSX in:        ${kb(jsx)} KB\n` +
    `  JS out:        ${kb(code)} KB\n` +
    `  page in:       ${kb(html)} KB\n` +
    `  page out:      ${kb(out)} KB\n` +
    `  extra files:   ${copied}\n` +
    `  browser no longer downloads babel-standalone (~2.78 MB) or compiles at runtime`
  );
}

build().catch((e) => {
  // Fail the deploy loudly. Shipping a half-compiled index.html would be far
  // worse than not shipping.
  console.error("BUILD FAILED:", e.message);
  process.exit(1);
});
