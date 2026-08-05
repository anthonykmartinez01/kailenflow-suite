// FIXTURE — not shipped code. Harder variant: the host lives in a constant
// declared far from the call, and the URL is assembled in stages. Nothing on
// or near the fetch() line names Google at all. This is what a "sync hours to
// Google" feature would plausibly look like if someone wrote it without ever
// hearing about the write guard.
const API_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";

function locationUrl(id: string): string {
  const path = ["locations", id].join("/");
  return [API_BASE, path].join("/");
}

export async function updateHours(id: string, token: string, hours: unknown) {
  const target = locationUrl(id);
  return fetch(target, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ regularHours: hours }),
  });
}
