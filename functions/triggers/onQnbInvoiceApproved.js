import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { ensureAdmin } from "../adminInit.js";
ensureAdmin();

import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { syncApprovedInvoiceToEta } from "../etaInvoiceSync.js";
import { formatEtaError } from "../etaError.js";
import { detectAracGideri, aracGideriUpdateFields } from "../plakaTespit.js";

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("ı", "i");
}

export const onQnbInvoiceApproved = onDocumentUpdated(
  {
    document: "qnb_invoices/{docId}",
    region: "europe-west1",
    // ETA kayıt zinciri onlarca SQL gidiş-dönüşü yapıyor; varsayılan 60 sn'lik sınır
    // zincirin ortasında kesilmeye yol açabilir (yarım kalmış fatura/muhasebe kaydı).
    // 540 sn, olay tetiklemeli fonksiyonlar için izin verilen üst sınırdır.
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (event) => {
    // Local worker mode: skip cloud-side SQL sync to avoid duplicate writes.
    if (String(process.env.ETA_SQL_LOCAL_ONLY || "").trim() === "1") {
      return;
    }

    const db = getFirestore();
    const before = event.data?.before?.data() || {};
    const after = event.data?.after?.data() || {};
    const docId = event.params.docId;
    const ref = db.collection("qnb_invoices").doc(docId);

    // Only run when status transitions to onaylandi.
    const beforeStatus = normalizeStatus(before.onayDurumu);
    const afterStatus = normalizeStatus(after.onayDurumu);
    if (beforeStatus === "onaylandi" || afterStatus !== "onaylandi") return;

    if (String(after.type || "").toLowerCase() !== "invoice") {
      console.log("onQnbInvoiceApproved: skipped non-invoice", docId);
      return;
    }

    if (!after.contentUbl || typeof after.contentUbl !== "string") {
      console.warn("onQnbInvoiceApproved: missing contentUbl", docId);
      return;
    }

    // Idempotency guard.
    const etaStatus = normalizeStatus(after.etaKayitDurumu);
    if (etaStatus === "tamamlandi") {
      console.log("onQnbInvoiceApproved: already completed", docId);
      return;
    }

    // Araç gideri (kira/yakıt) tedarikçisi ise plaka bulunmadan ETA'ya kayıt YAPILMAZ.
    // enrich aşamasında alanlar yazılmışsa onları kullan; eski/eksik kayıtta yeniden tespit et.
    let aracInfo = {
      aracGideriTedarikci: after.aracGideriTedarikci === true,
      aracPlakaDurumu: after.aracPlakaDurumu,
    };
    if (after.aracGideriTedarikci === undefined) {
      try {
        const det = await detectAracGideri({
          db,
          qnbRaw: after.qnbRaw,
          ublParsed: after.ublParsed,
          contentUbl: after.contentUbl,
        });
        aracInfo = det;
        const fields = aracGideriUpdateFields(det);
        await ref.set(fields, { merge: true });
        // Bellekteki after'a da uygula: syncApprovedInvoiceToEta binek dalı aracTespit'i okur.
        Object.assign(after, fields);
      } catch (aracErr) {
        console.warn("onQnbInvoiceApproved: plaka tespiti başarısız", docId, aracErr?.message || aracErr);
      }
    }
    if (aracInfo.aracGideriTedarikci === true && normalizeStatus(aracInfo.aracPlakaDurumu) !== "eslesti") {
      const durum = aracInfo.aracPlakaDurumu || "eksik";
      const mesaj =
        durum === "tanimsiz"
          ? "Araç gideri faturası: UBL'de bulunan plaka company_vehicles'ta tanımlı değil (binek/ticari belirlenemedi). ETA kaydı yapılmadı."
          : "Araç gideri faturası: UBL'de plaka bulunamadı. ETA kaydı yapılmadı.";
      await ref.set(
        {
          etaKayitDurumu: "beklemede_plaka",
          etaKayitGuncellemeTarihi: FieldValue.serverTimestamp(),
          etaKayitHata: mesaj,
        },
        { merge: true }
      );
      console.warn("onQnbInvoiceApproved: araç gideri plaka eksik/tanımsız, ETA atlandı", docId, durum);
      return;
    }

    await ref.set(
      {
        etaKayitDurumu: "isleniyor",
        etaKayitGuncellemeTarihi: FieldValue.serverTimestamp(),
        etaKayitHata: FieldValue.delete(),
      },
      { merge: true }
    );

    try {
      const result = await syncApprovedInvoiceToEta(after, docId);
      // Kur farkı faturası birden fazla döviz cariye denk gelip belirsizse: kayıt yapılmaz,
      // neden Firestore'a yazılır (arayüzde gösterilir), arşivlenmez.
      if (result?.blocked) {
        await ref.set(
          {
            etaKayitDurumu: "beklemede_kurfarki",
            etaKayitGuncellemeTarihi: FieldValue.serverTimestamp(),
            etaKayitHata: result.blockMessage || "Kur farkı faturası: cari belirlenemedi.",
            etaKayitDetay: {
              status: result.status || "blocked_kurfarki",
              blockReason: result.blockReason || null,
              adaylar: Array.isArray(result.blockDetail?.adaylar) ? result.blockDetail.adaylar : [],
            },
          },
          { merge: true }
        );
        console.warn("onQnbInvoiceApproved: kur farkı belirsiz, ETA kaydı yapılmadı", docId, result.blockReason);
        return;
      }
      await ref.set(
        {
          etaKayitDurumu: "tamamlandi",
          etaKayitGuncellemeTarihi: FieldValue.serverTimestamp(),
          etaFatFisRefNo: result.fatFisRefNo || null,
          etaStokFisRefNo: result.stokFisRefNo || null,
          etaMuhFisRefNo: result.muhFisRefNo || null,
          // Muhasebe arşive taşımadan önce mahsup fişini bu alandan görür.
          muhasebeFisi: result.muhasebeFisi || null,
          etaKayitDetay: {
            status: result.status || "ok",
            lineCount: result.lineCount || 0,
            erpCariKodu: result.erpCariKodu || null,
            cariResolveReason: result.cariResolveReason || null,
            muhasebeRefFatFisRefNo: result.muhasebeRefFatFisRefNo || 0,
            lineMatches: Array.isArray(result.lineMatches) ? result.lineMatches : [],
          },
          etaKayitHata: FieldValue.delete(),
          // Arşivleme otomatik değil: muhasebe kaydı kontrol edip "Arşive Taşı" ile tetikler.
          arsivDurumu: "arsiv_bekliyor",
          arsivBekliyorTarihi: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      console.log("onQnbInvoiceApproved: sql sync completed, arşiv muhasebe onayı bekliyor", docId, result);
    } catch (err) {
      const msg = formatEtaError(err);
      await ref.set(
        {
          etaKayitDurumu: "hata",
          etaKayitGuncellemeTarihi: FieldValue.serverTimestamp(),
          etaKayitHata: msg,
        },
        { merge: true }
      );
      console.error("onQnbInvoiceApproved: sql sync failed", docId, msg);
      throw err;
    }
  }
);
