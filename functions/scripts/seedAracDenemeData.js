/**
 * suppliers/arac_gideri ve company_vehicles koleksiyonlarını ÖRNEK (deneme) verisiyle
 * oluşturur. Amaç: yapıyı göstermek; gerçek kayıtları kullanıcı Console'dan ekler/değiştirir.
 *
 * Örnek dokümanlar `ornek: true` ile işaretlidir (gerçek veriden ayırt etmek için).
 *
 * Güvenlik: default DRY-RUN.
 *   node scripts/seedAracDenemeData.js
 *   node scripts/seedAracDenemeData.js --apply
 */
import "dotenv/config";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { ensureAdmin } from "../adminInit.js";

const SUPPLIER_DOC = {
  vkns: ["1111111111", "2222222222"], // DENEME VKN'leri — gerçekleriyle değiştirin
  aciklama: "Araç gideri (plaka zorunlu) tedarikçileri — DENEME",
  ornek: true,
};

const VEHICLES = [
  {
    id: "34ABC123",
    data: {
      plaka: "34 ABC 123",
      plakaNormalize: "34ABC123",
      tip: "binek",
      aktif: true,
      marka: "DENEME",
      model: "Örnek Binek",
      ornek: true,
    },
  },
  {
    id: "34XYZ456",
    data: {
      plaka: "34 XYZ 456",
      plakaNormalize: "34XYZ456",
      tip: "ticari",
      aktif: true,
      marka: "DENEME",
      model: "Örnek Ticari",
      ornek: true,
    },
  },
];

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  ensureAdmin();
  const db = getFirestore();

  console.log("=".repeat(64));
  console.log(`Araç deneme verisi  Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log("suppliers/arac_gideri:");
  console.log(JSON.stringify(SUPPLIER_DOC, null, 2));
  console.log("company_vehicles:");
  for (const v of VEHICLES) console.log(`  ${v.id} => ${JSON.stringify(v.data)}`);
  console.log("=".repeat(64));

  if (!apply) {
    console.log("DRY-RUN: yazılmadı. Uygulamak için: node scripts/seedAracDenemeData.js --apply");
    return;
  }

  const supRef = db.collection("suppliers").doc("arac_gideri");
  const supSnap = await supRef.get();
  if (supSnap.exists) {
    console.log("suppliers/arac_gideri zaten var; üzerine yazılmadı.");
  } else {
    await supRef.set({ ...SUPPLIER_DOC, createdAt: FieldValue.serverTimestamp() }, { merge: true });
    console.log("[OK] suppliers/arac_gideri oluşturuldu.");
  }

  for (const v of VEHICLES) {
    const ref = db.collection("company_vehicles").doc(v.id);
    const snap = await ref.get();
    if (snap.exists) {
      console.log(`company_vehicles/${v.id} zaten var; üzerine yazılmadı.`);
    } else {
      await ref.set({ ...v.data, createdAt: FieldValue.serverTimestamp() }, { merge: true });
      console.log(`[OK] company_vehicles/${v.id} oluşturuldu.`);
    }
  }
  console.log("\nÖrnek veriler `ornek: true` ile işaretli. Gerçek kayıtları ekledikten sonra bunları silebilirsiniz.");
}

main().catch((e) => {
  console.error("seedAracDenemeData failed:", e?.message || e);
  process.exitCode = 1;
});
