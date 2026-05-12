/**
 * ETA_DENEME_2026 (writeDb) üzerindeki faturaları ve "ilgili tüm bağlantılar"ı silmeden ÖNCE
 * etki sayımını gösterir. Hiçbir veri değiştirmez, sadece SELECT yapar.
 *
 * Çıktı:
 *  - dbo.FATFIS satır sayısı
 *  - dbo.FATFIS'e foreign key ile bağlı tüm tabloların satır sayısı
 *  - dbo.FATHAR'a foreign key ile bağlı tüm tabloların satır sayısı
 *  - FATFIS.FATFISMUHREFNO üzerinden bağlanan MUHFIS / MUHHAR satır sayısı
 *  - Yan etkili (geri alınması riskli) noktalar için uyarılar
 *
 * Gerekli env: functions/.env içindeki DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_WRITE_NAME
 *
 * Çalıştırma:
 *   node scripts/dryRunDeleteEtaDenemeInvoices.js
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

async function countTable(pool, schema, table) {
  const rs = await pool
    .request()
    .query(`SELECT COUNT_BIG(*) AS cnt FROM [${schema}].[${table}] WITH (NOLOCK)`);
  return Number(rs.recordset[0]?.cnt || 0);
}

/**
 * Verilen referans tabloya (örn. dbo.FATFIS) foreign key ile bağlanan tüm tabloları listeler.
 * Çıkan kayıt: { childSchema, childTable, childColumn, parentColumn, fkName }
 */
async function listForeignKeysReferencing(pool, refSchema, refTable) {
  const rs = await pool.request().query(`
    SELECT
      fk.name                                  AS fkName,
      SCHEMA_NAME(tp.schema_id)                AS parentSchema,
      tp.name                                  AS parentTable,
      cp.name                                  AS parentColumn,
      SCHEMA_NAME(tc.schema_id)                AS childSchema,
      tc.name                                  AS childTable,
      cc.name                                  AS childColumn
    FROM sys.foreign_keys fk
    INNER JOIN sys.foreign_key_columns fkc
      ON fkc.constraint_object_id = fk.object_id
    INNER JOIN sys.tables tp
      ON tp.object_id = fk.referenced_object_id
    INNER JOIN sys.columns cp
      ON cp.object_id = fkc.referenced_object_id AND cp.column_id = fkc.referenced_column_id
    INNER JOIN sys.tables tc
      ON tc.object_id = fk.parent_object_id
    INNER JOIN sys.columns cc
      ON cc.object_id = fkc.parent_object_id AND cc.column_id = fkc.parent_column_id
    WHERE SCHEMA_NAME(tp.schema_id) = '${refSchema}'
      AND tp.name = '${refTable}'
    ORDER BY tc.name, fk.name
  `);
  return rs.recordset;
}

/**
 * Child tablodaki, parent tablodaki TÜM kayıtlara referans veren satır sayısı.
 * (Bizde silme kapsamı 'all FATFIS' olduğu için, FK ile bağlı her satır etkilenir.)
 */
async function countReferencingRows(pool, fk) {
  const q = `
    SELECT COUNT_BIG(*) AS cnt
    FROM [${fk.childSchema}].[${fk.childTable}] AS c WITH (NOLOCK)
    INNER JOIN [${fk.parentSchema}].[${fk.parentTable}] AS p WITH (NOLOCK)
      ON p.[${fk.parentColumn}] = c.[${fk.childColumn}]
  `;
  const rs = await pool.request().query(q);
  return Number(rs.recordset[0]?.cnt || 0);
}

/**
 * Verilen sütun adına sahip TÜM kullanıcı tablolarını listeler.
 * (ETA'da FK tanımlı olmayabilir; mantıksal bağ sütun isimleriyle kuruluyor.)
 */
async function findTablesWithColumn(pool, columnName) {
  const rs = await pool.request().query(`
    SELECT
      SCHEMA_NAME(t.schema_id) AS schemaName,
      t.name                   AS tableName,
      c.name                   AS columnName
    FROM sys.columns c
    INNER JOIN sys.tables t ON t.object_id = c.object_id
    WHERE c.name = '${columnName}'
    ORDER BY t.name
  `);
  return rs.recordset;
}

