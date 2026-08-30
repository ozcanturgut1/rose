/**
 * `beklemede_plaka` durumundaki faturaların blokajını kaldırır ve plaka tespitini
 * sıfırlar, böylece bir sonraki turda tespit baştan koşar.
 *
 * Ne zaman gerekir: worker `tanimsiz` blokajlarını kendiliğinden çözer (araç
 * `company_vehicles`'a eklenince). Bu script asıl olarak `eksik` durumu için var:
 * UBL'de hiç plaka bulunamamışsa otomatik kurtarma çalışmaz. Ayrıca UBL'deki
 * plakanın yanlış okunduğu ya da tespiti bilerek yeniden çalıştırmak istediğiniz
 * durumlarda kullanılır.
 *
 * Neden yalnızca `etaKayitDurumu`'nu temizlemek yetmez: `evaluateAracPlakaKapisi`
 * tespiti yalnızca `aracGideriTedarikci` alanı HİÇ yazılmamışsa yeniden koşar.
 * Blokaj sırasında bu alan yazıldığı için, alan durduğu sürece kapı bayat
 * `aracPlakaDurumu` değerini okuyup aynı blokajı tekrar yazar. Bu yüzden tespit
 * alanları da siliniyor.
 *
 * Güvenlik: varsayılan DRY-RUN.
 *
 * Çalıştırma:
 *   node scripts/resetPlakaBlokaji.js
 *   node scripts/resetPlakaBlokaji.js --doc=invoice_ERD2026000002007
 *   node scripts/resetPlakaBlokaji.js --apply --confirm
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAdmin } from "../adminInit.js";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const COLLECTION = "qnb_invoices";

// Blokaj + tespit izleri. Tespitin sıfırdan koşması için aracGideriTedarikci de
// silinmeli; kapının yeniden tespit koşulu tam olarak bu alanın yokluğu.
const SILINECEK_ALANLAR = [
  "etaKayitDurumu",
  "etaKayitHata",
  "aracGideriTedarikci",
  "aracGideriVkn",
  "aracPlakaDurumu",
  "aracTespit",
  "tespitEdilenPlakalar",
];

function parseArgs(argv) {
  const out = { apply: false, confirm: false, docId: null };
  for (const a of argv.slice(2)) {
    if (a === "--apply") out.apply = true;
    else if (a === "--confirm") out.confirm = true;
    else if (a.startsWith("--doc=")) out.docId = a.slice("--doc=".length).trim();
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  ensureAdmin();
  const db = getFirestore();

  console.log("=".repeat(72));
  console.log(`PLAKA BLOKAJI SIFIRLAMA   Mod: ${args.apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Hedef: ${args.docId ? args.docId : "beklemede_plaka olan tum faturalar"}`);
  console.log("=".repeat(72));

  if (args.apply && !args.confirm) {
    throw new Error("Apply için --confirm gerekli.");
  }

  let hedefler = [];
  if (args.docId) {
    const snap = await db.collection(COLLECTION).doc(args.docId).get();
    if (!snap.exists) throw new Error(`Doküman bulunamadı: ${args.docId}`);
    const d = snap.data() || {};
    if (String(d.etaKayitDurumu || "") !== "beklemede_plaka") {
      console.log(
        `[UYARI] ${args.docId} 'beklemede_plaka' durumunda değil (etaKayitDurumu='${d.etaKayitDurumu ?? "-"}').`
      );
    }
    hedefler = [snap];
  } else {
    const q = await db
      .collection(COLLECTION)
      .where("etaKayitDurumu", "==", "beklemede_plaka")
      .get();
    hedefler = q.docs;
  }

  console.log(`\nBulunan doküman: ${hedefler.length}`);
  for (const s of hedefler) {
    const d = s.data() || {};
    console.log(
      `  ${s.id}  plakaDurumu=${d.aracPlakaDurumu ?? "-"}  plakalar=${JSON.stringify(d.tespitEdilenPlakalar ?? [])}`
    );
    const mevcut = SILINECEK_ALANLAR.filter((a) => d[a] !== undefined);
    console.log(`      silinecek alanlar: ${mevcut.length ? mevcut.join(", ") : "(yok)"}`);
  }

  if (!hedefler.length) {
    console.log("\nYapılacak bir şey yok.");
    return;
  }

  if (!args.apply) {
    console.log("\nDRY-RUN: hiçbir doküman değiştirilmedi. Uygulamak için:");
    console.log(
      `  node scripts/resetPlakaBlokaji.js${args.docId ? ` --doc=${args.docId}` : ""} --apply --confirm`
    );
    return;
  }

  const silme = {};
  for (const a of SILINECEK_ALANLAR) silme[a] = FieldValue.delete();
  silme.etaIslemKilitBitisMs = 0;
  silme.etaKayitGuncellemeTarihi = FieldValue.serverTimestamp();

  let sayac = 0;
  for (const s of hedefler) {
    await s.ref.set(silme, { merge: true });
    sayac++;
    console.log(`  [OK] ${s.id} sıfırlandı`);
  }
  console.log(`\n${sayac} doküman sıfırlandı. Worker bir sonraki turda tespiti yeniden koşacak.`);
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
    console.error("resetPlakaBlokaji failed:", e?.message || e);
    process.exitCode = 1;
  });
}
