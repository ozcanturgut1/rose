import { onRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { ensureAdmin } from "./adminInit.js";
ensureAdmin();

import { requireAuth } from "./requireAuth.js";
import { archiveCompletedInvoice } from "./archiveCompletedInvoice.js";

const db = getFirestore();

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("ı", "i");
}

/** @param {string | undefined} raw */
function normalizeProfileRole(raw) {
  if (raw == null) return "";
  return String(raw).trim().toLowerCase().replace(/\s+/g, "_");
}

/** Arşive taşıma yalnızca muhasebe (ve admin) rolünde. */
async function requireInvoiceArsivPermission(uid) {
  if (process.env.SUPER_ADMIN_UID && uid === process.env.SUPER_ADMIN_UID) return;
  const p = await db.collection("user_profiles").doc(uid).get();
  const r = p.exists ? normalizeProfileRole(p.data()?.role) : "";
  if (r === "muhasebe" || r === "admin") return;
  const err = new Error("PERMISSION_DENIED");
  err.status = 403;
  throw err;
}

const setCors = (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

/**
 * Muhasebe kontrolü sonrası faturayı (ve ilgili irsaliyeleri) arşive taşır.
 *
 * Nihai onay sonrası ETA kaydı yapılır ancak arşivleme otomatik değildir; fatura
 * `arsivDurumu == "arsiv_bekliyor"` ile muhasebe listesinde bekler. Bu uç, muhasebe
 * kullanıcısının "Arşive Taşı" aksiyonuyla çağrılır.
 *
 * POST JSON: { docId }
 */
export const archiveQnbInvoice = onRequest({ region: "europe-west1" }, async (req, res) => {
  try {
    setCors(req, res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const user = await requireAuth(req);
    await requireInvoiceArsivPermission(user.uid);

    const body = typeof req.body === "object" && req.body ? req.body : {};
    const docId = body.docId != null ? String(body.docId).trim() : "";
    if (!docId.startsWith("invoice_")) {
      return res.status(400).json({ error: "docId must start with invoice_" });
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
    if (normalizeStatus(data.onayDurumu) !== "onaylandi") {
      return res.status(409).json({
        error: "Fatura onaylanmadan arşive taşınamaz.",
        onayDurumu: data.onayDurumu || null,
      });
    }
    if (normalizeStatus(data.etaKayitDurumu) !== "tamamlandi") {
      return res.status(409).json({
        error: "ETA fatura kaydı tamamlanmadan arşive taşınamaz.",
        etaKayitDurumu: data.etaKayitDurumu || null,
      });
    }

    // Arşiv kopyasında kimin taşıdığı görünsün diye önce fatura belgesine yazılır.
    await ref.set(
      {
        arsivDurumu: "arsivlendi",
        arsiveTasiyanUid: user.uid,
        arsiveTasimaTarihi: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    let result;
    try {
      result = await archiveCompletedInvoice(docId);
    } catch (archiveErr) {
      // Fatura hâlâ aktif koleksiyonda; muhasebe listesinde beklemeye geri alınır.
      await ref.set({ arsivDurumu: "arsiv_bekliyor" }, { merge: true }).catch(() => {});
      throw archiveErr;
    }
    if (result?.skipped) {
      await ref.set({ arsivDurumu: "arsiv_bekliyor" }, { merge: true }).catch(() => {});
      return res.status(409).json({ error: "Arşivleme yapılamadı.", detail: result });
    }

    return res.status(200).json({ success: true, docId, ...result });
  } catch (e) {
    const status = e?.status && Number(e.status) >= 400 ? Number(e.status) : 500;
    return res.status(status).json({ error: String(e?.message || e) });
  }
});
