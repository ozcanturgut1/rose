/**
 * dbo.sp_Fatura_Detay_Kayit kopyasında STKHARNETFIYAT'a birim net fiyat yazdırır.
 *
 * Konnektör prosedürü STKHAR satırındaki dört alana da (`STKHARNETTUTAR`,
 * `STKHARNETFIYAT`, `STKHAROTVMATRAH`, `STKHAROTVTUTAR`) aynı değeri, yani
 * `@FatHarKdvMatrah` = (miktar × birim fiyat) − iskonto = satırın NET TOPLAMINI
 * yazıyor. `STKHARNETFIYAT` ise ETA'nın kendi kayıtlarında birim fiyat tutuyor:
 * canlıda incelenen 200 alış satırının 200'ünde `netFiyat = netTutar / miktar`.
 * Toplam yazılması stok birim maliyetini satır tutarı kadar büyük gösterir.
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

/**
 * @param {string} def prosedür tanımı
 * @returns {{ result: string, replaced: boolean, reason?: string }}
 */
export function transformSpFaturaDetayKayitNetFiyat(def) {
  if (!def || typeof def !== "string") return { result: def, replaced: false, reason: "bos tanim" };

  // Zaten yamalı: idempotent olmalı, aynı kopya birden çok kez kurulabiliyor.
  if (def.includes("@FatHarNetFiyat")) {
    return { result: def, replaced: false, reason: "zaten uygulanmis" };
  }
  if (!def.includes(STKHAR_VALUES_TAIL)) {
    return { result: def, replaced: false, reason: "STKHAR values kuyrugu bulunamadi" };
  }
  if (!ANCHOR.test(def)) {
    return { result: def, replaced: false, reason: "@FatHarToplamTut tanimi bulunamadi" };
  }

  // Kuyruk tek yerde geçmeli; birden fazlaysa hangi insert olduğundan emin olamayız.
  const kez = def.split(STKHAR_VALUES_TAIL).length - 1;
  if (kez !== 1) {
    return { result: def, replaced: false, reason: `values kuyrugu ${kez} yerde gecti` };
  }

  let out = def.replace(ANCHOR, DECLARATION);
  out = out.replace(STKHAR_VALUES_TAIL, STKHAR_VALUES_TAIL_PATCHED);
  return { result: out, replaced: out !== def };
}
