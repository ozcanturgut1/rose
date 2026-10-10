/**
 * Bir faturanın irsaliye eşleştirmesini tamamlar: otomatik akışın (autoSupplierInvoicePipeline)
 * 2-3-4. adımlarını yalnızca bu fatura için, beklemeden çalıştırır.
 *
 *   2) Faturanın `despatches` kayıtlarındaki her irsaliyeyi portalda arar ve
 *      `qnb_docs/despatch_<no>` önbelleğine ETTN + UBL ile yazar.
 *   3) Önbellekteki ETTN'leri faturanın `despatches` kayıtlarına yazar.
 *   4) ETTN'i olan kayıtlara irsaliye UBL'ini yazar.
 *
 * Ne zaman gerekir: irsaliye portalda olduğu halde akış onu bulamadıysa (ör. portal
 * listesinin 100 satır sınırı; bkz. qnbDespatchPortalLookup.js) ve bir sonraki
 * turu beklemek istemiyorsanız. Faturanın UBL'inde irsaliye referansı hiç yoksa
 * `despatches` boştur; bu script o durumu çözmez.
 *
 * Güvenlik: varsayılan DRY-RUN (yalnızca okur, portalda yalnızca liste sorgusu yapar).
 *
 * Çalıştırma:
 *   node scripts/repairInvoiceDespatches.js ERD2026000002480
 *   node scripts/repairInvoiceDespatches.js ERD2026000002480 --apply --confirm
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAdmin } from "../adminInit.js";
import { getFirestore } from "firebase-admin/firestore";

const ETTN_REGEX = /^[0-9A-Fa-f-]{30,}$/;
const looksLikeDespatchXml = (s) =>
  /^\s*<\?xml|^\s*<(\w+:)?DespatchAdvice\s|^\s*<DespatchAdvice\s/.test((s || "").slice(0, 2048));

function parseArgs(argv) {
  const out = { apply: false, confirm: false, belgeNo: null };
  for (const a of argv.slice(2)) {
    if (a === "--apply") out.apply = true;
    else if (a === "--confirm") out.confirm = true;
    else if (!a.startsWith("--")) out.belgeNo = a.trim();
  }
  return out;
}

function invoiceDocId(arg) {
  const s = String(arg || "").trim();
  if (!s) return null;
  return s.startsWith("invoice_") ? s : `invoice_${s.replace(/[/\\]/g, "_")}`;
}

async function describeDespatches(db, invRef) {
  const snap = await invRef.collection("despatches").get();
  const rows = [];
  for (const d of snap.docs) {
    const x = d.data() || {};
    const belgeNo = String(x.belgeNo ?? x.belgeNoStr ?? "").trim();
    const cache = belgeNo
      ? await db.collection("qnb_docs").doc(`despatch_${belgeNo.replace(/[/\\]/g, "_")}`).get()
      : null;
    const c = cache?.exists ? cache.data() || {} : null;
    rows.push({
      belgeNo,
      issueDate: x.issueDate ? String(x.issueDate).trim() : "",
      ettn: ETTN_REGEX.test(String(x.ettn || "").trim()) ? String(x.ettn).trim() : null,
      hasUbl: looksLikeDespatchXml(x.contentUbl),
      cache: c
        ? { ettn: ETTN_REGEX.test(String(c.ettn || "").trim()), ubl: looksLikeDespatchXml(c.contentUbl) }
        : null,
    });
  }
  return rows;
}

function printRows(rows) {
  for (const r of rows) {
    const cache = r.cache ? `ettn=${r.cache.ettn ? "var" : "yok"} ubl=${r.cache.ubl ? "var" : "yok"}` : "YOK";
    console.log(
      `  ${r.belgeNo || "(belgeNo yok)"}  tarih=${r.issueDate || "-"}  ettn=${r.ettn ?? "-"}  ubl=${r.hasUbl ? "var" : "yok"}  qnb_docs: ${cache}`
    );
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const docId = invoiceDocId(args.belgeNo);
  if (!docId) {
    throw new Error("Kullanım: node scripts/repairInvoiceDespatches.js <faturaBelgeNo> [--apply --confirm]");
  }
  if (args.apply && !args.confirm) throw new Error("Apply için --confirm gerekli.");

  const vknTckn = String(process.env.QNB_VKN_TCKN || "").trim();
  if (!vknTckn) throw new Error("QNB_VKN_TCKN tanımlı değil.");

  ensureAdmin();
  const db = getFirestore();
  // Modül yüklenirken ağ çağrısı yapmaz; yalnızca fonksiyonlar kullanılıyor.
  const { processDespatchTarget, applyEttnFromQnbDocsForInvoice, enrichUblForInvoiceDespatches } =
    await import("../autoSupplierInvoicePipeline.js");
  const { findDespatchInPortal } = await import("../qnbDespatchPortalLookup.js");

  console.log("=".repeat(72));
  console.log(`IRSALIYE ESLESTIRME ONARIMI   Mod: ${args.apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Fatura: ${docId}`);
  console.log("=".repeat(72));

  const invRef = db.collection("qnb_invoices").doc(docId);
  const invSnap = await invRef.get();
  if (!invSnap.exists) throw new Error(`Fatura bulunamadı: qnb_invoices/${docId}`);

  const once = await describeDespatches(db, invRef);
  console.log(`\nMevcut durum (${once.length} irsaliye):`);
  printRows(once);
  if (!once.length) {
    console.log("\nFaturanın UBL'inde irsaliye referansı yok; yapılacak bir şey yok.");
    return;
  }

  const eksik = once.filter((r) => r.belgeNo && !(r.cache?.ettn && r.cache?.ubl));
  console.log(`\nPortalda aranacak (qnb_docs eksik): ${eksik.length}`);
  for (const r of eksik) {
    const found = await findDespatchInPortal(vknTckn, r.belgeNo, { issueDate: r.issueDate });
    const yol = found.queries.map((q) => `${q.by}:${q.from}..${q.to}=${q.count ?? `HATA(${q.error})`}`).join(" ");
    console.log(
      `  ${r.belgeNo}: ${found.item ? `BULUNDU ettn=${found.item.ettn ?? "-"}` : found.error ? "PORTAL HATASI" : "bulunamadı"}  [${yol}]`
    );
  }

  if (!args.apply) {
    console.log("\nDRY-RUN: hiçbir doküman değiştirilmedi. Uygulamak için:");
    console.log(`  node scripts/repairInvoiceDespatches.js ${args.belgeNo} --apply --confirm`);
    return;
  }

  console.log("\nUygulanıyor...");
  for (const r of eksik) {
    const sonuc = await processDespatchTarget(vknTckn, r.belgeNo, r.issueDate);
    console.log(`  adım 2 ${r.belgeNo}: ${sonuc}`);
  }
  const s3 = await applyEttnFromQnbDocsForInvoice(invRef);
  console.log(`  adım 3 (ETTN): ${JSON.stringify(s3)}`);
  const s4 = await enrichUblForInvoiceDespatches(invRef, vknTckn);
  console.log(`  adım 4 (UBL):  ${JSON.stringify(s4)}`);

  const sonra = await describeDespatches(db, invRef);
  console.log("\nSon durum:");
  printRows(sonra);
  const tamam = sonra.every((r) => r.ettn && r.hasUbl);
  console.log(tamam ? "\nTüm irsaliyeler eşleşti." : "\n[UYARI] Eşleşmeyen irsaliye kaldı.");
  if (!tamam) process.exitCode = 2;
}

const isRunDirectly = (() => {
  const a1 = process.argv[1];
  if (!a1) return false;
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(a1);
  } catch {
    return false;
  }
})();

if (isRunDirectly) {
  main().catch((e) => {
    console.error("repairInvoiceDespatches failed:", e?.message || e);
    process.exitCode = 1;
  });
}
