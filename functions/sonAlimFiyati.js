/**
 * Son alım birim fiyatı. ETA'ya yazmaz; satır seçimi ve gösterim hesabı.
 * Fiyat, faturada görünen birim fiyatla karşılaştırılsın diye belge dövizi
 * varsa o döviz, yoksa TL birim fiyatıdır.
 */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function alan(row, ad) {
  if (!row || typeof row !== "object") return undefined;
  if (row[ad] != null && row[ad] !== "") return row[ad];
  const key = Object.keys(row).find((k) => k.toUpperCase() === ad);
  return key ? row[key] : undefined;
}

export function normAlimDoviz(raw) {
  const c = String(raw || "").trim().toUpperCase();
  if (!c || c === "TL" || c === "TRY") return "TRY";
  return c;
}

function yakin(a, b, oran) {
  if (!(b > 0)) return false;
  return Math.abs(a - b) / b <= oran;
}

/**
 * Miktar 1'den büyükken fiyat satır tutarına eşitse bu tutar/miktar birim fiyattır.
 * Aksi halde dolu fiyat birim fiyattır.
 */
export function birimFiyatAyikla(fiyat, tutar, miktar) {
  const f = num(fiyat);
  const t = num(tutar);
  const m = num(miktar);
  if (m > 1 && f > 0 && t > 0 && yakin(f, t, 0.02) && !yakin(f * m, t, 0.08)) {
    return t / m;
  }
  if (f > 0) return f;
  if (m > 0 && t > 0) return t / m;
  return 0;
}

/**
 * Geçmiş eşleşme bu kalemin kendi kartı sayılır mı?
 * Baskın stok yedeği ve düşük skor, başka bir kalemin fiyatını göstermesin.
 */
export function gecmisKartSonAlimaUygun(match, minScore = 0.28) {
  const kod = String(match?.stkkod || "").trim();
  if (!kod) return false;
  if (match?.dominantFallback) return false;
  const skor = Number(match?.score);
  if (!Number.isFinite(skor) || skor < minScore) return false;
  return true;
}

/**
 * @param {Record<string, unknown>} row FATHAR + FATFIS satırı
 * @param {string} faturaParaBirimi bu faturanın dövizi
 * @returns {{ fiyat: number, paraBirimi: string } | null}
 */
export function sonAlimBirimFiyati(row, faturaParaBirimi) {
  const miktar = num(alan(row, "MIKTAR"));
  const dovKod = normAlimDoviz(alan(row, "DOVKOD"));
  const istenen = normAlimDoviz(faturaParaBirimi);
  const dovBirim = birimFiyatAyikla(alan(row, "DOVFIYAT"), alan(row, "DOVTUTAR"), miktar);
  const net = num(alan(row, "NETTUTAR"));
  const tutar = num(alan(row, "TUTAR"));
  const tlBirim = birimFiyatAyikla(alan(row, "FIYAT"), net > 0 ? net : tutar, miktar);

  let fiyat = 0;
  let paraBirimi = "TRY";
  if (istenen !== "TRY" && dovKod === istenen && dovBirim > 0) {
    fiyat = dovBirim;
    paraBirimi = dovKod;
  } else if (istenen === "TRY" && tlBirim > 0) {
    fiyat = tlBirim;
    paraBirimi = "TRY";
  } else if (dovKod !== "TRY" && dovBirim > 0) {
    fiyat = dovBirim;
    paraBirimi = dovKod;
  } else if (tlBirim > 0) {
    fiyat = tlBirim;
    paraBirimi = "TRY";
  }
  if (!(fiyat > 0)) return null;
  return { fiyat: Math.round(fiyat * 1e6) / 1e6, paraBirimi };
}
