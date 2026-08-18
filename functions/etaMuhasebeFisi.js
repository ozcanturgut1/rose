import sql from "mssql";
import { roundMoney } from "./tevkifatMuhasebe.js";

/**
 * ETA mahsup fişi okuma: `MUHFIS` başlığı + `MUHHAR` borç/alacak satırları.
 *
 * ETA SQL sunucusu yerel ağda olduğu için arayüz fişi canlı okuyamaz. Fiş, SQL'e
 * erişimi olan taraf (yerel worker veya bulut trigger) fatura kaydını yaptıktan
 * hemen sonra okunur ve `qnb_invoices.muhasebeFisi` alanına yazılır; muhasebe
 * kullanıcısı arşive taşımadan önce bu anlık görüntüyü görür.
 *
 * Tüm sorgular salt okunurdur (`WITH (NOLOCK)`), ETA'ya hiçbir yazma yapılmaz.
 */

/** ETA sürümüne göre hesap planı `MUHKART` veya `MUHHESAP`; kolon adları keşifle bulunur. */
let cachedAccountTable;

/** Yalnızca `sys.columns`'tan gelen tanımlayıcılar SQL metnine gömülür. */
function safeIdentifier(name) {
  const s = String(name || "");
  return /^[A-Za-z0-9_]+$/.test(s) ? s : null;
}

/**
 * Hesap adı gösterimi için hesap planı tablosunu ve kod/ad kolonlarını çözer.
 * Bulunamazsa `null` döner ve fiş yalnızca hesap kodlarıyla okunur.
 *
 * @returns {Promise<null | {tbl: string, kodCol: string, adCol: string}>}
 */
async function resolveAccountTable(pool) {
  if (cachedAccountTable !== undefined) return cachedAccountTable;
  try {
    const tblRs = await pool
      .request()
      .query(
        "SELECT CASE WHEN OBJECT_ID('dbo.MUHKART') IS NOT NULL THEN 'MUHKART' " +
          "WHEN OBJECT_ID('dbo.MUHHESAP') IS NOT NULL THEN 'MUHHESAP' ELSE '' END AS t"
      );
    const tbl = safeIdentifier(String(tblRs.recordset[0]?.t || "").trim());
    if (!tbl) {
      cachedAccountTable = null;
      return cachedAccountTable;
    }
    const colRs = await pool.request().input("t", sql.NVarChar(128), tbl).query(`
      SELECT c.name AS col
      FROM sys.columns c
      INNER JOIN sys.tables t ON t.object_id = c.object_id
      INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name = 'dbo' AND t.name = @t
      ORDER BY c.column_id
    `);
    const cols = colRs.recordset.map((r) => String(r.col));
    const kodCol = safeIdentifier(cols.find((c) => /KOD/i.test(c) && !/KAY/i.test(c)));
    const adCol = safeIdentifier(cols.find((c) => /(UNVAN|ADI|ACIKLAMA|ISIM)/i.test(c)));
    cachedAccountTable = kodCol && adCol ? { tbl, kodCol, adCol } : null;
  } catch (_) {
    cachedAccountTable = null;
  }
  return cachedAccountTable;
}

/**
 * ETA tarihi `YYYY-MM-DD` metnine çevirir. `MUHFISTAR` gün başlangıcı olarak
 * saklandığı ve sürücü UTC etiketlediği için UTC alanları okunur.
 */
