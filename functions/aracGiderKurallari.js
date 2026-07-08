/**
 * Binek araç gideri muhasebe kuralları ve gider türü (yakıt/kira) tespiti.
 *
 * Kurallar Firestore'dan (app_config/arac_gider_kurallari) okunur; doküman yoksa
 * aşağıdaki 2026 varsayılanları kullanılır. Mevzuat/hesap değişince Firebase
 * Console'dan güncellenebilir (kod değişmez).
 *
 * Kaynak (2026): 332 Seri No.lu Gelir Vergisi Genel Tebliği (31.12.2025 R.G.).
 *   - Binek araç cari giderleri (yakıt/bakım/sigorta/HGS/muayene/diğer): en fazla
 *     %70 gider, %30 KKEG.
 *   - Binek araç aylık kira: 46.000 TL'ye (KDV hariç) kadar gider, aşan kısım KKEG.
 *   - KKEG'e isabet eden KDV indirilemez (689 1 03).
 *
 * Hesap kodları ETA hesap planından (salt okunur) doğrulanmıştır; karışık
 * 730 (fabrika) / 770 (genel yönetim) aile kullanımı korunmuştur.
 */
import { getFirestore } from "firebase-admin/firestore";

/** 2026 varsayılan kuralları + firmaya ait doğrulanmış hesap kodları. */
export const DEFAULT_ARAC_GIDER_KURALLARI = Object.freeze({
  yil: 2026,
  giderKabulOrani: 0.7, // yakıt/bakım/sigorta/hgs/muayene/diğer: kabul edilen oran
  kiraAylikLimit: 46000, // binek aylık kira gider tavanı (KDV hariç)
  hesaplar: Object.freeze({
    yakitKabul: "730 4 28", // Binek Araç Yakıt Gid.
    yakitKkeg: "689 1 07", // Binek Araç Yakıt Gideri (KKEG)
    kiraKabul: "770 4 34", // Binek Oto Kira Giderleri
    kiraKkeg: "689 1 11", // Binek Araç Kira Gideri (KKEG)
    bakimKabul: "770 3 29", // Binek Otoları Tamir Bakım Gideri
    bakimKkeg: "689 1 16", // Binek Araç Diğer Giderler (KKEG)
    sigortaKabul: "730 4 38", // Binek Otoları Sigorta Gid.
    sigortaKkeg: "689 1 14", // Binek Araç Kasko Gideri (KKEG)
    hgsKabul: "730 5 05", // Binek Araç HGS Gideri
    hgsKkeg: "689 1 15", // Binek Araç Ogs Gideri (KKEG)
    muayeneKabul: "730 4 55", // Nakil Vasıta Diğer Giderler (binek özel yok)
    muayeneKkeg: "689 1 16", // Binek Araç Diğer Giderler (KKEG)
    uttsKabul: "730 5 13", // Araç UTTS Gideri
    uttsKkeg: "689 1 16", // Binek Araç Diğer Giderler (KKEG)
    digerKabul: "730 4 55", // Nakil Vasıta Diğer Giderler
    digerKkeg: "689 1 16", // Binek Araç Diğer Giderler (KKEG)
    indirilemeyenKdv: "689 1 03", // İndirilemeyen Kdv (KKEG)
  }),
  aktif: true,
});

/**
 * Gider türü -> (kabul / KKEG) hesap alan adları eşlemesi.
 * KIRA aylık limit; diğerleri %70/%30 oranıyla bölünür.
 */
const GIDER_HESAP_MAP = Object.freeze({
  YAKIT: { kabul: "yakitKabul", kkeg: "yakitKkeg" },
  KIRA: { kabul: "kiraKabul", kkeg: "kiraKkeg" },
  BAKIM: { kabul: "bakimKabul", kkeg: "bakimKkeg" },
  SIGORTA: { kabul: "sigortaKabul", kkeg: "sigortaKkeg" },
  HGS_OGS: { kabul: "hgsKabul", kkeg: "hgsKkeg" },
  MUAYENE: { kabul: "muayeneKabul", kkeg: "muayeneKkeg" },
  UTTS: { kabul: "uttsKabul", kkeg: "uttsKkeg" },
  DIGER: { kabul: "digerKabul", kkeg: "digerKkeg" },
});

/**
 * Gider türüne göre binek kabul/KKEG hesaplarını çözer. Bilinmeyen tür DIGER'e
 * düşer. Dönüş: { kabulHesap, kkegHesap, isKira }.
 */
