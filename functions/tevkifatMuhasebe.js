/**

 * Tevkifatlı alış: matrah × KDV oranı = toplam KDV;

 * toplam KDV × tevkifat oranı = sorumlu sıfat (360); kalan = indirilecek (191).

 */



export function roundMoney(n) {

  const x = Number(n);

  if (!Number.isFinite(x)) return 0;

  return Math.round((x + Number.EPSILON) * 100) / 100;

}



function normalizePercent(v) {

  const n = Number(v);

  if (!Number.isFinite(n) || n <= 0) return 0;

  return n > 0 && n <= 1 ? n : n / 100;

}



/**

 * Belge döviz cinsinden gelen tutarı ETA'ya yazılacak TL'ye çevirir (OTV vb.).

 */

export function convertDocAmountToTlIfNeeded(docAmount, opts) {

  const n = roundMoney(docAmount);

  if (n <= 0) return 0;

  const isForeign = Boolean(opts?.isForeignCurrency);

  const kur = Number(opts?.kur);

  const ref = Number(opts?.tlReferenceAmount);

  const threshold = Number(opts?.ratioThreshold ?? 0.35);

  if (!isForeign || !Number.isFinite(kur) || kur <= 0) return n;

  if (!Number.isFinite(ref) || ref <= 0) return roundMoney(n * kur);

  if (n >= ref * threshold) return n;

  const converted = roundMoney(n * kur);

  if (converted > ref) return n;

  return converted;

}



/**

 * @param {object} p

 * @param {number} p.malHizmetToplam - matrah (TL)

 * @param {number} p.kdvOrani - yüzde (10) veya oran (0.1)

 * @param {number} p.tevkifatOrani - yüzde (70) veya oran (0.7)

 */

export function computeTevkifatKdvSplit(p) {

  const mal = roundMoney(p.malHizmetToplam);

  const kdvFrac = normalizePercent(p.kdvOrani);

  const tevFrac = normalizePercent(p.tevkifatOrani);



  const toplamKdv = mal > 0 && kdvFrac > 0 ? roundMoney(mal * kdvFrac) : 0;

  const sorumluKdv =

    toplamKdv > 0 && tevFrac > 0 ? roundMoney(toplamKdv * tevFrac) : 0;

  const kdvIndirilecek = roundMoney(toplamKdv - sorumluKdv);

  const odenecekTutar = roundMoney(mal + kdvIndirilecek);



  return {

    malHizmetToplam: mal,

    toplamKdv,

    sorumluKdv,

    tevkifatTutar: sorumluKdv,

    kdvIndirilecek,

    odenecekTutar,

    genelToplam: roundMoney(mal + toplamKdv),

  };

}

/**
 * Tevkifatlı faturada UBL/qnb ödenecek tutarını otorite kabul eder;
 * indirilecek KDV ve tevkifat tutarını buna göre hizalar.
 *
 * @param {ReturnType<typeof computeTevkifatKdvSplit> | null} split
 * @param {number} payableTl - TL ödenecek (UBL PayableAmount × kur)
 */
export function alignTevkifatSplitToPayable(split, payableTl) {
  if (!split) return null;
  const payable = roundMoney(payableTl);
  if (payable <= 0) return split;

  const mal = Number(split.malHizmetToplam) || 0;
  let toplamKdv = Number(split.toplamKdv) || 0;
  if (toplamKdv <= 0 && mal > 0) {
    return { ...split, odenecekTutar: payable };
  }

  let kdvIndirilecek = roundMoney(payable - mal);
  if (kdvIndirilecek < 0) kdvIndirilecek = 0;
  let tevkifatTutar = roundMoney(toplamKdv - kdvIndirilecek);
  if (tevkifatTutar < 0) tevkifatTutar = 0;

  return {
    ...split,
    malHizmetToplam: mal,
    toplamKdv,
    kdvIndirilecek,
    tevkifatTutar,
    sorumluKdv: tevkifatTutar,
    odenecekTutar: payable,
    genelToplam: roundMoney(mal + toplamKdv),
  };
}


