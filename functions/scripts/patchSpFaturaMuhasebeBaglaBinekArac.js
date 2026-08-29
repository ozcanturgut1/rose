/**
 * dbo.sp_Fatura_Muhasebe_Bagla_BinekArac — binek araç gideri (yakıt/kira) muhasebe kaydı.
 *
 * Binek araç kuralı:
 *   - Yakıt/bakım: mal ve KDV, kabul (%70) / KKEG (%30) olarak iki satıra bölünür.
 *   - Kira: aylık limite (KDV hariç 46.000) kadar kabul, aşan kısım KKEG.
 *   - İndirilemeyen KDV (KKEG'e isabet eden) ayrı hesaba yazılır.
 *   - Cari alacak = mal + toplam KDV (ödenecek).
 *
 * Normal (ticari / araç dışı) faturaların muhasebe kaydına DOKUNMAZ; bu prosedür
 * yalnızca binek araç faturaları için JS tarafından çağrılır.
 *
 * Hedef DB varsayılan olarak DB_WRITE_NAME'dir; --target-db ile .env'e dokunmadan
 * başka bir DB'ye (ör. canlı) kurulum yapılabilir.
 *
 * Güvenlik: default DRY-RUN.
 *   node scripts/patchSpFaturaMuhasebeBaglaBinekArac.js
 *   node scripts/patchSpFaturaMuhasebeBaglaBinekArac.js --apply --confirm-target-db=ETA_DENEME_2026
 *   node scripts/patchSpFaturaMuhasebeBaglaBinekArac.js --target-db=ETA_TEKNIKFILAMENT_2026 --apply --confirm-target-db=ETA_TEKNIKFILAMENT_2026
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import { resolveSqlTargets } from "../sqlDbTargets.js";

const PROC = "sp_Fatura_Muhasebe_Bagla_BinekArac";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_FILE = path.join(__dirname, "sp_Fatura_Muhasebe_Bagla_BinekArac.sql");

// Prosedürün MUHHAR'a yazacağı hesap kodları; deploy öncesi hedef DB'de var mı diye kontrol edilir.
const REQUIRED_ACCOUNTS = [
  "730 4 28",
  "770 4 34",
  "689 1 07",
  "689 1 11",
  "689 1 03",
  "191 108 01",
  "191 108 10",
  "191 108 20",
];

function parseArgs(argv) {
  const out = { apply: false, confirmTargetDb: null, targetDb: null };
  for (const a of argv.slice(2)) {
    if (a === "--apply") out.apply = true;
    else if (a.startsWith("--target-db=")) out.targetDb = a.slice("--target-db=".length).trim();
    // --confirm-write-db eski yazım; geriye dönük uyumluluk için korunuyor.
    else if (a.startsWith("--confirm-write-db=")) {
      out.confirmTargetDb = a.slice("--confirm-write-db=".length).trim();
    } else if (a.startsWith("--confirm-target-db=")) {
      out.confirmTargetDb = a.slice("--confirm-target-db=".length).trim();
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
    options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
  };
}

export function loadProcedureBody() {
  return fs.readFileSync(SQL_FILE, "utf8").trim();
}

async function checkAccounts(pool) {
  const rs = await pool.request().query(
    "SELECT CASE WHEN OBJECT_ID('dbo.MUHKART') IS NOT NULL THEN 'MUHKART' WHEN OBJECT_ID('dbo.MUHHESAP') IS NOT NULL THEN 'MUHHESAP' ELSE '' END AS t"
  );
  const tbl = rs.recordset[0].t;
  if (!tbl) return { tbl: null, missing: REQUIRED_ACCOUNTS };
  const colRs = await pool.request().input("t", sql.NVarChar(128), tbl).query(`
    SELECT c.name AS col FROM sys.columns c
    INNER JOIN sys.tables t ON t.object_id=c.object_id
    INNER JOIN sys.schemas s ON s.schema_id=t.schema_id
    WHERE s.name='dbo' AND t.name=@t ORDER BY c.column_id
  `);
  const cols = colRs.recordset.map((r) => r.col);
  const kodCol = cols.find((c) => /KOD/i.test(c) && !/KAY/i.test(c)) || cols[0];
  const missing = [];
  for (const code of REQUIRED_ACCOUNTS) {
    const r = await pool
      .request()
      .input("k", sql.NVarChar(64), code)
      .query(`SELECT TOP 1 1 AS ok FROM dbo.${tbl} WITH (NOLOCK) WHERE LTRIM(RTRIM(${kodCol}))=@k`);
    if (!r.recordset.length) missing.push(code);
  }
  return { tbl, missing };
}

async function main() {
  const args = parseArgs(process.argv);
  const t = resolveSqlTargets();
  const targetDb = args.targetDb || t.writeDb;
  const body = loadProcedureBody();

  console.log("=".repeat(72));
  console.log(`PATCH: ${PROC} (binek araç muhasebe)`);
  console.log(`Hedef DB: ${targetDb}${args.targetDb ? " (--target-db)" : " (DB_WRITE_NAME)"}`);
  console.log(`Mode: ${args.apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Kaynak: ${SQL_FILE}`);
  console.log(`Uzunluk: ${body.length} karakter`);
  console.log("=".repeat(72));

  if (args.apply) {
    if (!args.confirmTargetDb)
      throw new Error(`Apply için --confirm-target-db=${targetDb} gerekli.`);
    if (args.confirmTargetDb !== targetDb)
      throw new Error(
        `--confirm-target-db eşleşmiyor: '${args.confirmTargetDb}' != '${targetDb}'`
      );
  }

  const pool = await new sql.ConnectionPool(sqlConfig(targetDb)).connect();
  try {
    const exists = await pool
      .request()
      .query(`SELECT TOP 1 name FROM sys.procedures WHERE name='${PROC}'`);
    console.log(`Mevcut prosedür: ${exists.recordset.length ? "var" : "yok"}`);

    const { tbl, missing } = await checkAccounts(pool);
    console.log(`Hesap planı tablosu: ${tbl || "(bulunamadı)"}`);
    if (missing.length) {
      console.log(`[UYARI] '${targetDb}' içinde eksik hesap kodları: ${missing.join(", ")}`);
    } else {
      console.log(`[OK] Gerekli hesap kodları '${targetDb}' içinde mevcut.`);
    }

    if (!args.apply) {
      console.log("\nDRY-RUN: Değişiklik uygulanmadı.");
      console.log(
        `  node scripts/patchSpFaturaMuhasebeBaglaBinekArac.js` +
          (args.targetDb ? ` --target-db=${targetDb}` : "") +
          ` --apply --confirm-target-db=${targetDb}`
      );
      return;
    }

    if (missing.length) {
      throw new Error(
        `Eksik hesap kodları nedeniyle apply durduruldu: ${missing.join(", ")}. Önce '${targetDb}' içinde bu hesapları açın.`
      );
    }

    await pool.request().query(`IF OBJECT_ID('dbo.${PROC}','P') IS NOT NULL DROP PROCEDURE dbo.${PROC};`);
    await pool.request().batch(body);
    console.log("[OK] Prosedür oluşturuldu/güncellendi.");
  } finally {
    await pool.close();
  }
}

const isRunDirectly = (() => {
  const a1 = process.argv[1];
  if (!a1) return false;
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(a1);
  } catch {
    return false;
  }
})();

if (isRunDirectly) {
  main().catch((err) => {
    console.error("patchSpFaturaMuhasebeBaglaBinekArac failed:", err?.message || err);
    process.exitCode = 1;
  });
}
