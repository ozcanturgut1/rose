import sql from "mssql";
import { transformMaxToIsnullMax } from "./patchEtaDenemeProceduresNullSafe.js";
import { transformSpFaturaKayitCariBakiyeAllTypes } from "./patchSpFaturaKayitCariBakiyeAllTypes.js";

const sourceDb = "ETA_TEKNIKFILAMENT_2026";
const targetDb = "ETA_DENEME_2026";
const procedures = [
  "sp_Fatura_Kayit",
  "sp_Fatura_Detay_Kayit",
  "sp_FatFisToplam_Kayit",
  "sp_Yuvarlama_Kayit",
];

function cfg(database) {
  return {
    user: "sa",
    password: "Eta2014",
    server: "192.168.1.44",
    port: 1433,
    database,
    options: {
      encrypt: false,
      trustServerCertificate: true,
    },
  };
}

const inList = procedures.map((p) => `'${p}'`).join(", ");

const src = await sql.connect(cfg(sourceDb));
const defs = (
  await src.request().query(`
    SELECT p.name, m.definition
    FROM sys.procedures p
    JOIN sys.sql_modules m ON m.object_id = p.object_id
    WHERE p.name IN (${inList})
    ORDER BY p.name
  `)
).recordset;
await src.close();

if (!defs.length) {
  throw new Error("No procedure definitions found in source database.");
}

const dst = await sql.connect(cfg(targetDb));
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
  await dst
    .request()
    .query(`IF OBJECT_ID('dbo.${row.name}','P') IS NOT NULL DROP PROCEDURE dbo.${row.name};`);
  await dst.request().batch(patchedDef);
  console.log(`Applied: ${row.name}  null-safe yamalar=${replacements.length}`);
}

const check = (
  await dst.request().query(`
    SELECT name FROM sys.procedures
    WHERE name IN (${inList})
    ORDER BY name
  `)
).recordset;
await dst.close();

console.log(`Present in ${targetDb}: ${check.map((r) => r.name).join(", ")}`);