function toYmd(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Fatura fişine bağlı mahsup fişi referansı (`FATFIS.FATFISMUHREFNO`). */
export async function readMuhFisRefNoFromFatFis(pool, fatFisRefNo) {
  const ref = Number(fatFisRefNo);
  if (!Number.isFinite(ref) || ref <= 0) return 0;
  const rs = await pool
    .request()
    .input("fatRef", sql.Int, ref)
    .query(
      "SELECT TOP 1 ISNULL(FATFISMUHREFNO, 0) AS muhRef FROM dbo.FATFIS WITH (NOLOCK) WHERE FATFISREFNO = @fatRef"
    );
  const v = Number(rs.recordset[0]?.muhRef || 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Mahsup fişini başlık + satırlarıyla okur. Fiş yoksa `null`.
 *
 * `baTipi`: 1 = borç, 2 = alacak (`MUHHARBATIPI`).
 */
export async function readMuhasebeFisi(pool, muhFisRefNo) {
  const ref = Number(muhFisRefNo);
  if (!Number.isFinite(ref) || ref <= 0) return null;

  const headRs = await pool.request().input("muhRef", sql.Int, ref).query(`
    SELECT TOP 1
      MUHFISREFNO                              AS refNo,
      LTRIM(RTRIM(ISNULL(MUHFISNO, '')))       AS fisNo,
      MUHFISTAR                                AS fisTarih,
      ISNULL(MUHFISYEVNO, 0)                   AS yevmiyeNo,
      ISNULL(MUHFISBORCTOP, 0)                 AS borcToplam,
      ISNULL(MUHFISALACAKTOP, 0)               AS alacakToplam,
      LTRIM(RTRIM(ISNULL(MUHFISBELTUR, '')))   AS belgeTuru
    FROM dbo.MUHFIS WITH (NOLOCK)
    WHERE MUHFISREFNO = @muhRef
  `);
  const head = headRs.recordset[0];
  if (!head) return null;

  const acc = await resolveAccountTable(pool);
  const adSelect = acc ? `LTRIM(RTRIM(ISNULL(K.${acc.adCol}, '')))` : "''";
  const adJoin = acc
    ? `LEFT JOIN dbo.${acc.tbl} K WITH (NOLOCK) ` +
      `ON LTRIM(RTRIM(K.${acc.kodCol})) = LTRIM(RTRIM(H.MUHHARMUHKOD))`
    : "";

  const lineRs = await pool.request().input("muhRef", sql.Int, ref).query(`
    SELECT
      ISNULL(H.MUHHARSIRANO, 0)                    AS siraNo,
      LTRIM(RTRIM(ISNULL(H.MUHHARMUHKOD, '')))     AS hesapKodu,
      ${adSelect}                                  AS hesapAdi,
      ISNULL(H.MUHHARBATIPI, 0)                    AS baTipi,
      ISNULL(H.MUHHARTUTAR, 0)                     AS tutar,
      LTRIM(RTRIM(ISNULL(H.MUHHARACIKLAMA, '')))   AS aciklama
    FROM dbo.MUHHAR H WITH (NOLOCK)
    ${adJoin}
    WHERE H.MUHHARREFNO = @muhRef
    ORDER BY H.MUHHARSIRANO
  `);

  const satirlar = lineRs.recordset.map((r) => ({
    siraNo: Number(r.siraNo || 0),
    hesapKodu: String(r.hesapKodu || ""),
    hesapAdi: String(r.hesapAdi || ""),
    baTipi: Number(r.baTipi || 0),
    tutar: roundMoney(r.tutar),
    aciklama: String(r.aciklama || ""),
  }));

  const sumBy = (tip) =>
    roundMoney(satirlar.filter((s) => s.baTipi === tip).reduce((acc2, s) => acc2 + s.tutar, 0));
  const satirBorc = sumBy(1);
  const satirAlacak = sumBy(2);

  return {
    muhFisRefNo: Number(head.refNo || ref),
    fisNo: String(head.fisNo || ""),
    fisTarih: toYmd(head.fisTarih),
    yevmiyeNo: Number(head.yevmiyeNo || 0),
    belgeTuru: String(head.belgeTuru || ""),
    borcToplam: roundMoney(head.borcToplam),
    alacakToplam: roundMoney(head.alacakToplam),
    satirToplamBorc: satirBorc,
    satirToplamAlacak: satirAlacak,
    dengede: Math.abs(satirBorc - satirAlacak) < 0.01,
    satirSayisi: satirlar.length,
    hesapAdiVar: acc != null,
    satirlar,
  };
}

/**
 * Firestore'a yazılmaya hazır mahsup fişi anlık görüntüsü.
 *
 * `durum`: `ok` (fiş okundu) · `yok` (fatura muhasebeye bağlanmamış) ·
 * `bulunamadi` (referans var ama fiş ETA'da yok, ör. elle silinmiş).
 */
export async function buildMuhasebeFisiSnapshot(pool, { muhFisRefNo, fatFisRefNo } = {}) {
  const okunmaTarihi = new Date().toISOString();
  let ref = Number(muhFisRefNo || 0);
  if (!Number.isFinite(ref) || ref <= 0) {
    ref = await readMuhFisRefNoFromFatFis(pool, fatFisRefNo);
  }
  if (!ref) return { durum: "yok", muhFisRefNo: 0, okunmaTarihi };

  const fis = await readMuhasebeFisi(pool, ref);
  if (!fis) return { durum: "bulunamadi", muhFisRefNo: ref, okunmaTarihi };
  return { durum: "ok", okunmaTarihi, ...fis };
}
