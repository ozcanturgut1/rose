/**
 * suppliers/iplik + suppliers/kumas içindeki VKN'leri ve verilen fatura(lar)ın
 * gondericiVkn'sini yazdırır. autoSupplierInvoicePipeline filtresinin neden
 * X faturasını alıp Y faturasını almadığını göstermek için.
 *
 * Çalıştırma:
 *   node scripts/showSupplierFilterContext.js <belgeNo1> [<belgeNo2> ...]
 */
import "dotenv/config";
import { getFirestore } from "firebase-admin/firestore";
import { ensureAdmin } from "../adminInit.js";

function digitsOnly(raw) {
  if (raw == null) return "";
  return String(raw).replace(/\D/g, "");
}

function consumeVknValue(raw, out) {
  if (raw == null) return;
  if (Array.isArray(raw)) {
    for (const e of raw) {
      const v = digitsOnly(e);
      if (v) out.add(v);
    }
    return;
  }
  const s = String(raw).trim();
  if (!s) return;
  if (s.includes(",") || s.includes(";")) {
    for (const part of s.split(/[,;]\s*/)) {
      const v = digitsOnly(part);
      if (v) out.add(v);
    }
    return;
  }
  const v = digitsOnly(s);
  if (v) out.add(v);
}

function gondericiVknFromItem(it) {
  if (!it || typeof it !== "object") return null;
  const cand =
    it.gondericiVkn ??
    it.gondericiVergiNumarasi ??
    it.gonderenVkn ??
    it.supplierVkn ??
    it.vkn ??
    null;
  const s = digitsOnly(cand);
  return s || null;
}

function normalizeDocId(arg) {
  const s = String(arg || "").trim();
  if (!s) return null;
  if (s.startsWith("invoice_")) return s;
  return `invoice_${s.replace(/[/\\]/g, "_")}`;
}

async function loadAllowed(db) {
  const out = new Set();
  const perDoc = {};
  for (const docId of ["iplik", "kumas"]) {
    const snap = await db.collection("suppliers").doc(docId).get();
    if (!snap.exists) {
      perDoc[docId] = { exists: false, count: 0 };
      continue;
    }
    const d = snap.data() || {};
    const local = new Set();
    consumeVknValue(d.vkns, local);
    consumeVknValue(d.vkn, local);
    consumeVknValue(d.vknList, local);
    perDoc[docId] = { exists: true, count: local.size, sample: Array.from(local).slice(0, 10) };
    for (const v of local) out.add(v);
  }
  return { allowed: out, perDoc };
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error("Usage: node scripts/showSupplierFilterContext.js <belgeNo1> [<belgeNo2> ...]");
    process.exitCode = 1;
    return;
  }
  ensureAdmin();
  const db = getFirestore();

  const { allowed, perDoc } = await loadAllowed(db);
  console.log("=".repeat(72));
  console.log("autoSupplierInvoicePipeline VKN filtresi durumu");
  console.log("=".repeat(72));
  for (const k of Object.keys(perDoc)) {
    const v = perDoc[k];
    if (!v.exists) {
      console.log(`  suppliers/${k}  YOK`);
    } else {
      console.log(
        `  suppliers/${k}  VKN sayısı=${v.count}  örnek=${JSON.stringify(v.sample)}`
      );
    }
  }
  console.log(`  TOPLAM izinli VKN sayısı = ${allowed.size}`);

  for (const a of args) {
    const docId = normalizeDocId(a);
    if (!docId) continue;
    console.log(`\n--- ${docId} ---`);
    let snap = await db.collection("qnb_invoices").doc(docId).get();
    let col = "qnb_invoices";
    if (!snap.exists) {
      snap = await db.collection("qnb_invoices_archive").doc(docId).get();
      col = "qnb_invoices_archive";
    }
    if (!snap.exists) {
      console.log("  qnb_invoices ve archive: yok");
      console.log("  → Firestore'da hiç kaydedilmemiş. (autoPipeline VKN listesinde olmayan tedarikçiye ait olabilir.)");
      continue;
    }
    const d = snap.data() || {};
    const q = d.qnbRaw && typeof d.qnbRaw === "object" ? d.qnbRaw : {};
    const vkn = gondericiVknFromItem(q);
    const isAllowed = vkn ? allowed.has(vkn) : false;
    console.log(`  bulundu       = ${col}`);
    console.log(`  belgeNo       = ${d.belgeNo ?? "-"}`);
    console.log(`  qnbRaw.gondericiVkn (veya alternatif) = ${vkn ?? "(bulunamadı)"}`);
    console.log(`  qnbRaw.gondericiUnvan  = ${q.gondericiUnvan ?? q.unvan ?? q.gondericiAdSoyad ?? "-"}`);
    console.log(`  qnbRaw.gelisTarihi     = ${q.gelisTarihi ?? "-"}`);
    console.log(`  qnbRaw.belgeTarihi     = ${q.belgeTarihi ?? "-"}`);
    console.log(`  VKN allowed listede mi = ${isAllowed ? "EVET (autoPipeline alır)" : "HAYIR (autoPipeline atlar)"}`);
  }
}

main().catch((e) => {
  console.error("showSupplierFilterContext failed:", e?.message || e);
  process.exitCode = 1;
});
