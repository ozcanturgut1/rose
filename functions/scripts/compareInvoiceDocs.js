/**
 * İki belgeyi karşılaştırmak ve son sync zamanlarını görmek için tanı scripti.
 * Sadece okur; hiçbir şey değiştirmez.
 *
 * Çalıştırma: node scripts/compareInvoiceDocs.js
 */
import "dotenv/config";
import { getFirestore } from "firebase-admin/firestore";
import { ensureAdmin } from "../adminInit.js";

function fmtTs(v) {
  if (!v) return "-";
  if (typeof v?.toDate === "function") return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === "object" && "_seconds" in v) {
    return new Date(v._seconds * 1000).toISOString();
  }
  return String(v);
}

function dumpInvoice(label, snap) {
  console.log(`\n--- ${label} ---`);
  if (!snap.exists) {
    console.log("  (yok)");
    return;
  }
  const d = snap.data() || {};
  const q = d.qnbRaw && typeof d.qnbRaw === "object" ? d.qnbRaw : {};
  console.log(`  id              = ${snap.id}`);
  console.log(`  type            = ${d.type ?? "-"}`);
  console.log(`  belgeNo         = ${d.belgeNo ?? "-"}`);
  console.log(`  ettn            = ${d.ettn ?? "-"}`);
  console.log(`  externalId      = ${d.externalId ?? "-"}`);
  console.log(`  status          = ${d.status ?? "-"}`);
  console.log(`  onayDurumu      = ${d.onayDurumu ?? "-"}`);
  console.log(`  etaKayitDurumu  = ${d.etaKayitDurumu ?? "-"}`);
  console.log(`  createdAt       = ${fmtTs(d.createdAt)}`);
  console.log(`  updatedAt       = ${fmtTs(d.updatedAt)}`);
  console.log(`  qnbRaw.belgeNo  = ${q.belgeNo ?? "-"}`);
  console.log(`  qnbRaw.belgeTarihi  = ${q.belgeTarihi ?? "-"}`);
  console.log(`  qnbRaw.gelisTarihi  = ${q.gelisTarihi ?? "-"}`);
  console.log(`  qnbRaw.gonderimTarihi = ${q.gonderimTarihi ?? "-"}`);
  console.log(`  qnbRaw.belgeOid     = ${q.belgeOid ?? "-"}`);
  console.log(`  qnbRaw.faturaTipi   = ${q.faturaTipi ?? "-"}`);
  console.log(`  qnbRaw.gondericiVkn = ${q.gondericiVkn ?? "-"}`);
  console.log(`  qnbRaw.gondericiUnvan = ${q.gondericiUnvan ?? "-"}`);
  const allRawKeys = Object.keys(q).sort();
  console.log(`  qnbRaw keys (${allRawKeys.length}) = ${allRawKeys.join(", ")}`);
}

async function main() {
  ensureAdmin();
  const db = getFirestore();
  const ids = ["invoice_NAS2026000000246", "invoice_KRS2026000034053"];
  for (const id of ids) {
    const [inv, arch] = await Promise.all([
      db.collection("qnb_invoices").doc(id).get(),
      db.collection("qnb_invoices_archive").doc(id).get(),
    ]);
    dumpInvoice(`qnb_invoices/${id}`, inv);
    dumpInvoice(`qnb_invoices_archive/${id}`, arch);
  }

  console.log("\n--- En yeni 5 qnb_invoices (createdAt DESC) ---");
  const recent = await db
    .collection("qnb_invoices")
    .orderBy("createdAt", "desc")
    .limit(5)
    .get();
  for (const d of recent.docs) {
    const v = d.data() || {};
    const q = v.qnbRaw || {};
    console.log(
      `  ${d.id}  createdAt=${fmtTs(v.createdAt)}  belgeTarihi=${q.belgeTarihi ?? "-"}  gelisTarihi=${q.gelisTarihi ?? "-"}`
    );
  }

  console.log("\n--- belgeTarihi=20260502 olan kayıtlar ---");
  const byBelgeTarihi = await db
    .collection("qnb_invoices")
    .where("qnbRaw.belgeTarihi", "==", "20260502")
    .limit(10)
    .get();
  console.log(`  bulunan: ${byBelgeTarihi.size}`);
  for (const d of byBelgeTarihi.docs) {
    const v = d.data() || {};
    console.log(`  ${d.id}  createdAt=${fmtTs(v.createdAt)}`);
  }
}

main().catch((e) => {
  console.error("compareInvoiceDocs failed:", e?.message || e);
  process.exitCode = 1;
});
