import { gbpRead } from "./gbp-guard.mts";

// Every Business Profile location the RANK-AND-RENT Google account can see.
// Read-only: every call is a GET through gbpRead() (the write guard).
// Shared by gbp-portfolio (picker + report) and portfolio-reviews (which needs
// each selected listing's placeId to scan public review counts).

const ACCOUNTS_API = "https://mybusinessaccountmanagement.googleapis.com/v1";
const INFO_API = "https://mybusinessbusinessinformation.googleapis.com/v1";

export type Loc = { id: string; title: string; city: string; placeId: string | null };

async function readJson(url: string, token: string): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await gbpRead(url, token);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

export async function allLocations(token: string): Promise<{ ok: true; locations: Loc[] } | { ok: false; status: number; message: string }> {
  const accounts: any[] = [];
  let acctToken = "";
  do {
    const accts = await readJson(`${ACCOUNTS_API}/accounts?pageSize=20${acctToken ? `&pageToken=${encodeURIComponent(acctToken)}` : ""}`, token);
    if (!accts.ok) {
      if (!accounts.length) return { ok: false, status: accts.status, message: accts.body?.error?.message || `HTTP ${accts.status}` };
      break;
    }
    accounts.push(...(accts.body.accounts || []));
    acctToken = accts.body.nextPageToken || "";
  } while (acctToken);

  const seen = new Set<string>();
  const locations: Loc[] = [];
  for (const a of accounts) {
    let pageToken = "";
    do {
      const url = `${INFO_API}/${a.name}/locations?readMask=name,title,storefrontAddress,metadata&pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
      const r = await readJson(url, token);
      if (!r.ok) break; // one inaccessible account shouldn't blank the list
      for (const l of r.body.locations || []) {
        const id = String(l.name || "").replace(/^locations\//, "");
        // The same listing can appear under a personal account AND a location
        // group — list it once so it can't be counted twice.
        if (!id || seen.has(id)) continue;
        seen.add(id);
        locations.push({
          id,
          title: l.title || l.name,
          city: [l.storefrontAddress?.locality, l.storefrontAddress?.administrativeArea].filter(Boolean).join(", "),
          placeId: l.metadata?.placeId || null,
        });
      }
      pageToken = r.body.nextPageToken || "";
    } while (pageToken);
  }
  locations.sort((a, b) => a.title.localeCompare(b.title));
  return { ok: true, locations };
}
