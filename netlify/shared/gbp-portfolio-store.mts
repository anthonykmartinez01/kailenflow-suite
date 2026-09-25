import { getStore } from "@netlify/blobs";

// Wipes GBP Portfolio's saved listing picks and cached reports. Called whenever
// the rank-and-rent Google account is connected or disconnected, so data from
// a PREVIOUS account is never shown for a new one.
export async function clearPortfolioStore(): Promise<void> {
  const store = getStore("gbp-portfolio");
  try {
    const { blobs } = await store.list();
    for (const b of blobs) { try { await store.delete(b.key); } catch { /* fine */ } }
  } catch { /* fine */ }
}
