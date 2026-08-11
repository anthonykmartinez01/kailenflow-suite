// Server-side Firestore access (the app itself only ever writes from the
// browser via the client SDK — this is the one place that writes without a
// human having the app open, needed for anything that must run on a true
// schedule rather than "next time someone opens the app"). Mirrors the
// exact document shape the client uses (public/index.html's saveData()):
// appData/main, single doc, whole app state as a JSON string in `json`.
import admin from "firebase-admin";

let app: admin.app.App | null = null;

function getApp(): admin.app.App {
  if (app) return app;
  const raw = Netlify.env.get("FIREBASE_SERVICE_ACCOUNT");
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not configured on the server");
  const serviceAccount = JSON.parse(raw);
  app = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return app;
}

export async function readAppData(): Promise<any> {
  const db = admin.firestore(getApp());
  const snap = await db.collection("appData").doc("main").get();
  if (!snap.exists) throw new Error("appData/main document does not exist");
  const raw = snap.data()!.json;
  if (!raw) throw new Error("appData/main has no json field");
  return JSON.parse(raw);
}

// Same write shape as the client's saveData() — writeId is prefixed "server_"
// so it's identifiable in logs, but the client's echo-detection only compares
// against IDs it generated itself, so this is treated as a normal external
// write (which is correct — the client SHOULD pick it up and re-render).
//
// ⚠️ DO NOT use readAppData → (slow external calls) → writeAppData in a cron.
// That pattern silently erases anything saved from a browser during the
// window — observed live 2026-07-14: a re-picked business match and a
// just-generated heat map both vanished when run-scheduled-heatmaps wrote
// back its minutes-old copy. Use mutateAppData below instead.
export async function writeAppData(data: any): Promise<void> {
  const db = admin.firestore(getApp());
  const writeId = "server_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
  await db.collection("appData").doc("main").set({
    json: JSON.stringify(data),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    savedAt: new Date().toISOString(),
    writeId,
  });
}

// Read-modify-write the app document ATOMICALLY. The mutator receives the
// freshest committed data (re-read inside a Firestore transaction, which
// auto-retries if the document changes before commit — e.g. a browser save
// landing mid-write) and must be a pure, fast, re-runnable function: no
// network calls inside. Do all external work FIRST, collect the resulting
// deltas, then apply them here. Return false from the mutator to skip the
// write entirely (nothing to change).
export async function mutateAppData(mutator: (data: any) => boolean | void): Promise<void> {
  const db = admin.firestore(getApp());
  const ref = db.collection("appData").doc("main");
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new Error("appData/main document does not exist");
    const raw = snap.data()!.json;
    if (!raw) throw new Error("appData/main has no json field");
    const data = JSON.parse(raw);
    if (mutator(data) === false) return;
    const writeId = "server_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
    t.set(ref, {
      json: JSON.stringify(data),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      savedAt: new Date().toISOString(),
      writeId,
    });
  });
}

// Rank map grids get their OWN document per map, in their OWN collection —
// the structural fix for the recurring 1MiB appData/main crisis (hit
// 2026-07-14, 2026-07-15, 2026-07-17). Each map's own per-point grid
// (15-24KB) plus its top competitors' per-point grids (up to
// COMPETITOR_GRID_LIMIT=8 more, same size each) used to live INSIDE
// appData/main, where they were the single biggest driver of that doc
// filling up — forcing repeated "delete older maps' detail" pruning just to
// stay under Firestore's 1MiB-per-document ceiling. A single rank-map-grid
// document here (grid + up to 8 competitor grids) tops out around
// 200-500KB even for a large grid — nowhere near any Firestore limit — and
// EVERY map gets its own document, so there is no shared ceiling to hit at
// all. appData/main only ever holds the lightweight summary fields
// (avgRank, solv, snapshotDate, keyword, etc.) plus `hasGridDoc:true`
// pointing here — nothing ever needs to be pruned again.
export async function saveRankMapGrid(mapId: string, payload: { grid: any[]; competitorGrids: Record<string, any[]> }): Promise<void> {
  const db = admin.firestore(getApp());
  await db.collection("rankMapGrids").doc(mapId).set({
    grid: payload.grid || [],
    competitorGrids: payload.competitorGrids || {},
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

export async function getRankMapGrid(mapId: string): Promise<{ grid: any[]; competitorGrids: Record<string, any[]> } | null> {
  const db = admin.firestore(getApp());
  const snap = await db.collection("rankMapGrids").doc(mapId).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  return { grid: data.grid || [], competitorGrids: data.competitorGrids || {} };
}

export async function deleteRankMapGrid(mapId: string): Promise<void> {
  const db = admin.firestore(getApp());
  await db.collection("rankMapGrids").doc(mapId).delete();
}
