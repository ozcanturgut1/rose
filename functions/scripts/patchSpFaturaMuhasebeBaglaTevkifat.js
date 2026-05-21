/**
 * dbo.sp_Fatura_Muhasebe_Bagla_Deneme — tevkifatlı fatura muhasebe kaydı.
 *
 * Tevkifatlı alışta:
 *   - Toplam KDV = FATFISKDVTUTARI (mal × KDV oranı)
 *   - Sorumlu sıfat KDV = tevkifat tutarı → 360 hesabı (alacak)
 *   - İndirilecek KDV = toplam KDV − tevkifat → 191 108 … (borç)
 *   - Cari = ödenecek = mal + indirilecek KDV (FATFISGENTOPLAM)
 *   - İndirilecek KDV → 191 108 borç (toplam KDV − sorumlu)
 *   - Sorumlu KDV → 191 109 borç + 360 alacak (fiş dengesi; üretim şablonu)
 *   - MUHFISKAYITONC = 4, MUHFISNO = MA-{ref+530287}, MUHFISMATATEFLAG = 1 (arayüz listesi), SIRKETLOG (modul 4)
 *
 * Güvenlik: default DRY-RUN.
 *
 *   node scripts/patchSpFaturaMuhasebeBaglaTevkifat.js
 *   node scripts/patchSpFaturaMuhasebeBaglaTevkifat.js --apply --confirm-write-db=ETA_DENEME_2026
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import { resolveSqlTargets } from "../sqlDbTargets.js";

const PROC = "sp_Fatura_Muhasebe_Bagla_Deneme";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_FILE = path.join(__dirname, "sp_Fatura_Muhasebe_Bagla_Deneme.sql");

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

export function loadPatchedProcedureBody() {
  return fs.readFileSync(SQL_FILE, "utf8").trim();
}

async function main() {
  const args = parseArgs(process.argv);
  const t = resolveSqlTargets();
  const body = loadPatchedProcedureBody();

  console.log("=".repeat(72));
  console.log(`PATCH: ${PROC} (tevkifat muhasebe mantığı)`);
  console.log(`DB: ${t.writeDb}  Mode: ${args.apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Kaynak: ${SQL_FILE}`);
  console.log(`Uzunluk: ${body.length} karakter`);
  console.log("=".repeat(72));

  if (args.apply) {
    if (!args.confirmWriteDb) {
      throw new Error(`Apply için --confirm-write-db=${t.writeDb} gerekli.`);
    }
    if (args.confirmWriteDb !== t.writeDb) {
      throw new Error(`--confirm-write-db eşleşmiyor: '${args.confirmWriteDb}' != '${t.writeDb}'`);
    }
  }

  const pool = await new sql.ConnectionPool(sqlConfig(t.writeDb)).connect();
  try {
    const exists = await pool
      .request()
      .query(`SELECT TOP 1 name FROM sys.procedures WHERE name='${PROC}'`);
    console.log(`Mevcut prosedür: ${exists.recordset.length ? "var" : "yok"}`);

    if (!args.apply) {
      console.log("\nDRY-RUN: Değişiklik uygulanmadı.");
      console.log(
        `  node scripts/patchSpFaturaMuhasebeBaglaTevkifat.js --apply --confirm-write-db=${t.writeDb}`
      );
      return;
    }

    await pool
      .request()
      .query(`IF OBJECT_ID('dbo.${PROC}','P') IS NOT NULL DROP PROCEDURE dbo.${PROC};`);
    await pool.request().batch(body);
    console.log("[OK] Prosedür güncellendi.");
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
    console.error("patchSpFaturaMuhasebeBaglaTevkifat failed:", err?.message || err);
    process.exitCode = 1;
  });
}
