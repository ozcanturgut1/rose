/**
 * Onaylanmış faturaları ETA'ya kaydeden şirket içi worker.
 *
 *   node scripts/localEtaWorker.js          -> tek parti işleyip çıkar
 *   node scripts/localEtaWorker.js watch    -> sürekli çalışır (servis modu)
 *
 * Watch modunda `qnb_sync_state/eta_local_worker` dokümanına kalp atışı yazar;
 * durumu `node scripts/showEtaWorkerState.js` ile görebilirsiniz. Bu doküman
 * worker'ın ayakta olup olmadığını anlamanın tek yolu: arayüz kuyrukta bekleyen
 * faturaları göstermiyor, dolayısıyla worker sessizce durursa fark edilmez.
 *
 * Windows'ta servis olarak çalıştırma (elle başlatmaya güvenilmemeli):
 *   Görev Zamanlayıcı ile: tetikleyici "bilgisayar başlatıldığında", eylem
 *   `node.exe scripts/localEtaWorker.js watch`, başlangıç dizini `functions`,
 *   ayarlar sekmesinde "görev başarısız olursa her 1 dakikada bir yeniden başlat".
 *   Alternatif olarak NSSM ile gerçek bir Windows servisi kurulabilir.
 *   Her iki durumda da GOOGLE_APPLICATION_CREDENTIALS ve functions/.env
 *   değerlerinin o kullanıcı hesabında görünür olduğundan emin olun.
 *
 * SIGINT/SIGTERM alındığında worker mevcut partiyi bitirip durur; ikinci sinyal
 * zorla çıkartır.
 */
import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAdmin } from "../adminInit.js";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { syncApprovedInvoiceToEta } from "../etaInvoiceSync.js";
import { formatEtaError } from "../etaError.js";
import { evaluateAracPlakaKapisi } from "../plakaTespit.js";

const WORKER_ID = `${os.hostname()}:${process.pid}`;
// Kilit süresi: bunu aşan 'isleniyor' kayıtları çökmüş bir worker'dan kalmış
// sayılır ve devralınır. Çok kısa verilmesi yavaş bir faturayı iki kez işletebilir.
const CLAIM_LOCK_MS = Number(process.env.ETA_LOCAL_CLAIM_LOCK_SEC || "900") * 1000;
// Kalp atışı dokümanı; autoSupplierInvoicePipeline'ın qnb_sync_state/auto_pipeline
// kalıbıyla aynı yerde durur.
export const HEARTBEAT_DOC_PATH = ["qnb_sync_state", "eta_local_worker"];

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("ı", "i");
}

/**
 * Kalp atışı yazar. Yazım başarısız olursa yalnızca uyarır: izleme kaydı
 * yüzünden fatura işleme durmamalı.
 */
async function writeHeartbeat(db, fields) {
  try {
    await db
      .collection(HEARTBEAT_DOC_PATH[0])
      .doc(HEARTBEAT_DOC_PATH[1])
      .set({ ...fields, lastSeenAt: FieldValue.serverTimestamp() }, { merge: true });
  } catch (err) {
    console.warn(`[WARN] kalp atisi yazilamadi: ${err?.message || err}`);
  }
}

/**
 * Faturayı bu worker adına atomik olarak sahiplenir.
 *
 * Aynı faturanın iki worker sürecinde birden işlenmesini engeller: durum kontrolü
 * ve 'isleniyor' yazımı tek transaction içinde yapılır. Kilidi dolmuş kayıtlar
 * (çökmüş worker) devralınır; ETA tarafındaki belge numarası kontrolü
 * (already_exists) ikinci bir güvenlik katmanıdır.
 */
export async function claimInvoice(db, ref, now) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { claimed: false, reason: "not_found" };
    const d = snap.data() || {};
    if (normalizeStatus(d.onayDurumu) !== "onaylandi") {
      return { claimed: false, reason: "not_approved" };
    }
    const eta = normalizeStatus(d.etaKayitDurumu);
    if (eta === "tamamlandi") return { claimed: false, reason: "already_done" };
    if (eta === "beklemede_plaka") return { claimed: false, reason: "plaka_blokajli" };

    const kilitBitisMs =
      typeof d.etaIslemKilitBitisMs === "number" ? d.etaIslemKilitBitisMs : 0;
    if (eta === "isleniyor" && kilitBitisMs > now) {
      return { claimed: false, reason: "baska_isleyicide", isleyen: d.etaIsleyen || null };
    }

    tx.set(
      ref,
      {
        etaKayitDurumu: "isleniyor",
        etaIsleyen: WORKER_ID,
        etaIslemBaslangic: FieldValue.serverTimestamp(),
        etaIslemKilitBitisMs: now + CLAIM_LOCK_MS,
        etaKayitGuncellemeTarihi: FieldValue.serverTimestamp(),
        etaKayitHata: FieldValue.delete(),
      },
      { merge: true }
    );

    return { claimed: true, devralindi: eta === "isleniyor" };
  });
}

