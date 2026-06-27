/**
 * _denemeEvrakList.json içindeki evrak numaralarını Firestore'dan yeniden ETA'ya yazar.
 * Önce deleteEtaDenemeInvoices.js ile deneme temizlenmiş olmalı.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFirestore } from "firebase-admin/firestore";
import { ensureAdmin } from "../adminInit.js";
import { syncApprovedInvoiceToEta } from "../etaInvoiceSync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIST = path.join(__dirname, "_denemeEvrakList.json");

function docIdForBelgeNo(belgeNo) {
  const key = String(belgeNo || "").trim();
  return `invoice_${key.replace(/[/\\]/g, "_")}`;
}

async function main() {
  if (!fs.existsSync(LIST)) {
    throw new Error(`Evrak listesi yok: ${LIST}. Önce captureDenemeEvrakList.js çalıştırın.`);
  }
  const evraks = JSON.parse(fs.readFileSync(LIST, "utf8"));
  if (!Array.isArray(evraks) || !evraks.length) {
    throw new Error("Evrak listesi boş.");
  }

  ensureAdmin();
  const db = getFirestore();

  let ok = 0;
  let err = 0;
  for (const evrak of evraks) {
    const docId = docIdForBelgeNo(evrak);
    const ref = db.collection("qnb_invoices").doc(docId);
    let snap = await ref.get();
    if (!snap.exists) {
      const archRef = db.collection("qnb_invoices_archive").doc(docId);
      const arch = await archRef.get();
      if (!arch.exists) {
        console.log(`[SKIP-MISSING] ${docId} Firestore'da yok (aktif veya arsiv).`);
        err++;
        continue;
      }
      const archData = { ...(arch.data() || {}) };
      delete archData.archivedAt;
      delete archData.archivedFrom;
      await ref.set(archData, { merge: true });
      const archSub = await archRef.collection("despatches").get();
      for (const sd of archSub.docs) {
        await ref.collection("despatches").doc(sd.id).set(sd.data() || {}, { merge: true });
      }
      console.log(`[RESTORE] ${docId} arsivden aktif koleksiyona geri yuklendi (despatches=${archSub.size}).`);
      snap = await ref.get();
    }
    const data = snap.data() || {};
    const onay = String(data.onayDurumu || "")
      .trim()
      .toLowerCase()
      .replaceAll("ı", "i");
    if (onay !== "onaylandi") {
      console.log(`[SKIP-NOT-APPROVED] ${docId} onay=${data.onayDurumu || "-"}`);
      err++;
      continue;
    }
    try {
      console.log(`[SYNC] ${docId} (${evrak}) ...`);
      const result = await syncApprovedInvoiceToEta(data, docId);
      console.log(`[OK] ${docId}: ${JSON.stringify(result)}`);
      ok++;
    } catch (e) {
      console.error(`[ERR] ${docId}: ${e?.message || e}`);
      err++;
    }
  }
  console.log(`\nBitti. ok=${ok} err=${err} total=${evraks.length}`);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exitCode = 1;
});
