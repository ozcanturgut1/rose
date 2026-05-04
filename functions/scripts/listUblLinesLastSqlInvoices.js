/**
 * ETA_DENEME_2026.dbo.FATFIS üzerinden son 10 kayıt; her biri için Firestore qnb_invoices
 * UBL (ublParsed veya contentUbl) kalem satırlarını stdout'a yazar.
 *
 * Gerekli: functions/.env (DB_*, DB_READ_NAME, DB_WRITE_NAME), Firebase ADC veya GOOGLE_APPLICATION_CREDENTIALS.
 */
import "dotenv/config";
import sql from "mssql";
import { XMLParser } from "fast-xml-parser";
import { getFirestore } from "firebase-admin/firestore";
import { ensureAdmin } from "../adminInit.js";
import { resolveSqlTargets } from "../sqlDbTargets.js";

function firstOf(x) {
  if (Array.isArray(x)) return x.length ? x[0] : null;
  return x ?? null;
}

function textNode(x) {
  const v = firstOf(x);
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    const m = v;
    const t = m["#text"] ?? m["#TEXT"] ?? m._ ?? m.value;
    if (t != null) return String(t).trim();
  }
  return "";
}

function parseNum(v, def = 0) {
  if (v == null) return def;
  if (typeof v === "number") return Number.isFinite(v) ? v : def;
  const s = String(v).trim().replaceAll(".", "").replaceAll(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : def;
}

function extractInvoiceLines(data) {
  const out = [];
  const up = data.ublParsed && typeof data.ublParsed === "object" ? data.ublParsed : {};
  const inv = firstOf(up.Invoice);
  if (!inv || typeof inv !== "object") return out;
  const linesRaw = inv.InvoiceLine;
  const lines = Array.isArray(linesRaw) ? linesRaw : linesRaw ? [linesRaw] : [];
  for (const ln of lines) {
    const line = ln && typeof ln === "object" ? ln : {};
    const item = firstOf(line.Item) || {};
    const name = textNode(item.Name) || "Kalem";
    const id =
      textNode(item.SellersItemIdentification?.ID) || textNode(item.BuyersItemIdentification?.ID);
    const qtyNode = firstOf(line.InvoicedQuantity);
    const qty = parseNum(textNode(qtyNode), 1);
    const unit = (qtyNode && typeof qtyNode === "object" ? qtyNode["@_unitCode"] : null) || "AD";
    const priceNode = firstOf(line.Price)?.PriceAmount ?? firstOf(line.PriceAmount);
    const unitPrice = parseNum(textNode(priceNode), 0);
    const lineExt = firstOf(line.LineExtensionAmount);
    const lineNet = parseNum(textNode(lineExt), Math.max(0, qty * unitPrice));
    const taxNode = firstOf(line.TaxTotal);
    const taxAmount = parseNum(textNode(firstOf(taxNode?.TaxAmount)), 0);
    const sub = firstOf(firstOf(firstOf(line.TaxTotal)?.TaxSubtotal)?.Percent);
    const taxPercent = parseNum(textNode(sub), 10);
    out.push({
      itemCode: id || "",
      description: name,
      qty: qty || 1,
      unit: String(unit || "AD"),
      unitPrice: unitPrice || 0,
      net: lineNet || 0,
      taxAmount: taxAmount || 0,
      taxPercent: taxPercent || 10,
    });
  }
  return out;
}

function docIdForBelgeNo(belgeNo) {
  const key = String(belgeNo || "").trim();
  if (!key) return null;
  return `invoice_${key.replace(/[/\\]/g, "_")}`;
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

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: true,
});

function linesFromFirestoreData(data) {
  if (!data || typeof data !== "object") return { source: "none", lines: [] };
  const up = data.ublParsed;
  if (up && typeof up === "object") {
    const lines = extractInvoiceLines(data);
    if (lines.length) return { source: "ublParsed", lines };
  }
  const raw = data.contentUbl;
  if (typeof raw === "string" && raw.trim().length > 10) {
    try {
      const root = xmlParser.parse(raw);
      const invoice = root?.Invoice || root?.invoice;
      if (invoice && typeof invoice === "object") {
        const lines = extractInvoiceLines({ ublParsed: { Invoice: invoice } });
        if (lines.length) return { source: "contentUbl", lines };
      }
    } catch {
      /* fallthrough */
    }
  }
  return { source: up ? "ublParsed_empty" : "no_ubl", lines: [] };
}

async function main() {
  const t = resolveSqlTargets();
  const pool = await new sql.ConnectionPool(sqlConfig(t.writeDb)).connect();
  try {
    const rs = await pool.request().query(`
      SELECT TOP 10 FATFISREFNO, FATFISEVRAKNO1, FATFISTAR
      FROM dbo.FATFIS WITH (NOLOCK)
      ORDER BY FATFISREFNO DESC
    `);

    ensureAdmin();
    const db = getFirestore();

    for (const row of rs.recordset) {
      const evrak = String(row.FATFISEVRAKNO1 || "").trim();
      const docId = docIdForBelgeNo(evrak);
      console.log("\n==========");
      console.log(
        `FATFISREFNO=${row.FATFISREFNO} FATFISEVRAKNO1=${evrak} FATFISTAR=${row.FATFISTAR} docId=${docId}`
      );
      if (!docId) {
        console.log("(belge no yok, atlandı)");
        continue;
      }
      const snap = await db.collection("qnb_invoices").doc(docId).get();
      if (!snap.exists) {
        console.log(`Firestore: doküman yok (qnb_invoices/${docId})`);
        continue;
      }
      const data = snap.data() || {};
      const { source, lines } = linesFromFirestoreData(data);
      console.log(`UBL kaynağı: ${source}  kalem sayısı: ${lines.length}`);
      lines.forEach((ln, i) => {
        console.log(
          `  ${i + 1}. kod=${ln.itemCode || "-"}  ${ln.description.slice(0, 80)}${ln.description.length > 80 ? "…" : ""}  qty=${ln.qty} ${ln.unit}  birim=${ln.unitPrice}  net=${ln.net}  kdv%=${ln.taxPercent}`
        );
      });
    }
  } finally {
    await pool.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
