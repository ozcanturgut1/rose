import sql from "mssql";

/**
 * Çek / senet kur farkı.
 *
 * Normal fatura ve düz kur farkı akışına girmez. Üçü birden gerekir:
 *   1. Belge metninde kur farkı (satır veya genel not)
 *   2. Dar kalıp: vadeli çek/senet, çek/senet için düzenlenmiş, çek/senet kur farkı, çek/senet no
 *   3. Aynı caride bu vade veya numarayla tek çek ya da tek senet kaydı
 * Stok kartı her iki tipte de mevcut ÇEK KUR FARKI kartıdır. Aynı adda birden fazla kart
 * varsa, faturanın carisinin kendi fatura satırlarında daha çok kullanılan kod seçilir.
 * Senette yalnızca açıklamadaki çek sözcüğü senet olur; stok kartı ve stok cinsi aynı kalır.
 * Kart yoksa, teyit yoksa veya birden fazla aday varsa null döner; çağıran mevcut akışa devam eder.
 * Yeni stok kartı açılmaz.
 */

const CEK_KALIPLARI = [
  /vadeli cek\b/,
  /\bcek vade/,
  /\bcek icin duzen/,
  /\bcek kur fark/,
  /\bcek no\b/,
  /\bcek numara/,
];

const SENET_KALIPLARI = [
  /vadeli senet\b/,
  /\bsenet vade/,
  /\bsenet icin duzen/,
  /\bsenet kur fark/,
  /\bsenet no\b/,
  /\bsenet numara/,
];

const CEK_KUR_FARKI_CINSI = "ÇEK KUR FARKI";

/** Canlı kartlarda CSKCSTIP 1 = çek (ilk fiş: müşteri çek giriş), 2 = senet (ilk fiş: müşteri senet giriş). */
const KART_TIPI = { cek: 1, senet: 2 };

function normalizeBelgeMetni(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\u0307/g, "")
    .replaceAll("ı", "i")
    .replaceAll("İ", "i")
    .replaceAll("ğ", "g")
    .replaceAll("Ğ", "g")
    .replaceAll("ü", "u")
    .replaceAll("Ü", "u")
    .replaceAll("ş", "s")
    .replaceAll("Ş", "s")
    .replaceAll("ö", "o")
    .replaceAll("Ö", "o")
    .replaceAll("ç", "c")
    .replaceAll("Ç", "c")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pushText(parts, value) {
  if (value == null) return;
  if (typeof value === "string" || typeof value === "number") {
    const s = String(value).trim();
    if (s) parts.push(s);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) pushText(parts, item);
    return;
  }
  if (typeof value === "object") {
    const t = value["#text"] ?? value["#TEXT"] ?? value._ ?? value.value;
    if (t != null) pushText(parts, t);
  }
}

function headerNotlari(afterData) {
  const parts = [];
  const up = afterData?.ublParsed && typeof afterData.ublParsed === "object" ? afterData.ublParsed : {};
  const inv = Array.isArray(up.Invoice) ? up.Invoice[0] : up.Invoice;
  pushText(parts, inv?.Note);
  pushText(parts, afterData?.belgeOzet?.belgeBilgileri?.Note);
  return parts.join(" ");
}

export function belgeMetni(afterData, lines) {
  const parts = [headerNotlari(afterData)];
  if (Array.isArray(lines)) {
    for (const line of lines) {
      if (line?.stokCinsi) parts.push(String(line.stokCinsi));
      if (line?.description) parts.push(String(line.description));
      if (line?.lineAciklama) parts.push(String(line.lineAciklama));
    }
  }
  return parts.filter(Boolean).join(" ");
}

export function belgeMetnindeKurFarki(afterData, lines) {
  return /kur\s*fark/.test(normalizeBelgeMetni(belgeMetni(afterData, lines)));
}

function gecerliTarih(yil, ay, gun) {
  if (!Number.isInteger(yil) || !Number.isInteger(ay) || !Number.isInteger(gun)) return "";
  if (yil < 1990 || yil > 2100 || ay < 1 || ay > 12 || gun < 1 || gun > 31) return "";
  const dt = new Date(Date.UTC(yil, ay - 1, gun));
  if (dt.getUTCFullYear() !== yil || dt.getUTCMonth() !== ay - 1 || dt.getUTCDate() !== gun) return "";
  return `${yil}-${String(ay).padStart(2, "0")}-${String(gun).padStart(2, "0")}`;
}

