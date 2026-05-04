import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { ensureAdmin } from "./adminInit.js";
ensureAdmin();

import admin from "firebase-admin";

const db = getFirestore();

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

  const snap = await db.collection("users").doc(uid).get();
  const userDoc = snap.exists ? snap.data() : null;

  const roles =
    userDoc?.roles && Array.isArray(userDoc.roles) && userDoc.roles.length
      ? userDoc.roles
      : ["manager"]; // DEFAULT

  const ok =
    allowedRoles.length === 0 || roles.some((r) => allowedRoles.includes(r));

  if (!ok) {
    const err = new Error("PERMISSION_DENIED");
    err.status = 403;
    throw err;
  }

  return true;
}
