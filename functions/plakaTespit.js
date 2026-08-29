/**
 * Araç gideri (kira / yakıt / bakım) faturalarında binek-ticari ayrımı için
 * plaka tespiti ve araç eşleştirmesi.
 *
 * Firestore veri modeli (Firebase Console'dan yönetilir):
 *
 *   suppliers/arac_gideri
 *     ├─ vkns / vkn / vknList : araç gideri (plaka zorunlu) tedarikçilerinin VKN listesi
 *     └─ aciklama             : (opsiyonel) not
 *
 *   company_vehicles/{plakaNormalize}     (doc id = boşluksuz büyük harf plaka, ör. "34ABC123")
 *     ├─ plaka          : görünüm plakası (ör. "34 ABC 123")
 *     ├─ plakaNormalize : eşleştirme anahtarı ("34ABC123")
 *     ├─ tip            : "binek" | "ticari"
 *     ├─ aktif          : true/false
 *     └─ marka, model   : (opsiyonel)
 *
 * Bu modül SADECE OKUR (Firestore get); yazma işlemini çağıran taraf yapar.
 */
import { getFirestore } from "firebase-admin/firestore";

/** Sadece rakamları bırakır (VKN normalizasyonu). */
function digitsOnly(raw) {
  if (raw == null) return "";
  return String(raw).replace(/\D/g, "");
}

/** suppliers dokümanındaki vkns/vkn/vknList alanlarını Set'e toplar. */
function consumeVknValue(raw, out) {
  if (raw == null) return;
  if (Array.isArray(raw)) {
    for (const e of raw) {
      const v = digitsOnly(e);
      if (v) out.add(v);
    }
    return;
  }
  const s = String(raw).trim();
  if (!s) return;
  if (s.includes(",") || s.includes(";")) {
    for (const part of s.split(/[,;]\s*/)) {
      const v = digitsOnly(part);
      if (v) out.add(v);
    }
    return;
  }
  const v = digitsOnly(s);
  if (v) out.add(v);
}

/** Faturanın gönderici (tedarikçi) VKN'sini qnbRaw'dan çıkarır. */
export function gondericiVkn(qnbRaw) {
  if (!qnbRaw || typeof qnbRaw !== "object") return null;
  const cand =
    qnbRaw.gondericiVkn ??
    qnbRaw.gondericiVergiNumarasi ??
    qnbRaw.gonderenVkn ??
    qnbRaw.supplierVkn ??
    qnbRaw.vkn ??
    null;
  const s = digitsOnly(cand);
  return s || null;
}

/** suppliers/arac_gideri VKN listesini Set olarak yükler. */
export async function loadAracGiderVkns(db = getFirestore()) {
  const out = new Set();
  const snap = await db.collection("suppliers").doc("arac_gideri").get();
  if (!snap.exists) return out;
  const d = snap.data() || {};
  consumeVknValue(d.vkns, out);
  consumeVknValue(d.vkn, out);
  consumeVknValue(d.vknList, out);
  return out;
}

/**
 * Plakayı eşleştirme anahtarına çevirir: büyük harf + alfasayısal dışı karakterleri at.
 * "34 ABC 123" → "34ABC123"
 */