export function binekHesaplarForTuru(giderTuru, hesaplar = {}) {
  const key = String(giderTuru || "").toUpperCase();
  const map = GIDER_HESAP_MAP[key] || GIDER_HESAP_MAP.DIGER;
  return {
    kabulHesap: hesaplar[map.kabul] || hesaplar.digerKabul || null,
    kkegHesap: hesaplar[map.kkeg] || hesaplar.digerKkeg || null,
    isKira: key === "KIRA",
  };
}

/**
 * app_config/arac_gider_kurallari dokümanını okur; alanları varsayılanların
 * üzerine bindirir. Doküman yoksa varsayılanlar döner.
 */
export async function loadAracGiderKurallari(db = getFirestore()) {
  try {
    const snap = await db.collection("app_config").doc("arac_gider_kurallari").get();
    if (!snap.exists) return { ...DEFAULT_ARAC_GIDER_KURALLARI, kaynak: "default" };
    const d = snap.data() || {};
    return {
      yil: d.yil ?? DEFAULT_ARAC_GIDER_KURALLARI.yil,
      giderKabulOrani:
        typeof d.giderKabulOrani === "number" && d.giderKabulOrani > 0 && d.giderKabulOrani <= 1
          ? d.giderKabulOrani
          : DEFAULT_ARAC_GIDER_KURALLARI.giderKabulOrani,
      kiraAylikLimit:
        typeof d.kiraAylikLimit === "number" && d.kiraAylikLimit > 0
          ? d.kiraAylikLimit
          : DEFAULT_ARAC_GIDER_KURALLARI.kiraAylikLimit,
      hesaplar: { ...DEFAULT_ARAC_GIDER_KURALLARI.hesaplar, ...(d.hesaplar || {}) },
      aktif: d.aktif !== false,
      kaynak: "firestore",
    };
  } catch (_) {
    return { ...DEFAULT_ARAC_GIDER_KURALLARI, kaynak: "default_error" };
  }
}

const KIRA_RE = /\b(kira(lama|s[ıi])?|rent(al|ing)?|le?asing)\b/i;
const YAKIT_RE =
  /(yak[ıi]t|akaryak[ıi]t|motorin|benzin|mazot|d[iı]zel|d[iı]esel|lpg|kur[şs]unsuz|v[\-\/]?power|euro\s?d[iı]esel|pompa)/i;
const SIGORTA_RE =
  /(kasko|sigorta|po[li]i?[çc]e|trafik sig|zorunlu mali|ferdi kaza|imm |mali mesuliyet)/i;
const MUAYENE_RE = /(muayene|t[üu]vt[üu]rk|fenn[iı]|egzoz|emisyon)/i;
const UTTS_RE = /(utts|ta[şs][ıi]t tan[ıi]ma)/i;
const HGS_OGS_RE =
  /(\bhgs\b|\bogs\b|otoyol|k[öo]pr[üu]|ge[çc]i[şs] [üu]cret|h[ıi]zl[ıi] ge[çc]i[şs]|opc\b)/i;
const BAKIM_RE =
  /(bak[ıi]m|onar[ıi]m|tamir|servis|periyodik|last[iı]k|yedek par[çc]a|balata|balans|\brot\b|ak[üu]|ya[ğg] de[ğg]i[şs]|filtre|kaporta|boya|mekanik|d[öo][şs]eme)/i;

/**
 * Fatura metninden (kalem açıklamaları / stok cinsi birleşimi) binek araç gider
 * türünü tespit eder.
 * Dönüş: "KIRA" | "YAKIT" | "BAKIM" | "SIGORTA" | "HGS_OGS" | "MUAYENE" | "UTTS" | "DIGER".
 * Sıra önemlidir: özel/belirgin türler önce denenir (KIRA en başta, çünkü kiralama
 * faturasında yakıt/bakım kelimeleri de geçebilir).
 */
export function detectGiderTuru(text) {
  const s = String(text || "");
  if (!s.trim()) return "DIGER";
  if (KIRA_RE.test(s)) return "KIRA";
  if (UTTS_RE.test(s)) return "UTTS";
  if (HGS_OGS_RE.test(s)) return "HGS_OGS";
  if (MUAYENE_RE.test(s)) return "MUAYENE";
  if (SIGORTA_RE.test(s)) return "SIGORTA";
  if (YAKIT_RE.test(s)) return "YAKIT";
  if (BAKIM_RE.test(s)) return "BAKIM";
  return "DIGER";
}

/** usableLines dizisinden gider türü tespiti için birleşik metin üretir. */
export function giderMetniFromLines(lines) {
  if (!Array.isArray(lines)) return "";
  const parts = [];
  for (const l of lines) {
    if (l?.stokCinsi) parts.push(String(l.stokCinsi));
    if (l?.lineAciklama) parts.push(String(l.lineAciklama));
    if (l?.description) parts.push(String(l.description));
  }
  return parts.join(" | ");
}
