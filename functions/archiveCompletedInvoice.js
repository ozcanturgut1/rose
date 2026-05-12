import { ensureAdmin } from "./adminInit.js";
ensureAdmin();

import { getFirestore, FieldValue } from "firebase-admin/firestore";

const INVOICE_COL = "qnb_invoices";
const INVOICE_ARCHIVE_COL = "qnb_invoices_archive";
const DOCS_COL = "qnb_docs";
const DOCS_ARCHIVE_COL = "qnb_docs_archive";
const DESPATCHES_SUBCOL = "despatches";

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("ı", "i");
}

function despatchDocIdForBelgeNo(belgeNo) {
  const safe = String(belgeNo || "").replace(/[/\\]/g, "_").trim();
  if (!safe) return null;
  return `despatch_${safe}`;
}

/**
 * Faturaya ait irsaliye belge numaralarını fatura dokümanı + `despatches` alt
 * koleksiyonundan birleştirerek toplar.
 */
function collectBelgeNosFromInvoice(invData, subDocs) {
  const set = new Set();
  const add = (v) => {
    const s = String(v ?? "").trim();
    if (s) set.add(s);
  };

  if (invData && Array.isArray(invData.relatedBelgeNos)) {
    for (const x of invData.relatedBelgeNos) add(x);
  }
  if (invData && Array.isArray(invData.relatedDespatchEttns)) {
    for (const r of invData.relatedDespatchEttns) {
      if (r && typeof r === "object") add(r.belgeNo);
    }
  }
  for (const sd of subDocs || []) {
    const d = sd.data() || {};
    if (d.belgeNo) add(d.belgeNo);
  }
  return Array.from(set);
}

/**
 * Aynı `belgeNo` başka bir aktif `qnb_invoices` dokümanı tarafından da referanslanıyor mu?
 * (Arşivlenmekte olan fatura hariç.)
 */
async function isDespatchReferencedByOtherInvoice(db, belgeNo, currentDocId) {
  const snap = await db
    .collection(INVOICE_COL)
    .where("relatedBelgeNos", "array-contains", belgeNo)
    .limit(5)
    .get();
  return snap.docs.some((d) => d.id !== currentDocId);
}

/**
 * Fatura kaydı tamamlandığında çağrılır:
 *  - `qnb_invoices/{docId}` ve `despatches/*` alt koleksiyonu `qnb_invoices_archive`'a kopyalanır,
 *  - İlgili `qnb_docs/despatch_<belgeNo>` kayıtları `qnb_docs_archive`'a kopyalanır,
 *  - Başka aktif fatura referans vermiyorsa `qnb_docs`'tan silinir,
 *  - `qnb_invoices/{docId}` (ve alt koleksiyonu) silinir.
 *
 * @param {string} docId - qnb_invoices doc id (ör. `invoice_<belgeNo>`).
 * @param {{ skipStatusCheck?: boolean }} [opts]
 * @returns {Promise<object>}
 */
export async function archiveCompletedInvoice(docId, opts = {}) {
  if (!docId || typeof docId !== "string") {
    return { skipped: true, reason: "invalid_doc_id" };
  }
  const db = getFirestore();
  const invRef = db.collection(INVOICE_COL).doc(docId);
  const invSnap = await invRef.get();
  if (!invSnap.exists) {
    return { skipped: true, reason: "invoice_not_found", docId };
  }
  const invData = invSnap.data() || {};

  if (!opts.skipStatusCheck) {
    const eta = normalizeStatus(invData.etaKayitDurumu);
    if (eta !== "tamamlandi") {
      return { skipped: true, reason: "eta_not_completed", docId, etaKayitDurumu: invData.etaKayitDurumu || null };
    }
  }

  const subSnap = await invRef.collection(DESPATCHES_SUBCOL).get();

  const archInvRef = db.collection(INVOICE_ARCHIVE_COL).doc(docId);
  const headerBatch = db.batch();
  headerBatch.set(
    archInvRef,
    {
      ...invData,
      archivedAt: FieldValue.serverTimestamp(),
      archivedFrom: INVOICE_COL,
    },
    { merge: true }
  );
  for (const sd of subSnap.docs) {
    headerBatch.set(archInvRef.collection(DESPATCHES_SUBCOL).doc(sd.id), sd.data() || {}, { merge: true });
  }
  await headerBatch.commit();

  const belgeNos = collectBelgeNosFromInvoice(invData, subSnap.docs);
  const despatchesArchived = [];
  const despatchesSkipped = [];

  for (const belgeNo of belgeNos) {
    const did = despatchDocIdForBelgeNo(belgeNo);
    if (!did) {
      despatchesSkipped.push({ belgeNo, reason: "invalid_belge_no" });
      continue;
    }
    const docRef = db.collection(DOCS_COL).doc(did);
    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      despatchesSkipped.push({ belgeNo, reason: "qnb_docs_not_found" });
      continue;
    }

    await db
      .collection(DOCS_ARCHIVE_COL)
      .doc(did)
      .set(
        {
          ...(docSnap.data() || {}),
          archivedAt: FieldValue.serverTimestamp(),
          archivedFrom: DOCS_COL,
          archivedForInvoiceId: docId,
        },
        { merge: true }
      );

    const stillReferenced = await isDespatchReferencedByOtherInvoice(db, belgeNo, docId);
    if (stillReferenced) {
      despatchesSkipped.push({ belgeNo, reason: "referenced_by_other_invoice" });
      continue;
    }

    await docRef.delete();
    despatchesArchived.push(belgeNo);
  }

  if (subSnap.docs.length) {
    const delBatch = db.batch();
    for (const sd of subSnap.docs) delBatch.delete(sd.ref);
    await delBatch.commit();
  }
  await invRef.delete();

  return {
    skipped: false,
    docId,
    invoiceArchived: true,
    despatchesArchived,
    despatchesSkipped,
  };
}
