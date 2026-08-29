/**
 * dbo.sp_Fatura_Muhasebe_Bagla_Deneme — tevkifatlı fatura muhasebe kaydı.
 *
 * KDV hesap kodu: FATMUHGRP içinde FMGKDVORAN > 0 satırlarından (ör. %10 → 191 108 10).
 * Eski FMGISLEMNO=55 (oransız 191) yalnızca yedek.
 *
 * Tevkifatlı alışta:
 *   - Toplam KDV = FATFISKDVTUTARI (mal × KDV oranı)
 *   - Sorumlu sıfat KDV = tevkifat tutarı → 360 hesabı (alacak)
 *   - İndirilecek KDV = toplam KDV − tevkifat → 191 108 … (borç)
 *   - Cari = ödenecek = mal + indirilecek KDV (FATFISGENTOPLAM)
 *   - İndirilecek KDV → 191 108 borç (toplam KDV − sorumlu)
 *   - Sorumlu KDV → 191 109 borç + 360 alacak (fiş dengesi; üretim şablonu)
 *   - MUHFISKAYITONC = 4, MUHFISNO = mevcut MA- dizisinin devamı, MUHFISMATATEFLAG = 1 (arayüz listesi), SIRKETLOG (modul 4)
 *
 * Hedef DB varsayılan olarak DB_WRITE_NAME'dir; --target-db ile .env'e dokunmadan
 * başka bir DB'ye (ör. canlı) kurulum yapılabilir. SQL dosyasındaki {{REF_DB}} yer
 * tutucusu kurulum sırasında DB_READ_NAME ile değiştirilir.
 *
 * Güvenlik: default DRY-RUN.
 *
 *   node scripts/patchSpFaturaMuhasebeBaglaTevkifat.js
 *   node scripts/patchSpFaturaMuhasebeBaglaTevkifat.js --apply --confirm-target-db=ETA_DENEME_2026
 *   node scripts/patchSpFaturaMuhasebeBaglaTevkifat.js --target-db=ETA_TEKNIKFILAMENT_2026 --apply --confirm-target-db=ETA_TEKNIKFILAMENT_2026
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
const REF_DB_TOKEN = "{{REF_DB}}";

function parseArgs(argv) {
  const out = { apply: false, confirmTargetDb: null, syncFatmuhgrpOnly: false, targetDb: null };
  for (const a of argv.slice(2)) {
    if (a === "--apply") out.apply = true;
    else if (a === "--sync-fatmuhgrp-only") out.syncFatmuhgrpOnly = true;
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

async function syncFatmuhgrpKdvRows(pool, readDb) {
  const safeDb = readDb.replace(/]/g, "]]");
  const syncRs = await pool.request().query(`
    UPDATE w
    SET
      w.FMGMUHKOD1 = r.FMGMUHKOD1 COLLATE DATABASE_DEFAULT,
      w.FMGMUHKOD2 = r.FMGMUHKOD2 COLLATE DATABASE_DEFAULT,
      w.FMGMUHKOD3 = r.FMGMUHKOD3 COLLATE DATABASE_DEFAULT,
      w.FMGKDVORAN = r.FMGKDVORAN
    FROM dbo.FATMUHGRUP AS w
    INNER JOIN [${safeDb}].dbo.FATMUHGRUP AS r
      ON r.FMGGRUPKOD COLLATE DATABASE_DEFAULT = w.FMGGRUPKOD
     AND r.FMGISLEMNO = w.FMGISLEMNO
    WHERE w.FMGGRUPKOD = N'FATMUHGRP' COLLATE DATABASE_DEFAULT
      AND ISNULL(r.FMGKDVORAN, 0) > 0;
    SELECT @@ROWCOUNT AS updatedRows;
  `);
  return Number(syncRs.recordset[0]?.updatedRows ?? 0);
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

/**
 * Prosedür gövdesini okur ve {{REF_DB}} yer tutucusunu referans (okuma) DB adıyla
 * değiştirir. Referans fatura satırları JS tarafındaki çözümlemeyle aynı DB'den
 * okunmak zorunda olduğu için DB adı gövdeye kurulum anında gömülür; böylece
 * çalışma zamanında dinamik SQL gerekmez ve yıl devrinde .env değişip prosedür
 * yeniden kurulduğunda adres kendiliğinden güncellenir.
 */
