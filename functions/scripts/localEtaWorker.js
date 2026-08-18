import "dotenv/config";
import { ensureAdmin } from "../adminInit.js";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { syncApprovedInvoiceToEta } from "../etaInvoiceSync.js";
import { formatEtaError } from "../etaError.js";

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("ı", "i");
}

async function processDoc(db, docSnap) {
  const docId = docSnap.id;
  const data = docSnap.data() || {};
  const onay = normalizeStatus(data.onayDurumu);
  if (onay !== "onaylandi") return { skipped: true, reason: "not_approved" };

  const eta = normalizeStatus(data.etaKayitDurumu);
  if (eta === "tamamlandi") return { skipped: true, reason: "already_done" };

  const ref = db.collection("qnb_invoices").doc(docId);
  await ref.set(
    {
      etaKayitDurumu: "isleniyor",
      etaKayitGuncellemeTarihi: FieldValue.serverTimestamp(),
      etaKayitHata: FieldValue.delete(),
    },
    { merge: true }
  );

  try {
    const result = await syncApprovedInvoiceToEta(data, docId);
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
      return { skipped: false, blocked: true, reason: result.blockReason };
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
          localWorker: true,
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

    return { skipped: false, result };
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
    return { skipped: false, error: msg };
  }
}

async function runBatch(limitPerStatus) {
  ensureAdmin();
  const db = getFirestore();

  const statuses = ["onaylandı", "onaylandi"];
  const docs = new Map();
  for (const s of statuses) {
    const snap = await db
      .collection("qnb_invoices")
      .where("type", "==", "invoice")
      .where("onayDurumu", "==", s)
      .limit(limitPerStatus * 3)
      .get();
    for (const d of snap.docs) docs.set(d.id, d);
  }

  let ok = 0;
  let err = 0;
  let skipped = 0;
  let blocked = 0;
  for (const d of docs.values()) {
    const r = await processDoc(db, d);
    if (r.skipped) {
      skipped++;
      continue;
    }
    if (r.error) {
      err++;
      console.log(`[ERR] ${d.id}: ${r.error}`);
    } else if (r.blocked) {
      blocked++;
      console.log(`[BLOCKED] ${d.id}: ${r.reason}`);
    } else {
      ok++;
      console.log(`[OK] ${d.id}: ${JSON.stringify(r.result)}`);
    }
  }
  console.log(
    `Batch done. total=${docs.size} ok=${ok} blocked=${blocked} error=${err} skipped=${skipped}`
  );
}

async function main() {
  const mode = (process.argv[2] || "once").trim().toLowerCase();
  const limitPerStatus = Number(process.env.ETA_LOCAL_BATCH_LIMIT || "25");
  const intervalSec = Number(process.env.ETA_LOCAL_POLL_SEC || "20");

  if (mode === "watch") {
    console.log(
      `ETA local worker watch mode. poll=${intervalSec}s, limitPerStatus=${limitPerStatus}`
    );
    while (true) {
      try {
        await runBatch(limitPerStatus);
      } catch (err) {
        console.error("Batch failed:", err?.message || err);
      }
      await new Promise((r) => setTimeout(r, intervalSec * 1000));
    }
  }

  await runBatch(limitPerStatus);
}

main().catch((err) => {
  console.error("localEtaWorker failed:", err?.message || err);
  process.exitCode = 1;
});

