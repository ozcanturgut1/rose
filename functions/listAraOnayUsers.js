import { onRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { ensureAdmin } from "./adminInit.js";
ensureAdmin();

import { requireAuth } from "./requireAuth.js";

const db = getFirestore();

const setCors = (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

/** @param {string | undefined} raw */
function normalizeProfileRole(raw) {
  if (raw == null) return "";
  return String(raw).trim().toLowerCase().replace(/\s+/g, "_");
}

/**
 * Manuel yönlendirme hedefi olabilen roller: ara onay, Erdem (`ikinci_ara_onay`)
 * ve nihai onay (Sinan, Yasin). `assignQnbInvoiceAraOnay` aynı kümeyi doğrular.
 */
export const YONLENDIRME_HEDEF_ROLLER = new Set(["ara_onay", "ikinci_ara_onay", "nihai_onay"]);

/** @param {string} uid */
async function requireYonlendirmeListeleyebilir(uid) {
  const p = await db.collection("user_profiles").doc(uid).get();
  if (!p.exists) {
    const err = new Error("Profil bulunamadı");
    // @ts-ignore
    err.status = 403;
    throw err;
  }
  const r = normalizeProfileRole(p.data()?.role);
  if (r !== "ara_onay" && r !== "muhasebe") {
    const err = new Error("Yalnızca ara onay veya muhasebe kullanıcıları listeleyebilir");
    // @ts-ignore
    err.status = 403;
    throw err;
  }
}

/**
 * Yönlendirme hedefi seçimi: `user_profiles` içinde rolü [YONLENDIRME_HEDEF_ROLLER]
 * kümesinde olanlar (`birim` dahil). Ara onay ve muhasebe listeleyebilir.
 * GET — Authorization: Bearer idToken
 */
export const listAraOnayUsers = onRequest({ region: "europe-west1" }, async (req, res) => {
  try {
    setCors(req, res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

    const user = await requireAuth(req);
    await requireYonlendirmeListeleyebilir(user.uid);

    const snap = await db.collection("user_profiles").get();
    /** @type {{ uid: string; label: string; birim: string }[]} */
    const out = [];
    for (const doc of snap.docs) {
      const d = doc.data() || {};
      if (!YONLENDIRME_HEDEF_ROLLER.has(normalizeProfileRole(d.role))) continue;
      const uid = doc.id;
      const label =
        String(d.displayName || d.name || d.fullName || d.email || "").trim();
      const birim = String(d.birim || "").trim();
      out.push({ uid, label, birim });
    }
    out.sort((a, b) => {
      const byBirim = a.birim.localeCompare(b.birim, "tr");
      if (byBirim !== 0) return byBirim;
      const byLabel = a.label.localeCompare(b.label, "tr");
      if (byLabel !== 0) return byLabel;
      return a.uid.localeCompare(b.uid);
    });
    return res.status(200).json(out);
  } catch (e) {
    const status = e?.status && Number(e.status) >= 400 ? Number(e.status) : 500;
    return res.status(status).json({ error: String(e?.message || e) });
  }
});
