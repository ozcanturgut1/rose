/**
 * suppliers/arac_gideri.vkns alanını verilen VKN listesiyle GÜNCELLER (örnek verinin
 * yerine gerçek araç gideri tedarikçilerini yazar).
 *
 * Güvenlik: default DRY-RUN.
 *   node scripts/setAracGiderVkns.js
 *   node scripts/setAracGiderVkns.js --apply
 */
import "dotenv/config";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { ensureAdmin } from "../adminInit.js";

const VKNS = ["7331158248", "9290365070", "8170637336"];

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  ensureAdmin();
  const db = getFirestore();
  const ref = db.collection("suppliers").doc("arac_gideri");

  const snap = await ref.get();
  const mevcut = snap.exists ? snap.data()?.vkns : undefined;
  console.log("=".repeat(64));
  console.log(`suppliers/arac_gideri.vkns  Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Mevcut vkns: ${JSON.stringify(mevcut ?? null)}`);
  console.log(`Yeni vkns:   ${JSON.stringify(VKNS)}`);
  console.log("=".repeat(64));

  if (!apply) {
    console.log("DRY-RUN: yazılmadı. Uygulamak için: node scripts/setAracGiderVkns.js --apply");
    return;
  }
  await ref.set(
    {
      vkns: VKNS,
      aciklama: "Araç gideri (plaka zorunlu) tedarikçileri",
      ornek: false,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  console.log(`[OK] suppliers/arac_gideri.vkns güncellendi (${VKNS.length} VKN).`);
}

main().catch((e) => {
  console.error("setAracGiderVkns failed:", e?.message || e);
  process.exitCode = 1;
});
