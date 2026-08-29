/**
 * qnb_sync_state/eta_local_worker dokümanını okuyup yerel ETA worker'ının
 * ayakta olup olmadığını gösterir. Hiçbir veri yazmaz.
 *
 * Çalıştırma: node scripts/showEtaWorkerState.js
 *
 * Kalp atışı yalnızca watch modunda yazılır; tek seferlik koşum bu dokümana
 * dokunmaz.
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAdmin } from "../adminInit.js";
import { getFirestore } from "firebase-admin/firestore";

function toDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate();
  if (typeof ts === "number") return new Date(ts);
  return null;
}

function fmtTs(ts) {
  const d = toDate(ts);
  if (!d) return "-";
  return `${d.toISOString()}  (TR: ${d.toLocaleString("tr-TR", {
    timeZone: "Europe/Istanbul",
  })})`;
}

function fmtSure(saniye) {
  if (saniye == null) return "-";
  if (saniye < 60) return `${saniye} sn`;
  if (saniye < 3600) return `${Math.floor(saniye / 60)} dk ${saniye % 60} sn`;
  return `${Math.floor(saniye / 3600)} sa ${Math.floor((saniye % 3600) / 60)} dk`;
}

async function main() {
  ensureAdmin();
  const db = getFirestore();
  const snap = await db.collection("qnb_sync_state").doc("eta_local_worker").get();
  if (!snap.exists) {
    console.log(
      "qnb_sync_state/eta_local_worker DOKUMAN YOK (worker hic watch modunda calismamis olabilir)."
    );
    return;
  }

  const d = snap.data() || {};
  const pollSec = Number(d.pollSec || 20);
  // Bayatlama eşiği: üç tur kaçırmak gerçek bir sorun işareti. Kısa poll
  // aralıklarında tek bir yavaş partiyle yanlış alarm vermemek için alt sınır var.
  const esikSn = Math.max(pollSec * 3, 120);
  const sonGorulme = toDate(d.lastSeenAt);
  const gecenSn = sonGorulme ? Math.round((Date.now() - sonGorulme.getTime()) / 1000) : null;

  console.log("qnb_sync_state/eta_local_worker:");
  console.log(`  status           = ${d.status ?? "-"}`);
  console.log(`  workerId         = ${d.workerId ?? "-"}`);
  console.log(`  mode             = ${d.mode ?? "-"}`);
  console.log(`  startedAt        = ${fmtTs(d.startedAt)}`);
  console.log(`  lastSeenAt       = ${fmtTs(d.lastSeenAt)}`);
  console.log(`  lastBatchAt      = ${fmtTs(d.lastBatchAt)}`);
  console.log(
    `  ayarlar          = poll=${pollSec}s batchLimit=${d.batchLimit ?? "-"} claimLock=${
      d.claimLockSec ?? "-"
    }s`
  );

  const sum = d.lastSummary || {};
  console.log("\nlastSummary:");
  console.log(`  total=${sum.total ?? "-"} ok=${sum.ok ?? "-"} blocked=${sum.blocked ?? "-"} error=${sum.error ?? "-"} skipped=${sum.skipped ?? "-"}`);
  console.log(`  elapsedMs        = ${sum.elapsedMs ?? "-"}`);

  if (d.lastError) {
    console.log("\nson hata:");
    console.log(`  ${String(d.lastError).slice(0, 300)}`);
    console.log(`  zaman            = ${fmtTs(d.lastErrorAt)}`);
  }

  console.log("\ndegerlendirme:");
  if (d.status === "durdu") {
    console.log(
      `  DURDURULDU (${d.stopSignal || "sinyal"}) - ${fmtTs(d.stoppedAt)}. Planli durus; worker calismiyor.`
    );
  } else if (gecenSn == null) {
    console.log("  lastSeenAt okunamadi.");
  } else if (gecenSn > esikSn) {
    console.log(
      `  BAYAT: son kalp atisi ${fmtSure(gecenSn)} once (esik ${fmtSure(esikSn)}). Worker muhtemelen calismiyor.`
    );
    process.exitCode = 2;
  } else {
    console.log(`  Ayakta: son kalp atisi ${fmtSure(gecenSn)} once (esik ${fmtSure(esikSn)}).`);
  }
}

// Modül yüklenirken çalışmasın: import edilmesi Firestore'a bağlanmamalı.
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
    console.error("showEtaWorkerState failed:", e?.message || e);
    process.exitCode = 1;
  });
}
