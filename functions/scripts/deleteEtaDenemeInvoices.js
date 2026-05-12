/**
 * ETA_DENEME_2026 (writeDb) üzerindeki TÜM faturaları ve ilgili tüm bağlantılı kayıtları siler.
 *
 * Silme sırası (FK tanımı olmasa da mantıksal bağ için):
 *   1) dbo.MUHHAR        — MUHFIS.MUHFISREFNO üzerinden (FATFIS.FATFISMUHREFNO'dan gelir)
 *   2) dbo.MUHFIS        — FATFIS.FATFISMUHREFNO
 *   3) dbo.STKHAR        — STKFIS.STKFISREFNO üzerinden (FATFIS.FATFISSTKREFNO); STKHARREFNO + STKHARREFNO2 dahil
 *   4) dbo.STKFIS        — FATFIS.FATFISSTKREFNO
 *   5) dbo.CARHAR        — CARFIS.CARFISREFNO üzerinden (FATFIS.FATFISCARREFNO)
 *   6) dbo.CARFIS        — FATFIS.FATFISCARREFNO
 *   7) dbo.FATFISTOPLAM  — FFTREFNO = FATFIS.FATFISREFNO
 *   8) dbo.FATHAR        — FATHARREFNO = FATFIS.FATFISREFNO
 *   9) dbo.FATFIS        — tüm satırlar
 *
 * Güvenlik:
 *   - Tek transaction; herhangi bir adım hata verirse rollback.
 *   - `--apply` parametresi verilmedikçe sadece sayım yapar (dry-run gibi davranır), DELETE çalıştırmaz.
 *   - `--confirm-write-db=<dbAdi>` parametresi `DB_WRITE_NAME` ile birebir eşleşmeli; aksi halde durur.
 *   - CARKART / STKKART bakiyelerine dokunmaz. Firestore'a dokunmaz.
 *
 * Gerekli env: functions/.env (DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_WRITE_NAME)
 *
 * Çalıştırma:
 *   node scripts/deleteEtaDenemeInvoices.js                                  # sadece sayım (no-op)
 *   node scripts/deleteEtaDenemeInvoices.js --apply --confirm-write-db=ETA_DENEME_2026
 */
import "dotenv/config";
import sql from "mssql";
import { resolveSqlTargets } from "../sqlDbTargets.js";

function parseArgs(argv) {
  const out = { apply: false, confirmWriteDb: null };
  for (const a of argv.slice(2)) {
    if (a === "--apply") out.apply = true;
    else if (a.startsWith("--confirm-write-db=")) {
      out.confirmWriteDb = a.slice("--confirm-write-db=".length).trim();
    }
  }
  return out;
}

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

function fmt(n) {
  return new Intl.NumberFormat("tr-TR").format(n);
}

async function scalarCount(tx, query) {
  const rs = await tx.request().query(query);
  return Number(rs.recordset[0]?.cnt || 0);
}

/** Beklenen silme sayıları transaction başında alınır; loglama için kullanılır. */
async function captureCounts(tx) {
  const out = {};
  out.fatfis = await scalarCount(tx, "SELECT COUNT_BIG(*) AS cnt FROM dbo.FATFIS");

  out.fathar = await scalarCount(
    tx,
    `SELECT COUNT_BIG(*) AS cnt
     FROM dbo.FATHAR h
     WHERE EXISTS (SELECT 1 FROM dbo.FATFIS f WHERE f.FATFISREFNO = h.FATHARREFNO)`
  );

  out.fatfistoplam = await scalarCount(
    tx,
    `SELECT COUNT_BIG(*) AS cnt
     FROM dbo.FATFISTOPLAM t
     WHERE EXISTS (SELECT 1 FROM dbo.FATFIS f WHERE f.FATFISREFNO = t.FFTREFNO)`
  );

  out.stkfis = await scalarCount(
    tx,
    `SELECT COUNT_BIG(*) AS cnt
     FROM dbo.STKFIS x
     WHERE EXISTS (
       SELECT 1 FROM dbo.FATFIS f
       WHERE ISNULL(f.FATFISSTKREFNO, 0) = x.STKFISREFNO
     )`
  );

  out.stkhar = await scalarCount(
    tx,
    `SELECT COUNT_BIG(*) AS cnt
     FROM dbo.STKHAR h
     WHERE EXISTS (
       SELECT 1 FROM dbo.STKFIS x
       INNER JOIN dbo.FATFIS f ON ISNULL(f.FATFISSTKREFNO, 0) = x.STKFISREFNO
       WHERE h.STKHARREFNO = x.STKFISREFNO OR h.STKHARREFNO2 = x.STKFISREFNO
     )`
  );

  out.carfis = await scalarCount(
    tx,
    `SELECT COUNT_BIG(*) AS cnt
     FROM dbo.CARFIS x
     WHERE EXISTS (
       SELECT 1 FROM dbo.FATFIS f
       WHERE ISNULL(f.FATFISCARREFNO, 0) = x.CARFISREFNO
     )`
  );

  out.carhar = await scalarCount(
    tx,
    `SELECT COUNT_BIG(*) AS cnt
     FROM dbo.CARHAR h
     WHERE EXISTS (
       SELECT 1 FROM dbo.CARFIS x
       INNER JOIN dbo.FATFIS f ON ISNULL(f.FATFISCARREFNO, 0) = x.CARFISREFNO
       WHERE h.CARHARREFNO = x.CARFISREFNO
     )`
  );

  out.muhfis = await scalarCount(
    tx,
    `SELECT COUNT_BIG(*) AS cnt
     FROM dbo.MUHFIS m
     WHERE EXISTS (
       SELECT 1 FROM dbo.FATFIS f
       WHERE ISNULL(f.FATFISMUHREFNO, 0) = m.MUHFISREFNO
     )`
  );

  out.muhhar = await scalarCount(
    tx,
    `SELECT COUNT_BIG(*) AS cnt
     FROM dbo.MUHHAR h
     WHERE EXISTS (
       SELECT 1 FROM dbo.MUHFIS m
       INNER JOIN dbo.FATFIS f ON ISNULL(f.FATFISMUHREFNO, 0) = m.MUHFISREFNO
       WHERE h.MUHHARREFNO = m.MUHFISREFNO
     )`
  );

  out.toplam =
    out.fatfis +
    out.fathar +
    out.fatfistoplam +
    out.stkfis +
    out.stkhar +
    out.carfis +
    out.carhar +
    out.muhfis +
    out.muhhar;

  return out;
}

