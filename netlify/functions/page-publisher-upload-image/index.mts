import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";
import { uploadPageImage } from "../../shared/page-publisher/storage.mts";

// POST /api/page-publisher-upload-image {siteId, filename, base64Data,
// contentType?} — persists an already client-processed image (WebP
// conversion/resizing happens in the browser via Canvas — see
// public/index.html's processImageForWeb) to Firebase Storage. Namespaced
// by siteId + a timestamp so re-uploads of a same-named file never collide.

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const { siteId, filename, base64Data, contentType } = body;
  if (!siteId || !filename || !base64Data) return json({ error: "siteId, filename, and base64Data are required" }, 400);

  try {
    const safeName = String(filename).replace(/[^a-zA-Z0-9._-]/g, "-");
    const path = `page-publisher-images/${siteId}/${Date.now()}-${safeName}`;
    const url = await uploadPageImage(path, base64Data, contentType || "image/webp");
    return json({ ok: true, url });
  } catch (e: any) {
    return json({ error: `Upload failed: ${String(e?.message || e)}` }, 500);
  }
};

export const config: Config = { path: "/api/page-publisher-upload-image" };
