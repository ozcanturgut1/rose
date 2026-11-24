import { onRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { ensureAdmin } from "./adminInit.js";
ensureAdmin();

import { requireAuth } from "./requireAuth.js";
import { faturaNihaiEkranda, normBirim, vknKaynaklari } from "./nihaiEkranKriteri.js";
import { hedefSubeBirimi } from "./subeAciklamaAtama.js";
import { okuSatirSonAlimFiyatlari } from "./etaInvoiceSync.js";

const db = getFirestore();

const setCors = (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

function docIdAl(raw) {
  const id = String(raw || "").trim();
  if (!id.startsWith("invoice_") || id.length > 200) return "";
  if (/[/\s]/.test(id)) return "";
  return id;
}

/**
 * Sinan'ın onaylayacağı faturanın her kalemi için, varsa son alım birim fiyatı.
 * Yalnızca okur. ETA'ya ve Firestore'a yazmaz.
 * POST { docId } — Authorization: Bearer idToken
 */
export const sonAlimFiyatlari = onRequest(
  { region: "europe-west1", timeoutSeconds: 120, memory: "512MiB" },
  async (req, res) => {
    try {
      setCors(req, res);
      if (req.method === "OPTIONS") return res.status(204).send("");
      if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

      const user = await requireAuth(req);
      const prof = await db.collection("user_profiles").doc(user.uid).get();
      const birim = String(prof.data()?.birim || "").trim();
      if (!prof.exists || normBirim(birim) !== "sinan") {
        return res.status(403).json({ error: "Yalnızca Sinan kullanabilir" });
      }

      const docId = docIdAl(req.body?.docId);
      if (!docId) return res.status(400).json({ error: "docId geçersiz" });

      const inv = await db.collection("qnb_invoices").doc(docId).get();
      if (!inv.exists) return res.status(404).json({ error: "Fatura bulunamadı" });
      const data = inv.data() || {};

      let vkns = new Set();
      if (birim) {
        const sup = await db.collection("suppliers").doc(birim).get();
        if (sup.exists) vkns = vknKaynaklari(sup.data() || {}).digits;
      }
      const sube = await hedefSubeBirimi(db, data);
      const gorebilir = faturaNihaiEkranda(
        data,
        { uid: user.uid, birimNorm: "sinan", vkns },
        sube
      );
      if (!gorebilir) return res.status(200).json({ satirlar: [] });

      const satirlar = await okuSatirSonAlimFiyatlari(data);
      return res.status(200).json({ satirlar });
    } catch (e) {
      console.error("sonAlimFiyatlari", e);
      const status = e?.status && Number(e.status) >= 400 && Number(e.status) < 500 ? Number(e.status) : 500;
      const msg = status < 500 ? String(e?.message || e) : "Son alım fiyatı okunamadı";
      return res.status(status).json({ error: msg });
    }
  }
);