function printCounts(label, c) {
  console.log(`\n[${label}] Hedef satır sayıları:`);
  console.log(`  dbo.FATFIS                = ${fmt(c.fatfis)}`);
  console.log(`  dbo.FATHAR                = ${fmt(c.fathar)}`);
  console.log(`  dbo.FATFISTOPLAM (FFTREFNO) = ${fmt(c.fatfistoplam)}`);
  console.log(`  dbo.STKFIS                = ${fmt(c.stkfis)}`);
  console.log(`  dbo.STKHAR                = ${fmt(c.stkhar)}`);
  console.log(`  dbo.CARFIS                = ${fmt(c.carfis)}`);
  console.log(`  dbo.CARHAR                = ${fmt(c.carhar)}`);
  console.log(`  dbo.MUHFIS                = ${fmt(c.muhfis)}`);
  console.log(`  dbo.MUHHAR                = ${fmt(c.muhhar)}`);
  console.log(`  TOPLAM                    = ${fmt(c.toplam)}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const t = resolveSqlTargets();

  console.log("=".repeat(72));
  console.log(`SİL: ${t.writeDb} üzerinde fatura + ilgili tüm bağlantılı kayıt silme`);
  console.log(`Host: ${t.host}:${t.port}  User: ${t.user}  Mode: ${args.apply ? "APPLY" : "DRY-RUN"}`);
  console.log("=".repeat(72));

  if (args.apply) {
    if (!args.confirmWriteDb) {
      throw new Error(
        "Apply mode için --confirm-write-db=<dbAdi> parametresi zorunludur. " +
          `Beklenen: --confirm-write-db=${t.writeDb}`
      );
    }
    if (args.confirmWriteDb !== t.writeDb) {
      throw new Error(
        `--confirm-write-db değeri DB_WRITE_NAME ile eşleşmiyor. ` +
          `Verilen='${args.confirmWriteDb}', beklenen='${t.writeDb}'.`
      );
    }
  }

  const pool = await new sql.ConnectionPool(sqlConfig(t.writeDb)).connect();
  const tx = new sql.Transaction(pool);
  let txStarted = false;
  try {
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    txStarted = true;

    const before = await captureCounts(tx);
    printCounts("BEFORE", before);

    if (!args.apply) {
      await tx.rollback();
      txStarted = false;
      console.log("\nDRY-RUN: Hiçbir silme yapılmadı. Gerçek silme için:");
      console.log(`  node scripts/deleteEtaDenemeInvoices.js --apply --confirm-write-db=${t.writeDb}`);
      return;
    }

    console.log("\nAPPLY: Silme başlıyor...");

    // 1) MUHHAR
    const r1 = await tx.request().query(`
      DELETE h
      FROM dbo.MUHHAR h
      INNER JOIN dbo.MUHFIS m ON m.MUHFISREFNO = h.MUHHARREFNO
      INNER JOIN dbo.FATFIS f ON ISNULL(f.FATFISMUHREFNO, 0) = m.MUHFISREFNO
    `);
    console.log(`  [1/9] dbo.MUHHAR        silindi : ${fmt(r1.rowsAffected[0] || 0)} satır`);

    // 2) MUHFIS
    const r2 = await tx.request().query(`
      DELETE m
      FROM dbo.MUHFIS m
      INNER JOIN dbo.FATFIS f ON ISNULL(f.FATFISMUHREFNO, 0) = m.MUHFISREFNO
    `);
    console.log(`  [2/9] dbo.MUHFIS        silindi : ${fmt(r2.rowsAffected[0] || 0)} satır`);

    // 3) STKHAR (STKHARREFNO + STKHARREFNO2)
    const r3 = await tx.request().query(`
      DELETE h
      FROM dbo.STKHAR h
      WHERE EXISTS (
        SELECT 1 FROM dbo.STKFIS x
        INNER JOIN dbo.FATFIS f ON ISNULL(f.FATFISSTKREFNO, 0) = x.STKFISREFNO
        WHERE h.STKHARREFNO = x.STKFISREFNO OR h.STKHARREFNO2 = x.STKFISREFNO
      )
    `);
    console.log(`  [3/9] dbo.STKHAR        silindi : ${fmt(r3.rowsAffected[0] || 0)} satır`);

    // 4) STKFIS
    const r4 = await tx.request().query(`
      DELETE x
      FROM dbo.STKFIS x
      INNER JOIN dbo.FATFIS f ON ISNULL(f.FATFISSTKREFNO, 0) = x.STKFISREFNO
    `);
    console.log(`  [4/9] dbo.STKFIS        silindi : ${fmt(r4.rowsAffected[0] || 0)} satır`);

    // 5) CARHAR
    const r5 = await tx.request().query(`
      DELETE h
      FROM dbo.CARHAR h
      INNER JOIN dbo.CARFIS x ON x.CARFISREFNO = h.CARHARREFNO
      INNER JOIN dbo.FATFIS f ON ISNULL(f.FATFISCARREFNO, 0) = x.CARFISREFNO
    `);
    console.log(`  [5/9] dbo.CARHAR        silindi : ${fmt(r5.rowsAffected[0] || 0)} satır`);

    // 6) CARFIS
    const r6 = await tx.request().query(`
      DELETE x
      FROM dbo.CARFIS x
      INNER JOIN dbo.FATFIS f ON ISNULL(f.FATFISCARREFNO, 0) = x.CARFISREFNO
    `);
    console.log(`  [6/9] dbo.CARFIS        silindi : ${fmt(r6.rowsAffected[0] || 0)} satır`);

    // 7) FATFISTOPLAM
    const r7 = await tx.request().query(`
      DELETE t
      FROM dbo.FATFISTOPLAM t
      INNER JOIN dbo.FATFIS f ON f.FATFISREFNO = t.FFTREFNO
    `);
    console.log(`  [7/9] dbo.FATFISTOPLAM  silindi : ${fmt(r7.rowsAffected[0] || 0)} satır`);

    // 8) FATHAR
    const r8 = await tx.request().query(`
      DELETE h
      FROM dbo.FATHAR h
      INNER JOIN dbo.FATFIS f ON f.FATFISREFNO = h.FATHARREFNO
    `);
    console.log(`  [8/9] dbo.FATHAR        silindi : ${fmt(r8.rowsAffected[0] || 0)} satır`);

    // 9) FATFIS
    const r9 = await tx.request().query(`DELETE FROM dbo.FATFIS`);
    console.log(`  [9/9] dbo.FATFIS        silindi : ${fmt(r9.rowsAffected[0] || 0)} satır`);

    // Doğrulama
    const after = await captureCounts(tx);
    printCounts("AFTER", after);
    if (after.toplam !== 0) {
      throw new Error(
        `Silme sonrası kalan satır bulundu (toplam=${after.toplam}). Rollback yapılıyor.`
      );
    }

    await tx.commit();
    txStarted = false;
    console.log("\nCOMMIT yapıldı. Silme tamamlandı.");
    console.log("\nNot: CARKART / STKKART bakiyeleri DOKUNULMADI (talep gereği).");
    console.log("Not: Firestore'a DOKUNULMADI (talep gereği).");
  } catch (err) {
    if (txStarted) {
      try {
        await tx.rollback();
        console.error("Hata oluştu, ROLLBACK yapıldı.");
      } catch (e) {
        console.error("Rollback sırasında ek hata:", e?.message || e);
      }
    }
    throw err;
  } finally {
    try {
      await pool.close();
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error("deleteEtaDenemeInvoices failed:", err?.message || err);
  process.exitCode = 1;
});
