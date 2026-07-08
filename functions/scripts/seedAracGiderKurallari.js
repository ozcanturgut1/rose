/**
 * app_config/arac_gider_kurallari başlangıç dokümanını oluşturur (2026 varsayılanları).
 * Sonrasında değerler Firebase Console'dan güncellenebilir.
 *
 * Not: Doküman olmasa bile backend varsayılanları (aracGiderKurallari.js) kullanır;
 * bu script yalnızca Console'da düzenlenebilir bir doküman oluşturmak içindir.
 *
 * Güvenlik: default DRY-RUN.
 *   node scripts/seedAracGiderKurallari.js
 *   node scripts/seedAracGiderKurallari.js --apply
 */
import "dotenv/config";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { ensureAdmin } from "../adminInit.js";
import { DEFAULT_ARAC_GIDER_KURALLARI } from "../aracGiderKurallari.js";

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  ensureAdmin();
  const db = getFirestore();
  const ref = db.collection("app_config").doc("arac_gider_kurallari");

  const snap = await ref.get();
  console.log("=".repeat(64));
  console.log(`app_config/arac_gider_kurallari  Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Mevcut doküman: ${snap.exists ? "var" : "yok"}`);
  console.log("Yazılacak varsayılan:");
  console.log(JSON.stringify(DEFAULT_ARAC_GIDER_KURALLARI, null, 2));
  console.log("=".repeat(64));

  // Mevcut dokümanda eksik olan hesap anahtarlarını (yeni gider türleri) hesapla;
  // var olan değerleri ASLA ezme.
  const mevcutHesaplar = (snap.data() || {}).hesaplar || {};
  const eksikHesaplar = {};
  for (const [k, v] of Object.entries(DEFAULT_ARAC_GIDER_KURALLARI.hesaplar)) {
    if (mevcutHesaplar[k] === undefined) eksikHesaplar[k] = v;
  }
  if (snap.exists) {
    const eksikSayi = Object.keys(eksikHesaplar).length;
    console.log(`Eklenecek eksik hesap anahtarları (${eksikSayi}):`);
    console.log(JSON.stringify(eksikHesaplar, null, 2));
  }

  if (!apply) {
    console.log("DRY-RUN: yazılmadı. Uygulamak için: node scripts/seedAracGiderKurallari.js --apply");
    return;
  }

  if (snap.exists) {
    if (Object.keys(eksikHesaplar).length === 0) {
      console.log("Doküman güncel; eklenecek yeni hesap yok. İşlem yok.");
      return;
    }
    // Sadece eksik hesap anahtarlarını noktalı yol ile ekle (mevcutları koru).
    const patch = { updatedAt: FieldValue.serverTimestamp() };
    for (const [k, v] of Object.entries(eksikHesaplar)) patch[`hesaplar.${k}`] = v;
    await ref.update(patch);
    console.log(`[OK] ${Object.keys(eksikHesaplar).length} yeni hesap anahtarı eklendi (mevcutlar korundu).`);
    return;
  }

  await ref.set(
    { ...DEFAULT_ARAC_GIDER_KURALLARI, createdAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
  console.log("[OK] app_config/arac_gider_kurallari oluşturuldu.");
}

main().catch((e) => {
  console.error("seedAracGiderKurallari failed:", e?.message || e);
  process.exitCode = 1;
});
