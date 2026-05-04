/**
 * qnb_docs'a yazılan belgelerde contentUbl yoksa UBL'i indirip yazar (create veya update fark etmez).
 */
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { ensureAdmin } from "../adminInit.js";
ensureAdmin();

import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getQnbConnectorClient } from "../qnbSoapClient.js";
import { ublToFullJson } from "../ublToStructuredJson.js";
import { extractRelatedBelgeNosFromInvoiceUbl } from "../extractRelatedBelgeNos.js";

const db = getFirestore();

async function downloadUblAndSave(docId, data) {
  if (data?.type !== "invoice") {
    return; // Sadece faturalar için UBL indir; irsaliye işlenmez
  }

  const vknTckn = process.env.QNB_VKN_TCKN;
  if (!vknTckn) {
    console.warn("onQnbDoc: QNB_VKN_TCKN missing");
    return;
  }

  const idForDownload = data.ettn || data.externalId;
  if (!idForDownload) {
    console.log("onQnbDoc: no ettn/externalId", docId);
    return;
  }

  const method = "gelenFaturaIndir";
  const vkn = String(vknTckn);
  const extId = String(idForDownload);
  const formats = ["UBL", "PDF", "HTML"];
  const candidates = [];
  for (const fmt of formats) {
    candidates.push([vkn, extId, fmt]);
    candidates.push([extId, vkn, fmt]);
    candidates.push([vkn, fmt, extId]);
    candidates.push([extId, fmt, vkn]);
  }

  let base64 = null;
  const client = await getQnbConnectorClient();
  for (const args of candidates) {
    try {
      const asyncName = `${method}Async`;
      const payload = { arg0: args[0], arg1: args[1] };
      if (args[2] !== undefined) payload.arg2 = args[2];
      const [resp] = await client[asyncName](payload);
      const ret = resp?.return ?? resp;
      if (ret) {
        base64 = ret;
        break;
      }
    } catch (_) {}
  }
  if (!base64) {
    console.warn("onQnbDoc: download failed", docId);
    return;
  }

  const buffer = Buffer.from(base64, "base64");
  const peek = buffer.toString("utf8", 0, Math.min(buffer.length, 2048));
  const isXml = /^\s*<\?xml|^\s*<(\w+:)?Invoice\s|^\s*<Invoice\s/.test(peek);
  if (!isXml) {
    console.log("onQnbDoc: content not XML", docId);
    return;
  }

  const xmlStr = buffer.toString("utf8");
  const ref = db.collection("qnb_docs").doc(docId);
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
  await ref.set(payload, { merge: true });
  console.log("onQnbDoc: contentUbl saved", docId);
}

export const onQnbDocCreated = onDocumentWritten(
  {
    document: "qnb_docs/{docId}",
    region: "europe-west1",
    memory: "512MiB",
  },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists) return;
    const docId = event.params.docId;
    const data = after.data();
    if (data.contentUbl) return; // Zaten doluysa atla (sonsuz döngüyü önle)
    try {
      await downloadUblAndSave(docId, data);
    } catch (e) {
      console.warn("onQnbDocCreated:", docId, e?.message || e);
    }
  }
);
