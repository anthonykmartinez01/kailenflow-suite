import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { isAuthed } from "../../shared/auth.mts";
import { analyzeCall } from "../../shared/analyze.mts";

// Background function ("-background" suffix → Netlify runs it async, up to 15 min,
// so even very long recordings never hit the normal request time limit). It
// writes the outcome to Netlify Blobs; the page polls /api/call-coach?result=<id>.
export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return; // 202 already returned to the caller

  const body = await req.json().catch(() => ({} as any));
  const messageId = (body.messageId || "").toString();
  if (!messageId) return;

  const store = getStore("callcoach");
  const key = `a:${messageId}`;
  try {
    await store.setJSON(key, { status: "pending", at: Date.now() });
    const result = await analyzeCall(messageId);
    if (result && result.error) await store.setJSON(key, { status: "error", error: result.error, at: Date.now() });
    else await store.setJSON(key, { status: "done", result, at: Date.now() });
  } catch (e: any) {
    await store.setJSON(key, { status: "error", error: "Analysis failed: " + String(e?.message ?? e), at: Date.now() });
  }
};
