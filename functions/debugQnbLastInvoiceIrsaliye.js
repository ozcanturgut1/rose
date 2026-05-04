import { onRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { extractRelatedDespatchRefsFromInvoiceUbl } from "./extractRelatedBelgeNos.js";

const db = getFirestore();

const setCors = (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

/**
 * Debug: Portaldaki (Firestore'daki) son faturanın docId, belgeNo ve bu faturaya ait irsaliye numaralarını
 * konsola yazar ve JSON döndürür.
 */
export const debugQnbLastInvoiceIrsaliye = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    try {
      setCors(req, res);
      if (req.method === "OPTIONS") return res.status(204).send("");
      if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

      const snap = await db
        .collection("qnb_invoices")
        .orderBy("updatedAt", "desc")
        .limit(1)
        .get();

      if (snap.empty) {
        console.log("[debugQnbLastInvoiceIrsaliye] Son fatura bulunamadı.");
        return res.status(200).json({
          ok: false,
          message: "Son fatura bulunamadı",
          lastInvoice: null,
          irsaliyeNumbers: [],
        });
      }

      const doc = snap.docs[0];
      const docId = doc.id;
      const data = doc.data();
      const belgeNo = data.belgeNo ?? data.qnbRaw?.belgeNo ?? docId;

      let irsaliyeRefs = [];
      if (data.contentUbl && typeof data.contentUbl === "string") {
        irsaliyeRefs = extractRelatedDespatchRefsFromInvoiceUbl(data.contentUbl);
      }
      if (irsaliyeRefs.length === 0 && Array.isArray(data.relatedBelgeNos)) {
        irsaliyeRefs = data.relatedBelgeNos.map((id) => ({
          id: String(id).trim(),
          issueDate: "",
          uuid: null,
        })).filter((r) => r.id);
      }

      const irsaliyeNumbers = irsaliyeRefs.map((r) => r.id);

      // Konsola yaz (Firebase Functions log)
      console.log("[debugQnbLastInvoiceIrsaliye] Son fatura docId:", docId);
      console.log("[debugQnbLastInvoiceIrsaliye] Son fatura belgeNo:", belgeNo);
      console.log("[debugQnbLastInvoiceIrsaliye] Bu faturaya ait irsaliye numarası(ları):", irsaliyeNumbers);
      if (irsaliyeRefs.length > 0) {
        irsaliyeRefs.forEach((r, i) => {
          console.log(`  [${i + 1}] belgeNo=${r.id}, issueDate=${r.issueDate || "(yok)"}`);
        });
      }

      return res.status(200).json({
        ok: true,
        lastInvoice: { docId, belgeNo },
        irsaliyeNumbers,
        irsaliyeRefs,
      });
    } catch (e) {
      console.error("[debugQnbLastInvoiceIrsaliye] Hata:", e.message || e);
      return res.status(500).json({ error: e.message || "FAILED" });
    }
  }
);
