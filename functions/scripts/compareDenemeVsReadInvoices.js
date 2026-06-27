/**
 * ETA_DENEME_2026 (write) ile ETA_TEKNIKFILAMENT_2026 (read) fatura karşılaştırması.
 * Salt okunur; hiçbir veri değiştirmez.
 *
 * Çalıştırma: node scripts/compareDenemeVsReadInvoices.js
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
    options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
  };
}

const AMT_TOL = 0.02;

function fmt(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toFixed(2) : "-";
}

async function loadInvoiceSnapshot(pool, label) {
  const rs = await pool.request().query(`
    SELECT
      F.FATFISREFNO,
      LTRIM(RTRIM(F.FATFISEVRAKNO1)) AS evrak,
      F.FATFISTAR,
      F.FATFISTIPI,
      F.FATFISCARKOD,
      ISNULL(F.FATFISMALTOP, 0) AS malTop,
      ISNULL(F.FATFISKDVTUTARI, 0) AS kdvTop,
      ISNULL(F.FATFISGENTOPLAM, 0) AS genTop,
      ISNULL(F.FATFISTEVTUTAR, 0) AS tevTop,
      ISNULL(F.FATFISTEVKIFATFLAG, 0) AS tevFlag,
      ISNULL(F.FATFISDOVKOD, '') AS dovKod,
      ISNULL(F.FATFISMUHREFNO, 0) AS muhRef,
      ISNULL(F.FATFISSTKREFNO, 0) AS stkRef,
      ISNULL(F.FATFISCARREFNO, 0) AS carRef,
      (SELECT COUNT(*) FROM dbo.FATHAR H WITH (NOLOCK) WHERE H.FATHARREFNO = F.FATFISREFNO) AS lineCnt,
      (SELECT ISNULL(SUM(ISNULL(H.FATHARNETTUTAR, ISNULL(H.FATHARKDVMATRAH, H.FATHARTUTAR))), 0)
       FROM dbo.FATHAR H WITH (NOLOCK) WHERE H.FATHARREFNO = F.FATFISREFNO) AS harNet,
      (SELECT ISNULL(SUM(ISNULL(H.FATHARKDVTUTAR, 0)), 0)
       FROM dbo.FATHAR H WITH (NOLOCK) WHERE H.FATHARREFNO = F.FATFISREFNO) AS harKdv
    FROM dbo.FATFIS F WITH (NOLOCK)
    WHERE ISNULL(LTRIM(RTRIM(F.FATFISEVRAKNO1)), '') <> ''
  `);
  const byEvrak = new Map();
  for (const r of rs.recordset) {
    const evrak = String(r.evrak || "").trim();
    if (!evrak) continue;
    byEvrak.set(evrak, { ...r, evrak, db: label });
  }
  return byEvrak;
}

async function loadMuhBalance(pool, muhRef) {
  const ref = Number(muhRef);
  if (!Number.isFinite(ref) || ref <= 0) return null;
  const rs = await pool.request().input("ref", sql.Int, ref).query(`
    SELECT
      ISNULL(SUM(CASE WHEN MUHHARBATIPI = 1 THEN MUHHARTUTAR END), 0) AS borc,
      ISNULL(SUM(CASE WHEN MUHHARBATIPI = 2 THEN MUHHARTUTAR END), 0) AS alacak
    FROM dbo.MUHHAR WITH (NOLOCK)
    WHERE MUHHARREFNO = @ref
  `);
  const row = rs.recordset[0];
  if (!row) return null;
  return {
    borc: Number(row.borc) || 0,
    alacak: Number(row.alacak) || 0,
    fark: (Number(row.borc) || 0) - (Number(row.alacak) || 0),
  };
}

async function main() {
  const t = resolveSqlTargets();
  console.log("=".repeat(72));
  console.log("DENEME vs READ fatura karşılaştırması (salt okunur)");
  console.log(`Read : ${t.readDb}`);
  console.log(`Write: ${t.writeDb}`);
  console.log(`Host : ${t.host}:${t.port}`);
  console.log("=".repeat(72));

  const readPool = await new sql.ConnectionPool(sqlConfig(t.readDb)).connect();
  const writePool = await new sql.ConnectionPool(sqlConfig(t.writeDb)).connect();

  try {
    const [readMap, writeMap] = await Promise.all([
      loadInvoiceSnapshot(readPool, "read"),
      loadInvoiceSnapshot(writePool, "write"),
    ]);

    const readKeys = [...readMap.keys()].sort();
    const writeKeys = [...writeMap.keys()].sort();
    const common = readKeys.filter((k) => writeMap.has(k));
    const onlyRead = readKeys.filter((k) => !writeMap.has(k));
    const onlyWrite = writeKeys.filter((k) => !readMap.has(k));

    console.log(`\n--- Özet ---`);
    console.log(`Read fatura sayısı  : ${readKeys.length}`);
    console.log(`Deneme fatura sayısı: ${writeKeys.length}`);
    console.log(`Ortak evrak no      : ${common.length}`);
    console.log(`Yalnız read'de      : ${onlyRead.length}`);
    console.log(`Yalnız deneme'de    : ${onlyWrite.length}`);

    if (onlyRead.length) {
      console.log(`\n--- Deneme'de EKSİK (read'de var, deneme'de yok) — ilk 30 ---`);
      for (const ev of onlyRead.slice(0, 30)) {
        const r = readMap.get(ev);
        console.log(
          `  ${ev}  ref=${r.FATFISREFNO}  tip=${r.FATFISTIPI}  gen=${fmt(r.genTop)}  satır=${r.lineCnt}  muh=${r.muhRef}`
        );
      }
      if (onlyRead.length > 30) console.log(`  ... +${onlyRead.length - 30} fatura daha`);
    }

    if (onlyWrite.length) {
      console.log(`\n--- Deneme'de FAZLA (deneme'de var, read'de yok) — ilk 30 ---`);
      for (const ev of onlyWrite.slice(0, 30)) {
        const w = writeMap.get(ev);
        console.log(
          `  ${ev}  ref=${w.FATFISREFNO}  tip=${w.FATFISTIPI}  gen=${fmt(w.genTop)}  satır=${w.lineCnt}  muh=${w.muhRef}`
        );
      }
      if (onlyWrite.length > 30) console.log(`  ... +${onlyWrite.length - 30} fatura daha`);
    }

    const amountDiffs = [];
    const headerHarDiffs = [];
    const lineDiffs = [];
    const muhMissing = [];
    const muhUnbalanced = [];
    const stkCarMissing = [];

    for (const ev of common) {
      const r = readMap.get(ev);
      const w = writeMap.get(ev);

      if (Math.abs(w.genTop - r.genTop) > AMT_TOL) {
        amountDiffs.push({ ev, field: "GENTOPLAM", read: r.genTop, write: w.genTop, diff: w.genTop - r.genTop });
      }
      if (Math.abs(w.malTop - r.malTop) > AMT_TOL) {
        amountDiffs.push({ ev, field: "MALTOP", read: r.malTop, write: w.malTop, diff: w.malTop - r.malTop });
      }
      if (Math.abs(w.kdvTop - r.kdvTop) > AMT_TOL) {
        amountDiffs.push({ ev, field: "KDVTUTARI", read: r.kdvTop, write: w.kdvTop, diff: w.kdvTop - r.kdvTop });
      }

      if (Number(w.lineCnt) !== Number(r.lineCnt)) {
        lineDiffs.push({ ev, readLines: r.lineCnt, writeLines: w.lineCnt });
      }

      const harMalGap = Math.abs(Number(w.malTop) - Number(w.harNet));
      const harKdvGap = Math.abs(Number(w.kdvTop) - Number(w.harKdv));
      const genGap = Math.abs(Number(w.genTop) - (Number(w.harNet) + Number(w.harKdv)));
      if (harMalGap > AMT_TOL || harKdvGap > AMT_TOL || genGap > AMT_TOL) {
        headerHarDiffs.push({
          ev,
          malTop: w.malTop,
          harNet: w.harNet,
          malGap: Number(w.malTop) - Number(w.harNet),
          kdvTop: w.kdvTop,
          harKdv: w.harKdv,
          kdvGap: Number(w.kdvTop) - Number(w.harKdv),
          genTop: w.genTop,
          harGen: Number(w.harNet) + Number(w.harKdv),
          genGap: Number(w.genTop) - (Number(w.harNet) + Number(w.harKdv)),
        });
      }

      if (Number(r.muhRef) > 0 && Number(w.muhRef) <= 0) {
        muhMissing.push({ ev, readMuh: r.muhRef, writeMuh: w.muhRef });
      }

      if (Number(w.lineCnt) > 0 && Number(w.stkRef) <= 0) {
        stkCarMissing.push({ ev, kind: "STKREF", writeRef: w.stkRef, lines: w.lineCnt });
      }
      if (Number(w.carRef) <= 0) {
        stkCarMissing.push({ ev, kind: "CARREF", writeRef: w.carRef, lines: w.lineCnt });
      }

      if (Number(w.muhRef) > 0) {
        const bal = await loadMuhBalance(writePool, w.muhRef);
        if (bal && Math.abs(bal.fark) > AMT_TOL) {
          muhUnbalanced.push({ ev, muhRef: w.muhRef, ...bal });
        }
      }
    }

    console.log(`\n--- Deneme iç tutarsızlık: FATFIS başlık vs FATHAR toplamı ---`);
    console.log(`Sorunlu fatura: ${headerHarDiffs.length}`);
    for (const x of headerHarDiffs.sort((a, b) => Math.abs(b.malGap) - Math.abs(a.malGap)).slice(0, 20)) {
      console.log(
        `  ${x.ev}  malTop=${fmt(x.malTop)} harNet=${fmt(x.harNet)} fark=${fmt(x.malGap)}` +
          `  kdv=${fmt(x.kdvTop)}/${fmt(x.harKdv)}  gen=${fmt(x.genTop)} vs har=${fmt(x.harGen)}`
      );
    }

    console.log(`\n--- Deneme muhasebe fişi dengesiz (borç ≠ alacak) ---`);
    console.log(`Sorunlu fatura: ${muhUnbalanced.length}`);
    for (const x of muhUnbalanced.sort((a, b) => Math.abs(b.fark) - Math.abs(a.fark)).slice(0, 20)) {
      console.log(`  ${x.ev}  muh=${x.muhRef}  borç=${fmt(x.borc)}  alacak=${fmt(x.alacak)}  fark=${fmt(x.fark)}`);
    }

    console.log(`\n--- Deneme'de muhasebe fişi eksik (read'de var) ---`);
    console.log(`Sorunlu fatura: ${muhMissing.length}`);
    for (const x of muhMissing.slice(0, 20)) {
      console.log(`  ${x.ev}  readMuh=${x.readMuh}  denemeMuh=${x.writeMuh}`);
    }

    console.log(`\n--- Deneme'de kalem sayısı farklı (read vs deneme) ---`);
    console.log(`Sorunlu fatura: ${lineDiffs.length}`);
    for (const x of lineDiffs.slice(0, 20)) {
      console.log(`  ${x.ev}  read=${x.readLines} satır  deneme=${x.writeLines} satır`);
    }

    console.log(`\n--- Deneme'de stok/cari ref eksik ---`);
    const stkOnly = stkCarMissing.filter((x) => x.kind === "STKREF");
    const carOnly = stkCarMissing.filter((x) => x.kind === "CARREF");
    console.log(`STKREF eksik: ${stkOnly.length}  CARREF eksik: ${carOnly.length}`);
    for (const x of stkOnly.slice(0, 10)) console.log(`  STK ${x.ev}  satır=${x.lines}`);
    for (const x of carOnly.slice(0, 10)) console.log(`  CAR ${x.ev}`);

    console.log(`\n--- Ortak faturalarda tutar farkı (read vs deneme, tol>${AMT_TOL}) ---`);
    const byEvrak = new Map();
    for (const d of amountDiffs) {
      if (!byEvrak.has(d.ev)) byEvrak.set(d.ev, []);
      byEvrak.get(d.ev).push(d);
    }
    console.log(`Farklı tutarlı evrak: ${byEvrak.size}`);
    const sortedEvrak = [...byEvrak.entries()].sort((a, b) => {
      const maxA = Math.max(...a[1].map((x) => Math.abs(x.diff)));
      const maxB = Math.max(...b[1].map((x) => Math.abs(x.diff)));
      return maxB - maxA;
    });
    for (const [ev, diffs] of sortedEvrak.slice(0, 20)) {
      const parts = diffs.map((d) => `${d.field} read=${fmt(d.read)} deneme=${fmt(d.write)} Δ=${fmt(d.diff)}`);
      console.log(`  ${ev}: ${parts.join(" | ")}`);
    }

    console.log(`\n--- Sonuç ---`);
    const issues = [];
    if (onlyRead.length) issues.push(`${onlyRead.length} eksik fatura`);
    if (onlyWrite.length) issues.push(`${onlyWrite.length} fazla fatura (yalnız deneme)`);
    if (headerHarDiffs.length) issues.push(`${headerHarDiffs.length} başlık/kalem tutarsızlığı`);
    if (muhUnbalanced.length) issues.push(`${muhUnbalanced.length} muhasebe dengesiz`);
    if (muhMissing.length) issues.push(`${muhMissing.length} muhasebe fişi eksik`);
    if (lineDiffs.length) issues.push(`${lineDiffs.length} kalem sayısı farkı`);
    if (byEvrak.size) issues.push(`${byEvrak.size} read/deneme tutar farkı`);

    if (!issues.length) {
      console.log("Kritik fark bulunamadı (ortak evrak kümesinde).");
    } else {
      for (const i of issues) console.log(`  • ${i}`);
    }
  } finally {
    await readPool.close();
    await writePool.close();
  }
}

main().catch((e) => {
  console.error("compareDenemeVsReadInvoices failed:", e?.message || e);
  process.exitCode = 1;
});
