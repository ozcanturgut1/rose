/**
 * Yasin / Sinan ekranı ile ETA kaydı ve arşiv kuyruğu ayrı kapılardır.
 *
 * Ekran kuralı `son_10_fatura_screen.dart` içindeki nihai liste ile aynıdır.
 * Kayıt, fatura bu iki ekrandan birindeyken yapılır. `onayDurumu` değişmez;
 * muhasebe "onay bekliyor" listesi boş durum ve `onaya sunuldu` ile kalır.
 * Arşiv kuyruğu ancak `onaylandı` olduktan sonra açılır.
 *
 * `eta_kayitli`: ETA fişi yazıldı, Yasin veya Sinan henüz onaylamadı.
 * Yayındaki web, arşiv düğmesini `arsivDurumu` dolu ve `arsiv_bekliyor` değilken
 * gizler. Bu değer o yüzden `arsiv_bekliyor` değildir.
 */

export const ARSIV_ETA_KAYITLI = "eta_kayitli";
export const ARSIV_BEKLIYOR = "arsiv_bekliyor";

export function normBirim(raw) {
  let s = String(raw ?? "").trim().replaceAll("İ", "i").replaceAll("I", "ı");
  s = s.toLowerCase();
  return s
    .replaceAll("ı", "i")
    .replaceAll("ş", "s")
    .replaceAll("ğ", "g")
    .replaceAll("ü", "u")
    .replaceAll("ö", "o")
    .replaceAll("ç", "c");
}

export function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("ı", "i");
}

function onayMetni(raw) {
  return String(raw ?? "").trim().replace(/\s+/g, " ");
}

/** Dart `_invoiceSupplierVknDigits`: önce `supplierVkn`, yoksa `qnbRaw.gondericiVkn`. */
export function vknRakam(data) {
  const top = String(data?.supplierVkn || "").replace(/\D/g, "");
  if (top) return top;
  const q = data?.qnbRaw && typeof data.qnbRaw === "object" ? data.qnbRaw : {};
  return String(q.gondericiVkn || "").replace(/\D/g, "");
}

/**
 * `suppliers/{birim}` belgesinden rakam VKN kümesi ve sorguya verilebilecek ham değerler.
 * @returns {{ digits: Set<string>, sorgular: Set<string> }}
 */
export function vknKaynaklari(data) {
  const digits = new Set();
  const sorgular = new Set();
  const consume = (raw) => {
    if (raw == null) return;
    if (Array.isArray(raw)) {
      for (const e of raw) consume(e);
      return;
    }
    const s = String(raw).trim();
    if (!s) return;
    if (s.includes(",") || s.includes(";")) {
      for (const part of s.split(/[,;]\s*/)) consume(part);
      return;
    }
    sorgular.add(s);
    const v = s.replace(/\D/g, "");
    if (v) {
      digits.add(v);
      sorgular.add(v);
    }
  };
  if (data && typeof data === "object") {
    if ("vkns" in data) consume(data.vkns);
    if ("vkn" in data) consume(data.vkn);
    if ("vknList" in data) consume(data.vknList);
  }
  return { digits, sorgular };
}

/**
 * Bu nihai kullanıcı faturayı kendi listesinde görür mü?
 * `kisi`: `{ uid, birimNorm, vkns: Set<string> }`.
 * `sube`: `_hedefSubeBirimi` sonucu. `onaya sunuldu` kolunda kullanılmaz.
 * Karşılaştırma Dart ile aynı: şube metni tekrar normalize edilmez.
 */
export function faturaNihaiEkranda(data, kisi, sube) {
  const onay = onayMetni(data?.onayDurumu);
  const hedefUid = String(data?.nihaiOnayAtananUid || "").trim();
  if (onay === "onaya sunuldu") {
    if (kisi.birimNorm === "sinan") return hedefUid === kisi.uid;
    if (hedefUid && hedefUid !== kisi.uid) return false;
    return true;
  }
  if (onay !== "") return false;
  if (!kisi.vkns || kisi.vkns.size === 0) return false;
  const assigned = String(data?.araOnayAtananUid || "").trim();
  const yonlendiren = String(data?.araOnayYonlendirenUid || "").trim();
  const subeMetni = String(sube || "").trim();
  if (subeMetni && !yonlendiren) {
    if (kisi.birimNorm !== subeMetni) return false;
  } else if (assigned && assigned !== kisi.uid) {
    return false;
  }
  const vkn = vknRakam(data);
  return Boolean(vkn && kisi.vkns.has(vkn));
}

/** Yasin veya Sinan'ın ekranında. İkisinden biri yeter. */
export function yasinVeyaSinanEkraninda(data, kisiler, sube) {
  return (kisiler || []).some((k) => faturaNihaiEkranda(data, k, sube));
}

/**
 * ETA'ya yazma kapısı.
 * Onaylanmış fatura (eski yol) veya Yasin/Sinan ekranındaki fatura.
 * Reddedilmiş fatura yazılmaz.
 */
export function kaydaUygun(data, kisiler, sube) {
  const onay = normalizeStatus(data?.onayDurumu);
  if (onay === "reddedildi") return false;
  if (onay === "onaylandi") return true;
  return yasinVeyaSinanEkraninda(data, kisiler, sube);
}

/** Şube hesabı yalnız onay durumu boşken gerekir; `onaya sunuldu` atamaya bakar. */
export function onayDurumuBos(data) {
  return onayMetni(data?.onayDurumu) === "";
}
