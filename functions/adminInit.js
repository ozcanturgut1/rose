import { initializeApp, getApps } from "firebase-admin/app";

export function ensureAdmin() {
  if (!getApps().length) initializeApp();
}
