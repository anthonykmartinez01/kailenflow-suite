import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { getPage, deletePage, listImagesForPage, deleteImageDocsForPage } from "../../shared/page-publisher/firestore.mts";
import { deletePageImageFile } from "../../shared/page-publisher/storage.mts";

// POST /api/page-publisher-delete-page {pageId} — deletes a
// pagePublisherPages doc, its pagePublisherImages docs, and any files those
// images actually uploaded to Firebase Storage (best-effort — a missing/
// already-gone file never blocks the delete). No confirmation step here;
// the UI's confirm() dialog is the only gate, matching this app's existing
// delete-button pattern elsewhere.
//
// Deliberately does NOT touch client.pagePublisher.pageRefs — no function
// writes to it yet (a known gap, separate from this one), so there's
// nothing there to clean up for a page created through the current intake
// flow.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const { pageId } = body;
  if (!pageId) return json({ error: "pageId is required" }, 400);

  const page = await getPage(pageId);
  if (!page) return json({ error: "No page found for that pageId" }, 404);

  const images = await listImagesForPage(pageId);
  await Promise.all(images.map((img) => deletePageImageFile(img.uploadedRemoteUrl)));
  await deleteImageDocsForPage(pageId);
  await deletePage(pageId);

  return json({ ok: true });
};

export const config: Config = { path: "/api/page-publisher-delete-page" };
