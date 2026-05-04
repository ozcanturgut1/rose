import { onRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, FieldPath } from "firebase-admin/firestore";
import { requireAuth, requireRole, ROLES_QNB_MUTATE } from "./requireAuth.js";
import { readEttnFromQnbDocsForDespatch } from "./enrichInvoiceWithRelatedDespatches.js";

const db = getFirestore();

const setCors = (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

const isValidEttn = (t) => /^[0-9A-Fa-f-]{30,}$/.test(String(t ?? "").trim());

/**
 * qnb_invoices/{id}/despatches altındaki her irsaliye için belgeNo ile qnb_docs/despatch_<no> okunur;
 * ETTN varsa ilgili despatch dokümanına yazılır (portal yok).
 */
async function applyEttnFromQnbDocsForInvoice(invRef, debugCtx = null) {
  const stats = {
    despatchesScanned: 0,
    updated: 0,
    skippedNoBelgeNo: 0,
    skippedNoQnbDocs: 0,
    unchanged: 0,
  };
  const snap = await invRef.collection("despatches").get();
  for (const d of snap.docs) {
    stats.despatchesScanned++;
    const data = d.data() || {};
    const belgeNo = (data.belgeNo ?? data.belgeNoStr ?? "").toString().trim();
    if (!belgeNo) {
      stats.skippedNoBelgeNo++;
      if (debugCtx && debugCtx.samples.length < debugCtx.maxSamples) {
        debugCtx.samples.push({
          invoiceId: invRef.id,
          despatchId: d.id,
          reason: "no_belge_no",
        });
      }
      continue;
    }
    const ettnFromStore = await readEttnFromQnbDocsForDespatch(belgeNo);
    if (!ettnFromStore) {
      stats.skippedNoQnbDocs++;
      if (debugCtx && debugCtx.samples.length < debugCtx.maxSamples) {
        debugCtx.samples.push({
          invoiceId: invRef.id,
          despatchId: d.id,
          belgeNo,
          reason: "qnb_docs_missing_or_invalid_ettn",
        });
      }
      continue;
    }
    const prev = data.ettn != null ? String(data.ettn).trim() : "";
    if (isValidEttn(prev) && prev === ettnFromStore) {
      stats.unchanged++;
      if (debugCtx && debugCtx.samples.length < debugCtx.maxSamples) {
        debugCtx.samples.push({
          invoiceId: invRef.id,
          despatchId: d.id,
          belgeNo,
          reason: "already_same",
          ettn: ettnFromStore,
        });
      }
      continue;
    }
    await d.ref.set(
      { ettn: ettnFromStore, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    stats.updated++;
    if (debugCtx && debugCtx.samples.length < debugCtx.maxSamples) {
      debugCtx.samples.push({
        invoiceId: invRef.id,
        despatchId: d.id,
        belgeNo,
        reason: "updated",
        ettn: ettnFromStore,
      });
    }
  }
  return stats;
}

function mergeStats(total, part) {
  total.despatchesScanned += part.despatchesScanned;
  total.updated += part.updated;
  total.skippedNoBelgeNo += part.skippedNoBelgeNo;
  total.skippedNoQnbDocs += part.skippedNoQnbDocs;
  total.unchanged += part.unchanged;
}

const INVOICE_PAGE_ALL = 300;

export const backfillDespatchEttnFromQnbDocs = onRequest(
  { region: "europe-west1", timeoutSeconds: 540, memory: "512MiB" },
  async (req, res) => {
    try {
      setCors(req, res);
      if (req.method === "OPTIONS") return res.status(204).send("");
      if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

      const user = await requireAuth(req);
      await requireRole(user.uid, ROLES_QNB_MUTATE);

      const docIdRaw = req.query?.docId ? String(req.query.docId).trim() : "";
      const allParam = req.query?.all;
      const allInvoices =
        allParam === "1" ||
        allParam === "true" ||
        String(allParam || "").toLowerCase() === "yes";
      const invoiceLimit = Math.min(Math.max(Number(req.query?.limit) || 100, 1), 300);
      const debugEnabled = String(req.query?.debug || "").toLowerCase() === "1" ||
        String(req.query?.debug || "").toLowerCase() === "true";
      const debugCtx = debugEnabled
        ? { maxSamples: Math.min(Math.max(Number(req.query?.debugLimit) || 60, 1), 300), samples: [] }
        : null;

      if (docIdRaw) {
        if (!docIdRaw.startsWith("invoice_")) {
          return res.status(400).json({ error: "docId must be an invoice id (invoice_...)" });
        }
        const invRef = db.collection("qnb_invoices").doc(docIdRaw);
        const invSnap = await invRef.get();
        if (!invSnap.exists) return res.status(404).json({ error: "Invoice not found" });
        if (String(invSnap.data()?.type) !== "invoice") {
          return res.status(400).json({ error: "Only invoice documents are supported" });
        }
        const stats = await applyEttnFromQnbDocsForInvoice(invRef, debugCtx);
        return res.status(200).json({
          success: true,
          docId: docIdRaw,
          invoicesProcessed: 1,
          ...stats,
          ...(debugCtx ? { debugSamples: debugCtx.samples } : {}),
        });
      }

      const total = {
        mode: allInvoices ? "all" : "recent",
        invoicesProcessed: 0,
        invoiceDocPages: 0,
        despatchesScanned: 0,
        updated: 0,
        skippedNoBelgeNo: 0,
        skippedNoQnbDocs: 0,
        unchanged: 0,
      };

      if (allInvoices) {
        let lastDoc = null;
        while (true) {
          let q = db
            .collection("qnb_invoices")
            .orderBy(FieldPath.documentId())
            .limit(INVOICE_PAGE_ALL);
          if (lastDoc) q = q.startAfter(lastDoc);
          const snap = await q.get();
          if (snap.empty) break;
          total.invoiceDocPages++;
          for (const invDoc of snap.docs) {
            const data = invDoc.data() || {};
            if (String(data.type) !== "invoice") continue;
            total.invoicesProcessed++;
            const part = await applyEttnFromQnbDocsForInvoice(invDoc.ref, debugCtx);
            mergeStats(total, part);
          }
          lastDoc = snap.docs[snap.docs.length - 1];
          if (snap.size < INVOICE_PAGE_ALL) break;
        }
        return res.status(200).json({
          success: true,
          ...total,
          ...(debugCtx ? { debugSamples: debugCtx.samples } : {}),
        });
      }

      const snap = await db
        .collection("qnb_invoices")
        .orderBy("updatedAt", "desc")
        .limit(invoiceLimit)
        .get();

      for (const invDoc of snap.docs) {
        const data = invDoc.data() || {};
        if (String(data.type) !== "invoice") continue;
        total.invoicesProcessed++;
        const part = await applyEttnFromQnbDocsForInvoice(invDoc.ref, debugCtx);
        mergeStats(total, part);
      }

      return res.status(200).json({
        success: true,
        ...total,
        ...(debugCtx ? { debugSamples: debugCtx.samples } : {}),
      });
    } catch (e) {
      const status = e?.status && Number(e.status) >= 400 ? Number(e.status) : 500;
      return res.status(status).json({ error: String(e?.message || e) });
    }
  }
);
