/**
 * qnb_sync_state/auto_pipeline dokümanını okuyup autoSupplierInvoicePipeline'ın
 * son çalışma/finish zamanlarını gösterir. Hiçbir veri yazmaz.
 *
 * Çalıştırma: node scripts/showAutoPipelineState.js
 */
import "dotenv/config";
import { ensureAdmin } from "../adminInit.js";
ensureAdmin();
import { getFirestore } from "firebase-admin/firestore";

function fmtTs(ts) {
  if (!ts) return "-";
  if (typeof ts.toDate === "function") {
    const d = ts.toDate();
    return `${d.toISOString()}  (TR: ${d.toLocaleString("tr-TR", {
      timeZone: "Europe/Istanbul",
    })})`;
  }
  if (typeof ts === "number") {
    const d = new Date(ts);
    return `${d.toISOString()}  (TR: ${d.toLocaleString("tr-TR", {
      timeZone: "Europe/Istanbul",
    })})`;
  }
  return String(ts);
}

async function main() {
  const db = getFirestore();
  const snap = await db.collection("qnb_sync_state").doc("auto_pipeline").get();
  if (!snap.exists) {
    console.log("qnb_sync_state/auto_pipeline DOK\u00dcMAN YOK (henuz hic calismamis olabilir).");
    return;
  }
  const d = snap.data() || {};
  console.log("qnb_sync_state/auto_pipeline:");
  console.log(`  disabled         = ${d.disabled === true ? "EVET (DUR)" : "hayir"}`);
  console.log(`  running          = ${d.running === true ? "EVET" : "hayir"}`);
  console.log(`  lockedUntilMs    = ${d.lockedUntilMs ?? "-"}${d.lockedUntilMs ? `  -> ${fmtTs(d.lockedUntilMs)}` : ""}`);
  console.log(`  lastRunAt        = ${fmtTs(d.lastRunAt)}`);
  console.log(`  lastFinishedAt   = ${fmtTs(d.lastFinishedAt)}`);
  console.log(`  lastSuccessAt    = ${fmtTs(d.lastSuccessAt)}`);

  const sum = d.lastSummary || {};
  console.log("\nlastSummary:");
  console.log(`  elapsedMs        = ${sum.elapsedMs ?? "-"}`);
  console.log(`  errors           = ${Array.isArray(sum.errors) ? sum.errors.length : 0}`);
  if (Array.isArray(sum.errors) && sum.errors.length) {
    for (const e of sum.errors.slice(0, 5)) {
      console.log(`    [${e.step}] ${String(e.error).slice(0, 200)}`);
    }
  }

  const s1 = sum.step1 || {};
  console.log("\nstep1 (VKN-suzulmus fatura ingest):");
  console.log(`  window           = ${s1.window ? `${s1.window.from}..${s1.window.to}` : "-"}`);
  console.log(`  listSource       = ${s1.listSource ?? "-"}`);
  console.log(`  chunksCalled     = ${s1.chunksCalled ?? "-"} / totalChunks=${s1.totalChunks ?? "-"}  stoppedEarly=${s1.listStoppedEarly ?? "-"}`);
  console.log(`  daysCalled       = ${s1.daysCalled ?? "-"} (eski alan; yeni surumde chunksCalled var)`);
  console.log(`  totalListed      = ${s1.totalListed ?? "-"}`);
  console.log(`  matchedBySupplier= ${s1.matchedBySupplier ?? "-"}`);
  console.log(`  upsertedDocs     = ${s1.upsertedDocs ?? "-"}`);
  console.log(`  enriched         = ${s1.enriched ?? "-"}`);
  console.log(`  upsertErrors     = ${s1.upsertErrors ?? "-"}`);
  if (Array.isArray(s1.perChunkCounts)) {
    console.log(`  perChunkCounts:`);
    for (const c of s1.perChunkCounts) {
      console.log(`    [${c.from}..${c.to}]  count=${c.count}`);
    }
  } else if (Array.isArray(s1.perDayCounts)) {
    console.log(`  perDayCounts (ESKI):`);
    for (const c of s1.perDayCounts) {
      console.log(`    [${c.day}]  count=${c.count}`);
    }
  }
}

main().catch((e) => {
  console.error("showAutoPipelineState failed:", e?.message || e);
  process.exitCode = 1;
});
