/**
 * Araçla ilgili TÜM gider hesaplarını ve bunların pratikteki yönlendirmesini
 * (STKMUHBAGLANTI) SALT OKUNUR keşfeder. Bakım/sigorta/muayene/HGS-OGS/UTTS/
 * lastik/kasko/MTV/ceza gibi "diğer" araç giderlerini haritalamak için.
 *
 * Çalıştırma: cd functions && node scripts/discoverAracGiderDetay.js
 */
import "dotenv/config";
import sql from "mssql";
import { resolveSqlTargets } from "../sqlDbTargets.js";

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

function sec(t) {
  console.log(`\n${"=".repeat(72)}\n${t}\n${"=".repeat(72)}`);
}

async function main() {
  const t = resolveSqlTargets();
  console.log(`Araç gider detay keşfi (SALT OKUNUR): ${t.readDb}`);
  const pool = await new sql.ConnectionPool(sqlConfig(t.readDb)).connect();
  try {
    const accTable = (
      await pool.request().query(
        "SELECT CASE WHEN OBJECT_ID('dbo.MUHKART') IS NOT NULL THEN 'MUHKART' WHEN OBJECT_ID('dbo.MUHHESAP') IS NOT NULL THEN 'MUHHESAP' ELSE '' END AS t"
      )
    ).recordset[0].t;
    const colRs = await pool.request().input("t", sql.NVarChar(128), accTable).query(`
      SELECT c.name AS col FROM sys.columns c
      INNER JOIN sys.tables tt ON tt.object_id=c.object_id
      INNER JOIN sys.schemas s ON s.schema_id=tt.schema_id
      WHERE s.name='dbo' AND tt.name=@t ORDER BY c.column_id
    `);
    const cols = colRs.recordset.map((r) => r.col);
    const kodCol = cols.find((c) => /KOD/i.test(c) && !/KAY/i.test(c)) || cols[0];
    const adCol = cols.find((c) => /(UNVAN|ADI|ACIKLAMA|ISIM)/i.test(c)) || cols[1];

    sec("1) Araçla ilgili hesap planı (ad bazlı arama)");
    const rs = await pool.request().query(`
      SELECT LTRIM(RTRIM(${kodCol})) AS kod, LTRIM(RTRIM(${adCol})) AS ad
      FROM dbo.${accTable} WITH (NOLOCK)
      WHERE UPPER(${adCol}) LIKE '%ARA[ÇC]%'
         OR UPPER(${adCol}) LIKE '%TA[ŞS]IT%'
         OR UPPER(${adCol}) LIKE '%NAK[İI]L VASITA%'
         OR UPPER(${adCol}) LIKE '%B[İI]NEK%'
         OR UPPER(${adCol}) LIKE '%OTO %'
         OR UPPER(${adCol}) LIKE '%OTOLAR%'
         OR UPPER(${adCol}) LIKE '%LAST[İI]K%'
         OR UPPER(${adCol}) LIKE '%MUAYENE%'
         OR UPPER(${adCol}) LIKE '%HGS%'
         OR UPPER(${adCol}) LIKE '%OGS%'
         OR UPPER(${adCol}) LIKE '%UTTS%'
         OR UPPER(${adCol}) LIKE '%KASKO%'
         OR UPPER(${adCol}) LIKE '%MOTORLU TA[ŞS]IT%'
      ORDER BY kod
    `);
    for (const r of rs.recordset) console.log(`  ${r.kod}\t${r.ad}`);
    console.log(`  (${rs.recordset.length} hesap)`);

    sec("2) STKMUHBAGLANTI — araç ile ilgili stok kartı → hesap yönlendirmesi");
    const hasStk = (await pool.request().query("SELECT OBJECT_ID('dbo.STKKART') AS o")).recordset[0].o;
    if (hasStk) {
      const rs2 = await pool.request().query(`
        SELECT LTRIM(RTRIM(B.SMBSTKKOD)) AS stkKod, B.SMBFTNO AS ftno,
               LTRIM(RTRIM(B.SMBMUHKOD1)) AS muhKod1, LTRIM(RTRIM(K.STKCINSI)) AS cins
        FROM dbo.STKMUHBAGLANTI B WITH (NOLOCK)
        LEFT JOIN dbo.STKKART K WITH (NOLOCK) ON K.STKKOD = B.SMBSTKKOD
        WHERE UPPER(ISNULL(K.STKCINSI,'')) LIKE '%ARA[ÇC]%'
           OR UPPER(ISNULL(K.STKCINSI,'')) LIKE '%TA[ŞS]IT%'
           OR UPPER(ISNULL(K.STKCINSI,'')) LIKE '%NAK[İI]L%'
           OR UPPER(ISNULL(K.STKCINSI,'')) LIKE '%B[İI]NEK%'
           OR UPPER(ISNULL(K.STKCINSI,'')) LIKE '%OTO%'
           OR UPPER(ISNULL(K.STKCINSI,'')) LIKE '%LAST[İI]K%'
           OR UPPER(ISNULL(K.STKCINSI,'')) LIKE '%MUAYENE%'
           OR UPPER(ISNULL(K.STKCINSI,'')) LIKE '%HGS%'
           OR UPPER(ISNULL(K.STKCINSI,'')) LIKE '%OGS%'
           OR UPPER(ISNULL(K.STKCINSI,'')) LIKE '%UTTS%'
           OR UPPER(ISNULL(K.STKCINSI,'')) LIKE '%KASKO%'
           OR UPPER(ISNULL(K.STKCINSI,'')) LIKE '%S[İI]GORTA%'
           OR UPPER(ISNULL(K.STKCINSI,'')) LIKE '%K[İI]RA%'
        ORDER BY cins, stkKod
      `);
      for (const r of rs2.recordset)
        console.log(`  STK=${r.stkKod}\tFTNO=${r.ftno}\tMUH=${r.muhKod1 || "-"}\tCINS=${r.cins || "-"}`);
      console.log(`  (${rs2.recordset.length} bağlantı)`);
    } else {
      console.log("  STKKART tablosu yok.");
    }

    sec("3) 689 1 (KKEG) alt hesapları — tam liste");
    const rs3 = await pool.request().query(`
      SELECT LTRIM(RTRIM(${kodCol})) AS kod, LTRIM(RTRIM(${adCol})) AS ad
      FROM dbo.${accTable} WITH (NOLOCK)
      WHERE LTRIM(RTRIM(${kodCol})) LIKE '689 1%'
      ORDER BY kod
    `);
    for (const r of rs3.recordset) console.log(`  ${r.kod}\t${r.ad}`);

    console.log("\nKeşif tamamlandı. Hiçbir veri değiştirilmedi.");
  } finally {
    await pool.close();
  }
}

main().catch((e) => {
  console.error("discoverAracGiderDetay failed:", e?.message || e);
  process.exitCode = 1;
});
