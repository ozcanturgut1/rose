/**
 * IADE / ISTISNA muhasebe yolu simülasyonu (yazmaz).
 * node scripts/simulateMuhasebeIadeIstisna.js
 */
import "dotenv/config";
import sql from "mssql";
import { resolveSqlTargets } from "../sqlDbTargets.js";

function sqlConfig(db) {
  const t = resolveSqlTargets();
  return {
    user: t.user,
    password: t.password,
    server: t.host,
    port: t.port,
    database: db,
    options: { encrypt: false, trustServerCertificate: true },
  };
}

function isAlisLike(fatTip) {
  return [1, 8, 9, 11].includes(Number(fatTip));
}

function muhasebePathLabel({ hasTevkifat, refFatFisRefNo, fatTip }) {
  const ft = Number(fatTip);
  if (ft === 1) {
    return hasTevkifat
      ? "ALIM (FatTip=1) — kalem bazlı STKMUHBAGLANTI + tevkifat satırları"
      : "ALIM (FatTip=1) — kalem bazlı STKMUHBAGLANTI";
  }
  if (refFatFisRefNo > 0) {
    return "referans_fatura (read DB MUHHAR şablonu)";
  }
  if (hasTevkifat) {
    return "tevkifatlı_referanssız (tek @AccMal, 5 satırlı şablon)";
  }
  if (isAlisLike(ft)) {
    return "alış benzeri (8,9,11…) — tek @AccMal, 3 satır (kalem döngüsü yok)";
  }
  return "satış / IADE — cari borç + mal/kdv alacak";
}

async function resolveAccMalForStk(pool, stkKod, fatTip) {
  const isAlis = isAlisLike(fatTip);
  let acc = null;
  const p = await pool
    .request()
    .input("stk", sql.NVarChar(40), stkKod)
    .input("ft", sql.Int, fatTip);
  let rs = await p.query(`
    SELECT TOP 1 B.SMBMUHKOD1, B.SMBFTNO, T.FATFTKOD
    FROM dbo.STKMUHBAGLANTI B WITH (NOLOCK)
    LEFT JOIN dbo.FATFISTIP T ON T.FATFTNO = B.SMBFTNO
    WHERE B.SMBSTKKOD=@stk AND B.SMBFTNO=@ft
      AND ISNULL(NULLIF(LTRIM(RTRIM(B.SMBMUHKOD1)),''),'')<>''
  `);
  if (rs.recordset[0]) acc = { step: "SMBFTNO=@FatTip", ...rs.recordset[0] };

  if (!acc) {
    rs = await pool.request().input("stk", sql.NVarChar(40), stkKod).query(`
      SELECT TOP 1 B.SMBMUHKOD1, B.SMBFTNO, T.FATFTKOD
      FROM dbo.STKMUHBAGLANTI B WITH (NOLOCK)
      LEFT JOIN dbo.FATFISTIP T ON T.FATFTNO = B.SMBFTNO
      WHERE B.SMBSTKKOD=@stk AND ISNULL(NULLIF(LTRIM(RTRIM(B.SMBMUHKOD1)),''),'')<>''
        AND B.SMBFTNO ${isAlis ? "IN (1,8,9,11)" : "NOT IN (1,8,9,11)"}
      ORDER BY B.SMBFTNO
    `);
    if (rs.recordset[0]) acc = { step: "SMBFTNO aile", ...rs.recordset[0] };
  }

  if (!acc) {
    rs = await pool.request().input("ft", sql.Int, fatTip).query(`
      SELECT TOP 1 FMGISLEMNO, FMGMUHKOD1 FROM dbo.FATMUHGRUP WITH (NOLOCK)
      WHERE FMGGRUPKOD='FATMUHGRP' AND FMGISLEMNO=@ft
    `);
    if (rs.recordset[0]) acc = { step: "FATMUHGRUP @FatTip", ...rs.recordset[0] };
  }

  return acc || { step: "fallback", SMBMUHKOD1: "153" };
}

