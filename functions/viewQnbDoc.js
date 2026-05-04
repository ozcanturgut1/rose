import { onRequest } from "firebase-functions/v2/https";
import { ensureAdmin } from "./adminInit.js";
ensureAdmin();

import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getQnbConnectorClient } from "./qnbSoapClient.js";
import { ublToFullJson } from "./ublToStructuredJson.js";
import { extractRelatedBelgeNosFromInvoiceUbl } from "./extractRelatedBelgeNos.js";

// Debug aşamasında auth kapalıysa requireAuth/requireRole kullanma.
// Açık kullanacaksan aşağıyı uncomment et.
// import { requireAuth, requireRole } from "./auth/requireAuth.js";

const db = getFirestore();

const setCors = (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

function asArray(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

export const viewQnbDoc = onRequest({ region: "europe-west1" }, async (req, res) => {
  try {
    setCors(req, res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

    // Auth açıksa:
    // const user = await requireAuth(req);
    // await requireRole(user.uid, ["admin", "manager", "accounting"]);

    const docId = req.query.docId ? String(req.query.docId) : null;
    if (!docId) return res.status(400).json({ error: "docId is required" });

    const invSnap = await db.collection("qnb_invoices").doc(docId).get();
    let data = null;
    let docType = null;
    if (invSnap.exists && invSnap.data()?.type === "invoice") {
      data = invSnap.data();
      docType = "invoice";
    } else {
      const dsSnap = await db.collection("qnb_docs").doc(docId).get();
      if (dsSnap.exists && dsSnap.data()?.type === "despatch") {
        data = dsSnap.data();
        docType = "despatch";
      }
    }
    if (!data || !docType) return res.status(404).json({ error: "Not found" });
    const externalId = data.ettn ?? data.externalId ?? data.belgeNo;
    if (!externalId) {
      return res.status(400).json({ error: "Belge için externalId/ettn bulunamadı" });
    }

    const vknTckn = process.env.QNB_VKN_TCKN;
    if (!vknTckn) return res.status(500).json({ error: "QNB_VKN_TCKN missing in .env" });

    const client = await getQnbConnectorClient();

    const method = docType === "invoice" ? "gelenFaturaIndir" : "gelenIrsaliyeIndir";

    const vkn = String(vknTckn);
    const extId = String(externalId);
    const formats = ["PDF", "UBL", "HTML"];

    const candidates = [];
    for (const fmt of formats) {
      candidates.push([vkn, extId, fmt]);
      candidates.push([extId, vkn, fmt]);
      candidates.push([vkn, fmt, extId]);
      candidates.push([extId, fmt, vkn]);
    }

    let base64 = null;
    let usedArgs = null;
    const errors = [];

    for (const args of candidates) {
      try {
        const asyncName = `${method}Async`;
        const payload = { arg0: args[0], arg1: args[1] };
        if (args[2] !== undefined) payload.arg2 = args[2];
        const [resp] = await client[asyncName](payload);

        // output şeması return: base64Binary
        const ret = resp?.return ?? resp;
        if (ret) {
          base64 = ret;
          usedArgs = args;
          break;
        }
      } catch (e) {
        errors.push(String(e?.message || e));
      }
    }

    if (!base64) {
      return res.status(502).json({
        error: "Download failed for all arg candidates",
        tried: candidates,
        errors: errors.slice(0, 3),
      });
    }

    const buffer = Buffer.from(base64, "base64");
    // İndirilen içerik UBL/XML ise hiç süzmeden tamamını ilgili dokümana yaz
    const peek = buffer.toString("utf8", 0, Math.min(buffer.length, 2048));
    const isXml = /^\s*<\?xml|^\s*<(\w+:)?Invoice\s|^\s*<Invoice\s|^\s*<(\w+:)?DespatchAdvice\s|^\s*<DespatchAdvice\s/.test(peek);
    if (isXml) {
      try {
        const xmlStr = buffer.toString("utf8");
        const payload = {
          contentUbl: xmlStr,
          contentFetchedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        };
        const ublKeyValue = ublToFullJson(xmlStr);
        if (ublKeyValue) payload.ublParsed = ublKeyValue;
        const relatedNos = extractRelatedBelgeNosFromInvoiceUbl(xmlStr);
        if (relatedNos.length) {
          payload.relatedBelgeNos = relatedNos;
          payload.relatedBelgeNosFromUbl = relatedNos;
        }
        await db.collection("qnb_docs").doc(docId).set(payload, { merge: true });
      } catch (_) { /* doc boyut limiti vb. */ }
    }

    const contentType = isXml ? "application/xml" : "application/pdf";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("X-QNB-Used-Args", usedArgs.join("|"));

    return res.status(200).send(buffer);
  } catch (e) {
    return res.status(500).json({ error: e.message || "FAILED" });
  }
});
