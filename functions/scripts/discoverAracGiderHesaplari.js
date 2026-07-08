/**
 * Binek/ticari araç gideri (kira, yakıt, bakım) fatura kaydı için ETA hesap
 * kodlarını KEŞFEDER. SALT OKUNUR — hiçbir veri değiştirmez, sadece SELECT + NOLOCK.
 *
 * Hedef veritabanı: DB_READ_NAME (ör. ETA_TEKNIKFILAMENT_2026) — canlı/okunur ETA.
 *
 * Listelenenler:
 *   1) FATFISTIP            → mevcut fiş tipleri (ALIM / GİDER / YAKIT ALIM ...)
 *   2) Hesap planı (MUHKART)→ 7xx gider, 191 indirilecek KDV, 689/9xx KKEG/nazım,
 *                             ve adı ARAÇ/BINEK/TAŞIT/AKARYAKIT/KİRA/KKEG geçen hesaplar
 *   3) FATMUHGRUP           → fatura muhasebe grubu KDV/mal hesap eşlemeleri
 *   4) STKMUHBAGLANTI (örnek)→ stok kartı → muhasebe hesabı bağlantıları
 *
 * Gerekli: functions/.env → DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_READ_NAME, DB_WRITE_NAME
 * Çalıştırma: cd functions && node scripts/discoverAracGiderHesaplari.js
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
    requestTimeout: 60000,
  };
}

function printSection(title) {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

async function tableExists(pool, name) {
  const rs = await pool
    .request()
    .input("n", sql.NVarChar(128), name)
    .query(
      "SELECT COUNT(*) AS c FROM sys.tables t INNER JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE t.name=@n AND s.name='dbo'"
    );
  return Number(rs.recordset?.[0]?.c || 0) > 0;
}

async function columnsOf(pool, table) {
  const rs = await pool.request().input("t", sql.NVarChar(128), table).query(`
    SELECT c.name AS col, ty.name AS typ
    FROM sys.columns c
    INNER JOIN sys.tables t ON t.object_id = c.object_id
    INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
    INNER JOIN sys.types ty ON ty.user_type_id = c.user_type_id
    WHERE s.name='dbo' AND t.name=@t
    ORDER BY c.column_id
  `);
  return rs.recordset.map((r) => ({ col: r.col, typ: r.typ }));
}

async function main() {
  const t = resolveSqlTargets();
  console.log(`Araç gideri hesap keşfi (SALT OKUNUR): ${t.readDb} @ ${t.host}:${t.port}`);
  const pool = await new sql.ConnectionPool(sqlConfig(t.readDb)).connect();
  try {
    // 1) FATFISTIP — fiş tipleri
    printSection("1) FATFISTIP — mevcut fiş tipleri");
    if (await tableExists(pool, "FATFISTIP")) {
      const cols = (await columnsOf(pool, "FATFISTIP")).map((c) => c.col);
      const kodCol = cols.find((c) => /FATFTKOD/i.test(c)) || cols[0];
      const noCol = cols.find((c) => /FATFTNO/i.test(c)) || cols[0];
      const stkCol = cols.find((c) => /FATFTSTKFTNO/i.test(c));
      const rs = await pool.request().query(
        `SELECT ${noCol} AS FATFTNO, ${kodCol} AS FATFTKOD${stkCol ? `, ${stkCol} AS FATFTSTKFTNO` : ""}
         FROM dbo.FATFISTIP WITH (NOLOCK) ORDER BY ${noCol}`
      );
      for (const r of rs.recordset) {
        console.log(
          `  FATFTNO=${r.FATFTNO}  KOD=${String(r.FATFTKOD || "").trim()}` +
            (stkCol ? `  STKFTNO=${r.FATFTSTKFTNO}` : "")
        );
      }
    } else {
      console.log("  FATFISTIP tablosu bulunamadı.");
    }

    // 2) Hesap planı — MUHKART veya benzeri
    printSection("2) Hesap planı — araç/gider/KDV/KKEG hesapları");
    const accTable = (await tableExists(pool, "MUHKART"))
      ? "MUHKART"
      : (await tableExists(pool, "MUHHESAP"))
        ? "MUHHESAP"
        : null;
    if (accTable) {
      const cols = (await columnsOf(pool, accTable)).map((c) => c.col);
      const kodCol = cols.find((c) => /KOD/i.test(c) && !/MUHKARTKAY/i.test(c)) || cols[0];
      const adCol =
        cols.find((c) => /(UNVAN|ADI|ACIKLAMA|ISIM)/i.test(c)) || cols[1] || cols[0];
      console.log(`  (tablo=${accTable}, kod=${kodCol}, ad=${adCol})`);
      const rs = await pool.request().query(`
        SELECT LTRIM(RTRIM(${kodCol})) AS kod, LTRIM(RTRIM(${adCol})) AS ad
        FROM dbo.${accTable} WITH (NOLOCK)
        WHERE LTRIM(RTRIM(${kodCol})) LIKE '7%'
           OR LTRIM(RTRIM(${kodCol})) LIKE '191%'
           OR LTRIM(RTRIM(${kodCol})) LIKE '689%'
           OR LTRIM(RTRIM(${kodCol})) LIKE '9%'
           OR UPPER(${adCol}) LIKE '%ARA[ÇC]%'
           OR UPPER(${adCol}) LIKE '%B[İI]NEK%'
           OR UPPER(${adCol}) LIKE '%TA[ŞS]IT%'
           OR UPPER(${adCol}) LIKE '%AKARYAKIT%'
           OR UPPER(${adCol}) LIKE '%YAKIT%'
           OR UPPER(${adCol}) LIKE '%K[İI]RA%'
           OR UPPER(${adCol}) LIKE '%KKEG%'
           OR UPPER(${adCol}) LIKE '%KANUNEN%'
        ORDER BY kod
      `);
      for (const r of rs.recordset) console.log(`  ${r.kod}\t${r.ad}`);
      console.log(`  (${rs.recordset.length} hesap listelendi)`);
    } else {
      console.log("  MUHKART/MUHHESAP tablosu bulunamadı. Tüm MUH* tabloları:");
      const rs = await pool.request().query(
        "SELECT t.name FROM sys.tables t INNER JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE t.name LIKE 'MUH%' ORDER BY t.name"
      );
      for (const r of rs.recordset) console.log(`    dbo.${r.name}`);
    }

    // 3) FATMUHGRUP — fatura muhasebe grubu
    printSection("3) FATMUHGRUP — mal/KDV muhasebe eşlemeleri");
    if (await tableExists(pool, "FATMUHGRUP")) {
      const rs = await pool.request().query(`
        SELECT TOP 200 FMGGRUPKOD, FMGISLEMNO, FMGKDVORAN,
               LTRIM(RTRIM(FMGMUHKOD1)) AS FMGMUHKOD1, LTRIM(RTRIM(FMGMUHKOD2)) AS FMGMUHKOD2
        FROM dbo.FATMUHGRUP WITH (NOLOCK)
        ORDER BY FMGGRUPKOD, FMGISLEMNO
      `);
      for (const r of rs.recordset) {
        console.log(
          `  GRUP=${String(r.FMGGRUPKOD || "").trim()}  ISLEM=${r.FMGISLEMNO}  KDV%=${r.FMGKDVORAN}  ` +
            `KOD1=${r.FMGMUHKOD1 || "-"}  KOD2=${r.FMGMUHKOD2 || "-"}`
        );
      }
    } else {
      console.log("  FATMUHGRUP tablosu bulunamadı.");
    }

    // 4) STKMUHBAGLANTI — stok kartı → muhasebe hesabı (örnek + yakıt/araç adayları)
    printSection("4) STKMUHBAGLANTI — stok → muhasebe hesap bağlantısı (örnek)");
    if (await tableExists(pool, "STKMUHBAGLANTI")) {
      const hasStkKart = await tableExists(pool, "STKKART");
      if (hasStkKart) {
        const rs = await pool.request().query(`
          SELECT TOP 100
                 LTRIM(RTRIM(B.SMBSTKKOD)) AS stkKod,
                 B.SMBFTNO AS fisTipNo,
                 LTRIM(RTRIM(B.SMBMUHKOD1)) AS muhKod1,
                 LTRIM(RTRIM(K.STKCINSI)) AS stkCinsi
          FROM dbo.STKMUHBAGLANTI B WITH (NOLOCK)
          LEFT JOIN dbo.STKKART K WITH (NOLOCK) ON K.STKKOD = B.SMBSTKKOD
          WHERE UPPER(ISNULL(K.STKCINSI,'')) LIKE '%YAKIT%'
             OR UPPER(ISNULL(K.STKCINSI,'')) LIKE '%AKARYAKIT%'
             OR UPPER(ISNULL(K.STKCINSI,'')) LIKE '%MOTOR[İI]N%'
             OR UPPER(ISNULL(K.STKCINSI,'')) LIKE '%BENZ[İI]N%'
             OR UPPER(ISNULL(K.STKCINSI,'')) LIKE '%K[İI]RA%'
             OR UPPER(ISNULL(K.STKCINSI,'')) LIKE '%ARA[ÇC]%'
          ORDER BY stkCinsi, stkKod
        `);
        if (rs.recordset.length === 0) {
          console.log("  Yakıt/araç/kira ile eşleşen stok kartı bağlantısı bulunamadı.");
        }
        for (const r of rs.recordset) {
          console.log(
            `  STK=${r.stkKod}  FTNO=${r.fisTipNo}  MUHKOD1=${r.muhKod1 || "-"}  CINS=${r.stkCinsi || "-"}`
          );
        }
      } else {
        const rs = await pool.request().query(`
          SELECT TOP 50 LTRIM(RTRIM(SMBSTKKOD)) AS stkKod, SMBFTNO AS fisTipNo,
                        LTRIM(RTRIM(SMBMUHKOD1)) AS muhKod1
          FROM dbo.STKMUHBAGLANTI WITH (NOLOCK) ORDER BY SMBSTKKOD
        `);
        for (const r of rs.recordset) {
          console.log(`  STK=${r.stkKod}  FTNO=${r.fisTipNo}  MUHKOD1=${r.muhKod1 || "-"}`);
        }
      }
    } else {
      console.log("  STKMUHBAGLANTI tablosu bulunamadı.");
    }

    console.log("\nKeşif tamamlandı. Hiçbir veri değiştirilmedi.");
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error("discoverAracGiderHesaplari failed:", err?.message || err);
  process.exitCode = 1;
});
