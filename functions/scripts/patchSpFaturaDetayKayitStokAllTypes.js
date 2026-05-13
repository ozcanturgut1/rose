/**
 * ETA_DENEME_2026 (writeDb) içindeki dbo.sp_Fatura_Detay_Kayit prosedüründe stok bakiye
 * adımı yalnızca ALIM/GİDER/YAKIT ALIM/ALIM İADE için tanımlıydı; TEVKİFATLI ALIŞ gibi
 * diğer FATFISTIP kodları "Tanımsız Fatura Tipi!" ile düşüyordu.
 *
 * Düzeltme: stok yönü için genel kural:
 *   - @FATFTKOD içinde İADE/IADE geçiyorsa stok azalsın (0)
 *   - aksi halde stok artsın (1)
 * Geçersiz @ErpFaturaTipi (FATFISTIP'ta yok → @FATFTKOD NULL) için açık hata kalır.
 *
 * Güvenlik: default DRY-RUN. `--apply` + `--confirm-write-db=<db>` ile uygulanır.
 *
 * Çalıştırma:
 *   node scripts/patchSpFaturaDetayKayitStokAllTypes.js
 *   node scripts/patchSpFaturaDetayKayitStokAllTypes.js --apply --confirm-write-db=ETA_DENEME_2026
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import { resolveSqlTargets } from "../sqlDbTargets.js";
import { transformMaxToIsnullMax } from "./patchEtaDenemeProceduresNullSafe.js";

const PROC = "sp_Fatura_Detay_Kayit";

// Daha toleranslı: declare satırından başlayıp RAISERROR'a kadar olan bloğu yakala.
const LEGACY_STK_BLOCK =
  /declare\s+@StokBakiyeArttirma\s+int\s+[\s\S]*?if\s+@StokBakiyeArttirma\s*=\s*-1\s+begin\s+RAISERROR\s*\(\s*'Tanımsız Fatura Tipi!'\s*,\s*11\s*,\s*1\s*\)\s*end/i;

const REPLACEMENT_STK_BLOCK = `declare @StokBakiyeArttirma int 
 if @FATFTKOD IS NULL begin RAISERROR ('Geçersiz fiş tipi (FATFISTIP/FATFTNO bulunamadı).', 11, 1) end
 set @StokBakiyeArttirma = case when @FATFTKOD like '%İADE%' or @FATFTKOD like '%IADE%' then 0 else 1 end`;

export function transformSpFaturaDetayKayitStokAllTypes(def) {
  if (!def || typeof def !== "string") return { result: def, replaced: false };
  if (!LEGACY_STK_BLOCK.test(def)) return { result: def, replaced: false };
  const result = def.replace(LEGACY_STK_BLOCK, REPLACEMENT_STK_BLOCK);
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
  console.log(`PATCH: ${writeDb} — dbo.${PROC} stok bloğu (tüm FATFISTIP kodları)`);
  console.log(
    `Host: ${t.host}:${t.port}  User: ${t.user}  Mode: ${args.apply ? "APPLY" : "DRY-RUN"}`
  );
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
    if (!r.recordset?.length) throw new Error(`Procedure not found: dbo.${PROC}`);
    const def = String(r.recordset[0].definition || "");
    const { result: afterStk, replaced: stkReplaced } =
      transformSpFaturaDetayKayitStokAllTypes(def);
    const { result: patchedDef, replacements: nullSafe } = transformMaxToIsnullMax(afterStk);

    console.log(`\n--- ${PROC} ---`);
    console.log(
      `  stok bloğu yaması: ${stkReplaced ? "evet" : "hayır (zaten uygulanmış veya farklı metin)"}`
    );
    console.log(`  ISNULL(MAX) yaması: ${nullSafe.length} yer`);

    if (!args.apply) {
      console.log("\nDRY-RUN. Uygulamak için:");
      console.log(
        `  node scripts/patchSpFaturaDetayKayitStokAllTypes.js --apply --confirm-write-db=${writeDb}`
      );
      return;
    }

    if (!stkReplaced && nullSafe.length === 0) {
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
    console.error("patchSpFaturaDetayKayitStokAllTypes failed:", e?.message || e);
    process.exitCode = 1;
  });
}

