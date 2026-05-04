/**
 * Son 10 fatura (ETA write DB FATFIS sırası) için Firestore qnb_invoices UBL'den
 * stok cinsi / kod / sınıflandırma bilgilerini listeler (veri kaynağı: Firebase).
 *
 * Gerekli: .env (DB_*), Firebase ADC veya GOOGLE_APPLICATION_CREDENTIALS.
 *
 * Sadece Firestore sırası: `node scripts/listFirebaseStokCinsiLast10Invoices.js --from-firestore`
 * (type==invoice + updatedAt desc; gerekirse Firestore composite index oluşturulmalı.)
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

function collectDescriptions(item) {
  if (!item || typeof item !== "object") return [];
  const d = item.Description;
  if (d == null) return [];
  const parts = [];
  const pushOne = (v) => {
    const s = textNode(v);
    if (s) parts.push(s);
  };
  if (typeof d === "string" || typeof d === "number") {
    pushOne(d);
    return parts;
  }
  if (Array.isArray(d)) {
    for (const x of d) pushOne(x);
    return parts;
  }
  pushOne(d);
  return parts;
}

function commodityClassifications(item) {
  if (!item || typeof item !== "object") return [];
  const cc = item.CommodityClassification;
  if (!cc) return [];
  const arr = Array.isArray(cc) ? cc : [cc];
  const out = [];
  for (const c of arr) {
    if (!c || typeof c !== "object") continue;
    const code = textNode(c.ItemClassificationCode);
    if (!code) continue;
    const listID = c["@_listID"] ?? c["@_listId"] ?? c.listID ?? "";
    out.push(listID ? `${listID}:${code}` : code);
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

function getInvoiceFromDocData(data) {
  if (!data || typeof data !== "object") return { source: "none", invoice: null };
  const up = data.ublParsed;
  if (up && typeof up === "object") {
    const inv = firstOf(up.Invoice);
    if (inv && typeof inv === "object") return { source: "ublParsed", invoice: inv };
  }
  const raw = data.contentUbl;
  if (typeof raw === "string" && raw.trim().length > 10) {
    try {
      const root = xmlParser.parse(raw);
      const invoice = root?.Invoice || root?.invoice;
      if (invoice && typeof invoice === "object") return { source: "contentUbl", invoice };
    } catch {
      /* ignore */
    }
  }
  return { source: "no_ubl", invoice: null };
}

function extractStokLines(invoice) {
  const linesRaw = invoice?.InvoiceLine;
  const lines = Array.isArray(linesRaw) ? linesRaw : linesRaw ? [linesRaw] : [];
  const out = [];
  for (const ln of lines) {
    const line = ln && typeof ln === "object" ? ln : {};
    const item = firstOf(line.Item) || {};
    const lineId = textNode(line.ID) || "";
    const name = textNode(item.Name) || "";
    const descParts = collectDescriptions(item);
    const seller = textNode(item.SellersItemIdentification?.ID);
    const buyer = textNode(item.BuyersItemIdentification?.ID);
    const standard = textNode(item.StandardItemIdentification?.ID);
    const commodity = commodityClassifications(item);
    const qtyNode = firstOf(line.InvoicedQuantity);
    const qty = textNode(qtyNode) || "";
    const unit =
      (qtyNode && typeof qtyNode === "object" ? qtyNode["@_unitCode"] : null) || "";
    out.push({
      lineId,
      stokCinsi: name,
      aciklamaSatirlari: descParts,
      satiriciKod: seller,
      aliciKod: buyer,
      standartKod: standard,
      siniflandirma: commodity,
      miktar: qty,
      birim: unit,
    });
  }
  return out;
}

async function docIdsFromSql() {
  const t = resolveSqlTargets();
  const pool = await new sql.ConnectionPool(sqlConfig(t.writeDb)).connect();
  try {
    const rs = await pool.request().query(`
      SELECT TOP 10 FATFISREFNO, FATFISEVRAKNO1, FATFISTAR
      FROM dbo.FATFIS WITH (NOLOCK)
      ORDER BY FATFISREFNO DESC
    `);
    return rs.recordset.map((row) => ({
      fatFisRefNo: row.FATFISREFNO,
      belgeNo: String(row.FATFISEVRAKNO1 || "").trim(),
      fatFisTar: row.FATFISTAR,
      docId: docIdForBelgeNo(row.FATFISEVRAKNO1),
    }));
  } finally {
    await pool.close();
  }
}

async function docIdsFromFirestore(db) {
  const snap = await db
    .collection("qnb_invoices")
    .where("type", "==", "invoice")
    .orderBy("updatedAt", "desc")
    .limit(10)
    .get();
  return snap.docs.map((d) => ({
    fatFisRefNo: null,
    belgeNo: String(d.get("belgeNo") || "").trim(),
    fatFisTar: null,
    docId: d.id,
  }));
}

async function main() {
  const fromFs = process.argv.includes("--from-firestore");

  ensureAdmin();
  const db = getFirestore();

  const rows = fromFs ? await docIdsFromFirestore(db) : await docIdsFromSql();

  for (const meta of rows) {
    const { docId, belgeNo, fatFisRefNo, fatFisTar } = meta;
    console.log("\n==========");
    console.log(
      `docId=${docId} belgeNo=${belgeNo || "-"}${fatFisRefNo != null ? ` FATFISREFNO=${fatFisRefNo}` : ""}${fatFisTar != null ? ` FATFISTAR=${fatFisTar}` : ""}`
    );
    if (!docId) {
      console.log("(docId yok)");
      continue;
    }
    const snap = await db.collection("qnb_invoices").doc(docId).get();
    if (!snap.exists) {
      console.log(`Firestore: doküman yok (qnb_invoices/${docId})`);
      continue;
    }
    const data = snap.data() || {};
    const { source, invoice } = getInvoiceFromDocData(data);
    const stokLines = invoice ? extractStokLines(invoice) : [];
    console.log(`UBL: ${source}  kalem: ${stokLines.length}`);
    stokLines.forEach((s, i) => {
      const acik = s.aciklamaSatirlari.length ? ` | ek: ${s.aciklamaSatirlari.join(" | ")}` : "";
      const snf = s.siniflandirma.length ? ` | sınıf: ${s.siniflandirma.join(", ")}` : "";
      console.log(
        `  ${i + 1}. satır=${s.lineId || "-"} | stokCinsi=${s.stokCinsi || "-"}${acik}`
      );
      console.log(
        `      satıcıKod=${s.satiriciKod || "-"} alıcıKod=${s.aliciKod || "-"} standart=${s.standartKod || "-"} miktar=${s.miktar} ${s.birim}${snf}`
      );
    });
    if (!stokLines.length && source === "no_ubl") {
      console.log("  (UBL yok veya parse edilemedi)");
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
