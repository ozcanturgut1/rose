import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { ensureAdmin } from "../adminInit.js";
ensureAdmin();

import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { syncApprovedInvoiceToEta } from "../etaInvoiceSync.js";
import { formatEtaError } from "../etaError.js";
import { archiveCompletedInvoice } from "../archiveCompletedInvoice.js";

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
    memory: "256MiB",
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
      await ref.set(
        {
          etaKayitDurumu: "tamamlandi",
          etaKayitGuncellemeTarihi: FieldValue.serverTimestamp(),
          etaFatFisRefNo: result.fatFisRefNo || null,
          etaStokFisRefNo: result.stokFisRefNo || null,
          etaMuhFisRefNo: result.muhFisRefNo || null,
          etaKayitDetay: {
            status: result.status || "ok",
            lineCount: result.lineCount || 0,
            muhasebeRefFatFisRefNo: result.muhasebeRefFatFisRefNo || 0,
            lineMatches: Array.isArray(result.lineMatches) ? result.lineMatches : [],
          },
          etaKayitHata: FieldValue.delete(),
        },
        { merge: true }
      );
      console.log("onQnbInvoiceApproved: sql sync completed", docId, result);

      try {
        const archiveResult = await archiveCompletedInvoice(docId, { skipStatusCheck: true });
        console.log("onQnbInvoiceApproved: archive completed", docId, archiveResult);
      } catch (archiveErr) {
        console.error(
          "onQnbInvoiceApproved: archive failed",
          docId,
          archiveErr?.message || archiveErr
        );
      }
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