function vadeleriBul(raw) {
  const bulunan = [];
  const metin = String(raw || "");
  for (const m of metin.matchAll(/\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/g)) {
    const ymd = gecerliTarih(Number(m[3]), Number(m[2]), Number(m[1]));
    if (ymd) bulunan.push(ymd);
  }
  for (const m of metin.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const ymd = gecerliTarih(Number(m[1]), Number(m[2]), Number(m[3]));
    if (ymd) bulunan.push(ymd);
  }
  return [...new Set(bulunan)];
}

function numaralariBul(norm, tip) {
  const etiket = tip === "senet" ? "senet" : "cek";
  const re = new RegExp(`\\b(?:${etiket}|portfoy)\\s+(?:no\\b|numara\\w*)\\s+(\\d{3,})\\b`, "g");
  const bulunan = [];
  for (const m of String(norm || "").matchAll(re)) {
    const n = String(m[1] || "").replace(/^0+/, "");
    if (n.length >= 3) bulunan.push(n);
  }
  return [...new Set(bulunan)];
}

/**
 * Kur farkı metninden çek veya senet ipucu.
 * Hem çek hem senet kalıbı varsa null (otomatik seçim yok).
 * @returns {{ tip: "cek"|"senet", vadeler: string[], numaralar: string[] } | null}
 */
export function analyzeCekSenetKurFarki(afterData, lines) {
  const raw = belgeMetni(afterData, lines);
  const norm = normalizeBelgeMetni(raw);
  if (!/kur\s*fark/.test(norm)) return null;
  const cek = CEK_KALIPLARI.some((re) => re.test(norm));
  const senet = SENET_KALIPLARI.some((re) => re.test(norm));
  if (cek === senet) return null;
  const tip = cek ? "cek" : "senet";
  return {
    tip,
    vadeler: vadeleriBul(raw),
    numaralar: numaralariBul(norm, tip),
  };
}

function kayitRakami(value) {
  return String(value || "").replace(/\D/g, "").replace(/^0+/, "");
}

function kartNumaralari(row) {
  return [
    row?.CSKPORTFOYNO,
    row?.CSKBANCEKNO,
    row?.CSKBANCEKSERINO,
    row?.CSKILKHAREVRAKNO,
    row?.CSKSONHAREVRAKNO,
  ]
    .map(kayitRakami)
    .filter((n) => n.length >= 3);
}

/**
 * Read DB'de bu cari + tip için vade ve/veya numara tek karta iniyorsa true.
 * Tarih veya numara yoksa teyit edilmez.
 */
export async function cekSenetKaydiTeyit(rPool, ipucu, carkod) {
  const kod = String(carkod || "").trim();
  const tipNo = KART_TIPI[ipucu?.tip];
  const vadeler = Array.isArray(ipucu?.vadeler) ? ipucu.vadeler : [];
  const numaralar = Array.isArray(ipucu?.numaralar) ? ipucu.numaralar : [];
  if (!kod || !tipNo || (!vadeler.length && !numaralar.length)) return false;

  const rs = await rPool
    .request()
    .input("tip", sql.Int, tipNo)
    .input("carkod", sql.NVarChar(40), kod)
    .query(`
      SELECT
        K.CSKPORTFOYNO,
        K.CSKBANCEKNO,
        K.CSKBANCEKSERINO,
        K.CSKILKHAREVRAKNO,
        K.CSKSONHAREVRAKNO,
        CONVERT(char(10), K.CSKVADETAR, 23) AS VADE
      FROM dbo.CSNKART K WITH (NOLOCK)
      WHERE K.CSKCSTIP = @tip
        AND (
          K.CSKILKHARREFNO IN (
            SELECT H.CSNHARREFNO
            FROM dbo.CSNHAR H WITH (NOLOCK)
            INNER JOIN dbo.CARFIS CF WITH (NOLOCK) ON CF.CARFISREFNO = H.CSNHARCARREFNO
            WHERE LTRIM(RTRIM(CF.CARFISCARKOD)) = @carkod
          )
          OR LTRIM(RTRIM(ISNULL(K.CSKILKVERKODU, N''))) = @carkod
          OR LTRIM(RTRIM(ISNULL(K.CSKASILKODU, N''))) = @carkod
          OR LTRIM(RTRIM(ISNULL(K.CSKILKHARKARTKOD, N''))) = @carkod
        )
    `);

  let rows = rs.recordset || [];
  if (vadeler.length) {
    const vadeSet = new Set(vadeler);
    rows = rows.filter((row) => vadeSet.has(String(row.VADE || "").slice(0, 10)));
  }
  if (numaralar.length) {
    const noSet = new Set(numaralar);
    rows = rows.filter((row) => kartNumaralari(row).some((n) => noSet.has(n)));
  }
  return rows.length === 1;
}

