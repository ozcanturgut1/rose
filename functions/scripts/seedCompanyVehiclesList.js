/**
 * company_vehicles koleksiyonuna firma araçlarını (ticari/binek) ekler/günceller.
 * doc id = normalize plaka (boşluksuz büyük harf). set(merge) → tip güncellenir.
 *
 * Güvenlik: default DRY-RUN.
 *   node scripts/seedCompanyVehiclesList.js
 *   node scripts/seedCompanyVehiclesList.js --apply
 */
import "dotenv/config";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { ensureAdmin } from "../adminInit.js";
import { normalizePlaka } from "../plakaTespit.js";

const TICARI = [
  "34BEG725", "34DRK675", "34ETJ274", "34FDK972", "34HLV280", "34HLV242",
  "34HLV286", "34FNU671", "35BMJ888", "34MBV820", "34KSF825", "35BTT055", "34MKS977",
];

const BINEK = [
  "35AVK293", "34GIT168", "34HZE028", "34GEN850", "34HYS121", "34HYS122",
  "34TF5151", "34MPP282", "34MPN293", "34GFA100", "34GGE662", "34MBJ737",
  "34NOV485", "34NRZ406", "34NDZ287", "34PAE998", "34PJA366", "34PJA386", "34PJC148",
];

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  ensureAdmin();
  const db = getFirestore();

  const rows = [
    ...TICARI.map((p) => ({ tip: "ticari", raw: p })),
    ...BINEK.map((p) => ({ tip: "binek", raw: p })),
  ].map((r) => ({ ...r, norm: normalizePlaka(r.raw) }));

  console.log("=".repeat(64));
  console.log(`company_vehicles ekleme  Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Ticari: ${TICARI.length}, Binek: ${BINEK.length}, Toplam: ${rows.length}`);

  // Doc id çakışması kontrolü
  const seen = new Map();
  for (const r of rows) {
    if (seen.has(r.norm)) console.log(`  [UYARI] Tekrarlı plaka: ${r.norm}`);
    seen.set(r.norm, r.tip);
  }

  if (!apply) {
    for (const r of rows) console.log(`  ${r.norm}\t${r.tip}`);
    console.log("=".repeat(64));
    console.log("DRY-RUN: yazılmadı. Uygulamak için: node scripts/seedCompanyVehiclesList.js --apply");
    return;
  }

  let written = 0;
  for (const r of rows) {
    await db.collection("company_vehicles").doc(r.norm).set(
      {
        plaka: r.raw,
        plakaNormalize: r.norm,
        tip: r.tip,
        aktif: true,
        ornek: false,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    written++;
  }
  console.log("=".repeat(64));
  console.log(`[OK] ${written} araç yazıldı/güncellendi (company_vehicles).`);
}

main().catch((e) => {
  console.error("seedCompanyVehiclesList failed:", e?.message || e);
  process.exitCode = 1;
});
