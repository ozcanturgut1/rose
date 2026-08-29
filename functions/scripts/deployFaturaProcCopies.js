/**
 * Fatura kayıt zincirindeki üç prosedürün AYRI İSİMLİ KOPYASINI kurar.
 *
 * Neden: Production'da EFE konnektörü `sp_Fatura_Kayit`, `sp_Fatura_Detay_Kayit` ve
 * `sp_FatFisToplam_Kayit` prosedürlerini kullanmaya devam ediyor. Bizim yamalarımız
 * (NULL-safe MAX, tüm FATFISTIP kodları için cari/stok bakiye yönü) canlıdaki bu
 * tanımları EZMEDEN yaşasın diye, aynı gövde `<ad><suffix>` şeklinde yeni bir
 * prosedür olarak kurulur. JS tarafı `ETA_FATURA_PROC_SUFFIX` env'i ile bu kopyaları
 * çağırır (functions/etaFaturaProcNames.js).
 *
 * Kaynak seçimi:
 *   --source=write (varsayılan)  → writeDb'deki mevcut (yamalı) tanımlar kopyalanır
 *   --source=read                → readDb'deki (canlı/orijinal) tanımlar kopyalanır
 *
 * Yama uygulaması:
 *   --patch (varsayılan açık)    → kopyaya NULL-safe MAX + cari/stok "tüm tipler"
 *                                  yamaları uygulanır (idempotent; zaten yamalıysa no-op)
 *   --no-patch                   → gövde birebir kopyalanır
 *
 * Güvenlik:
 *   - Varsayılan DRY-RUN. Uygulamak için `--apply --confirm-target-db=<db>`.
 *   - Yalnızca `<ad><suffix>` nesneleri oluşturulur/değiştirilir; orijinal
 *     prosedürlere HİÇ dokunulmaz (isim eşitse script hata verip durur).
 *
 * Çalıştırma örnekleri:
 *   node scripts/deployFaturaProcCopies.js --suffix=_Ymm
 *   node scripts/deployFaturaProcCopies.js --suffix=_Ymm --apply --confirm-target-db=ETA_DENEME_2026
 *   node scripts/deployFaturaProcCopies.js --suffix=_Ymm --source=read --target-db=ETA_2026 --apply --confirm-target-db=ETA_2026
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import { resolveSqlTargets } from "../sqlDbTargets.js";
import { BASE_FATURA_PROCS } from "../etaFaturaProcNames.js";
import { transformMaxToIsnullMax } from "./patchEtaDenemeProceduresNullSafe.js";
import { transformSpFaturaKayitCariBakiyeAllTypes } from "./patchSpFaturaKayitCariBakiyeAllTypes.js";
import { transformSpFaturaDetayKayitStokAllTypes } from "./patchSpFaturaDetayKayitStokAllTypes.js";
import { transformSpFaturaDetayKayitNetFiyat } from "./patchSpFaturaDetayKayitNetFiyat.js";

const SOURCE_PROCS = [BASE_FATURA_PROCS.kayit, BASE_FATURA_PROCS.detay, BASE_FATURA_PROCS.toplam];

function parseArgs(argv) {
  const out = {
    apply: false,
    confirmTargetDb: null,
    suffix: (process.env.ETA_FATURA_PROC_SUFFIX || "").trim(),
    source: "write",
    targetDb: null,
    patch: true,
  };
  for (const a of argv.slice(2)) {
    if (a === "--apply") out.apply = true;
    else if (a === "--no-patch") out.patch = false;
    else if (a === "--patch") out.patch = true;
    else if (a.startsWith("--suffix=")) out.suffix = a.slice("--suffix=".length).trim();
    else if (a.startsWith("--source=")) out.source = a.slice("--source=".length).trim().toLowerCase();
    else if (a.startsWith("--target-db=")) out.targetDb = a.slice("--target-db=".length).trim();
    else if (a.startsWith("--confirm-target-db=")) {
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

function extractCreateBody(def) {
  const up = def.toUpperCase();
  const idx1 = up.indexOf("CREATE PROC");
  const idx2 = up.indexOf("CREATE PROCEDURE");
  if (idx1 < 0 && idx2 < 0) return null;
  const idx = idx1 >= 0 && idx2 >= 0 ? Math.min(idx1, idx2) : Math.max(idx1, idx2);
  return def.slice(idx);
}

/**
 * CREATE PROC başlığındaki prosedür adını yeni adla değiştirir.
 * Yalnızca ilk (başlıktaki) eşleşme değişir; gövdedeki metinlere dokunulmaz.
 */
