import type { Context, Config } from "@netlify/functions";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

// Review-request funnel for ONE client's GoHighLevel sub-account, sourced
// from their "Review Pipeline" (a template cloned into every client's GHL —
// same stage names everywhere: "Review Requested" → "Review Link Clicked",
// plus the opportunity's built-in status for "won" = left a review).
//
// Each opportunity's timestamps map directly onto the funnel:
//   createdAt          → the review request went out (opportunity is
//                         created the moment the automation fires)
//   lastStageChangeAt  → when it moved into "Review Link Clicked"
//   lastStatusChangeAt → when it was marked "won" (review left)
// This avoids the drift you'd get from tag-based counting (tags carry no
// per-application timestamp) — these are real GHL-tracked event times.
//
// Same per-client credential requirement as ghl-leads: needs a per-client
// Private Integration token (client.ghlPrivateToken) with "View Opportunities"
// scope, passed in the request body. Falls back to the agency-wide
// GHL_API_TOKEN only as a last resort.

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

function norm(s: string): string {
  return (s || "").toLowerCase().trim();
}

export default async (req: Request, _ctx: Context) => {
  if (!(await isAuthed(req))) return unauthorized();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const locationId: string = (body.locationId || "").toString().trim();
  if (!locationId) return json({ error: "Missing locationId" }, 400);

  const token: string = (body.token || "").toString().trim() || Netlify.env.get("GHL_API_TOKEN") || "";
  if (!token) return json({ error: "No GHL Private Integration token set for this client, and no fallback GHL_API_TOKEN configured on the server." }, 500);

  const months = Math.max(1, Math.min(12, Number(body.months) || 4));
  const end = new Date();
  const headers = { Authorization: `Bearer ${token}`, Version: GHL_VERSION, Accept: "application/json" };

  async function ghlGet(url: string) {
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`GHL ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }

  try {
    // 1) Find the Review Pipeline by its stage names, not its display name
    //    (some clients have it prefixed "(Don't Touch) Review Pipeline" —
    //    the stage names are the stable part since the automation is cloned
    //    from one template).
    const pipelinesRes = await ghlGet(`${GHL_BASE}/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`);
    const pipelines: any[] = pipelinesRes.pipelines || [];
    let pipeline: any = null, requestedStageId = "", clickedStageId = "";
    for (const p of pipelines) {
      const stages: any[] = p.stages || [];
      const req = stages.find((s) => norm(s.name) === "review requested");
      const clk = stages.find((s) => norm(s.name) === "review link clicked");
      if (req && clk) { pipeline = p; requestedStageId = req.id; clickedStageId = clk.id; break; }
    }
    if (!pipeline) {
      return json({ error: "No \"Review Pipeline\" found for this client (looked for stages named \"Review Requested\" and \"Review Link Clicked\")." }, 404);
    }

    // 2) Pull every opportunity in that pipeline — paginated, cursor-based
    //    (same shape as the conversations search paging used elsewhere).
    const opportunities: any[] = [];
    let startAfter = "", startAfterId = "", pages = 0;
    while (pages++ < 40) {
      const cursor = startAfter ? `&startAfter=${startAfter}&startAfterId=${startAfterId}` : "";
      const r = await ghlGet(`${GHL_BASE}/opportunities/search?location_id=${encodeURIComponent(locationId)}&pipeline_id=${encodeURIComponent(pipeline.id)}&limit=100${cursor}`);
      const batch: any[] = r.opportunities || [];
      if (!batch.length) break;
      opportunities.push(...batch);
      if (batch.length < 100) break;
      const last = batch[batch.length - 1];
      const sort = last.sort || [];
      startAfter = String(sort[0] ?? "");
      startAfterId = String(sort[1] ?? last.id ?? "");
    }

    // 3) Bucket into YYYY-MM counts across the requested month range.
    const monthKeys: string[] = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(end.getFullYear(), end.getMonth() - i, 1);
      monthKeys.push(d.toISOString().slice(0, 7));
    }
    const empty = () => Object.fromEntries(monthKeys.map((k) => [k, 0])) as Record<string, number>;
    const requested = empty(), clicked = empty(), won = empty();

    for (const o of opportunities) {
      const reqKey = o.createdAt ? new Date(o.createdAt).toISOString().slice(0, 7) : "";
      if (reqKey in requested) requested[reqKey]++;

      if (o.pipelineStageId === clickedStageId && o.lastStageChangeAt) {
        const clkKey = new Date(o.lastStageChangeAt).toISOString().slice(0, 7);
        if (clkKey in clicked) clicked[clkKey]++;
      }

      if (o.status === "won" && o.lastStatusChangeAt) {
        const wonKey = new Date(o.lastStatusChangeAt).toISOString().slice(0, 7);
        if (wonKey in won) won[wonKey]++;
      }
    }

    const monthly = monthKeys.map((month) => ({ month, requested: requested[month], clicked: clicked[month], won: won[month] }));
    const currentMonth = monthly[monthly.length - 1] || { requested: 0, clicked: 0, won: 0 };
    const previousMonth = monthly[monthly.length - 2] || { requested: 0, clicked: 0, won: 0 };
    const pctChange = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : (cur > 0 ? 100 : 0));

    return json({
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      totalOpportunities: opportunities.length,
      monthly,
      currentMonth,
      previousMonth,
      changePct: {
        requested: pctChange(currentMonth.requested, previousMonth.requested),
        clicked: pctChange(currentMonth.clicked, previousMonth.clicked),
        won: pctChange(currentMonth.won, previousMonth.won),
      },
    });
  } catch (e: any) {
    return json({ error: "Couldn't reach GoHighLevel.", detail: String(e?.message || e) }, 502);
  }
};

export const config: Config = { path: "/api/ghl-review-funnel" };