export function normalizePlaka(raw) {
  if (raw == null) return "";
  return String(raw)
    .toUpperCase()
    .replace(/İ/g, "I")
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Türk plaka biçimini metinden yakalar: NN (il 01-81) + 1-3 harf + 2-4 rakam.
 * Örn: "34 ABC 123", "06AB1234", "35 BTT 055".
 * Dönüş: normalize edilmiş benzersiz plakalar dizisi.
 */
export function extractPlakalarFromText(text) {
  const s = String(text || "");
  if (!s) return [];
  // İl kodu 01-81, ardından 1-3 harf, ardından 2-4 rakam (aralarında opsiyonel boşluk).
  const re = /\b(0[1-9]|[1-7]\d|8[0-1])\s?([A-Za-z]{1,3})\s?(\d{2,4})\b/g;
  const found = new Set();
  let m;
  while ((m = re.exec(s)) !== null) {
    const norm = normalizePlaka(`${m[1]}${m[2]}${m[3]}`);
    if (norm) found.add(norm);
  }
  return Array.from(found);
}

/**
 * UBL içeriğinden (ham XML öncelikli, yoksa parse edilmiş JSON) plakaları çıkarır.
 */
export function extractPlakalarFromUbl(ublParsed, contentUbl) {
  let text = "";
  if (typeof contentUbl === "string" && contentUbl.trim()) {
    text = contentUbl;
  } else if (ublParsed && typeof ublParsed === "object") {
    try {
      text = JSON.stringify(ublParsed);
    } catch (_) {
      text = "";
    }
  }
  return extractPlakalarFromText(text);
}

/** Normalize plakaya karşılık gelen aracı company_vehicles'tan bulur (aktif olanı önceler). */
export async function lookupVehicle(db, plakaNorm) {
  if (!plakaNorm) return null;
  const col = db.collection("company_vehicles");
  const byId = await col.doc(plakaNorm).get();
  if (byId.exists) {
    const d = byId.data() || {};
    if (d.aktif !== false) return { plakaNorm, ...d };
  }
  const q = await col.where("plakaNormalize", "==", plakaNorm).limit(1).get();
  if (!q.empty) {
    const d = q.docs[0].data() || {};
    if (d.aktif !== false) return { plakaNorm, ...d };
  }
  return null;
}

/**
 * Faturanın araç gideri olup olmadığını, plaka tespitini ve araç tipini belirler.
 *
 * Dönüş alanları:
 *   aracGideriTedarikci : bool  (tedarikçi VKN, suppliers/arac_gideri listesinde mi)
 *   aracGideriVkn       : string|null
 *   tespitEdilenPlakalar: string[]  (yalnızca araç gideri tedarikçisinde doldurulur)
 *   aracPlakaDurumu     : "eslesti" | "eksik" | "tanimsiz"  (yalnızca araç gideri tedarikçisinde)
 *   aracTespit          : { plaka, aracTipi, eslesti, kaynak } | null
 */
export async function detectAracGideri({ db = getFirestore(), qnbRaw, ublParsed, contentUbl }) {
  const vkn = gondericiVkn(qnbRaw);
  const allowed = await loadAracGiderVkns(db);
  const aracGideriTedarikci = !!(vkn && allowed.has(vkn));

  const result = {
    aracGideriTedarikci,
    aracGideriVkn: vkn || null,
  };

  // Araç gideri tedarikçisi değilse: normal akış, plaka aranmaz.
  if (!aracGideriTedarikci) return result;

  const plakalar = extractPlakalarFromUbl(ublParsed, contentUbl);
  result.tespitEdilenPlakalar = plakalar;

  if (!plakalar.length) {
    result.aracPlakaDurumu = "eksik";
    result.aracTespit = null;
    return result;
  }

  let matched = null;
  for (const p of plakalar) {
    const v = await lookupVehicle(db, p);
    if (v) {
      matched = { plaka: p, vehicle: v };
      break;
    }
  }

  if (!matched) {
    result.aracPlakaDurumu = "tanimsiz";
    result.aracTespit = {
      plaka: plakalar[0],
      aracTipi: null,
      eslesti: false,
      kaynak: "ubl_otomatik",
    };
    return result;
  }

  const tipRaw = String(matched.vehicle.tip || "").trim().toLowerCase();
  const aracTipi = tipRaw === "binek" || tipRaw === "ticari" ? tipRaw : null;
  result.aracPlakaDurumu = aracTipi ? "eslesti" : "tanimsiz";
  result.aracTespit = {
    plaka: matched.vehicle.plaka || matched.plaka,
    plakaNormalize: matched.plaka,
    aracTipi,
    eslesti: aracTipi != null,
    kaynak: "ubl_otomatik",
  };
  return result;
}

/**
 * detectAracGideri sonucunu Firestore merge-set için alan nesnesine çevirir.
 * (undefined alanları göndermez; Firestore merge undefined kabul etmez.)
 */
export function aracGideriUpdateFields(det) {
  const out = { aracGideriTedarikci: det.aracGideriTedarikci === true };
  if (det.aracGideriVkn != null) out.aracGideriVkn = det.aracGideriVkn;
  if (Array.isArray(det.tespitEdilenPlakalar)) out.tespitEdilenPlakalar = det.tespitEdilenPlakalar;
  if (det.aracPlakaDurumu != null) out.aracPlakaDurumu = det.aracPlakaDurumu;
  if (det.aracTespit !== undefined) out.aracTespit = det.aracTespit;
  return out;
}

const PLAKA_BLOK_MESAJLARI = {
  tanimsiz:
    "Araç gideri faturası: UBL'de bulunan plaka company_vehicles'ta tanımlı değil " +
    "(binek/ticari belirlenemedi). ETA kaydı yapılmadı.",
  eksik: "Araç gideri faturası: UBL'de plaka bulunamadı. ETA kaydı yapılmadı.",
};

function normalizePlakaDurumu(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("ı", "i");
}

/**
 * Araç gideri faturaları için ETA kayıt kapısı.
 *
 * Plaka eşleşmediğinde kayıt YAPILMAMALIDIR: binek/ticari ayrımı belirlenemediği
 * için `syncApprovedInvoiceToEta` binek dalını atlar ve fatura normal ticari
 * muhasebeyle kaydedilir, yani yanlış hesaplara fiş düşer.
 *
 * `aracGideriTedarikci` / `aracPlakaDurumu` alanları normalde zenginleştirme
 * aşamasında (`enrichInvoiceWithRelatedDespatches`) yazılır. Alan hiç yazılmamış
 * eski kayıtlarda tespit burada bir kez yapılır; tespit hata verirse kapı açık
 * bırakılır ve `tespitHatasi` doldurulur.
 *
 * Modülün sözleşmesine uygun olarak Firestore'a YAZMAZ. `guncellenenAlanlar`
 * doluysa çağıran tarafın dokümana merge etmesi gerekir.
 *
 * Dönüş: { blocked, durum?, mesaj?, guncellenenAlanlar, tespitHatasi }
 */
export async function evaluateAracPlakaKapisi({ db = getFirestore(), data }) {
  let info = {
    aracGideriTedarikci: data?.aracGideriTedarikci === true,
    aracPlakaDurumu: data?.aracPlakaDurumu,
  };
  let guncellenenAlanlar = null;
  let tespitHatasi = null;

  if (data?.aracGideriTedarikci === undefined) {
    try {
      const det = await detectAracGideri({
        db,
        qnbRaw: data?.qnbRaw,
        ublParsed: data?.ublParsed,
        contentUbl: data?.contentUbl,
      });
      info = det;
      guncellenenAlanlar = aracGideriUpdateFields(det);
    } catch (err) {
      tespitHatasi = err?.message || String(err);
    }
  }

  if (info.aracGideriTedarikci !== true) {
    return { blocked: false, guncellenenAlanlar, tespitHatasi };
  }

  const durum = normalizePlakaDurumu(info.aracPlakaDurumu) || "eksik";
  if (durum === "eslesti") {
    return { blocked: false, guncellenenAlanlar, tespitHatasi };
  }

  return {
    blocked: true,
    durum,
    mesaj: PLAKA_BLOK_MESAJLARI[durum] || PLAKA_BLOK_MESAJLARI.eksik,
    guncellenenAlanlar,
    tespitHatasi,
  };
}
