/**
 * ETA_DENEME_2026 üzerindeki refno üretim mantığını teşhis eder.
 * Hiçbir veri değiştirmez.
 *
 * Çıktı:
 *  - FATFIS/CARFIS/CARHAR/MUHFIS/MUHHAR/STKFIS/STKHAR/SIRKETLOG için MAX(refno) ve satır sayısı
 *  - sp_Fatura_Kayit ve ilgili procedure'lerin DEFINITION içinde nasıl refno üretildiğine dair anahtar kelime taraması
 *
 * Çalıştırma: node scripts/diagnoseEtaRefnoIssue.js
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

const REFNO_TABLES = [
  ["FATFIS", "FATFISREFNO"],
  ["FATHAR", "FATHARREFNO"],
  ["CARFIS", "CARFISREFNO"],
  ["CARHAR", "CARHARREFNO"],
  ["STKFIS", "STKFISREFNO"],
  ["STKHAR", "STKHARREFNO"],
  ["MUHFIS", "MUHFISREFNO"],
  ["MUHHAR", "MUHHARREFNO"],
  ["FATFISTOPLAM", "FFTREFNO"],
  ["SIRKETLOG", "SIRLOGKYTREFNO"],
];

const PROC_NAMES = [
  "sp_Fatura_Kayit",
  "sp_Fatura_Detay_Kayit",
  "sp_FatFisToplam_Kayit",
  "sp_Yuvarlama_Kayit",
  "sp_Fatura_Muhasebe_Bagla_Deneme",
];

async function main() {
  const t = resolveSqlTargets();
  console.log(`Tanı: ${t.writeDb} @ ${t.host}:${t.port}\n`);
  const pool = await new sql.ConnectionPool(sqlConfig(t.writeDb)).connect();
  try {
    console.log("--- Tablo durumu (cnt + MAX(refno)) ---");
    for (const [tbl, col] of REFNO_TABLES) {
      try {
        const rs = await pool.request().query(`
          SELECT COUNT_BIG(*) AS cnt, MAX([${col}]) AS maxRef
          FROM dbo.[${tbl}] WITH (NOLOCK)
        `);
        const r = rs.recordset[0];
        console.log(`  dbo.${tbl}.${col}  cnt=${r.cnt}  MAX=${r.maxRef ?? "NULL"}`);
      } catch (e) {
        console.log(`  dbo.${tbl}.${col}  HATA: ${e?.message || e}`);
      }
    }

    console.log("\n--- Default constraint / IDENTITY incelemesi ---");
    const idCols = await pool.request().query(`
      SELECT s.name AS sch, t.name AS tbl, c.name AS col,
             c.is_identity, c.is_nullable, dc.definition AS dflt
      FROM sys.columns c
      INNER JOIN sys.tables t ON t.object_id = c.object_id
      INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
      LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
      WHERE t.name IN ('FATFIS','FATHAR','CARFIS','CARHAR','STKFIS','STKHAR','MUHFIS','MUHHAR','SIRKETLOG','FATFISTOPLAM')
        AND c.name LIKE '%REFNO%'
      ORDER BY t.name, c.name
    `);
    for (const r of idCols.recordset) {
      console.log(
        `  ${r.sch}.${r.tbl}.${r.col}  identity=${r.is_identity ? "YES" : "no"}  nullable=${r.is_nullable ? "yes" : "no"}  default=${r.dflt || "-"}`
      );
    }

    console.log("\n--- Sequence keşfi (sys.sequences) ---");
    const seqs = await pool.request().query(`
      SELECT name, current_value, start_value, increment, is_cycling
      FROM sys.sequences ORDER BY name
    `);
    if (!seqs.recordset.length) console.log("  (kayıtlı sequence yok)");
    for (const r of seqs.recordset) {
      console.log(`  ${r.name}  current=${r.current_value}  start=${r.start_value}  inc=${r.increment}`);
    }

    console.log("\n--- 'REFNO üreten' olabilecek tablolar ---");
    const cnt = await pool.request().query(`
      SELECT s.name AS sch, t.name AS tbl
      FROM sys.tables t INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE t.name LIKE '%REFNO%' OR t.name LIKE '%SAYAC%' OR t.name LIKE '%COUNTER%' OR t.name LIKE 'SIRKET%'
      ORDER BY t.name
    `);
    for (const r of cnt.recordset) console.log(`  ${r.sch}.${r.tbl}`);

    console.log("\n--- dbo.HARREFNO içeriği ---");
    try {
      const rs = await pool.request().query(`SELECT TOP 50 * FROM dbo.HARREFNO WITH (NOLOCK)`);
      console.log(`  satır=${rs.recordset.length}`);
      for (const r of rs.recordset) console.log(`  ${JSON.stringify(r)}`);
    } catch (e) {
      console.log(`  HATA: ${e?.message || e}`);
    }

    console.log("\n--- Prosedürlerde refno üretim mantığı (anahtar kelime taraması) ---");
    for (const p of PROC_NAMES) {
      const rs = await pool.request().query(`
        SELECT m.definition
        FROM sys.procedures pr
        INNER JOIN sys.sql_modules m ON m.object_id = pr.object_id
        WHERE pr.name = '${p}'
      `);
      if (!rs.recordset.length) {
        console.log(`\n  [${p}] (bulunamadı)`);
        continue;
      }
      const def = String(rs.recordset[0].definition || "");
      const totalLines = def.split(/\r?\n/).length;
      const interest = def
        .split(/\r?\n/)
        .map((l, i) => ({ i: i + 1, l }))
        .filter(
          ({ l }) =>
            /MAX\s*\(/i.test(l) ||
            /ISNULL\s*\(\s*MAX/i.test(l) ||
            /NEXT VALUE FOR/i.test(l) ||
            /SIRKETLOG/i.test(l) ||
            /SIRLOGKYTREFNO/i.test(l) ||
            /FATFISREFNO\s*=/i.test(l) ||
            /SET\s+@.*REFNO/i.test(l) ||
            /SELECT\s+@.*REFNO/i.test(l)
        );
      console.log(`\n  [${p}]  toplam satır=${totalLines}  ilgili=${interest.length}`);
      for (const ix of interest.slice(0, 40)) {
        console.log(`    L${ix.i}: ${ix.l.trim().slice(0, 200)}`);
      }
      if (interest.length > 40) console.log(`    ... (${interest.length - 40} satır daha)`);
    }
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error("diagnoseEtaRefnoIssue failed:", err?.message || err);
  process.exitCode = 1;
});
