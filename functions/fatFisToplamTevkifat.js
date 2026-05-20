import sql from "mssql";

/**
 * ETA FATFISTOPLAM satırlarından tevkifat / KDV tutarları (TL).
 * Üretimde gözlenen FFTKONU kodları:
 *   101 — KDV(%…)
 *   73  — DÖVİZ(KDV) TOPLAM
 *   74  — DÖVİZ(TEVKİFAT) TOPLAM  → FFTTUTAR = tevkifat (TL), FFTDOVTUTAR = belge dövizi
 *   75  — DÖVİZ(KALAN KDV) TOPLAM → indirilecek KDV (TL)
 */

export const FFT_KONU = {
  KDV: 101,
  DOVIZ_KDV: 73,
  DOVIZ_TEVKIFAT: 74,
  DOVIZ_KALAN_KDV: 75,
};

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {number} fatFisRefNo
 * @returns {Promise<null | {
 *   toplamKdv: number,
 *   tevkifatTutar: number,
 *   kdvIndirilecek: number,
 *   tevkifatDovizTutar: number,
 *   kdvIndirilecekDovizTutar: number,
 * }>}
 */
export async function loadTevkifatAmountsFromFatFisToplam(pool, fatFisRefNo) {
  const ref = Number(fatFisRefNo);
  if (!Number.isFinite(ref) || ref <= 0) return null;

  const rs = await pool.request().input("ref", sql.Int, ref).query(`
    SELECT FFTKONU, ISNULL(FFTTUTAR, 0) AS tutar, ISNULL(FFTDOVTUTAR, 0) AS dovTutar
    FROM dbo.FATFISTOPLAM WITH (NOLOCK)
    WHERE FFTREFNO = @ref AND FFTKONU IN (73, 74, 75, 101)
  `);

  const byKonu = new Map();
  for (const row of rs.recordset || []) {
    byKonu.set(Number(row.FFTKONU), {
      tutar: Number(row.tutar) || 0,
      dovTutar: Number(row.dovTutar) || 0,
    });
  }

  const k101 = byKonu.get(FFT_KONU.KDV);
  const k73 = byKonu.get(FFT_KONU.DOVIZ_KDV);
  const k74 = byKonu.get(FFT_KONU.DOVIZ_TEVKIFAT);
  const k75 = byKonu.get(FFT_KONU.DOVIZ_KALAN_KDV);

  const toplamKdv = k101?.tutar > 0 ? k101.tutar : k73?.tutar > 0 ? k73.tutar : 0;
  const tevkifatTutar = k74?.tutar ?? 0;
  const kdvIndirilecek =
    k75?.tutar > 0 ? k75.tutar : toplamKdv > 0 && tevkifatTutar > 0 ? toplamKdv - tevkifatTutar : 0;

  if (toplamKdv <= 0 && tevkifatTutar <= 0 && kdvIndirilecek <= 0) return null;
  if (tevkifatTutar <= 0 && kdvIndirilecek <= 0 && toplamKdv <= 0) return null;

  return {
    toplamKdv,
    tevkifatTutar,
    kdvIndirilecek: kdvIndirilecek > 0 ? kdvIndirilecek : Math.max(0, toplamKdv - tevkifatTutar),
    tevkifatDovizTutar: k74?.dovTutar ?? 0,
    kdvIndirilecekDovizTutar: k75?.dovTutar ?? 0,
  };
}

/** sp_FatFisToplam_Kayit sonrası FATFIS başlığını toplam satırlarıyla hizalar. */
export async function syncFatFisHeaderFromFatFisToplam(pool, fatFisRefNo) {
  const amounts = await loadTevkifatAmountsFromFatFisToplam(pool, fatFisRefNo);
  if (!amounts) return null;

  const ref = Number(fatFisRefNo);
  if (amounts.tevkifatTutar > 0) {
    await pool
      .request()
      .input("ref", sql.Int, ref)
      .input("tev", sql.Decimal(18, 4), amounts.tevkifatTutar)
      .query(`
        UPDATE dbo.FATFIS
        SET
          FATFISTEVTUTAR = @tev,
          FATFISTEVKIFATFLAG = 1
        WHERE FATFISREFNO = @ref
      `);
  }

  return amounts;
}
