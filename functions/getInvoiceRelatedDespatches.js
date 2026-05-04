import { onRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { ublToStructuredJson, despatchToStructuredJson } from "./ublToStructuredJson.js";
import { extractRelatedDespatchRefsFromInvoiceUbl } from "./extractRelatedBelgeNos.js";
import {
  resolveDespatchUblHybrid,
  readEttnFromQnbDocsForDespatch,
} from "./enrichInvoiceWithRelatedDespatches.js";

const db = getFirestore();

const setCors = (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

/**
 * Fatura içinden irsaliye numarası + tarih alır; önce qnb_docs, yoksa portaldan UBL; Firebase'e kaydeder.
 * Fatura UBL yoksa sadece relatedBelgeNos kullanılır. ETTN faturada okunmaz.
 */
async function ensureDespatchesFromInvoiceAndPortal(docId, invData, vknTckn) {
  let refs = [];
  if (invData.contentUbl && typeof invData.contentUbl === "string") {
    refs = extractRelatedDespatchRefsFromInvoiceUbl(invData.contentUbl);
  }
  if (refs.length === 0 && Array.isArray(invData.relatedBelgeNos) && invData.relatedBelgeNos.length > 0) {
    refs = invData.relatedBelgeNos.map((id) => ({ id: String(id).trim(), issueDate: "" })).filter((r) => r.id);
  }
  if (refs.length === 0) return [];

  const relatedDespatches = [];
  const invRef = db.collection("qnb_invoices").doc(docId);
  const despatchCol = invRef.collection("despatches");

  for (const ref of refs) {
    const belgeNo = ref.id;
    const issueDate = ref.issueDate || null;
    const despatchDocId = String(belgeNo).replace(/[/\\]/g, "_");
    const refDoc = despatchCol.doc(despatchDocId);

    let contentUbl = null;
    let ublParsed = null;
    let ettn = null;
    const ettnFromQnbStore = await readEttnFromQnbDocsForDespatch(belgeNo);

    const existing = await refDoc.get();
    if (existing.exists) {
      const data = existing.data();
      if (data.contentUbl) contentUbl = data.contentUbl;
      if (data.ublParsed) ublParsed = data.ublParsed;
      if (data.ettn) {
        const t = String(data.ettn).trim();
        if (/^[0-9A-Fa-f-]{30,}$/.test(t)) ettn = t;
      }
    }

    if (!contentUbl) {
      try {
        const irOpts =
          issueDate && String(issueDate).trim() !== "" ? { issueDate: String(issueDate).trim() } : {};
        const fetched = await resolveDespatchUblHybrid(vknTckn || null, belgeNo, irOpts);
        if (fetched?.contentUbl) {
          contentUbl = fetched.contentUbl;
          ublParsed = fetched.ublParsed || null;
          const da = fetched.ublParsed?.DespatchAdvice;
          const rawUuid = da?.UUID ?? da?.Uuid ?? da?.uuid;
          const ettnFromFetched =
            rawUuid != null ? String(typeof rawUuid === "object" && rawUuid["#text"] != null ? rawUuid["#text"] : rawUuid).trim() : "";
          if (ettnFromFetched && /^[0-9A-Fa-f-]{30,}$/.test(ettnFromFetched)) ettn = ettnFromFetched;
          if (!ettn && ettnFromQnbStore) ettn = ettnFromQnbStore;
          await refDoc.set(
            {
              invoiceId: docId,
              belgeNo,
              issueDate,
              ettn: ettn || null,
              contentUbl,
              ublParsed,
              updatedAt: FieldValue.serverTimestamp(),
              createdAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
      } catch (_) {}
    }

    if (!ettn && ettnFromQnbStore) ettn = ettnFromQnbStore;

    if (!existing.exists && (!contentUbl || !ublParsed)) {
      await refDoc.set(
        {
          invoiceId: docId,
          belgeNo,
          issueDate,
          ettn: ettn || null,
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    let belgeOzet = null;
    if (contentUbl) {
      const parsed = ublToStructuredJson(contentUbl);
      if (parsed?.type === "despatch" && parsed.belgeOzet) belgeOzet = parsed.belgeOzet;
    }
    if (!belgeOzet && ublParsed?.DespatchAdvice) {
      belgeOzet = despatchToStructuredJson(ublParsed.DespatchAdvice) ?? null;
    }

    // Mevcut dokümanda UBL vardı ama ETTN boş/ geçersizse; qnb_docs veya UBL ile gelen ettn'i diske yaz.
    if (ettn && existing.exists) {
      const prevEttn =
        existing.data()?.ettn != null ? String(existing.data().ettn).trim() : "";
      const prevValid = /^[0-9A-Fa-f-]{30,}$/.test(prevEttn);
      if (!prevValid || prevEttn !== ettn) {
        await refDoc.set(
          { ettn, updatedAt: FieldValue.serverTimestamp() },
          { merge: true }
        );
      }
    }

    relatedDespatches.push({
      id: despatchDocId,
      belgeNo,
      issueDate,
      belgeOzet,
    });
  }
  return relatedDespatches;
}

/**
 * Fatura docId ile o faturanın irsaliyelerini (qnb_invoices/{id}/despatches, eski: qnb_irsaliyeler) ve
 * her biri için görüntülenebilir belge özetini (belgeOzet) döndürür.
 * Akış: Fatura içinden irsaliye no bulunur → Portaldan UBL indirilir → Firebase'e kaydedilir.
 */
export const getInvoiceRelatedDespatches = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    try {
      setCors(req, res);
      if (req.method === "OPTIONS") return res.status(204).send("");
      if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

      const docId = req.query.docId ? String(req.query.docId).trim() : null;
      if (!docId) return res.status(400).json({ error: "docId is required" });

      const invSnap = await db.collection("qnb_invoices").doc(docId).get();
      if (!invSnap.exists) return res.status(404).json({ error: "Invoice not found" });
      const invData = invSnap.data();
      if (invData?.type !== "invoice") {
        return res.status(400).json({ error: "Only invoice documents are supported" });
      }

      const vknTckn = process.env.QNB_VKN_TCKN || "";
      const invRef = db.collection("qnb_invoices").doc(docId);
      let irsaliyelerSnap = await invRef.collection("despatches").get();
      if (irsaliyelerSnap.empty) {
        irsaliyelerSnap = await db
          .collection("qnb_irsaliyeler")
          .where("invoiceId", "==", docId)
          .get();
      }

      // Subcollection / eski koleksiyon boşsa: fatura içinden irsaliye no bul → portala git indir → Firebase'e kaydet
      if (irsaliyelerSnap.empty && vknTckn) {
        const fromInvoice = await ensureDespatchesFromInvoiceAndPortal(docId, invData, vknTckn);
        if (fromInvoice.length > 0) {
          return res.status(200).json({ docId, relatedDespatches: fromInvoice });
        }
      }

      const relatedDespatches = [];
      for (const d of irsaliyelerSnap.docs) {
        const data = d.data();
        const id = d.id;
        const belgeNo = (data.belgeNo ?? data.belgeNoStr ?? "").toString().trim();
        const issueDate = data.issueDate ?? null;

        let belgeOzet = null;
        if (data.contentUbl && typeof data.contentUbl === "string") {
          const parsed = ublToStructuredJson(data.contentUbl);
          if (parsed?.type === "despatch" && parsed.belgeOzet) belgeOzet = parsed.belgeOzet;
        }
        if (!belgeOzet && data.ublParsed?.DespatchAdvice) {
          belgeOzet = despatchToStructuredJson(data.ublParsed.DespatchAdvice) ?? null;
        }

        // Özet yoksa: qnb_docs ETTN portal'dan bağımsız okunur (portal throw ederse yine yazılabilir).
        if (!belgeOzet && belgeNo) {
          const qnbEttnOnly = await readEttnFromQnbDocsForDespatch(belgeNo);
          let fetched = null;
          let wroteDespatchDoc = false;
          try {
            const irOpts =
              issueDate && String(issueDate).trim() !== ""
                ? { issueDate: String(issueDate).trim() }
                : {};
            fetched = await resolveDespatchUblHybrid(vknTckn || null, belgeNo, irOpts);
            if (fetched?.contentUbl) {
              const parsed = ublToStructuredJson(fetched.contentUbl);
              if (parsed?.type === "despatch" && parsed.belgeOzet) belgeOzet = parsed.belgeOzet;
              if (!belgeOzet && fetched.ublParsed?.DespatchAdvice) {
                belgeOzet = despatchToStructuredJson(fetched.ublParsed.DespatchAdvice) ?? null;
              }
              const update = {
                contentUbl: fetched.contentUbl,
                ublParsed: fetched.ublParsed || null,
                updatedAt: FieldValue.serverTimestamp(),
              };
              const da = fetched.ublParsed?.DespatchAdvice;
              const rawUuid = da?.UUID ?? da?.Uuid ?? da?.uuid;
              const ettnFromFetched =
                rawUuid != null ? String(typeof rawUuid === "object" && rawUuid["#text"] != null ? rawUuid["#text"] : rawUuid).trim() : "";
              if (ettnFromFetched && /^[0-9A-Fa-f-]{30,}$/.test(ettnFromFetched)) update.ettn = ettnFromFetched;
              if (!update.ettn && qnbEttnOnly) update.ettn = qnbEttnOnly;
              await d.ref.set(update, { merge: true });
              wroteDespatchDoc = true;
            } else if (qnbEttnOnly) {
              await d.ref.set(
                { ettn: qnbEttnOnly, updatedAt: FieldValue.serverTimestamp() },
                { merge: true }
              );
              wroteDespatchDoc = true;
            }
          } catch (_) {
            /* portal/UBL hatası; belgeOzet null kalabilir */
          }
          if (qnbEttnOnly && !wroteDespatchDoc) {
            await d.ref.set(
              { ettn: qnbEttnOnly, updatedAt: FieldValue.serverTimestamp() },
              { merge: true }
            );
          }
        }

        relatedDespatches.push({
          id,
          belgeNo: belgeNo || id,
          issueDate,
          belgeOzet,
        });
      }

      return res.status(200).json({ docId, relatedDespatches });
    } catch (e) {
      return res.status(500).json({ error: e.message || "FAILED" });
    }
  }
);
