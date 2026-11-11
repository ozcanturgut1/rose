import { onRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { ensureAdmin } from "./adminInit.js";
ensureAdmin();

import { requireAuth } from "./requireAuth.js";
import { YONLENDIRME_HEDEF_ROLLER } from "./listAraOnayUsers.js";
import { onayZinciriEkle } from "./updateQnbInvoiceYonetimOnay.js";

const db = getFirestore();

const setCors = (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

/** @param {string | undefined} raw */
function normalizeProfileRole(raw) {
  if (raw == null) return "";
  return String(raw).trim().toLowerCase().replace(/\s+/g, "_");
}

/**
 * Çağıran ara onay olmalı; profil verisi (`birim` için) döner.
 * @param {string} uid
 */
async function requireAraOnayProfile(uid) {
  const p = await db.collection("user_profiles").doc(uid).get();
  if (!p.exists) {
    const err = new Error("Profil bulunamadı");
    // @ts-ignore
    err.status = 403;
    throw err;
  }
  const data = p.data() || {};
  const r = normalizeProfileRole(data.role);
  if (r !== "ara_onay") {
    const err = new Error("Yalnızca ara onay kullanıcıları yönlendirebilir");
    // @ts-ignore
    err.status = 403;
    throw err;
  }
  return data;
}

/** @param {string} uid */
async function getProfileRoleNormalized(uid) {
  const p = await db.collection("user_profiles").doc(uid).get();
  if (!p.exists) return "";
  return normalizeProfileRole(p.data()?.role);
}

/**
 * Ara onay kullanıcısı, bekleyen faturayı başka bir onay kullanıcısına yönlendirir.
 * POST JSON: { docId, targetUid }
 * - Hedef rolü [YONLENDIRME_HEDEF_ROLLER] içinde olmalı (`listAraOnayUsers` ile aynı küme).
 * - Hedef `ara_onay` / `ikinci_ara_onay` (Erdem): `araOnayAtananUid` = hedef uid; fatura ara kuyrukta kalır.
 * - Hedef `nihai_onay` (Sinan, Yasin): `updateQnbInvoiceYonetimOnay` içindeki Erdem → Sinan yazımıyla aynı;
 *   `onayDurumu` = `onaya sunuldu`, `nihaiOnayAtananUid` = hedef uid, `onayaSunanUid/Birim` = çağıran.
 * - Atanmamışsa herhangi bir ara onay yönlendirebilir; başka birine atanmışsa yalnızca o kullanıcı
 *   yeniden yönlendirebilir. `onayDurumu` dolu fatura yönlendirilemez.
 */
export const assignQnbInvoiceAraOnay = onRequest({ region: "europe-west1" }, async (req, res) => {
  try {
    setCors(req, res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const user = await requireAuth(req);
    const callerData = await requireAraOnayProfile(user.uid);

    const body = typeof req.body === "object" && req.body ? req.body : {};
    const docId = body.docId != null ? String(body.docId).trim() : "";
    const targetUid = body.targetUid != null ? String(body.targetUid).trim() : "";

    if (!docId.startsWith("invoice_")) {
      return res.status(400).json({ error: "docId must start with invoice_" });
    }
    if (!targetUid) {
      return res.status(400).json({ error: "targetUid is required" });
    }
    if (targetUid === user.uid) {
      return res.status(400).json({ error: "Kendinize yönlendiremezsiniz" });
    }

    const targetRole = await getProfileRoleNormalized(targetUid);
    if (!YONLENDIRME_HEDEF_ROLLER.has(targetRole)) {
      return res.status(400).json({ error: "Hedef kullanıcı yönlendirilebilir bir rolde değil" });
    }

    const ref = db.collection("qnb_invoices").doc(docId);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ error: "Invoice document not found" });
    }
    const data = snap.data() || {};
    if (String(data.type) !== "invoice") {
      return res.status(400).json({ error: "Document is not type=invoice" });
    }

    const onay = String(data.onayDurumu || "").trim();
    if (onay.length > 0) {
      return res.status(409).json({ error: "Yalnızca onay bekleyen (onayDurumu boş) faturalar yönlendirilebilir" });
    }

    const currentAssigned = String(data.araOnayAtananUid || "").trim();

    const mayAssign =
      !currentAssigned || currentAssigned === user.uid;

    if (!mayAssign) {
      return res.status(403).json({ error: "Bu faturayı yönlendirme yetkiniz yok" });
    }

    /** @type {Record<string, unknown>} */
    const patch = {
      araOnayYonlendirenUid: user.uid,
      araOnayYonlendirildiAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    let yeniOnayDurumu = onay;
    if (targetRole === "nihai_onay") {
      // Erdem'in "Onaya Sun"u ile aynı: fatura ara kuyruktan çıkar, hedefin nihai kuyruğuna düşer.
      yeniOnayDurumu = "onaya sunuldu";
      patch.onayDurumu = yeniOnayDurumu;
      patch.onayTarihi = FieldValue.serverTimestamp();
      patch.onaylayanUid = user.uid;
      patch.nihaiOnayAtananUid = targetUid;
      patch.onayaSunanUid = user.uid;
      const callerBirim = String(callerData.birim || "").trim();
      if (callerBirim) patch.onayaSunanBirim = callerBirim;
      Object.assign(patch, onayZinciriEkle(data, user.uid, callerData, "onaya_sundu"));
    } else {
      patch.araOnayAtananUid = targetUid;
    }

    await ref.set(patch, { merge: true });

    return res.status(200).json({ success: true, docId, targetUid, targetRole, onayDurumu: yeniOnayDurumu });
  } catch (e) {
    const status = e?.status && Number(e.status) >= 400 ? Number(e.status) : 500;
    return res.status(status).json({ error: String(e?.message || e) });
  }
});