/**
 * childTable.childColumn IN (SELECT parentColumn FROM parentSchema.parentTable) sayımı.
 * "all" kapsamında tüm parent satırlar etkilendiği için EXISTS daha hızlı.
 */
async function countByLogicalLink(pool, childSchema, childTable, childColumn, parentSchema, parentTable, parentColumn) {
  const rs = await pool.request().query(`
    SELECT COUNT_BIG(*) AS cnt
    FROM [${childSchema}].[${childTable}] c WITH (NOLOCK)
    WHERE EXISTS (
      SELECT 1 FROM [${parentSchema}].[${parentTable}] p WITH (NOLOCK)
      WHERE p.[${parentColumn}] = c.[${childColumn}]
    )
  `);
  return Number(rs.recordset[0]?.cnt || 0);
}

async function tableExists(pool, schema, table) {
  const rs = await pool.request().query(`
    SELECT 1 AS ok
    FROM sys.tables t
    INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = '${schema}' AND t.name = '${table}'
  `);
  return rs.recordset.length > 0;
}

/**
 * Bir tablonun REFNO/REFNO2 kalıbına uyan kolonlarını listeler.
 * Belirsiz yan tablolarda link kolonunu tespit etmek için kullanılır.
 */
async function listRefnoColumns(pool, schema, table) {
  const rs = await pool.request().query(`
    SELECT c.name AS colName
    FROM sys.columns c
    INNER JOIN sys.tables t ON t.object_id = c.object_id
    INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = '${schema}' AND t.name = '${table}'
      AND (c.name LIKE '%REFNO%' OR c.name LIKE '%REFNO2%')
    ORDER BY c.column_id
  `);
  return rs.recordset.map((r) => r.colName);
}

/**
 * FATFIS başlığından çıkan ikincil fiş zincirlerinin (STK / CAR) etki sayısı.
 *   FATFIS.<headerCol>   -> <fisTable>.<fisRef>      (parent fiş)
 *   <fisTable>.<fisRef>  -> <harTable>.<harRef>      (parent hareketler)
 */
async function countSecondaryChain(pool, opts) {
  const out = { fisRows: 0, harRows: 0, har2Rows: 0 };

  const headerColRs = await pool.request().query(`
    SELECT COUNT_BIG(*) AS cnt
    FROM dbo.FATFIS WITH (NOLOCK)
    WHERE ISNULL([${opts.headerCol}], 0) > 0
  `);
  out.fatfisRefCount = Number(headerColRs.recordset[0]?.cnt || 0);

  const fisExists = await tableExists(pool, "dbo", opts.fisTable);
  const harExists = await tableExists(pool, "dbo", opts.harTable);
  if (!fisExists) {
    out.notes = [`${opts.fisTable} tablosu yok — sayım atlandı.`];
    return out;
  }

  out.fisRows = Number(
    (
      await pool.request().query(`
        SELECT COUNT_BIG(*) AS cnt
        FROM dbo.[${opts.fisTable}] x WITH (NOLOCK)
        WHERE EXISTS (
          SELECT 1 FROM dbo.FATFIS f WITH (NOLOCK)
          WHERE ISNULL(f.[${opts.headerCol}], 0) = x.[${opts.fisRef}]
        )
      `)
    ).recordset[0]?.cnt || 0
  );

  if (harExists) {
    out.harRows = Number(
      (
        await pool.request().query(`
          SELECT COUNT_BIG(*) AS cnt
          FROM dbo.[${opts.harTable}] h WITH (NOLOCK)
          WHERE EXISTS (
            SELECT 1 FROM dbo.[${opts.fisTable}] x WITH (NOLOCK)
            INNER JOIN dbo.FATFIS f WITH (NOLOCK)
              ON ISNULL(f.[${opts.headerCol}], 0) = x.[${opts.fisRef}]
            WHERE h.[${opts.harRef}] = x.[${opts.fisRef}]
          )
        `)
      ).recordset[0]?.cnt || 0
    );

    if (opts.harRef2) {
      out.har2Rows = Number(
        (
          await pool.request().query(`
            SELECT COUNT_BIG(*) AS cnt
            FROM dbo.[${opts.harTable}] h WITH (NOLOCK)
            WHERE EXISTS (
              SELECT 1 FROM dbo.[${opts.fisTable}] x WITH (NOLOCK)
              INNER JOIN dbo.FATFIS f WITH (NOLOCK)
                ON ISNULL(f.[${opts.headerCol}], 0) = x.[${opts.fisRef}]
              WHERE h.[${opts.harRef2}] = x.[${opts.fisRef}]
            )
          `)
        ).recordset[0]?.cnt || 0
      );
    }
  }

  return out;
}