export function renameProcedureHeader(body, oldName, newName) {
  const pattern = new RegExp(
    String.raw`(CREATE\s+PROC(?:EDURE)?\s+)((?:\[?dbo\]?\s*\.\s*)?)(\[?)` +
      oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      String.raw`(\]?)`,
    "i"
  );
  if (!pattern.test(body)) return { result: body, renamed: false };
  const result = body.replace(pattern, (_m, create, schema, ob, cb) => {
    const schemaPart = schema && schema.trim() ? "dbo." : "";
    const open = ob || "";
    const close = ob ? "]" : cb || "";
    return `${create}${schemaPart}${open}${newName}${close}`;
  });
  return { result, renamed: result !== body };
}

/** Kopyaya uygulanacak yamalar (idempotent). */
function applyPatches(procName, def) {
  const notes = [];
  let out = def;

  if (procName === BASE_FATURA_PROCS.kayit) {
    const r = transformSpFaturaKayitCariBakiyeAllTypes(out);
    out = r.result;
    notes.push(`cari-tüm-tipler: ${r.replaced ? "uygulandı" : "gerek yok/zaten var"}`);
  }
  if (procName === BASE_FATURA_PROCS.detay) {
    const r = transformSpFaturaDetayKayitStokAllTypes(out);
    out = r.result;
    notes.push(`stok-tüm-tipler: ${r.replaced ? "uygulandı" : "gerek yok/zaten var"}`);

    const nf = transformSpFaturaDetayKayitNetFiyat(out);
    out = nf.result;
    notes.push(
      `stok-birim-net-fiyat: ${nf.replaced ? "uygulandı" : `uygulanmadı (${nf.reason})`}`
    );
  }

  const ns = transformMaxToIsnullMax(out);
  out = ns.result;
  notes.push(`ISNULL(MAX): ${ns.replacements.length} yer`);

  return { result: out, notes };
}

