import { onRequest } from "firebase-functions/v2/https";
import { ensureAdmin } from "./adminInit.js";
ensureAdmin();

import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { callConnector } from "./qnbCall.js";

const db = getFirestore();

function yyyymmddToTimestamp(s) {
  // "20260201"
  if (!s || String(s).length !== 8) return null;
  const str = String(s);
  const y = Number(str.slice(0, 4));
  const m = Number(str.slice(4, 6));
  const d = Number(str.slice(6, 8));
  if (!y || !m || !d) return null;
  // UTC midnight
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
}

function toNumber(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(String(x).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export const normalizeQnbInvoices = onRequest({ region: "europe-west1" }, async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const vknTckn = process.env.QNB_VKN_TCKN;
    if (!vknTckn) return res.status(500).json({ error: "QNB_VKN_TCKN missing in .env" });

    const from = req.query.from ? String(req.query.from) : "2026-02-01";
    const to = req.query.to ? String(req.query.to) : "2026-02-19";

    // FATURA özet/tutar sorgusu
    const resp = await callConnector("gelenBelgeTutarBilgileriSorgula", {
      vergiTcKimlikNo: String(vknTckn),
      belgeTuru: "FATURA",
      baslangicGelisTarihi: String(from),
      bitisGelisTarihi: String(to),
    });

    const items = resp?.return || resp?.["return"] || resp?.["return[]"] || [];
    const arr = Array.isArray(items) ? items : [items];

    let processed = 0;
    let matched = 0;
    let updated = 0;

    // Firestore batch limit 500; biz güvenli olsun diye 400 ile parçalıyoruz
    let batch = db.batch();
    let batchCount = 0;

    for (const it of arr) {
      processed++;

      const ettn = it.ettn ? String(it.ettn) : null;
      if (!ettn) continue;

      const belgeNo = it.belgeNo != null && String(it.belgeNo).trim() !== "" ? String(it.belgeNo).trim() : null;
      const docId = `invoice_${belgeNo || ettn}`.replace(/[/\\]/g, "_");
      const ref = db.collection("qnb_docs").doc(docId);

      // Doc var mı? "set merge" ile var/yok fark etmez ama matched sayısını görmek için get yapmadan tahmini sayacağız.
      matched++;

      const issueDate = yyyymmddToTimestamp(it.belgeTarihi);
      const supplierVkn = it.gondericiVkn ? String(it.gondericiVkn) : null;

      const gondericiUnvanRaw = it.gondericiUnvan ?? it.gondericiIsim ?? it.GondericiUnvan ?? it.gonderenUnvan ?? it.gonderenIsim;
      const gondericiUnvanStr = gondericiUnvanRaw != null && String(gondericiUnvanRaw).trim() !== "" ? String(gondericiUnvanRaw).trim() : null;

      const total = toNumber(it.odenecekTutar);
      const currency = it.odenecekTutarDovizCinsi ? String(it.odenecekTutarDovizCinsi) : null;

      const vatTotal = toNumber(it.kdvToplamTutari);
      const goodsTotal = toNumber(it.malHizmetToplamTutari);

      batch.set(
        ref,
        {
          type: "invoice",
          externalId: ettn,
          qnbBelgeTuru: "FATURA",
          belgeNo: it.belgeNo ? String(it.belgeNo) : null,

          issueDate: issueDate ? issueDate : null,
          supplierVkn: supplierVkn,
          supplierUnvan: gondericiUnvanStr,
          currency: currency,
          total: total,

          vatTotal: vatTotal,
          goodsTotal: goodsTotal,

          qnbRaw: it,

          normalizedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      updated++;
      batchCount++;

      if (batchCount >= 400) {
        await batch.commit();
        batch = db.batch();
        batchCount = 0;
      }
    }

    if (batchCount > 0) {
      await batch.commit();
    }

    return res.status(200).json({
      success: true,
      from,
      to,
      processed,
      matched,
      updated,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});
