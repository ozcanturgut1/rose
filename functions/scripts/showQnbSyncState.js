/**
 * qnb_sync_state/app dokümanını okur ve cursor durumunu insan-okuyabilir biçimde yazdırır.
 * Hiçbir veri değiştirmez. Sadece Firestore SELECT.
 *
 * Çalıştırma: node scripts/showQnbSyncState.js
 */
import "dotenv/config";
import { getFirestore } from "firebase-admin/firestore";
import { ensureAdmin } from "../adminInit.js";

function fmtTs(v) {
  if (!v) return "-";
  if (typeof v.toDate === "function") return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function obj(o) {
  return o && typeof o === "object" ? o : {};
}

async function main() {
  ensureAdmin();
  const db = getFirestore();
  const ref = db.collection("qnb_sync_state").doc("app");
  const snap = await ref.get();
  if (!snap.exists) {
    console.log("qnb_sync_state/app dokümanı YOK.");
    return;
  }
  const d = snap.data() || {};

  console.log("=".repeat(72));
  console.log("qnb_sync_state/app durumu");
  console.log("=".repeat(72));

  console.log("\n--- syncQnbDocs cursor (günlük, 30-gün chunk) ---");
  console.log(`  invoiceNextFrom = ${d.invoiceNextFrom ?? "-"}`);
  console.log(`  updatedAt       = ${fmtTs(d.updatedAt)}`);

  const byYear = obj(d.invoicePageStartByYear);
  const lastFrom = obj(d.invoicePageLastFromByYear);
  const lastTo = obj(d.invoicePageLastToByYear);
  const lastRun = obj(d.invoicePageLastRunAtByYear);
  const lastStart = obj(d.invoicePageLastStartByYear);

  console.log("\n--- syncAllInvoices cursor (yıllık, 7-gün pencere) ---");
  const years = new Set([
    ...Object.keys(byYear),
    ...Object.keys(lastFrom),
    ...Object.keys(lastTo),
    ...Object.keys(lastRun),
    ...Object.keys(lastStart),
  ]);
  if (!years.size) {
    console.log("  (yıllık cursor kaydı yok)");
  } else {
    const sortedYears = Array.from(years).sort();
    for (const y of sortedYears) {
      console.log(`  Yıl ${y}:`);
      console.log(`    invoicePageStartByYear[${y}]   (sonraki pencere indeksi) = ${byYear[y] ?? "-"}`);
      console.log(`    invoicePageLastStartByYear[${y}] (son işlenen indeks)    = ${lastStart[y] ?? "-"}`);
      console.log(`    invoicePageLastFromByYear[${y}] (son işlenen FROM)       = ${lastFrom[y] ?? "-"}`);
      console.log(`    invoicePageLastToByYear[${y}]   (son işlenen TO)         = ${lastTo[y] ?? "-"}`);
      console.log(`    invoicePageLastRunAtByYear[${y}]                          = ${fmtTs(lastRun[y])}`);
    }
  }

  console.log("\n--- Diğer alanlar ---");
  const known = new Set([
    "invoiceNextFrom",
    "invoicePageStartByYear",
    "invoicePageLastFromByYear",
    "invoicePageLastToByYear",
    "invoicePageLastRunAtByYear",
    "invoicePageLastStartByYear",
    "updatedAt",
  ]);
  const extras = Object.keys(d).filter((k) => !known.has(k));
  if (!extras.length) {
    console.log("  (yok)");
  } else {
    for (const k of extras) {
      const v = d[k];
      const printable =
        v && typeof v === "object" && !Array.isArray(v)
          ? JSON.stringify(v, null, 2)
          : Array.isArray(v)
            ? JSON.stringify(v)
            : String(v);
      console.log(`  ${k} = ${printable}`);
    }
  }

  console.log("\n--- NAS2026000000246 belge kontrolü ---");
  const docId = "invoice_NAS2026000000246";
  const [invSnap, archSnap] = await Promise.all([
    db.collection("qnb_invoices").doc(docId).get(),
    db.collection("qnb_invoices_archive").doc(docId).get(),
  ]);
  console.log(`  qnb_invoices/${docId}        exists=${invSnap.exists}`);
  console.log(`  qnb_invoices_archive/${docId} exists=${archSnap.exists}`);
  if (invSnap.exists) {
    const v = invSnap.data() || {};
    console.log(`    onayDurumu=${v.onayDurumu ?? "-"}  etaKayitDurumu=${v.etaKayitDurumu ?? "-"}  belgeNo=${v.belgeNo ?? "-"}  gelisTarihi=${v.qnbRaw?.gelisTarihi ?? "-"}`);
  }
  if (archSnap.exists) {
    const v = archSnap.data() || {};
    console.log(`    onayDurumu=${v.onayDurumu ?? "-"}  etaKayitDurumu=${v.etaKayitDurumu ?? "-"}  belgeNo=${v.belgeNo ?? "-"}  archivedAt=${fmtTs(v.archivedAt)}`);
  }
}

main().catch((e) => {
  console.error("showQnbSyncState failed:", e?.message || e);
  process.exitCode = 1;
});
