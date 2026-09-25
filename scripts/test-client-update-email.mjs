// Proves the weekly client update: structure matches the template, repeats are
// grouped, wording reads naturally, and the deliverability guards actually fire.
// Run: node scripts/test-client-update-email.mjs
import { buildWeeklyUpdate, phrase, whenLabel, firstName, groupItems, deliverability, escapeHtml } from "../netlify/shared/client-update-email.mts";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("PASS ", name); } else { fail++; console.log("FAIL ", name, "\n   got ", g, "\n   want", w); }
};
const NOW = Date.parse("2026-09-24T12:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const ahead = (d) => new Date(NOW + d * 86400000).toISOString();

// Wording.
eq("first name", firstName("Brandon Miller"), "Brandon");
eq("no name falls back", firstName(""), "there");
eq("days ago", whenLabel(Date.parse(ago(5)), NOW, false), "5 days ago");
eq("yesterday", whenLabel(Date.parse(ago(1)), NOW, false), "yesterday");
eq("in days", whenLabel(Date.parse(ahead(3)), NOW, true), "in 3 days");
eq("tomorrow", whenLabel(Date.parse(ahead(1)), NOW, true), "tomorrow");
eq("page phrasing", phrase("Published new page: AC Repair in Prosper"), "published a new page (AC Repair in Prosper)");
eq("indexing phrasing", phrase("Submitted for indexing: /ac-repair"), "submitted /ac-repair to Google for indexing");
eq("website phrasing", phrase("Website: Update the H1 on the services page"), "updated the website — update the H1 on the services page");
eq("task phrasing", phrase("Completed: monthly GBP posts"), "completed monthly GBP posts");
eq("verb kept", phrase("Uploaded an image"), "uploaded an image");

// Repeats collapse instead of ten identical bullets.
const repeats = Array.from({ length: 10 }, () => ({ at: ahead(2), text: "Publish a post to GBP" }));
eq("repeats grouped", groupItems(repeats, NOW, true).length, 1);
eq("repeat count shown", groupItems(repeats, NOW, true)[0].count, 10);
eq("blank items dropped", groupItems([{ at: ago(1), text: "   " }, { at: ago(1), text: "Uploaded an image" }], NOW, false).length, 1);
eq("undated items dropped", groupItems([{ at: "not-a-date", text: "Uploaded an image" }], NOW, false).length, 0);

// Full build.
const built = buildWeeklyUpdate({
  clientName: "Pool Clean",
  contactName: "Brandon Miller",
  done: [
    { at: ago(5), text: "Uploaded an image" },
    { at: ago(5), text: "Published a post to GBP", url: "https://example.com/post" },
    { at: ago(3), text: "Website: Add a pricing page", url: "https://example.com/pricing" },
    { at: ago(1), text: "Sent a reminder to get more reviews" },
  ],
  upcoming: [
    { at: ahead(2), text: "Publish a post to GBP" },
    { at: ahead(2), text: "Publish a post to GBP" },
    { at: ahead(5), text: "Upload an image" },
  ],
  nowMs: NOW,
});
eq("subject matches the template", built.subject, "Pool Clean's Weekly Summary");
eq("greets the contact", built.text.startsWith("Hi Brandon,"), true);
eq("names the client in the intro", built.text.includes("for Pool Clean:"), true);
eq("past-7-days heading", built.text.includes("What we did the past 7 days:"), true);
eq("next-7-days heading", built.text.includes("What we're doing in the next 7 days:"), true);
eq("past bullet reads naturally", built.text.includes("• 5 days ago we uploaded an image"), true);
eq("future bullet reads naturally", built.text.includes("• In 2 days we will publish a post to GBP (×2)"), true);
eq("sign-off", built.text.trim().endsWith("Thank you!\n\nKailenFlow"), true);
eq("html has both headings", (built.html.match(/<b>What we/g) || []).length, 2);
eq("html links are real urls", built.html.includes('href="https://example.com/pricing"'), true);
eq("clean email has no warnings", built.warnings, []);

// Quiet week still sends something honest, and drops the future section.
const quiet = buildWeeklyUpdate({ clientName: "Pool Clean", contactName: "Brandon", done: [], nowMs: NOW });
eq("quiet week is honest", quiet.text.includes("nothing client-facing went live"), true);
eq("no upcoming section when nothing scheduled", quiet.text.includes("next 7 days"), false);

// Deliverability guards.
eq("spam wording flagged", deliverability("Free money", "Act now, click here for a risk-free guarantee", "").warnings.length > 0, true);
eq("shouting flagged", deliverability("UPDATE", "HELLO THERE", "").warnings.some((w) => w.includes("ALL-CAPS")), true);
eq("too many links flagged", deliverability("s", "t", "<a ".repeat(20)).warnings.some((w) => w.includes("links")), true);
eq("shortener flagged", deliverability("s", "see bit.ly/abc", "").warnings.some((w) => w.includes("shorteners")), true);
eq("long subject flagged", deliverability("x".repeat(80), "t", "").warnings.some((w) => w.includes("Subject")), true);
eq("link budget caps html links", (buildWeeklyUpdate({
  clientName: "C", contactName: "A", nowMs: NOW,
  done: Array.from({ length: 14 }, (_, i) => ({ at: ago(i % 6 + 1), text: `Published page number ${i}`, url: `https://example.com/${i}` })),
}).html.match(/<a /g) || []).length <= 12, true);

eq("html escaped", escapeHtml('<script>"&'), "&lt;script&gt;&quot;&amp;");

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
