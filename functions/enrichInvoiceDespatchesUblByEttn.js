import { onRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, FieldPath } from "firebase-admin/firestore";
import { requireAuth, requireRole } from "./requireAuth.js";
import {
  fetchDespatchUblByEttn,
  readDespatchFromQnbDocs,
} from "./enrichInvoiceWithRelatedDespatches.js";

const db = getFirestore();

const setCors = (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

const looksLikeDespatchXml = (s) =>
  /^\s*<\?xml|^\s*<(\w+:)?DespatchAdvice\s|^\s*<DespatchAdvice\s/.test((s || "").slice(0, 2048));

const isValidEttn = (t) => /^[0-9A-Fa-f-]{30,}$/.test(String(t ?? "").trim());

/**
 * qnb_invoices/{id}/despatches: geçerli ettn ile UBL doldurur.
 * Önce qnb_docs/despatch_* içindeki tam UBL; yoksa portaldan gelenIrsaliyeIndir.
 */
async function enrichUblForInvoiceDespatches(invRef, vknTckn, { force, debugCtx = null }) {
  const stats = {
    despatchesScanned: 0,
    ublWritten: 0,
    skippedNoBelgeNo: 0,
    skippedNoEttn: 0,
    skippedAlreadyHasUbl: 0,
    fromQnbDocs: 0,
    fromPortal: 0,
    fetchFailed: 0,
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
    const ettn = data.ettn != null ? String(data.ettn).trim() : "";
    if (!isValidEttn(ettn)) {
      stats.skippedNoEttn++;
      if (debugCtx && debugCtx.samples.length < debugCtx.maxSamples) {
        debugCtx.samples.push({
          invoiceId: invRef.id,
          despatchId: d.id,
          belgeNo,
          reason: "invalid_or_missing_ettn",
          ettn: ettn || null,
        });
      }
      continue;
    }
    const existingUbl = data.contentUbl && typeof data.contentUbl === "string" ? data.contentUbl : "";
    if (!force && existingUbl && looksLikeDespatchXml(existingUbl)) {
      stats.skippedAlreadyHasUbl++;
      if (debugCtx && debugCtx.samples.length < debugCtx.maxSamples) {
        debugCtx.samples.push({
          invoiceId: invRef.id,
          despatchId: d.id,
          belgeNo,
          reason: "already_has_ubl",
        });
      }
      continue;
    }

    const fromDoc = await readDespatchFromQnbDocs(belgeNo);
    if (fromDoc?.contentUbl && looksLikeDespatchXml(fromDoc.contentUbl)) {
      await d.ref.set(
        {
          contentUbl: fromDoc.contentUbl,
          ublParsed: fromDoc.ublParsed || null,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      stats.ublWritten++;
      stats.fromQnbDocs++;
      if (debugCtx && debugCtx.samples.length < debugCtx.maxSamples) {
        debugCtx.samples.push({
          invoiceId: invRef.id,
          despatchId: d.id,
          belgeNo,
          reason: "written_from_qnb_docs",
        });
      }
      continue;
    }

    if (!vknTckn) {
      stats.fetchFailed++;
      if (debugCtx && debugCtx.samples.length < debugCtx.maxSamples) {
        debugCtx.samples.push({
          invoiceId: invRef.id,
          despatchId: d.id,
          belgeNo,
          reason: "portal_fetch_failed_no_vkn",
        });
      }
      continue;
    }
    const fetched = await fetchDespatchUblByEttn(vknTckn, ettn);
    if (!fetched?.contentUbl || !looksLikeDespatchXml(fetched.contentUbl)) {
      stats.fetchFailed++;
      if (debugCtx && debugCtx.samples.length < debugCtx.maxSamples) {
        debugCtx.samples.push({
          invoiceId: invRef.id,
          despatchId: d.id,
          belgeNo,
          reason: "portal_fetch_failed",
          errorCode: fetched?.errorCode || null,
        });
      }
      continue;
    }
    await d.ref.set(
      {
        contentUbl: fetched.contentUbl,
        ublParsed: fetched.ublParsed || null,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    stats.ublWritten++;
    stats.fromPortal++;
    if (debugCtx && debugCtx.samples.length < debugCtx.maxSamples) {
      debugCtx.samples.push({
        invoiceId: invRef.id,
        despatchId: d.id,
        belgeNo,
        reason: "written_from_portal",
      });
    }
  }
  return stats;
}

function mergeEnrichStats(total, part) {
  total.despatchesScanned += part.despatchesScanned;
  total.ublWritten += part.ublWritten;
  total.skippedNoBelgeNo += part.skippedNoBelgeNo;
  total.skippedNoEttn += part.skippedNoEttn;
  total.skippedAlreadyHasUbl += part.skippedAlreadyHasUbl;
  total.fromQnbDocs += part.fromQnbDocs;
  total.fromPortal += part.fromPortal;
  total.fetchFailed += part.fetchFailed;
}

const INVOICE_PAGE_ALL = 300;

export const enrichInvoiceDespatchesUblByEttn = onRequest(
  { region: "europe-west1", timeoutSeconds: 540, memory: "512MiB" },
  async (req, res) => {
    try {
      setCors(req, res);
      if (req.method === "OPTIONS") return res.status(204).send("");
      if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

      const user = await requireAuth(req);
      await requireRole(user.uid, ["admin", "manager", "accounting"]);

      const docIdRaw = req.query?.docId ? String(req.query.docId).trim() : "";
      const allParam = req.query?.all;
      const allInvoices =
        allParam === "1" ||
        allParam === "true" ||
        String(allParam || "").toLowerCase() === "yes";
      const invoiceLimit = Math.min(Math.max(Number(req.query?.limit) || 100, 1), 300);
      const force =
        req.query?.force === "1" ||
        req.query?.force === "true" ||
        String(req.query?.force || "").toLowerCase() === "yes";
      const debugEnabled =
        req.query?.debug === "1" ||
        req.query?.debug === "true" ||
        String(req.query?.debug || "").toLowerCase() === "yes";
      const debugCtx = debugEnabled
        ? { maxSamples: Math.min(Math.max(Number(req.query?.debugLimit) || 60, 1), 300), samples: [] }
        : null;

      const vknTckn = process.env.QNB_VKN_TCKN ? String(process.env.QNB_VKN_TCKN).trim() : "";

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
        const stats = await enrichUblForInvoiceDespatches(invRef, vknTckn, { force, debugCtx });
        return res.status(200).json({
          success: true,
          docId: docIdRaw,
          invoicesProcessed: 1,
          vknConfigured: Boolean(vknTckn),
          force,
          ...stats,
          ...(debugCtx ? { debugSamples: debugCtx.samples } : {}),
        });
      }

      const total = {
        mode: allInvoices ? "all" : "recent",
        invoicesProcessed: 0,
        invoiceDocPages: 0,
        despatchesScanned: 0,
        ublWritten: 0,
        skippedNoBelgeNo: 0,
        skippedNoEttn: 0,
        skippedAlreadyHasUbl: 0,
        fromQnbDocs: 0,
        fromPortal: 0,
        fetchFailed: 0,
        vknConfigured: Boolean(vknTckn),
        force,
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
            const part = await enrichUblForInvoiceDespatches(invDoc.ref, vknTckn, { force, debugCtx });
            mergeEnrichStats(total, part);
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
        const part = await enrichUblForInvoiceDespatches(invDoc.ref, vknTckn, { force, debugCtx });
        mergeEnrichStats(total, part);
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
