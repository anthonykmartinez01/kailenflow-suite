// Shared auth helper for DataForSEO's SERP API (HTTP Basic Auth, login:password).
export function dataForSeoHeaders(): { Authorization: string; "content-type": string } | null {
  const login = Netlify.env.get("DATAFORSEO_LOGIN");
  const password = Netlify.env.get("DATAFORSEO_PASSWORD");
  if (!login || !password) return null;
  return {
    Authorization: "Basic " + Buffer.from(`${login}:${password}`).toString("base64"),
    "content-type": "application/json",
  };
}
