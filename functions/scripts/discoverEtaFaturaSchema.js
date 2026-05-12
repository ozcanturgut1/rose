/**
 * ETA_DENEME_2026 üzerinde fatura ile bağlantılı olabilecek (STK*, CAR*, MUH*, YUVARLAMA, FATFIS*)
 * tabloları ve REFNO kolonlarını keşfeder. Hiçbir veri değiştirmez.
 *
 * Çalıştırma: node scripts/discoverEtaFaturaSchema.js
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
    options: {
      encrypt: false,
      trustServerCertificate: true,
      enableArithAbort: true,
    },
  };
}

async function main() {
  const t = resolveSqlTargets();
  console.log(`Schema discovery: ${t.writeDb} @ ${t.host}:${t.port}\n`);
  const pool = await new sql.ConnectionPool(sqlConfig(t.writeDb)).connect();
  try {
    const tables = (
      await pool.request().query(`
        SELECT s.name AS schemaName, t.name AS tableName
        FROM sys.tables t
        INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
        WHERE t.name LIKE 'FAT%'
           OR t.name LIKE 'STK%'
           OR t.name LIKE 'CAR%'
           OR t.name LIKE 'MUH%'
           OR t.name LIKE 'YUVAR%'
        ORDER BY t.name
      `)
    ).recordset;

    console.log("--- İlgili tablolar ---");
    for (const r of tables) console.log(`  ${r.schemaName}.${r.tableName}`);
    console.log(`  (${tables.length} tablo)\n`);

    const cols = (
      await pool.request().query(`
        SELECT s.name AS schemaName, t.name AS tableName, c.name AS colName
        FROM sys.columns c
        INNER JOIN sys.tables t ON t.object_id = c.object_id
        INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
        WHERE (
              c.name LIKE '%FATFISREFNO%'
           OR c.name LIKE '%FATHARREFNO%'
           OR c.name LIKE '%STKFISREFNO%'
           OR c.name LIKE '%STOKFISREFNO%'
           OR c.name LIKE '%STKHARREFNO%'
           OR c.name LIKE '%STOKHARREFNO%'
           OR c.name LIKE '%MUHFISREFNO%'
           OR c.name LIKE '%MUHHARREFNO%'
           OR c.name LIKE '%CARFISREFNO%'
           OR c.name LIKE '%CARHARREFNO%'
           OR c.name LIKE '%CARKARTREFNO%'
           OR c.name LIKE '%YUVARREFNO%'
        )
        AND t.name NOT LIKE 'sys%'
        ORDER BY t.name, c.name
      `)
    ).recordset;

    console.log("--- REFNO konvansiyonuna uyan kolonlar ---");
    let currentTable = null;
    for (const r of cols) {
      const key = `${r.schemaName}.${r.tableName}`;
      if (key !== currentTable) {
        console.log(`\n  ${key}:`);
        currentTable = key;
      }
      console.log(`    - ${r.colName}`);
    }

    // Tabloların satır sayıları
    console.log("\n--- Satır sayıları (NOLOCK) ---");
    for (const r of tables) {
      try {
        const rs = await pool
          .request()
          .query(`SELECT COUNT_BIG(*) AS cnt FROM [${r.schemaName}].[${r.tableName}] WITH (NOLOCK)`);
        const cnt = Number(rs.recordset[0].cnt || 0);
        console.log(`  ${r.schemaName}.${r.tableName}  = ${cnt}`);
      } catch (e) {
        console.log(`  ${r.schemaName}.${r.tableName}  HATA: ${e?.message || e}`);
      }
    }

    // FATFIS'in tüm kolonlarını da yazdır — STKFIS/CARFIS bağı genelde FATFIS'te tutulur
    console.log("\n--- dbo.FATFIS kolonları ---");
    const fatfisCols = (
      await pool.request().query(`
        SELECT c.name AS colName, ty.name AS typeName
        FROM sys.columns c
        INNER JOIN sys.tables t ON t.object_id = c.object_id
        INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
        INNER JOIN sys.types ty ON ty.user_type_id = c.user_type_id
        WHERE s.name='dbo' AND t.name='FATFIS'
        ORDER BY c.column_id
      `)
    ).recordset;
    for (const r of fatfisCols) console.log(`  ${r.colName}  (${r.typeName})`);
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error("discoverEtaFaturaSchema failed:", err?.message || err);
  process.exitCode = 1;
});
