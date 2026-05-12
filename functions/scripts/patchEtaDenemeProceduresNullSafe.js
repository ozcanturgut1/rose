/**
 * ETA_DENEME_2026 (writeDb) içindeki fatura kayıt prosedürlerini "NULL-safe MAX" haline getirir.
 * Yani `MAX(SOMEREFNO)` ifadelerini `ISNULL(MAX(SOMEREFNO), 0)` ile değiştirir.
 * Üretim mantığı bozulmaz (dolu tabloda davranış birebir aynıdır); boş tabloda NULL + 1 = NULL hatası
 * yerine 0 + 1 = 1 üretilir.
 *
 * Hedef prosedürler:
 *   - sp_Fatura_Kayit
 *   - sp_Fatura_Detay_Kayit
 *   - sp_FatFisToplam_Kayit
 *   - sp_Yuvarlama_Kayit
 *   - sp_Fatura_Muhasebe_Bagla_Deneme  (opsiyonel; varsa yamalar)
 *
 * Güvenlik:
 *   - Default DRY-RUN. `--apply` verilmedikçe değişiklik YAPILMAZ; sadece bulunan eşleşmeleri listeler.
 *   - `--confirm-write-db=<dbAdi>` parametresi DB_WRITE_NAME ile eşleşmeli (yanlış DB'ye karşı çift güvenlik).
 *   - Sadece DROP + CREATE yapar; aynı bağlamda transaction kullanır.
 *   - Üretim DB'sine (readDb) DOKUNULMAZ.
 *
 * Çalıştırma:
 *   node scripts/patchEtaDenemeProceduresNullSafe.js                                  # dry-run
 *   node scripts/patchEtaDenemeProceduresNullSafe.js --apply --confirm-write-db=ETA_DENEME_2026
 */
import "dotenv/config";
import sql from "mssql";
import { resolveSqlTargets } from "../sqlDbTargets.js";

const TARGET_PROCS = [
  "sp_Fatura_Kayit",
  "sp_Fatura_Detay_Kayit",
  "sp_FatFisToplam_Kayit",
  "sp_Yuvarlama_Kayit",
  "sp_Fatura_Muhasebe_Bagla_Deneme",
];

/**
 * Dönüştürülecek MAX(...) kolon isimleri.
 * "REFNO" ile bitenler + FFTKONU (FATFISTOPLAM içinde özel).
 */
const MAX_COL_PATTERN = /max\s*\(\s*([A-Za-z_][A-Za-z0-9_]*REFNO|FFTKONU)\s*\)/gi;

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

/**
 * Definition içindeki tüm `max(REFNO_COL)` eşleşmelerini `ISNULL(max(REFNO_COL), 0)` ile değiştirir.
 * Daha önce zaten `ISNULL(MAX(...), 0)` yazılmışsa tekrar sarmaz (idempotent).
 */
export function transformMaxToIsnullMax(def) {
  if (!def || typeof def !== "string") return { result: def, replacements: [] };

  const replacements = [];
  const result = def.replace(MAX_COL_PATTERN, (match, col, offset) => {
    // Önündeki ~10 karaktere bak, zaten ISNULL ile sarılı mı?
    const back = def.slice(Math.max(0, offset - 10), offset).toUpperCase();
    if (back.endsWith("ISNULL(") || back.endsWith("ISNULL (")) {
      return match;
    }
    const upperCol = String(col).toUpperCase();
    const replacement = `ISNULL(${match}, 0)`;
    replacements.push({ offset, col: upperCol, from: match, to: replacement });
    return replacement;
  });

  return { result, replacements };
}

function extractCreateBody(def) {
  const idx1 = def.toUpperCase().indexOf("CREATE PROC");
  const idx2 = def.toUpperCase().indexOf("CREATE PROCEDURE");
  if (idx1 < 0 && idx2 < 0) return null;
  const idx = idx1 >= 0 && idx2 >= 0 ? Math.min(idx1, idx2) : Math.max(idx1, idx2);
  return def.slice(idx);
}

async function main() {
  const args = parseArgs(process.argv);
  const t = resolveSqlTargets();

  console.log("=".repeat(72));
  console.log(`PATCH: ${t.writeDb} üzerindeki refno üretim prosedürlerini NULL-safe yap`);
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
  try {
    const inList = TARGET_PROCS.map((p) => `'${p}'`).join(", ");
    const defs = (
      await pool.request().query(`
        SELECT p.name, m.definition
        FROM sys.procedures p
        INNER JOIN sys.sql_modules m ON m.object_id = p.object_id
        WHERE p.name IN (${inList})
        ORDER BY p.name
      `)
    ).recordset;

    if (!defs.length) {
      throw new Error("Hedef prosedürlerin hiçbiri bulunamadı.");
    }

    let grandTotal = 0;
    const planned = [];
    for (const row of defs) {
      const name = String(row.name);
      const def = String(row.definition || "");
      const { result, replacements } = transformMaxToIsnullMax(def);

      console.log(`\n--- ${name} ---`);
      if (!replacements.length) {
        console.log("  (yamalanacak yer yok)");
        continue;
      }
      grandTotal += replacements.length;
      planned.push({ name, original: def, patched: result, replacements });

      for (const r of replacements) {
        const lineNo = def.slice(0, r.offset).split(/\r?\n/).length;
        const lineStart = def.lastIndexOf("\n", r.offset - 1) + 1;
        const lineEnd = def.indexOf("\n", r.offset);
        const line = def.slice(lineStart, lineEnd < 0 ? def.length : lineEnd).trim();
        console.log(`  L${lineNo}  ${r.col}`);
        console.log(`      önce: ${line.slice(0, 200)}`);
        console.log(`      sonra (ilgili kısım): ${r.from} -> ${r.to}`);
      }
    }

    console.log(`\nToplam yamalanacak eşleşme: ${grandTotal}`);

    if (!args.apply) {
      console.log("\nDRY-RUN: Hiçbir prosedür değiştirilmedi. Uygulamak için:");
      console.log(`  node scripts/patchEtaDenemeProceduresNullSafe.js --apply --confirm-write-db=${t.writeDb}`);
      return;
    }

    if (!planned.length) {
      console.log("Yamalanacak prosedür yok; çıkılıyor.");
      return;
    }

    console.log("\nAPPLY: Prosedürler güncelleniyor...");
    for (const p of planned) {
      const body = extractCreateBody(p.patched);
      if (!body) throw new Error(`CREATE PROC bulunamadı: ${p.name}`);
      await pool
        .request()
        .query(`IF OBJECT_ID('dbo.${p.name}','P') IS NOT NULL DROP PROCEDURE dbo.${p.name};`);
      await pool.request().batch(body);
      console.log(`  [OK] ${p.name}  yamalanan eşleşme: ${p.replacements.length}`);
    }

    console.log("\nDoğrulama: prosedürler hâlâ mevcut mu?");
    const check = (
      await pool.request().query(`
        SELECT name FROM sys.procedures
        WHERE name IN (${inList})
        ORDER BY name
      `)
    ).recordset.map((r) => String(r.name));
    console.log(`  bulunan: ${check.join(", ") || "(yok)"}`);

    console.log("\nTamam. Aynı dönüşüm copyEtaProcedures.js içine de eklenmelidir ki gelecekte yeniden");
    console.log("kopyalandığında otomatik uygulansın.");
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error("patchEtaDenemeProceduresNullSafe failed:", err?.message || err);
  process.exitCode = 1;
});