async function main() {
  const args = parseArgs(process.argv);
  const t = resolveSqlTargets();

  if (!args.suffix) {
    throw new Error(
      "--suffix=<ek> zorunlu (veya ETA_FATURA_PROC_SUFFIX env). Örn: --suffix=_Ymm"
    );
  }
  if (!/^[A-Za-z0-9_]+$/.test(args.suffix)) {
    throw new Error(`Geçersiz suffix: '${args.suffix}' (yalnızca harf/rakam/alt çizgi)`);
  }
  if (!["read", "write"].includes(args.source)) {
    throw new Error(`--source=read|write olmalı (verilen: '${args.source}')`);
  }

  const sourceDb = args.source === "read" ? t.readDb : t.writeDb;
  const targetDb = args.targetDb || t.writeDb;

  console.log("=".repeat(72));
  console.log(`DEPLOY: fatura prosedürlerinin '${args.suffix}' ekli kopyaları`);
  console.log(`Kaynak DB: ${sourceDb} (--source=${args.source})   Hedef DB: ${targetDb}`);
  console.log(`Yama: ${args.patch ? "AÇIK" : "KAPALI"}   Mod: ${args.apply ? "APPLY" : "DRY-RUN"}`);
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

  const srcPool = await new sql.ConnectionPool(sqlConfig(sourceDb)).connect();
  let tgtPool = null;
  try {
    const inList = SOURCE_PROCS.map((p) => `'${p}'`).join(", ");
    const defs = (
      await srcPool.request().query(`
        SELECT p.name, m.definition
        FROM sys.procedures p
        INNER JOIN sys.sql_modules m ON m.object_id = p.object_id
        WHERE p.name IN (${inList})
      `)
    ).recordset;

    const byName = new Map(defs.map((r) => [String(r.name), String(r.definition || "")]));
    const missing = SOURCE_PROCS.filter((p) => !byName.has(p));
    if (missing.length) {
      throw new Error(`Kaynak DB '${sourceDb}' içinde bulunamayan prosedür: ${missing.join(", ")}`);
    }

    const planned = [];
    for (const name of SOURCE_PROCS) {
      const newName = `${name}${args.suffix}`;
      if (newName === name) {
        throw new Error(`Kopya adı orijinalle aynı olamaz: ${name}`);
      }

      let def = byName.get(name);
      const notes = [];
      if (args.patch) {
        const p = applyPatches(name, def);
        def = p.result;
        notes.push(...p.notes);
      }

      const body0 = extractCreateBody(def);
      if (!body0) throw new Error(`CREATE PROC bulunamadı: ${name}`);
      const { result: body, renamed } = renameProcedureHeader(body0, name, newName);
      if (!renamed) {
        throw new Error(`CREATE PROC başlığı yeniden adlandırılamadı: ${name}`);
      }
      if (new RegExp(String.raw`CREATE\s+PROC(?:EDURE)?\s+(?:\[?dbo\]?\s*\.\s*)?\[?${name}\]?\b`, "i").test(body)) {
        throw new Error(`Güvenlik kontrolü: gövdede hâlâ orijinal ada CREATE var: ${name}`);
      }

      planned.push({ name, newName, body, notes });
      console.log(`\n--- ${name} -> ${newName} ---`);
      for (const n of notes) console.log(`  ${n}`);
      console.log(`  gövde uzunluğu: ${body.length} karakter`);
    }

    if (!args.apply) {
      console.log("\nDRY-RUN: hiçbir nesne oluşturulmadı. Uygulamak için:");
      console.log(
        `  node scripts/deployFaturaProcCopies.js --suffix=${args.suffix} --source=${args.source}` +
          (args.targetDb ? ` --target-db=${targetDb}` : "") +
          ` --apply --confirm-target-db=${targetDb}`
      );
      return;
    }

    tgtPool = await new sql.ConnectionPool(sqlConfig(targetDb)).connect();
    console.log("\nAPPLY: kopyalar oluşturuluyor...");
    for (const p of planned) {
      await tgtPool
        .request()
        .query(`IF OBJECT_ID('dbo.${p.newName}','P') IS NOT NULL DROP PROCEDURE dbo.${p.newName};`);
      await tgtPool.request().batch(p.body);
      console.log(`  [OK] dbo.${p.newName}`);
    }

    const checkList = planned.map((p) => `'${p.newName}'`).join(", ");
    const check = (
      await tgtPool.request().query(`
        SELECT name, create_date, modify_date FROM sys.procedures
        WHERE name IN (${checkList}) ORDER BY name
      `)
    ).recordset;
    console.log("\nDoğrulama:");
    for (const row of check) {
      console.log(`  ${row.name}  modify_date=${row.modify_date?.toISOString?.() || row.modify_date}`);
    }
    if (check.length !== planned.length) {
      throw new Error("Bazı kopyalar oluşmadı; lütfen kontrol edin.");
    }

    console.log("\nSonraki adım (uygulama tarafı):");
    console.log(`  ETA_FATURA_PROC_SUFFIX=${args.suffix}`);
    console.log("  (orijinal prosedürler değişmedi; EFE konnektörü etkilenmez)");
  } finally {
    if (tgtPool) await tgtPool.close();
    await srcPool.close();
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
    console.error("deployFaturaProcCopies failed:", e?.message || e);
    process.exitCode = 1;
  });
}