async function countMuhasebeImpact(pool) {
  const out = { fatfisWithMuhRef: 0, muhfisRows: 0, muhharRows: 0, notes: [] };

  const muhfisExists = await tableExists(pool, "dbo", "MUHFIS");
  const muhharExists = await tableExists(pool, "dbo", "MUHHAR");
  if (!muhfisExists && !muhharExists) {
    out.notes.push("MUHFIS / MUHHAR tabloları bulunamadı; muhasebe etkisi yok varsayılıyor.");
    return out;
  }

  const refRs = await pool.request().query(`
    SELECT COUNT_BIG(*) AS cnt
    FROM dbo.FATFIS WITH (NOLOCK)
    WHERE ISNULL(FATFISMUHREFNO, 0) > 0
  `);
  out.fatfisWithMuhRef = Number(refRs.recordset[0]?.cnt || 0);

  if (muhfisExists) {
    const rs = await pool.request().query(`
      SELECT COUNT_BIG(*) AS cnt
      FROM dbo.MUHFIS m WITH (NOLOCK)
      WHERE EXISTS (
        SELECT 1 FROM dbo.FATFIS f WITH (NOLOCK)
        WHERE ISNULL(f.FATFISMUHREFNO, 0) = m.MUHFISREFNO
      )
    `);
    out.muhfisRows = Number(rs.recordset[0]?.cnt || 0);
  } else {
    out.notes.push("MUHFIS tablosu yok — sayım atlandı.");
  }

  if (muhharExists && muhfisExists) {
    const rs = await pool.request().query(`
      SELECT COUNT_BIG(*) AS cnt
      FROM dbo.MUHHAR h WITH (NOLOCK)
      WHERE EXISTS (
        SELECT 1 FROM dbo.MUHFIS m WITH (NOLOCK)
        INNER JOIN dbo.FATFIS f WITH (NOLOCK)
          ON ISNULL(f.FATFISMUHREFNO, 0) = m.MUHFISREFNO
        WHERE h.MUHHARREFNO = m.MUHFISREFNO
      )
    `);
    out.muhharRows = Number(rs.recordset[0]?.cnt || 0);
  } else if (muhharExists) {
    out.notes.push("MUHHAR var ama MUHFIS yok — sayım atlandı.");
  }

  return out;
}

function fmt(n) {
  return new Intl.NumberFormat("tr-TR").format(n);
}

