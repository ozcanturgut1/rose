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

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("ı", "i");
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
  console.log(
    `Batch done. total=${docs.size} ok=${ok} blocked=${blocked} error=${err} skipped=${skipped}`
  );
}

async function main() {
  const mode = (process.argv[2] || "once").trim().toLowerCase();
  const limitPerStatus = Number(process.env.ETA_LOCAL_BATCH_LIMIT || "25");
  const intervalSec = Number(process.env.ETA_LOCAL_POLL_SEC || "20");

  if (mode === "watch") {
    console.log(
      `ETA local worker watch mode. poll=${intervalSec}s, limitPerStatus=${limitPerStatus}`
    );
    while (true) {
      try {
        await runBatch(limitPerStatus);
      } catch (err) {
        console.error("Batch failed:", err?.message || err);
      }
      await new Promise((r) => setTimeout(r, intervalSec * 1000));
    }
  }

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

