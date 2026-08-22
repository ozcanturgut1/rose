/**
 * Fatura kayıt prosedürlerini kaynak DB'den hedef DB'ye AYNI İSİMLE kopyalar
 * (null-safe MAX + cari "tüm tipler" yamaları uygulanarak).
 *
 * DİKKAT: Hedef DB'deki aynı isimli prosedürler DROP edilip yeniden oluşturulur.
 * Production'da bu prosedürleri EFE konnektörü kullandığı için orada bu script
 * yerine ayrı isimli kopya kuran `deployFaturaProcCopies.js` tercih edilmelidir.
 *
 * Bağlantı bilgileri ve varsayılan DB adları env'den gelir (functions/.env):
 *   DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_READ_NAME / DB_WRITE_NAME
 *
 * Güvenlik:
 *   - Varsayılan DRY-RUN. Uygulamak için `--apply --confirm-target-db=<db>`.
 *
 * Çalıştırma örnekleri:
 *   node scripts/copyEtaProcedures.js
 *   node scripts/copyEtaProcedures.js --apply --confirm-target-db=ETA_DENEME_2026
 *   node scripts/copyEtaProcedures.js --source-db=ETA_TEKNIKFILAMENT_2026 --target-db=ETA_DENEME_2026
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import { resolveSqlTargets } from "../sqlDbTargets.js";
import { transformMaxToIsnullMax } from "./patchEtaDenemeProceduresNullSafe.js";
import { transformSpFaturaKayitCariBakiyeAllTypes } from "./patchSpFaturaKayitCariBakiyeAllTypes.js";

const procedures = [
  "sp_Fatura_Kayit",
  "sp_Fatura_Detay_Kayit",
  "sp_FatFisToplam_Kayit",
  "sp_Yuvarlama_Kayit",
];

function parseArgs(argv) {
  const out = { apply: false, confirmTargetDb: null, sourceDb: null, targetDb: null };
  for (const a of argv.slice(2)) {
    if (a === "--apply") out.apply = true;
    else if (a.startsWith("--source-db=")) out.sourceDb = a.slice("--source-db=".length).trim();
    else if (a.startsWith("--target-db=")) out.targetDb = a.slice("--target-db=".length).trim();
    else if (a.startsWith("--confirm-target-db=")) {
      out.confirmTargetDb = a.slice("--confirm-target-db=".length).trim();
    }
  }
  return out;
}

function cfg(database) {
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
    },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const t = resolveSqlTargets();
  const sourceDb = args.sourceDb || t.readDb;
  const targetDb = args.targetDb || t.writeDb;

  if (sourceDb.toLowerCase() === targetDb.toLowerCase()) {
    throw new Error(`Kaynak ve hedef DB aynı olamaz: '${sourceDb}'`);
  }

  console.log("=".repeat(72));
  console.log("COPY: fatura prosedürleri (AYNI İSİMLE, hedefteki tanımlar EZİLİR)");
  console.log(`Kaynak DB: ${sourceDb}   Hedef DB: ${targetDb}`);
  console.log(`Mod: ${args.apply ? "APPLY" : "DRY-RUN"}`);
  console.log("=".repeat(72));

  if (args.apply) {
    if (!args.confirmTargetDb) {
      throw new Error(
        `Apply için --confirm-target-db=<dbAdi> gerekli. Beklenen: --confirm-target-db=${targetDb}`
      );
    }
    if (args.confirmTargetDb !== targetDb) {
      throw new Error(
        `--confirm-target-db='${args.confirmTargetDb}' hedef DB '${targetDb}' ile uyuşmuyor.`
      );
    }
  }

  const inList = procedures.map((p) => `'${p}'`).join(", ");

  const src = await new sql.ConnectionPool(cfg(sourceDb)).connect();
  let dst = null;
  try {
    const defs = (
      await src.request().query(`
        SELECT p.name, m.definition
        FROM sys.procedures p
        JOIN sys.sql_modules m ON m.object_id = p.object_id
        WHERE p.name IN (${inList})
        ORDER BY p.name
      `)
    ).recordset;

    if (!defs.length) {
      throw new Error(`Kaynak DB '${sourceDb}' içinde prosedür tanımı bulunamadı.`);
    }

    const planned = [];
    for (const row of defs) {
      let def = String(row.definition || "").trim();
      if (!def) throw new Error(`Empty definition: ${row.name}`);
      const createIdx = def.toUpperCase().indexOf("CREATE PROC");
      const createIdx2 = def.toUpperCase().indexOf("CREATE PROCEDURE");
      const idx =
        createIdx >= 0 && createIdx2 >= 0
          ? Math.min(createIdx, createIdx2)
          : Math.max(createIdx, createIdx2);
      if (idx < 0) throw new Error(`CREATE PROC not found in definition: ${row.name}`);
      def = def.slice(idx);
      const { result: afterNull, replacements } = transformMaxToIsnullMax(def);
      let patchedDef = afterNull;
      if (row.name === "sp_Fatura_Kayit") {
        patchedDef = transformSpFaturaKayitCariBakiyeAllTypes(patchedDef).result;
      }
      planned.push({ name: row.name, def: patchedDef, nullSafeCount: replacements.length });
      console.log(`Planlandı: ${row.name}  null-safe yamalar=${replacements.length}`);
    }

    if (!args.apply) {
      console.log("\nDRY-RUN: hedefte hiçbir prosedür değiştirilmedi. Uygulamak için:");
      console.log(
        `  node scripts/copyEtaProcedures.js --source-db=${sourceDb} --target-db=${targetDb}` +
          ` --apply --confirm-target-db=${targetDb}`
      );
      return;
    }

    dst = await new sql.ConnectionPool(cfg(targetDb)).connect();
    for (const p of planned) {
      await dst
        .request()
        .query(`IF OBJECT_ID('dbo.${p.name}','P') IS NOT NULL DROP PROCEDURE dbo.${p.name};`);
      await dst.request().batch(p.def);
      console.log(`Applied: ${p.name}  null-safe yamalar=${p.nullSafeCount}`);
    }

    const check = (
      await dst.request().query(`
        SELECT name FROM sys.procedures
        WHERE name IN (${inList})
        ORDER BY name
      `)
    ).recordset;

    console.log(`Present in ${targetDb}: ${check.map((r) => r.name).join(", ")}`);
  } finally {
    if (dst) await dst.close();
    await src.close();
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
  main().catch((e) => {
    console.error("copyEtaProcedures failed:", e?.message || e);
    process.exitCode = 1;
  });
}
