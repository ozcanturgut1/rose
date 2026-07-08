/**
 * Binek araç gideri muhasebe kaydında kullanılacak hesap kodlarının read DB'de
 * (DB_READ_NAME) var olduğunu DOĞRULAR. SALT OKUNUR.
 *
 * Çalıştırma: cd functions && node scripts/verifyAracGiderHesaplari.js
 */
import "dotenv/config";
import sql from "mssql";
import { resolveSqlTargets } from "../sqlDbTargets.js";

const CODES = [
  "730 4 27", // Ticari Araç Yakıt Gideri
  "730 4 28", // Binek Araç Yakıt Gid. (kabul %70)
  "770 4 34", // Binek kira kabul edilen kısım (kullanıcı onayı)
  "689 1 07", // Binek Araç Yakıt Gideri (KKEG %30)
  "689 1 11", // Binek Araç Kira Gideri (KKEG)
  "689 1 03", // İndirilemeyen Kdv (KKEG)
  "191 108 01",
  "191 108 10",
  "191 108 20",
];

function sqlConfig(database) {
  const t = resolveSqlTargets();
  return {
    user: t.user,
    password: t.password,
    server: t.host,
    port: t.port,
    database,
    options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
  };
}

async function main() {
  const t = resolveSqlTargets();
  console.log(`Hesap kodu doğrulama (SALT OKUNUR): ${t.readDb}\n`);
  const pool = await new sql.ConnectionPool(sqlConfig(t.readDb)).connect();
  try {
    const tbl = (
      await pool
        .request()
        .query(
          "SELECT CASE WHEN OBJECT_ID('dbo.MUHKART') IS NOT NULL THEN 'MUHKART' WHEN OBJECT_ID('dbo.MUHHESAP') IS NOT NULL THEN 'MUHHESAP' ELSE '' END AS t"
        )
    ).recordset[0].t;
    if (!tbl) {
      console.log("Hesap planı tablosu bulunamadı.");
      return;
    }
    const colRs = await pool.request().input("t", sql.NVarChar(128), tbl).query(`
      SELECT c.name AS col FROM sys.columns c
      INNER JOIN sys.tables t ON t.object_id=c.object_id
      INNER JOIN sys.schemas s ON s.schema_id=t.schema_id
      WHERE s.name='dbo' AND t.name=@t ORDER BY c.column_id
    `);
    const cols = colRs.recordset.map((r) => r.col);
    const kodCol = cols.find((c) => /KOD/i.test(c) && !/KAY/i.test(c)) || cols[0];
    const adCol = cols.find((c) => /(UNVAN|ADI|ACIKLAMA|ISIM)/i.test(c)) || cols[1];
    console.log(`(tablo=${tbl}, kod=${kodCol}, ad=${adCol})\n`);
    for (const code of CODES) {
      const rs = await pool
        .request()
        .input("k", sql.NVarChar(64), code)
        .query(
          `SELECT LTRIM(RTRIM(${adCol})) AS ad FROM dbo.${tbl} WITH (NOLOCK) WHERE LTRIM(RTRIM(${kodCol})) = @k`
        );
      const ad = rs.recordset[0]?.ad;
      console.log(`  ${ad != null ? "VAR " : "YOK "} ${code}\t${ad ?? ""}`);
    }
  } finally {
    await pool.close();
  }
}

main().catch((e) => {
  console.error("verifyAracGiderHesaplari failed:", e?.message || e);
  process.exitCode = 1;
});