export function loadPatchedProcedureBody(refDb) {
  if (!refDb) throw new Error("loadPatchedProcedureBody: refDb zorunlu.");
  const raw = fs.readFileSync(SQL_FILE, "utf8").trim();
  if (!raw.includes(REF_DB_TOKEN)) {
    throw new Error(
      `${SQL_FILE} içinde ${REF_DB_TOKEN} yer tutucusu bulunamadı; referans DB adı sabitlenmiş olabilir.`
    );
  }
  const body = raw.split(REF_DB_TOKEN).join(`[${refDb.replace(/]/g, "]]")}]`);
  if (body.includes(REF_DB_TOKEN)) {
    throw new Error(`${REF_DB_TOKEN} yer tutucusu değiştirilemedi.`);
  }

  // Tek beklenen çapraz DB adresi referans DB'dir; başka bir ad kalmışsa kurulum durur.
  const unexpected = new Set();
  for (const m of body.matchAll(/\[?([A-Za-z0-9_]+)\]?\.dbo\./g)) {
    if (m[1].toLowerCase() !== refDb.toLowerCase()) unexpected.add(m[1]);
  }
  if (unexpected.size) {
    throw new Error(
      `Beklenmeyen çapraz DB referansı: ${[...unexpected].join(", ")} (beklenen: ${refDb}).`
    );
  }

  return body;
}

async function main() {
  const args = parseArgs(process.argv);
  const t = resolveSqlTargets();
  const targetDb = args.targetDb || t.writeDb;
  const body = loadPatchedProcedureBody(t.readDb);
  // Hedef ve okuma DB'si aynı canlı veritabanına denk geldiğinde FATMUHGRUP senkronu
  // kendi kendine UPDATE'e dönüşür; anlamsız yazma yapmamak için atlanır.
  const syncFatmuhgrp = targetDb.toLowerCase() !== t.readDb.toLowerCase();

  console.log("=".repeat(72));
  console.log(`PATCH: ${PROC} (tevkifat muhasebe mantığı)`);
  console.log(`Hedef DB: ${targetDb}${args.targetDb ? " (--target-db)" : " (DB_WRITE_NAME)"}`);
  console.log(`Referans DB (${REF_DB_TOKEN}): ${t.readDb}`);
  console.log(`Mode: ${args.apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Kaynak: ${SQL_FILE}`);
  console.log(`Uzunluk: ${body.length} karakter`);
  console.log(
    `FATMUHGRUP senkron: ${syncFatmuhgrp ? "evet" : "atlanacak (hedef = referans DB)"}`
  );
  console.log("=".repeat(72));

  if (args.apply) {
    if (!args.confirmTargetDb) {
      throw new Error(`Apply için --confirm-target-db=${targetDb} gerekli.`);
    }
    if (args.confirmTargetDb !== targetDb) {
      throw new Error(`--confirm-target-db eşleşmiyor: '${args.confirmTargetDb}' != '${targetDb}'`);
    }
  }

  const pool = await new sql.ConnectionPool(sqlConfig(targetDb)).connect();
  try {
    const exists = await pool
      .request()
      .query(`SELECT TOP 1 name FROM sys.procedures WHERE name='${PROC}'`);
    console.log(`Mevcut prosedür: ${exists.recordset.length ? "var" : "yok"}`);

    if (!args.apply) {
      console.log("\nDRY-RUN: Değişiklik uygulanmadı.");
      const targetOpt = args.targetDb ? ` --target-db=${targetDb}` : "";
      console.log(
        `  node scripts/patchSpFaturaMuhasebeBaglaTevkifat.js${targetOpt} --apply --confirm-target-db=${targetDb}`
      );
      if (syncFatmuhgrp) {
        console.log(
          `  (yalnızca FATMUHGRUP senkron)${targetOpt} --apply --sync-fatmuhgrp-only --confirm-target-db=${targetDb}`
        );
      }
      return;
    }

    if (!args.syncFatmuhgrpOnly) {
      await pool
        .request()
        .query(`IF OBJECT_ID('dbo.${PROC}','P') IS NOT NULL DROP PROCEDURE dbo.${PROC};`);
      await pool.request().batch(body);
      console.log(`[OK] Prosedür güncellendi (referans DB: ${t.readDb}).`);
    } else {
      console.log("(--sync-fatmuhgrp-only: prosedür adımı atlandı)");
    }

    if (!syncFatmuhgrp) {
      console.log(
        `[ATLANDI] FATMUHGRUP senkronu: hedef ve referans DB aynı ('${targetDb}'), kopyalanacak bir şey yok.`
      );
    } else {
      const updated = await syncFatmuhgrpKdvRows(pool, t.readDb);
      console.log(`[OK] FATMUHGRUP KDV oran satırları senkron (${updated} güncellendi).`);
    }
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
