/**
 * Belirli bir qnb_invoices dokümanının oluşturulma izini gösterir:
 *  - createdAt / updatedAt
 *  - status, onayDurumu, etaKayitDurumu, type
 *  - qnbRaw alanları (gelisTarihi, belgeTarihi, belgeNo, ettn, vs.)
 *  - despatches alt koleksiyonunda kaç kayıt var
 *  - relatedBelgeNos
 *  - hangi alan setine sahip olduğuna bakarak hangi yol tarafından yazılmış olabilir tahmini
 *
 * Hiçbir şey değiştirmez. Sadece okur.
 *
 * Çalıştırma: node scripts/showQnbInvoiceTrace.js <belgeNoOrDocId>
 * Örnek: node scripts/showQnbInvoiceTrace.js KRS2026000034053
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

function normalizeDocId(arg) {
  const s = String(arg || "").trim();
  if (!s) return null;
  if (s.startsWith("invoice_")) return s;
  return `invoice_${s.replace(/[/\\]/g, "_")}`;
}

async function showOne(db, label, col, docId) {
  const snap = await db.collection(col).doc(docId).get();
  console.log(`\n=== ${label}  (${col}/${docId}) ===`);
  if (!snap.exists) {
    console.log("  exists=false");
    return null;
  }
  const d = snap.data() || {};
  const q = d.qnbRaw && typeof d.qnbRaw === "object" ? d.qnbRaw : {};

  console.log(`  exists                = true`);
  console.log(`  createdAt             = ${fmtTs(d.createdAt)}`);
  console.log(`  updatedAt             = ${fmtTs(d.updatedAt)}`);
  console.log(`  type                  = ${d.type ?? "-"}`);
  console.log(`  status                = ${d.status ?? "-"}`);
  console.log(`  onayDurumu            = ${d.onayDurumu ?? "-"}`);
  console.log(`  etaKayitDurumu        = ${d.etaKayitDurumu ?? "-"}`);
  console.log(`  qnbBelgeTuru          = ${d.qnbBelgeTuru ?? "-"}`);
  console.log(`  belgeNo               = ${d.belgeNo ?? "-"}`);
  console.log(`  ettn                  = ${d.ettn ?? "-"}`);
  console.log(`  externalId            = ${d.externalId ?? "-"}`);
  console.log(`  qnbRaw.gelisTarihi    = ${q.gelisTarihi ?? "-"}`);
  console.log(`  qnbRaw.belgeTarihi    = ${q.belgeTarihi ?? "-"}`);
  console.log(`  qnbRaw.gonderimTarihi = ${q.gonderimTarihi ?? "-"}`);
  console.log(`  qnbRaw.faturaTipi     = ${q.faturaTipi ?? "-"}`);
  console.log(`  qnbRaw.faturaProfili  = ${q.faturaProfili ?? "-"}`);
  console.log(`  qnbRaw.odenecekTutar  = ${q.odenecekTutar ?? "-"}`);
  console.log(`  relatedBelgeNos       = ${JSON.stringify(d.relatedBelgeNos ?? null)}`);
  console.log(`  ublParsed?            = ${d.ublParsed ? "var" : "yok"}`);
  console.log(`  contentUbl?           = ${d.contentUbl ? `var (${String(d.contentUbl).length} chr)` : "yok"}`);

  try {
    const sub = await snap.ref.collection("despatches").get();
    console.log(`  despatches alt koleksiyonu satır = ${sub.size}`);
  } catch (_) {
    console.log(`  despatches alt koleksiyonu      = (okunamadı)`);
  }

  const allKeys = Object.keys(d).sort();
  console.log(`  toplam alan sayısı: ${allKeys.length}`);
  console.log(`  tüm alanlar: ${allKeys.join(", ")}`);

  return d;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: node scripts/showQnbInvoiceTrace.js <belgeNoOrDocId> [<ikinciBelgeNo> ...]");
    process.exitCode = 1;
    return;
  }
  const args = process.argv.slice(2);

  ensureAdmin();
  const db = getFirestore();

  for (const a of args) {
    const docId = normalizeDocId(a);
    if (!docId) continue;
    await showOne(db, "qnb_invoices", "qnb_invoices", docId);
    await showOne(db, "qnb_invoices_archive", "qnb_invoices_archive", docId);
  }
}

main().catch((e) => {
  console.error("showQnbInvoiceTrace failed:", e?.message || e);
  process.exitCode = 1;
});
