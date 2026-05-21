/**
 * Belge no için güncel stok seçim simülasyonu (lineMatches).
 * Kullanım: node scripts/previewLineMatchesForBelge.js ERD2026000001235
 */
import "dotenv/config";
import { getFirestore } from "firebase-admin/firestore";
import { ensureAdmin } from "../adminInit.js";
import { previewStockLineMatches } from "../etaInvoiceSync.js";
import { ublToFullJson } from "../ublToStructuredJson.js";

function safeDocKey(s) {
  return String(s || "").replace(/[/\\]/g, "_");
}

async function findInvoiceData(belgeNo) {
  ensureAdmin();
  const db = getFirestore();
  const key = belgeNo.trim();
  const docId = `invoice_${safeDocKey(key)}`;

  const tries = [
    () => db.collection("qnb_invoices").doc(docId).get(),
    () =>
      db.collection("qnb_invoices").where("belgeNo", "==", key).limit(1).get(),
    () => db.collection("qnb_docs").doc(docId).get(),
    () => db.collection("qnb_docs").where("belgeNo", "==", key).limit(1).get(),
  ];

  for (const fn of tries) {
    const snap = await fn();
    if (snap?.exists) return { data: snap.data(), id: snap.id, coll: "doc" };
    if (!snap?.empty && snap.docs?.length) {
      const d = snap.docs[0];
      return { data: d.data(), id: d.id, coll: d.ref.parent.id };
    }
  }
  return null;
}

async function main() {
  const belgeNo = process.argv[2] || "ERD2026000001235";
  let found = await findInvoiceData(belgeNo);
  let afterData;
  if (!found && belgeNo === "ERD2026000001235") {
    console.warn(
      "Firestore kaydı yok; son ETA kaydındaki FATHAR/UBL alanlarından örnek veri ile simülasyon."
    );
    afterData = {
      belgeNo,
      supplierVkn: "3460729091",
      qnbRaw: { gondericiVkn: "3460729091", belgeNo },
      ublParsed: {
        Invoice: {
          InvoiceLine: {
            ID: "1",
            Note: "A3 70/40 NA6 24 FLM SİYAH",
            Item: {
              Name: "152.0039",
              Description: "70/24 SİYAH NYLON6 + 40 ELASTANE YARN",
            },
            InvoicedQuantity: { "#text": "1", "@_unitCode": "KGM" },
            LineExtensionAmount: { "#text": "1000", "@_currencyID": "TRY" },
            TaxTotal: {
              TaxAmount: { "#text": "200" },
              TaxSubtotal: { Percent: "20" },
            },
          },
        },
      },
    };
  } else if (!found) {
    console.error("Firestore'da fatura bulunamadı:", belgeNo);
    process.exit(1);
  } else {
    afterData = { ...found.data };
    console.log("Kaynak:", found.coll, found.id);
  }
  if (
    (!afterData.ublParsed || !Object.keys(afterData.ublParsed || {}).length) &&
    afterData.contentUbl &&
    typeof afterData.contentUbl === "string"
  ) {
    afterData.ublParsed = ublToFullJson(afterData.contentUbl) ?? {};
  }

  if (!afterData.ublParsed || !Object.keys(afterData.ublParsed).length) {
    console.error("UBL verisi yok (contentUbl / ublParsed). Koleksiyon:", found.coll, found.id);
    process.exit(1);
  }

  const preview = await previewStockLineMatches(afterData);
  console.log(JSON.stringify(preview, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
