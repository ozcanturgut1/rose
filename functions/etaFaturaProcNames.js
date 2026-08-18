/**
 * Fatura kayıt zincirindeki üç ETA prosedürünün adını çözer.
 *
 * Production'da EFE konnektörü `sp_Fatura_Kayit` / `sp_Fatura_Detay_Kayit` /
 * `sp_FatFisToplam_Kayit` prosedürlerini kullanmaya devam ediyor. Bizim yamalı
 * sürümlerimiz canlıda bu tanımları EZMEMELİ; ayrı isimli kopya olarak kurulur ve
 * yalnızca bizim süreç o kopyaları çağırır.
 *
 * Varsayılan: ek yok (mevcut davranış birebir korunur — ETA_DENEME_2026).
 * Production: `ETA_FATURA_PROC_SUFFIX=_Ymm` (veya her prosedür için açık env).
 */

function pickEnv(key) {
  const v = process.env[key];
  return v == null ? "" : String(v).trim();
}

/** SQL enjeksiyonuna karşı: yalnızca harf, rakam, alt çizgi. */
function assertSafeProcName(name, key) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid procedure name from ${key}: '${name}'`);
  }
  return name;
}

export const BASE_FATURA_PROCS = {
  kayit: "sp_Fatura_Kayit",
  detay: "sp_Fatura_Detay_Kayit",
  toplam: "sp_FatFisToplam_Kayit",
};

export function resolveFaturaProcNames() {
  const suffix = pickEnv("ETA_FATURA_PROC_SUFFIX");
  if (suffix && !/^[A-Za-z0-9_]+$/.test(suffix)) {
    throw new Error(`Invalid ETA_FATURA_PROC_SUFFIX: '${suffix}'`);
  }

  const resolve = (envKey, base) => {
    const explicit = pickEnv(envKey);
    if (explicit) return assertSafeProcName(explicit, envKey);
    return suffix ? assertSafeProcName(`${base}${suffix}`, "ETA_FATURA_PROC_SUFFIX") : base;
  };

  return {
    kayit: resolve("ETA_PROC_FATURA_KAYIT", BASE_FATURA_PROCS.kayit),
    detay: resolve("ETA_PROC_FATURA_DETAY_KAYIT", BASE_FATURA_PROCS.detay),
    toplam: resolve("ETA_PROC_FATFISTOPLAM_KAYIT", BASE_FATURA_PROCS.toplam),
  };
}
