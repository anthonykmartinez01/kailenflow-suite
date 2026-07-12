import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();

  const store = getStore("indexing-log");
  const entries = ((await store.get("entries", { type: "json" })) as any[] | null) || [];

  return json({ entries });
};

export const config: Config = { path: "/api/indexing-log" };
