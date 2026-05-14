import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { ensureAdmin } from "./adminInit.js";
ensureAdmin();

import admin from "firebase-admin";

const db = getFirestore();

/** Liste / okuma uçları (ör. son faturalar, depo dahil). */
export const ROLES_QNB_READ = [
  "admin",
  "manager",
  "accounting",
  "ara_onay",
  "nihai_onay",
  "muhasebe",
  "depo",
];

/** Senkron, backfill, onay, zenginleştirme (depo hariç). */
export const ROLES_QNB_MUTATE = [
  "admin",
  "manager",
  "accounting",
  "ara_onay",
  "nihai_onay",
  "muhasebe",
];

function normalizeProfileRole(raw) {
  if (raw == null || typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase().replace(/\s+/g, "_");
  return s || null;
}

/**
 * Etkin rol listesi: önce Firestore `user_profiles/{uid}.role` (uygulama ve konsol ile aynı),
 * boşsa `users/{uid}.roles`, ikisi de yoksa `manager` (geriye uyum).
 */
export async function getRoleSlugsForUser(uid) {
  const prof = await db.collection("user_profiles").doc(uid).get();
  if (prof.exists) {
    const one = normalizeProfileRole(prof.data()?.role);
    if (one) return [one];
  }
  const snap = await db.collection("users").doc(uid).get();
  const userDoc = snap.exists ? snap.data() : null;
  if (userDoc?.roles && Array.isArray(userDoc.roles) && userDoc.roles.length) {
    return userDoc.roles.map((r) => String(r).toLowerCase());
  }
  return ["manager"];
}

export async function requireAuth(req) {
  const authHeader =
  req.get("authorization") ||
  req.get("Authorization") ||
  req.get("x-forwarded-authorization") ||
  req.get("X-Forwarded-Authorization") ||
  req.headers.authorization ||
  req.headers["x-forwarded-authorization"];

const match = (authHeader || "").match(/^Bearer\s+(.+)$/i);
const idToken = match ? match[1] : null;

if (!idToken) {
  const err = new Error("UNAUTHENTICATED: MISSING_BEARER");
  err.status = 401;
  throw err;
}

  
let decoded;
try {
  decoded = await admin.auth().verifyIdToken(idToken);
} catch (e) {
  const err = new Error("UNAUTHENTICATED: VERIFY_FAILED: " + (e?.message || e));
  err.status = 401;
  throw err;
}
decoded.isSuperAdmin =
  process.env.SUPER_ADMIN_UID &&
  decoded.uid === process.env.SUPER_ADMIN_UID;
return decoded;
}

export async function requireRole(uid, allowedRoles = []) {
  console.log(
    "requireRole uid=",
    uid,
    "SUPER_ADMIN_UID=",
    process.env.SUPER_ADMIN_UID,
    "allowed=",
    allowedRoles
  );

  if (process.env.SUPER_ADMIN_UID && uid === process.env.SUPER_ADMIN_UID) {
    return true;
  }

  const roles = await getRoleSlugsForUser(uid);
  const allowedNorm = allowedRoles.map((r) => String(r).toLowerCase());
  const ok =
    allowedRoles.length === 0 ||
    roles.some((r) => allowedNorm.includes(String(r).toLowerCase()));

  if (!ok) {
    const err = new Error("PERMISSION_DENIED");
    err.status = 403;
    throw err;
  }

  return true;
}
