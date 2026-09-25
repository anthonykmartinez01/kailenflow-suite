// Firebase Storage upload for Page Publisher's image pipeline. WebP
// conversion/resizing happens CLIENT-SIDE (Canvas API, in public/index.html)
// — no server-side image library needed, matches this app's existing
// client-heavy/server-light architecture and avoids a native-binary
// dependency (e.g. sharp) in a Netlify Function. This module only persists
// the already-processed bytes.
//
// Bucket name passed EXPLICITLY to bucket() rather than relying on the
// shared Admin app's default config — confirmed 2026-07-23 that
// firestore-admin.mts (a different module, for the main appData/main doc)
// initializes that same default Admin app with only `credential`, no
// `storageBucket` option, and whichever module's init call runs first in a
// given cold start wins. Passing the bucket name explicitly here sidesteps
// that ordering risk entirely. Bucket name confirmed from the client SDK's
// own firebaseConfig in public/index.html (storageBucket:
// "kailenflow-suite.firebasestorage.app").
import admin from "firebase-admin";
import { getApp } from "./firestore.mts";

const BUCKET_NAME = "kailenflow-suite.firebasestorage.app";

// path should already be a safe, unique storage path (caller's job — see
// page-publisher-upload-image.mts, which namespaces by siteId + timestamp).
// Returns a public URL — made public deliberately: these are website page
// images, meant to be publicly visible on a client's live site regardless
// of which platform ultimately hosts them, not a sensitive asset.
export async function uploadPageImage(path: string, base64Data: string, contentType: string): Promise<string> {
  const bucket = admin.storage(getApp()).bucket(BUCKET_NAME);
  const buffer = Buffer.from(base64Data, "base64");
  const file = bucket.file(path);
  await file.save(buffer, { contentType, resumable: false });
  await file.makePublic();
  return `https://storage.googleapis.com/${BUCKET_NAME}/${path}`;
}

// Cleans up an uploaded file when its page/image record is deleted — takes
// the public URL uploadPageImage() returned (that's what's actually stored
// on PagePublisherImage.uploadedRemoteUrl), not a bare path, since that's
// the only reference the caller has. Silently no-ops on anything that
// isn't one of our own bucket URLs (nothing uploaded yet, or an already-
// removed file) rather than throwing — deleting a page should never fail
// because its image cleanup hit a missing/malformed file.
export async function deletePageImageFile(uploadedRemoteUrl: string | null | undefined): Promise<void> {
  if (!uploadedRemoteUrl) return;
  const prefix = `https://storage.googleapis.com/${BUCKET_NAME}/`;
  if (!uploadedRemoteUrl.startsWith(prefix)) return;
  const path = uploadedRemoteUrl.slice(prefix.length);
  try {
    await admin.storage(getApp()).bucket(BUCKET_NAME).file(path).delete({ ignoreNotFound: true });
  } catch { /* best-effort cleanup — never block a page delete on this */ }
}