async function main() {
  const t = resolveSqlTargets();
  const pool = await new sql.ConnectionPool(sqlConfig(t.writeDb)).connect();

  const tips = await pool.request().query(`
    SELECT FATFTNO, FATFTKOD FROM dbo.FATFISTIP WITH (NOLOCK) ORDER BY FATFTNO
  `);
  console.log("=== FATFISTIP ===");
  for (const row of tips.recordset) {
    const ft = row.FATFTNO;
    console.log(
      `  ${ft} ${row.FATFTKOD} → isAlisLike=${isAlisLike(ft) ? 1 : 0}`
    );
  }

  const scenarios = [
    { name: "ALIM (normal)", fatTip: 1, hasTevkifat: false, ref: 0 },
    { name: "ISTISNA", fatTip: 11, hasTevkifat: false, ref: 0 },
    { name: "ALIM İADE (ör. tip 2)", fatTip: 2, hasTevkifat: false, ref: 0 },
    { name: "SATIŞ İADE (ör. tip 4)", fatTip: 4, hasTevkifat: false, ref: 0 },
    { name: "ALIM + tevkifat + referans", fatTip: 1, hasTevkifat: true, ref: 3226 },
    { name: "ISTISNA + tevkifat + referans", fatTip: 11, hasTevkifat: true, ref: 3226 },
    { name: "IADE + tevkifat (nadir)", fatTip: 2, hasTevkifat: true, ref: 3226 },
  ];

  console.log("\n=== Muhasebe yolu simülasyonu (etaInvoiceSync + SP) ===");
  for (const s of scenarios) {
    const path = muhasebePathLabel({
      hasTevkifat: s.hasTevkifat,
      refFatFisRefNo: s.ref,
      fatTip: s.fatTip,
    });
    const refNote =
      s.hasTevkifat && s.ref > 0
        ? " (sync: ref yalnız cls.hasTevkifat ise set edilir)"
        : "";
    console.log(`\n${s.name} (@FatTip=${s.fatTip})`);
    console.log(`  Yol: ${path}${refNote}`);
    console.log(
      `  Kalem bazlı özellik: ${path.includes("kalem bazlı") ? "EVET" : "HAYIR"}`
    );
  }

  const sampleStk = "A1-7572/1-04";
  console.log(`\n=== STKMUHBAGLANTI örnek: ${sampleStk} ===`);
  for (const ft of [1, 2, 4, 11]) {
    const acc = await resolveAccMalForStk(pool, sampleStk, ft);
    const kod = tips.recordset.find((r) => r.FATFTNO === ft)?.FATFTKOD || "?";
    console.log(
      `  @FatTip=${ft} (${kod}): ${acc.SMBMUHKOD1 || acc.FMGMUHKOD1} ← ${acc.step} (SMBFTNO=${acc.SMBFTNO ?? "-"} ${acc.FATFTKOD ?? ""})`
    );
  }

  const iadeSamples = await pool.request().query(`
    SELECT TOP 3 F.FATFISREFNO, F.FATFISEVRAKNO1, F.FATFISTIPI, T.FATFTKOD, F.FATFISMUHREFNO
    FROM dbo.FATFIS F WITH (NOLOCK)
    LEFT JOIN dbo.FATFISTIP T ON T.FATFTNO = F.FATFISTIPI
    WHERE F.FATFISTIPI IN (2,4,6) OR T.FATFTKOD LIKE '%İADE%' OR T.FATFTKOD LIKE '%IADE%'
    ORDER BY F.FATFISREFNO DESC
  `);
  const istisnaSamples = await pool.request().query(`
    SELECT TOP 3 F.FATFISREFNO, F.FATFISEVRAKNO1, F.FATFISTIPI, T.FATFTKOD
    FROM dbo.FATFIS F WITH (NOLOCK)
    LEFT JOIN dbo.FATFISTIP T ON T.FATFTNO = F.FATFISTIPI
    WHERE F.FATFISTIPI = 11 OR T.FATFTKOD LIKE '%ISTISNA%'
    ORDER BY F.FATFISREFNO DESC
  `);

  console.log("\n=== Write DB örnek IADE faturaları ===");
  console.log(iadeSamples.recordset.length ? iadeSamples.recordset : "(yok)");

  console.log("\n=== Write DB örnek ISTISNA faturaları ===");
  console.log(istisnaSamples.recordset.length ? istisnaSamples.recordset : "(yok)");

  await pool.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
