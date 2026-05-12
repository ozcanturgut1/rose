import "dotenv/config";
import { ensureAdmin } from "../adminInit.js";
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
          localWorker: true,
          muhasebeRefFatFisRefNo: result.muhasebeRefFatFisRefNo || 0,
          lineMatches: Array.isArray(result.lineMatches) ? result.lineMatches : [],
        },
        etaKayitHata: FieldValue.delete(),
      },
      { merge: true }
    );

    try {
      const archiveResult = await archiveCompletedInvoice(docId, { skipStatusCheck: true });
      console.log(`[ARCHIVE] ${docId}: ${JSON.stringify(archiveResult)}`);
    } catch (archiveErr) {
      console.error(`[ARCHIVE-ERR] ${docId}: ${archiveErr?.message || archiveErr}`);
    }

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
  for (const d of docs.values()) {
    const r = await processDoc(db, d);
    if (r.skipped) {
      skipped++;
      continue;
    }
    if (r.error) {
      err++;
      console.log(`[ERR] ${d.id}: ${r.error}`);
    } else {
      ok++;
      console.log(`[OK] ${d.id}: ${JSON.stringify(r.result)}`);
    }
  }
  console.log(
    `Batch done. total=${docs.size} ok=${ok} error=${err} skipped=${skipped}`
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