async function main() {
  const t = resolveSqlTargets();
  console.log("=".repeat(72));
  console.log(`DRY-RUN: ${t.writeDb} üzerindeki fatura silme etki raporu`);
  console.log(`Host: ${t.host}:${t.port}  User: ${t.user}`);
  console.log("=".repeat(72));

  const pool = await new sql.ConnectionPool(sqlConfig(t.writeDb)).connect();
  try {
    const fatfisCnt = await countTable(pool, "dbo", "FATFIS");
    const fatharCnt = await countTable(pool, "dbo", "FATHAR");
    console.log(`\n[BAŞLIK]  dbo.FATFIS  satır = ${fmt(fatfisCnt)}`);
    console.log(`[HAREKET] dbo.FATHAR satır (toplam) = ${fmt(fatharCnt)}`);

    console.log("\n--- FATFIS'e foreign key ile bağlı tablolar ---");
    const fkToFatfis = await listForeignKeysReferencing(pool, "dbo", "FATFIS");
    if (!fkToFatfis.length) {
      console.log("  (tanımlı FK yok — sadece mantıksal bağ olabilir)");
    } else {
      let totalChildRows = 0;
      for (const fk of fkToFatfis) {
        const cnt = await countReferencingRows(pool, fk);
        totalChildRows += cnt;
        console.log(
          `  ${fk.childSchema}.${fk.childTable}.${fk.childColumn} -> ${fk.parentTable}.${fk.parentColumn}  ` +
            `(FK=${fk.fkName})  etkilenen satır = ${fmt(cnt)}`
        );
      }
      console.log(`  --> FATFIS'e bağlı toplam satır = ${fmt(totalChildRows)}`);
    }

    console.log("\n--- FATHAR'a foreign key ile bağlı tablolar ---");
    const fkToFathar = await listForeignKeysReferencing(pool, "dbo", "FATHAR");
    if (!fkToFathar.length) {
      console.log("  (tanımlı FK yok)");
    } else {
      let totalGrand = 0;
      for (const fk of fkToFathar) {
        const cnt = await countReferencingRows(pool, fk);
        totalGrand += cnt;
        console.log(
          `  ${fk.childSchema}.${fk.childTable}.${fk.childColumn} -> ${fk.parentTable}.${fk.parentColumn}  ` +
            `(FK=${fk.fkName})  etkilenen satır = ${fmt(cnt)}`
        );
      }
      console.log(`  --> FATHAR'a bağlı toplam satır = ${fmt(totalGrand)}`);
    }

    console.log("\n--- Mantıksal bağlar (sütun adı konvansiyonu) ---");
    const logicalLinks = [
      { col: "FATFISREFNO", parent: { schema: "dbo", table: "FATFIS", column: "FATFISREFNO" } },
      { col: "FATHARREFNO", parent: { schema: "dbo", table: "FATFIS", column: "FATFISREFNO" } },
      { col: "FATFISMUHREFNO", parent: { schema: "dbo", table: "FATFIS", column: "FATFISREFNO" } },
    ];
    for (const link of logicalLinks) {
      const tables = await findTablesWithColumn(pool, link.col);
      console.log(
        `\n  '${link.col}' sütunu olan tablolar (parent = ${link.parent.schema}.${link.parent.table}.${link.parent.column}):`
      );
      if (!tables.length) {
        console.log("    (eşleşen tablo yok)");
        continue;
      }
      let total = 0;
      for (const tbl of tables) {
        if (tbl.schemaName === link.parent.schema && tbl.tableName === link.parent.table) {
          continue;
        }
        const cnt = await countByLogicalLink(
          pool,
          tbl.schemaName,
          tbl.tableName,
          link.col,
          link.parent.schema,
          link.parent.table,
          link.parent.column
        );
        total += cnt;
        console.log(`    ${tbl.schemaName}.${tbl.tableName}.${link.col}  satır = ${fmt(cnt)}`);
      }
      console.log(`    --> bu sütundan bağlı toplam satır = ${fmt(total)}`);
    }

    console.log("\n--- Muhasebe (FATFIS.FATFISMUHREFNO -> MUHFIS / MUHHAR) ---");
    const muh = await countMuhasebeImpact(pool);
    console.log(`  FATFIS satırları muhasebe ref'li = ${fmt(muh.fatfisWithMuhRef)}`);
    console.log(`  MUHFIS satırları (etkilenecek)   = ${fmt(muh.muhfisRows)}`);
    console.log(`  MUHHAR satırları (etkilenecek)   = ${fmt(muh.muhharRows)}`);
    for (const n of muh.notes) console.log(`  ! ${n}`);

    console.log("\n--- Stok zinciri (FATFIS.FATFISSTKREFNO -> STKFIS -> STKHAR) ---");
    const stk = await countSecondaryChain(pool, {
      headerCol: "FATFISSTKREFNO",
      fisTable: "STKFIS",
      fisRef: "STKFISREFNO",
      harTable: "STKHAR",
      harRef: "STKHARREFNO",
      harRef2: "STKHARREFNO2",
    });
    console.log(`  FATFIS satırları stok ref'li      = ${fmt(stk.fatfisRefCount || 0)}`);
    console.log(`  STKFIS satırları (etkilenecek)    = ${fmt(stk.fisRows)}`);
    console.log(`  STKHAR satırları (etkilenecek)    = ${fmt(stk.harRows)}`);
    if (stk.har2Rows) {
      console.log(`  STKHAR satırları (STKHARREFNO2)   = ${fmt(stk.har2Rows)}  ! ek bağ`);
    }
    for (const n of stk.notes || []) console.log(`  ! ${n}`);

    console.log("\n--- Cari zinciri (FATFIS.FATFISCARREFNO -> CARFIS -> CARHAR) ---");
    const car = await countSecondaryChain(pool, {
      headerCol: "FATFISCARREFNO",
      fisTable: "CARFIS",
      fisRef: "CARFISREFNO",
      harTable: "CARHAR",
      harRef: "CARHARREFNO",
    });
    console.log(`  FATFIS satırları cari ref'li      = ${fmt(car.fatfisRefCount || 0)}`);
    console.log(`  CARFIS satırları (etkilenecek)    = ${fmt(car.fisRows)}`);
    console.log(`  CARHAR satırları (etkilenecek)    = ${fmt(car.harRows)}`);
    for (const n of car.notes || []) console.log(`  ! ${n}`);

    console.log("\n--- Belirsiz yan tablolar (link kolonu keşfi) ---");
    for (const tname of ["FATFISTOPLAM", "STKSERIHAR", "STKSERINO", "STKREZERV", "STKMUHBAGLANTI"]) {
      const exists = await tableExists(pool, "dbo", tname);
      if (!exists) {
        console.log(`  dbo.${tname}: (yok)`);
        continue;
      }
      const cols = await listRefnoColumns(pool, "dbo", tname);
      const total = await countTable(pool, "dbo", tname);
      console.log(`  dbo.${tname}  toplam = ${fmt(total)}  REFNO-kolonları: ${cols.join(", ") || "(yok)"}`);
    }

    console.log("\n--- FATFISTOPLAM bağ probu ---");
    if (await tableExists(pool, "dbo", "FATFISTOPLAM")) {
      const ftCols = await listRefnoColumns(pool, "dbo", "FATFISTOPLAM");
      for (const c of ftCols) {
        const cnt = await countByLogicalLink(
          pool,
          "dbo",
          "FATFISTOPLAM",
          c,
          "dbo",
          "FATFIS",
          "FATFISREFNO"
        );
        console.log(`  FATFISTOPLAM.${c}  ↔  FATFIS.FATFISREFNO  eşleşen satır = ${fmt(cnt)}`);
      }
    } else {
      console.log("  (FATFISTOPLAM yok)");
    }

    console.log("\n--- Yan etkili / dikkat edilmesi gerekenler ---");
    console.log(
      "  * CARKART cari bakiyeleri sp_Fatura_Kayit içinde güncelleniyor; faturalar silindiğinde\n" +
        "    bakiyeler ESKİ değerinde KALMAZ — bakiye tutarsızlığı oluşur. Bu dry-run bunu otomatik olarak\n" +
        "    geri almaz, sadece bilgi amaçlı uyarır."
    );
    console.log(
      "  * STKKART stok bakiye/toplam alanları benzer şekilde güncellenmiş olabilir; silme bunları geri almaz."
    );
    console.log(
      "  * Süreçte yeni oluşturulmuş STKKART / CARKART kayıtları (varsa) bu silmeden etkilenmez —\n" +
        "    master data olarak kalır."
    );
    console.log(
      "  * Firestore tarafına bu dry-run dokunmaz; talebiniz doğrultusunda silme aşamasında da dokunulmayacak."
    );

    console.log("\n" + "=".repeat(72));
    console.log("Dry-run bitti. Hiçbir veri değiştirilmedi.");
    console.log("=".repeat(72));
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error("dryRunDeleteEtaDenemeInvoices failed:", err?.message || err);
  process.exitCode = 1;
});
