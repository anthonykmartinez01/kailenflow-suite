// FIXTURE — not shipped code. The correct shape: the host appears, the URL is
// still built from variables, but the call goes through the shared guard. The
// scan must NOT flag this, or it would be crying wolf and people would start
// suppressing it.
import { gbpRead } from "../../netlify/shared/gbp-guard.mts";

export async function listLocations(accountName: string, token: string) {
  const url = `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title`;
  const r = await gbpRead(url, token);
  return r.json();
}
