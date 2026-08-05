// FIXTURE — not shipped code. This is the exact pattern that slipped past the
// first version of the bypass scan: the Business Profile host is inside a
// template literal with an interpolated segment, and the fetch() call site
// itself mentions only a local variable. A scan that inspects the text around
// `fetch(` cannot see the host here.
export async function listLocations(accountName: string, token: string) {
  const out: any[] = [];
  let pageToken = "";
  do {
    const url = `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title&pageSize=100${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const b: any = await r.json();
    out.push(...(b.locations || []));
    pageToken = b.nextPageToken || "";
  } while (pageToken);
  return out;
}
