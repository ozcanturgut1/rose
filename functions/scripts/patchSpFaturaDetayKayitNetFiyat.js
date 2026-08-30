/**
 * dbo.sp_Fatura_Detay_Kayit kopyasında net birim fiyat alanlarını düzeltir.
 *
 * İki ayrı sapma var, ikisi de aynı değerle çözülüyor:
 *
 * 1. STKHAR: prosedür satırdaki dört alana da (`STKHARNETTUTAR`,
 *    `STKHARNETFIYAT`, `STKHAROTVMATRAH`, `STKHAROTVTUTAR`) aynı değeri, yani
 *    `@FatHarKdvMatrah` = (miktar × birim fiyat) − iskonto = satırın NET
 *    TOPLAMINI yazıyor.
 * 2. FATHAR: `FATHARNETFIYAT` alanına sabit `0` yazıyor.
 *
 * ETA'nın kendi kayıtlarında ikisi de birim fiyat tutuyor: canlıda FATHAR'ın
 * dolu 31.657 satırının 31.657'sinde `netFiyat = netTutar / miktar`, STKHAR'da
 * incelenen 200 alış satırının 200'ünde aynı kural. Toplam ya da sıfır yazılması
 * birim maliyet tarafını bozuyor.
 *
 * `NETTUTAR` ve ÖTV alanlarına dokunulmaz; onların net toplam taşıması ETA'nın
 * kendi kayıtlarıyla da uyumlu.
 *
 * Bu dönüşüm yalnızca `<ad><suffix>` kopyasına uygulanır (deployFaturaProcCopies.js);
 * EFE konnektörünün kullandığı orijinal prosedür değişmez.
 *
 * Miktar 0 ise bölme yapılamaz; o durumda eski davranış (net toplam) korunur.
 */

// Prosedürdeki STKHAR values listesinin kuyruğu: SIRANO=1'den sonra dört alan da
// aynı değişkeni alıyor. İkincisi STKHARNETFIYAT'a denk gelir.
const STKHAR_VALUES_TAIL =
  ",1,@FatHarKdvMatrah,@FatHarKdvMatrah,@FatHarKdvMatrah,@FatHarKdvMatrah )";

const STKHAR_VALUES_TAIL_PATCHED =
  ",1,@FatHarKdvMatrah,@FatHarNetFiyat,@FatHarKdvMatrah,@FatHarKdvMatrah )";

// Değişkeni tanımlamak için tutunacağımız yer: @FatHarToplamTut hesabının hemen ardı.
const ANCHOR = /(SET\s+@FatHarToplamTut\s*=\s*@FatHarKdvMatrah\s*\+\s*@VergiTutari)/i;

const DECLARATION = `$1
DECLARE @FatHarNetFiyat decimal(28, 9)
SET @FatHarNetFiyat = CASE WHEN ISNULL(@MalHizmetMiktar, 0) = 0 THEN @FatHarKdvMatrah ELSE @FatHarKdvMatrah / @MalHizmetMiktar END`;

// FATHAR insert'inde FATHARNETFIYAT sutununa karsilik gelen sabit 0.
// Yorum etiketi sayesinde hedef tek ve belirsizlik yok.
const FATHAR_NETFIYAT = /(^|\n)(\s*)0,(\s*--<FATHARNETFIYAT\b)/;

/**
 * @param {string} def prosedür tanımı
 * @returns {{ result: string, replaced: boolean, reason?: string }}
 */
export function transformSpFaturaDetayKayitNetFiyat(def) {
  if (!def || typeof def !== "string") return { result: def, replaced: false, reason: "bos tanim" };

  const eksik = [];
  let out = def;

  // Değişken tanımı: iki yama da bunu kullanıyor, bir kez eklenir.
  if (!out.includes("@FatHarNetFiyat")) {
    if (!ANCHOR.test(out)) {
      return { result: def, replaced: false, reason: "@FatHarToplamTut tanimi bulunamadi" };
    }
    out = out.replace(ANCHOR, DECLARATION);
  }

  // 1) STKHAR values kuyrugu. Tek yerde geçmeli; birden fazlaysa hangi insert
  //    olduğundan emin olamayız.
  const stkKez = out.split(STKHAR_VALUES_TAIL).length - 1;
  if (stkKez === 1) {
    out = out.replace(STKHAR_VALUES_TAIL, STKHAR_VALUES_TAIL_PATCHED);
  } else if (stkKez > 1) {
    return { result: def, replaced: false, reason: `STKHAR kuyrugu ${stkKez} yerde gecti` };
  } else if (!out.includes(STKHAR_VALUES_TAIL_PATCHED)) {
    eksik.push("STKHAR kuyrugu bulunamadi");
  }

  // 2) FATHAR sabit sifiri.
  const fatKez = (out.match(new RegExp(FATHAR_NETFIYAT.source, "g")) || []).length;
  if (fatKez === 1) {
    out = out.replace(FATHAR_NETFIYAT, "$1$2@FatHarNetFiyat,$3");
  } else if (fatKez > 1) {
    return { result: def, replaced: false, reason: `FATHARNETFIYAT sifiri ${fatKez} yerde gecti` };
  } else if (!/@FatHarNetFiyat,\s*--<FATHARNETFIYAT\b/.test(out)) {
    eksik.push("FATHARNETFIYAT sabiti bulunamadi");
  }

  if (out === def) {
    return {
      result: def,
      replaced: false,
      reason: eksik.length ? eksik.join(" / ") : "zaten uygulanmis",
    };
  }
  return { result: out, replaced: true, ...(eksik.length && { reason: eksik.join(" / ") }) };
}
