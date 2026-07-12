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
