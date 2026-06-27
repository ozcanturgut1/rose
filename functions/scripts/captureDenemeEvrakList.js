import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import { resolveSqlTargets } from "../sqlDbTargets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "_denemeEvrakList.json");

async function main() {
  const t = resolveSqlTargets();
  const pool = await new sql.ConnectionPool({
    user: t.user,
    password: t.password,
    server: t.host,
    port: t.port,
    database: t.writeDb,
    options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
  }).connect();
  try {
    const rs = await pool.request().query(`
      SELECT LTRIM(RTRIM(FATFISEVRAKNO1)) AS evrak
      FROM dbo.FATFIS
      WHERE ISNULL(LTRIM(RTRIM(FATFISEVRAKNO1)), '') <> ''
      ORDER BY FATFISREFNO
    `);
    const evraks = rs.recordset.map((r) => String(r.evrak || "").trim()).filter(Boolean);
    fs.writeFileSync(OUT, JSON.stringify(evraks, null, 2));
    console.log(`Kaydedildi: ${OUT}`);
    console.log(`Evrak sayisi: ${evraks.length}`);
    for (const ev of evraks) console.log(`  ${ev}`);
  } finally {
    await pool.close();
  }
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exitCode = 1;
});
