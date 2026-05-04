import { onRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { ensureAdmin } from "./adminInit.js";
ensureAdmin();

import { requireAuth, requireRole, ROLES_QNB_MUTATE } from "./requireAuth.js";

const db = getFirestore();

/** @param {string} uid */
async function yazarGorunenAd(uid) {
  try {
    const u = await getAuth().getUser(uid);
    const n = u.displayName && String(u.displayName).trim();
    if (n) return n;
    const e = u.email && String(u.email).trim();
    if (e) return e;
  } catch (_) {
    /* ignore */
  }
  const p = await db.collection("user_profiles").doc(uid).get();
  if (p.exists) {
    const d = p.data() || {};
    const ad =
      (d.displayName && String(d.displayName).trim()) ||
      (d.name && String(d.name).trim()) ||
      (d.fullName && String(d.fullName).trim());
    if (ad) return ad;
  }
  return uid;
}

/** @param {string | undefined} raw */
function normalizeProfileRole(raw) {
  if (raw == null) return "";
  return String(raw).trim().toLowerCase().replace(/\s+/g, "_");
}

/** @param {string} uid */
async function getProfileRoleNormalized(uid) {
  const p = await db.collection("user_profiles").doc(uid).get();
  if (!p.exists) return "";
  return normalizeProfileRole(p.data()?.role);
}

/** Ara/nihai onay (user_profiles) veya eski users.roles. */
async function requireInvoiceOnayPermission(uid) {
  const p = await db.collection("user_profiles").doc(uid).get();
  if (p.exists) {
    const r = normalizeProfileRole(p.data()?.role);
    if (["admin", "ara_onay", "nihai_onay", "muhasebe"].includes(r)) return;
  }
  await requireRole(uid, ROLES_QNB_MUTATE);
}

const setCors = (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

/**
 * qnb_invoices/{invoice_*} belgesine yönetim onayı / red / araya sunma kaydı yazar (portal yok).
 * POST JSON: { docId, decision, note?, aciklamaRole?: "ara_onay" | "nihai_onay" | "muhasebe" | "admin" }
 * Açıklama: ara / nihai / muhasebe ayrı alanlar; admin → onayAciklama
 * Firestore onayDurumu: onaylandı | reddedildi | onaya sunuldu
 * Red (ara/nihai): `reddedenRol` (`ara_onay` | `nihai_onay`), `reddedenUid`
 */
export const updateQnbInvoiceYonetimOnay = onRequest({ region: "europe-west1" }, async (req, res) => {
  try {
    setCors(req, res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const user = await requireAuth(req);
    await requireInvoiceOnayPermission(user.uid);

    const body = typeof req.body === "object" && req.body ? req.body : {};
    const docId = body.docId != null ? String(body.docId).trim() : "";
    const decision = body.decision != null ? String(body.decision).trim() : "";
    const noteRaw = body.note != null ? String(body.note).trim() : "";
    const aciklamaRole =
      body.aciklamaRole != null ? normalizeProfileRole(String(body.aciklamaRole)) : "";

    /** API kararı → qnb_invoices.onayDurumu alanı */
    const onayDurumuByDecision = {
      onaylandı: "onaylandı",
      reddedildi: "reddedildi",
      onaya_sunuldu: "onaya sunuldu",
    };

    if (!docId.startsWith("invoice_")) {
      return res.status(400).json({ error: "docId must start with invoice_" });
    }
    if (!Object.prototype.hasOwnProperty.call(onayDurumuByDecision, decision)) {
      return res.status(400).json({
        error: 'decision must be "onaylandı", "reddedildi", or "onaya_sunuldu"',
      });
    }
    const onayDurumu = onayDurumuByDecision[decision];

    const ref = db.collection("qnb_invoices").doc(docId);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ error: "Invoice document not found" });
    }
    const data = snap.data() || {};
    if (String(data.type) !== "invoice") {
      return res.status(400).json({ error: "Document is not type=invoice" });
    }

    /** @type {Record<string, unknown>} */
    const patch = {
      onayDurumu,
      onayTarihi: FieldValue.serverTimestamp(),
      onaylayanUid: user.uid,
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (noteRaw) {
      const yazarAd = await yazarGorunenAd(user.uid);
      if (aciklamaRole === "ara_onay") {
        patch.onayAciklamaAraOnay = noteRaw;
        patch.onayAciklamaAraOnayYazanAd = yazarAd;
      } else if (aciklamaRole === "nihai_onay") {
        patch.onayAciklamaNihaiOnay = noteRaw;
        patch.onayAciklamaNihaiOnayYazanAd = yazarAd;
      } else if (aciklamaRole === "muhasebe") {
        patch.onayAciklamaMuhasebe = noteRaw;
        patch.onayAciklamaMuhasebeYazanAd = yazarAd;
      } else {
        patch.onayAciklama = noteRaw;
        patch.onayAciklamaYazanAd = yazarAd;
      }
    }

    if (onayDurumu === "reddedildi") {
      const profRol = await getProfileRoleNormalized(user.uid);
      if (profRol === "ara_onay" || profRol === "nihai_onay") {
        patch.reddedenRol = profRol;
        patch.reddedenUid = user.uid;
      }
    }

    await ref.set(patch, { merge: true });

    return res.status(200).json({ success: true, docId, onayDurumu });
  } catch (e) {
    const status = e?.status && Number(e.status) >= 400 ? Number(e.status) : 500;
    return res.status(status).json({ error: String(e?.message || e) });
  }
});