/**
 * Açıklamadaki çek sözcüğünü senet yapar. Çekim, ceket gibi sözcüklere dokunmaz.
 */
export function aciklamadaCekYerineSenet(text) {
  return String(text || "").replace(
    /(^|[^\p{L}\p{N}])((?:çek|cek))(?=$|[^\p{L}\p{N}])/giu,
    (full, pre, word) => {
      const upper = word.toLocaleUpperCase("tr-TR");
      const senet =
        word === upper ? "SENET" : word[0] === word[0].toLocaleUpperCase("tr-TR") ? "Senet" : "senet";
      return `${pre}${senet}`;
    }
  );
}

/** Cari kartının birinci döviz kodu. Yurtiçi veya boşsa domestic. Kart yoksa null. */
export async function cariDovizKarti(pool, carkod) {
  const kodCari = String(carkod || "").trim();
  if (!kodCari) return null;
  const rs = await pool
    .request()
    .input("carkod", sql.NVarChar(40), kodCari)
    .query(`
      SELECT TOP 1
        LTRIM(RTRIM(ISNULL(CARDOVKOD1, N''))) AS KOD,
        LTRIM(RTRIM(ISNULL(CARDOVTUR1, N''))) AS TUR
      FROM dbo.CARKART WITH (NOLOCK)
      WHERE CARKOD = @carkod
    `);
  const row = rs.recordset?.[0];
  if (!row) return null;
  const kod = String(row.KOD || "").trim().toUpperCase();
  const tur = String(row.TUR || "").trim().toUpperCase() || "MBNKSAT";
  const domestic = !kod || kod === "TRY" || kod === "TL" || kod === "TRL";
  return { kod, tur, domestic };
}

async function mevcutStokKarti(wPool, rPool, tip, carkod) {
  const rs = await wPool
    .request()
    .input("cinsi", sql.NVarChar(80), CEK_KUR_FARKI_CINSI)
    .query(`
      SELECT LTRIM(RTRIM(STKKOD)) AS STKKOD
      FROM dbo.STKKART WITH (NOLOCK)
      WHERE LTRIM(RTRIM(STKCINSI)) = LTRIM(RTRIM(@cinsi))
        AND ISNULL(STKKOD, N'') <> N''
    `);
  const codes = [
    ...new Set((rs.recordset || []).map((row) => String(row.STKKOD || "").trim()).filter(Boolean)),
  ];
  if (!codes.length) {
    console.warn("çek/senet kur farkı: yazma veritabanında ÇEK KUR FARKI kartı yok");
    return null;
  }
  const source = tip === "senet" ? "senet_kur_farki" : "cek_kur_farki";
  if (codes.length === 1) return { stkkod: codes[0], source };

  const kod = String(carkod || "").trim();
  if (!kod) return null;

  const req = rPool.request();
  req.input("carkod", sql.NVarChar(40), kod);
  const params = codes.map((code, i) => {
    req.input(`s${i}`, sql.NVarChar(40), code);
    return `@s${i}`;
  });
  const usage = await req.query(`
    SELECT LTRIM(RTRIM(H.FATHARSTKKOD)) AS STKKOD, COUNT(*) AS ADET
    FROM dbo.FATHAR H WITH (NOLOCK)
    INNER JOIN dbo.FATFIS F WITH (NOLOCK) ON F.FATFISREFNO = H.FATHARREFNO
    WHERE LTRIM(RTRIM(H.FATHARSTKKOD)) IN (${params.join(",")})
      AND LTRIM(RTRIM(F.FATFISCARKOD)) = @carkod
    GROUP BY LTRIM(RTRIM(H.FATHARSTKKOD))
  `);
  const adet = new Map(
    (usage.recordset || []).map((row) => [String(row.STKKOD || "").trim(), Number(row.ADET) || 0])
  );
  const ranked = codes
    .map((code) => ({ code, n: adet.get(code) || 0 }))
    .sort((a, b) => b.n - a.n);
  if (ranked[0].n > ranked[1].n && ranked[0].n > 0) {
    return { stkkod: ranked[0].code, source };
  }
  return null;
}

/**
 * Teyit ve mevcut stok kartı. Uygun değilse null; çağıran stok seçimine devam eder.
 * @returns {Promise<{ stkkod: string, source: string } | null>}
 */
export async function resolveCekSenetKurFarkiStok(rPool, wPool, ipucu, carkod) {
  const confirmed = await cekSenetKaydiTeyit(rPool, ipucu, carkod);
  if (!confirmed) return null;
  return mevcutStokKarti(wPool, rPool, ipucu.tip, carkod);
}