async function processDoc(db, docSnap) {
  const docId = docSnap.id;
  const data = docSnap.data() || {};
  const onay = normalizeStatus(data.onayDurumu);
  if (onay !== "onaylandi") return { skipped: true, reason: "not_approved" };

  const eta = normalizeStatus(data.etaKayitDurumu);
  if (eta === "tamamlandi") return { skipped: true, reason: "already_done" };
  // Plaka blokajı yeniden denemekle çözülmez: kapı dokümandaki aracPlakaDurumu
  // alanını okur ve o alan yalnızca zenginleştirme aşamasında yazılır. Araç
  // company_vehicles'a eklendikten sonra tespitin yeniden koşması gerekir, aksi
  // halde her turda aynı blokaj tekrar yazılırdı. (beklemede_kurfarki bilinçli
  // olarak burada değil: o karar her turda SQL'den yeniden hesaplanıyor, yani
  // sorun giderildiğinde kendiliğinden başarılı olabiliyor.)
  if (eta === "beklemede_plaka") return { skipped: true, reason: "plaka_blokajli" };

  const ref = db.collection("qnb_invoices").doc(docId);

  // Araç gideri faturasında plaka eşleşmemişse kayıt yapılmaz: binek/ticari ayrımı
  // belirlenemediği için fatura normal ticari muhasebeyle, yani yanlış hesaplara
  // kaydedilirdi. Bulut trigger'ıyla aynı kapı (plakaTespit.js).
  const plakaKapisi = await evaluateAracPlakaKapisi({ db, data });
  if (plakaKapisi.tespitHatasi) {
    console.warn(`[WARN] ${docId}: plaka tespiti başarısız: ${plakaKapisi.tespitHatasi}`);
  }
  if (plakaKapisi.guncellenenAlanlar) {
    await ref.set(plakaKapisi.guncellenenAlanlar, { merge: true });
    // syncApprovedInvoiceToEta binek dalı aracTespit'i okur.
    Object.assign(data, plakaKapisi.guncellenenAlanlar);
  }
  if (plakaKapisi.blocked) {
    await ref.set(
      {
        etaKayitDurumu: "beklemede_plaka",
        etaKayitGuncellemeTarihi: FieldValue.serverTimestamp(),
        etaIslemKilitBitisMs: 0,
        etaKayitHata: plakaKapisi.mesaj,
      },
      { merge: true }
    );
    return { skipped: false, blocked: true, reason: `plaka_${plakaKapisi.durum}` };
  }

  const claim = await claimInvoice(db, ref, Date.now());
  if (!claim.claimed) {
    if (claim.reason === "baska_isleyicide") {
      console.log(`[SKIP] ${docId}: baska isleyicide (${claim.isleyen || "bilinmiyor"})`);
    }
    return { skipped: true, reason: claim.reason };
  }
  if (claim.devralindi) {
    console.warn(`[WARN] ${docId}: kilidi dolmus 'isleniyor' kaydi devralindi`);
  }

  try {
    const result = await syncApprovedInvoiceToEta(data, docId);
    if (result?.blocked) {
      await ref.set(
        {
          etaKayitDurumu: "beklemede_kurfarki",
          etaKayitGuncellemeTarihi: FieldValue.serverTimestamp(),
          // Kilit serbest bırakılır: bu karar her turda SQL'den yeniden hesaplanıyor,
          // sorun giderildiğinde bir sonraki tur kaydı tamamlayabilmeli.
          etaIslemKilitBitisMs: 0,
          etaKayitHata: result.blockMessage || "Kur farkı faturası: cari belirlenemedi.",
          etaKayitDetay: {
            status: result.status || "blocked_kurfarki",
            blockReason: result.blockReason || null,
            adaylar: Array.isArray(result.blockDetail?.adaylar) ? result.blockDetail.adaylar : [],
          },
        },
        { merge: true }
      );
      return { skipped: false, blocked: true, reason: result.blockReason };
    }
    await ref.set(
      {
        etaKayitDurumu: "tamamlandi",
        etaKayitGuncellemeTarihi: FieldValue.serverTimestamp(),
        etaIslemKilitBitisMs: 0,
        etaFatFisRefNo: result.fatFisRefNo || null,
        etaStokFisRefNo: result.stokFisRefNo || null,
        etaMuhFisRefNo: result.muhFisRefNo || null,
        // Muhasebe arşive taşımadan önce mahsup fişini bu alandan görür.
        muhasebeFisi: result.muhasebeFisi || null,
        etaKayitDetay: {
          status: result.status || "ok",
          lineCount: result.lineCount || 0,
          localWorker: true,
          muhasebeRefFatFisRefNo: result.muhasebeRefFatFisRefNo || 0,
          lineMatches: Array.isArray(result.lineMatches) ? result.lineMatches : [],
        },
        etaKayitHata: FieldValue.delete(),
        // Arşivleme otomatik değil: muhasebe kaydı kontrol edip "Arşive Taşı" ile tetikler.
        arsivDurumu: "arsiv_bekliyor",
        arsivBekliyorTarihi: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { skipped: false, result };
  } catch (err) {
    const msg = formatEtaError(err);
    await ref.set(
      {
        etaKayitDurumu: "hata",
        etaKayitGuncellemeTarihi: FieldValue.serverTimestamp(),
        // Kilit serbest bırakılır: hatalı kayıt bir sonraki turda yeniden denenir
        // (bugünkü davranış). Aksi halde kilit süresi boyunca beklerdi.
        etaIslemKilitBitisMs: 0,
        etaKayitHata: msg,
      },
      { merge: true }
    );
    return { skipped: false, error: msg };
  }
}

async function runBatch(limitPerStatus) {
  ensureAdmin();
  const db = getFirestore();
  const basladi = Date.now();

  const statuses = ["onaylandı", "onaylandi"];
  const docs = new Map();
  for (const s of statuses) {
    const snap = await db
      .collection("qnb_invoices")
      .where("type", "==", "invoice")
      .where("onayDurumu", "==", s)
      .limit(limitPerStatus * 3)
      .get();
    for (const d of snap.docs) docs.set(d.id, d);
  }

  let ok = 0;
  let err = 0;
  let skipped = 0;
  let blocked = 0;
  for (const d of docs.values()) {
    const r = await processDoc(db, d);
    if (r.skipped) {
      skipped++;
      continue;
    }
    if (r.error) {
      err++;
      console.log(`[ERR] ${d.id}: ${r.error}`);
    } else if (r.blocked) {
      blocked++;
      console.log(`[BLOCKED] ${d.id}: ${r.reason}`);
    } else {
      ok++;
      console.log(`[OK] ${d.id}: ${JSON.stringify(r.result)}`);
    }
  }
  const ozet = {
    total: docs.size,
    ok,
    blocked,
    error: err,
    skipped,
    elapsedMs: Date.now() - basladi,
  };
  console.log(
    `Batch done. total=${ozet.total} ok=${ok} blocked=${blocked} error=${err} skipped=${skipped}`
  );
  return ozet;
}

// Düzenli duruş: sinyal geldiğinde mevcut parti bitirilir, sonra çıkılır.
// Faturanın ortasında kesilmek yarım kalmış bir ETA kaydı bırakabilirdi.
let durdurmaSinyali = null;

function registerShutdown() {
  for (const sinyal of ["SIGINT", "SIGTERM"]) {
    process.on(sinyal, () => {
      if (durdurmaSinyali) {
        console.log(`\n${sinyal} tekrar alindi, zorla cikiliyor.`);
        process.exit(1);
      }
      durdurmaSinyali = sinyal;
      console.log(
        `\n${sinyal} alindi: mevcut parti bitince durulacak. Zorlamak icin tekrar gonderin.`
      );
    });
  }
}

// Bekleme sırasında sinyal gelirse turu boşuna beklemeyelim.
async function bekle(totalMs) {
  const adimMs = 500;
  let gecen = 0;
  while (gecen < totalMs && !durdurmaSinyali) {
    await new Promise((r) => setTimeout(r, Math.min(adimMs, totalMs - gecen)));
    gecen += adimMs;
  }
}

export async function main() {
  const mode = (process.argv[2] || "once").trim().toLowerCase();
  const limitPerStatus = Number(process.env.ETA_LOCAL_BATCH_LIMIT || "25");
  const intervalSec = Number(process.env.ETA_LOCAL_POLL_SEC || "20");

  if (mode === "watch") {
    ensureAdmin();
    const db = getFirestore();
    registerShutdown();
    console.log(
      `ETA local worker watch mode. poll=${intervalSec}s, limitPerStatus=${limitPerStatus}, worker=${WORKER_ID}`
    );
    await writeHeartbeat(db, {
      workerId: WORKER_ID,
      hostname: os.hostname(),
      pid: process.pid,
      mode: "watch",
      status: "calisiyor",
      startedAt: FieldValue.serverTimestamp(),
      pollSec: intervalSec,
      batchLimit: limitPerStatus,
      claimLockSec: CLAIM_LOCK_MS / 1000,
      lastError: null,
    });

    while (!durdurmaSinyali) {
      try {
        const ozet = await runBatch(limitPerStatus);
        await writeHeartbeat(db, {
          status: "calisiyor",
          lastBatchAt: FieldValue.serverTimestamp(),
          lastSummary: ozet,
          lastError: null,
        });
      } catch (err) {
        const msg = err?.message || String(err);
        console.error("Batch failed:", msg);
        await writeHeartbeat(db, {
          status: "calisiyor",
          lastError: msg,
          lastErrorAt: FieldValue.serverTimestamp(),
        });
      }
      await bekle(intervalSec * 1000);
    }

    await writeHeartbeat(db, {
      status: "durdu",
      stoppedAt: FieldValue.serverTimestamp(),
      stopSignal: durdurmaSinyali,
    });
    console.log("Worker durdu.");
    return;
  }

  // Tek seferlik koşum kalp atışı yazmaz: elle çalıştırılan bir parti,
  // servis olarak koşan worker'ın durum kaydını ezmemeli.
  await runBatch(limitPerStatus);
}

// Modül yüklenirken worker başlamamalı: import edilmesi bile faturaları işlemeye
// başlardı. Diğer script'lerle aynı koruma.
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
  main().catch((err) => {
    console.error("localEtaWorker failed:", err?.message || err);
    process.exitCode = 1;
  });
}

