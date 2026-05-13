/**
 * ETA_DENEME_2026 (writeDb) içindeki dbo.sp_Fatura_Kayit prosedüründe cari bakiye
 * adımı yalnızca ALIM / GİDER / ALIM İADE için tanımlıydı; diğer FATFISTIP kodları
 * (TEVKİFATLI ALIŞ, SATIŞ İADE vb.) "Tanımsız Fatura Tipi!" ile düşüyordu.
 *
 * Düzeltme: aynı prosedürde STKFIS için zaten kullanılan genel İADE kuralıyla hizalanır:
 *   - @FATFTKOD içinde İADE/IADE geçiyorsa cari tarafında 1 (iade akışı)
 *   - aksi halde 0 (normal alış/gider/satış vb. — mevcut ALIM/GİDER ile aynı yön)
 * Geçersiz @ErpFaturaTipi (FATFISTIP'ta yok → @FATFTKOD NULL) için açık hata kalır.
 *
 * Güvenlik: default DRY-RUN. `--apply` + `--confirm-write-db=<db>` ile uygulanır.
 *
 * Çalıştırma:
 *   node scripts/patchSpFaturaKayitCariBakiyeAllTypes.js
 *   node scripts/patchSpFaturaKayitCariBakiyeAllTypes.js --apply --confirm-write-db=ETA_DENEME_2026
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import { resolveSqlTargets } from "../sqlDbTargets.js";
import { transformMaxToIsnullMax } from "./patchEtaDenemeProceduresNullSafe.js";

const PROC = "sp_Fatura_Kayit";

/** ETA_DENEME_2026'da gözlenen eski cari bloğu (tab girintili). */
const LEGACY_CARI_BLOCK =
  /declare\s+@CariBakiyeArttirma\s+int\s+set\s+@CariBakiyeArttirma\s*=\s*case\s+when\s+@FATFTKOD\s*=\s*'ALIM'\s+then\s+0[\s\S]*?if\s+@CariBakiyeArttirma\s*=\s*-1\s+begin\s+RAISERROR\s*\(\s*'Tanımsız Fatura Tipi!'\s*,\s*11\s*,\s*1\s*\)\s*end/i;

const REPLACEMENT_CARI_BLOCK = `declare @CariBakiyeArttirma int 
 if @FATFTKOD IS NULL begin RAISERROR ('Geçersiz fiş tipi (FATFISTIP/FATFTNO bulunamadı).', 11, 1) end
 set @CariBakiyeArttirma = case when @FATFTKOD like '%İADE%' or @FATFTKOD like '%IADE%' then 1 else 0 end`;

export function transformSpFaturaKayitCariBakiyeAllTypes(def) {
  if (!def || typeof def !== "string") {
    return { result: def, replaced: false };
  }
  if (!LEGACY_CARI_BLOCK.test(def)) {
    return { result: def, replaced: false };
  }
  const result = def.replace(LEGACY_CARI_BLOCK, REPLACEMENT_CARI_BLOCK);
  return { result, replaced: result !== def };
}

function extractCreateBody(def) {
  const up = def.toUpperCase();
  const idx1 = up.indexOf("CREATE PROC");
  const idx2 = up.indexOf("CREATE PROCEDURE");
  if (idx1 < 0 && idx2 < 0) return null;
  const idx = idx1 >= 0 && idx2 >= 0 ? Math.min(idx1, idx2) : Math.max(idx1, idx2);
  return def.slice(idx);
}

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

async function main() {
  const args = parseArgs(process.argv);
  const t = resolveSqlTargets();
  const writeDb = t.writeDb;

  console.log("=".repeat(72));
  console.log(`PATCH: ${writeDb} — dbo.${PROC} cari bloğu (tüm FATFISTIP kodları)`);
  console.log(`Host: ${t.host}:${t.port}  User: ${t.user}  Mode: ${args.apply ? "APPLY" : "DRY-RUN"}`);
  console.log("=".repeat(72));

  if (args.apply) {
    if (!args.confirmWriteDb) {
      throw new Error(
        "Apply için --confirm-write-db=<dbAdi> gerekli. " +
          `Beklenen: --confirm-write-db=${writeDb}`
      );
    }
    if (args.confirmWriteDb !== writeDb) {
      throw new Error(
        `--confirm-write-db='${args.confirmWriteDb}' ile DB_WRITE_NAME='${writeDb}' uyuşmuyor.`
      );
    }
  }

  const pool = await new sql.ConnectionPool(sqlConfig(writeDb)).connect();
  try {
    const r = await pool.request().query(`
      SELECT m.definition
      FROM sys.procedures p
      INNER JOIN sys.sql_modules m ON m.object_id = p.object_id
      WHERE p.name = '${PROC.replace(/'/g, "''")}'
    `);
    if (!r.recordset?.length) {
      throw new Error(`Procedure not found: dbo.${PROC}`);
    }
    const def = String(r.recordset[0].definition || "");
    const { result: afterCari, replaced: cariReplaced } =
      transformSpFaturaKayitCariBakiyeAllTypes(def);
    const { result: patchedDef, replacements: nullSafe } =
      transformMaxToIsnullMax(afterCari);

    console.log(`\n--- ${PROC} ---`);
    console.log(`  cari bloğu yaması: ${cariReplaced ? "evet" : "hayır (zaten uygulanmış veya farklı metin)"}`);
    console.log(`  ISNULL(MAX) yaması: ${nullSafe.length} yer`);

    if (!cariReplaced) {
      const hasNew = /Geçersiz fiş tipi \(FATFISTIP/.test(def);
      console.log(`  mevcut tanımda yeni blok imzası: ${hasNew}`);
    }

    if (!args.apply) {
      console.log("\nDRY-RUN. Uygulamak için:");
      console.log(
        `  node scripts/patchSpFaturaKayitCariBakiyeAllTypes.js --apply --confirm-write-db=${writeDb}`
      );
      return;
    }

    if (!cariReplaced && nullSafe.length === 0) {
      console.log("\nYapılacak değişiklik yok; çıkılıyor.");
      return;
    }

    const body = extractCreateBody(patchedDef);
    if (!body) throw new Error(`CREATE PROC bulunamadı: ${PROC}`);

    await pool
      .request()
      .query(`IF OBJECT_ID('dbo.${PROC}','P') IS NOT NULL DROP PROCEDURE dbo.${PROC};`);
    await pool.request().batch(body);
    console.log(`\n[OK] dbo.${PROC} yeniden oluşturuldu.`);
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
  main().catch((e) => {
    console.error("patchSpFaturaKayitCariBakiyeAllTypes failed:", e?.message || e);
    process.exitCode = 1;
  });
}
