/**
 * ERD2026000001452.xml üzerinde UBL birebir tutar önizlemesi.
 * node scripts/previewUblExactFromFile.js ../ERD2026000001452.xml
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import {
  computeUblExactAmounts,
  extractIssuerTlTotalsFromUbl,
  strictLineNetFromUbl,
  strictLineTaxFromUbl,
} from "../ublExactAmounts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    const t = v["#text"] ?? v["#TEXT"] ?? v._ ?? v.value;
    if (t != null) return String(t).trim();
  }
  return "";
}

function parseNum(v, def = 0) {
  if (v == null) return def;
  if (typeof v === "number") return Number.isFinite(v) ? v : def;
  const raw = String(v).trim();
  if (!raw) return def;
  const s = raw.replace(/\s+/g, "");
  let normalized = s;
  const commaIdx = s.lastIndexOf(",");
  const dotIdx = s.lastIndexOf(".");
  if (commaIdx >= 0 && dotIdx >= 0) {
    if (commaIdx > dotIdx) normalized = s.replaceAll(".", "").replace(",", ".");
    else normalized = s.replaceAll(",", "");
  } else if (commaIdx >= 0) normalized = s.replace(",", ".");
  else normalized = s;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : def;
}

function extractLines(inv) {
  const out = [];
  const linesRaw = inv.InvoiceLine;
  const lines = Array.isArray(linesRaw) ? linesRaw : linesRaw ? [linesRaw] : [];
  for (const ln of lines) {
    const line = ln && typeof ln === "object" ? ln : {};
    const qtyNode = firstOf(line.InvoicedQuantity);
    const qty = parseNum(textNode(qtyNode), 1);
    const unit = (qtyNode && typeof qtyNode === "object" ? qtyNode["@_unitCode"] : null) || "AD";
    const priceNode = firstOf(line.Price)?.PriceAmount ?? firstOf(line.PriceAmount);
    const unitPrice = parseNum(textNode(priceNode), 0);
    const lineNet = parseNum(textNode(firstOf(line.LineExtensionAmount)), 0);
    const taxAmount = parseNum(textNode(firstOf(firstOf(line.TaxTotal)?.TaxAmount)), 0);
    const taxPercent = parseNum(textNode(firstOf(firstOf(firstOf(line.TaxTotal)?.TaxSubtotal)?.Percent)), 10);
    out.push({ qty, unit, unitPrice, net: lineNet, taxAmount, taxPercent });
  }
  return out;
}

function extractKur(inv) {
  for (const key of ["PricingExchangeRate", "PaymentExchangeRate", "TaxExchangeRate"]) {
    const ex = firstOf(inv[key]);
    const n = parseNum(textNode(ex?.CalculationRate ?? ex?.Rate), 0);
    if (n > 0) return n;
  }
  return 1;
}

function extractDocTotals(inv) {
  const lmt = inv.LegalMonetaryTotal || {};
  const tt = firstOf(inv.TaxTotal);
  return {
    mal: parseNum(textNode(firstOf(lmt.LineExtensionAmount)), 0),
    kdv: parseNum(textNode(firstOf(tt?.TaxAmount)), 0),
    payable: parseNum(textNode(firstOf(lmt.PayableAmount)), 0),
  };
}

async function main() {
  const xmlPath = path.resolve(process.argv[2] || path.join(__dirname, "../../ERD2026000001452.xml"));
  const xml = fs.readFileSync(xmlPath, "utf8");
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    trimValues: true,
  });
  const parsed = parser.parse(xml);
  const inv = firstOf(parsed.Invoice);
  if (!inv) throw new Error("Invoice node not found");

  const afterData = { ublParsed: { Invoice: inv } };
  const usableLines = extractLines(inv);
  const docTotals = extractDocTotals(inv);
  const kur = extractKur(inv);
  const issuerTl = extractIssuerTlTotalsFromUbl(afterData);

  const r = computeUblExactAmounts({
    usableLines,
    docTotals,
    afterData,
    isForeignCurrency: true,
    kur,
  });

  console.log("UBL dosya:", xmlPath);
  console.log("Kur:", kur);
  console.log("Issuer TL (AdditionalDocumentReference):", issuerTl);
  console.log("Doc toplamlar (USD):", docTotals);
  console.log("\n--- ETA'ya yazılacak TL başlık ---");
  console.log("  Mal   :", r.malHizmetToplamTutari, "  (PDF: 108062.24)");
  console.log("  KDV   :", r.vergiTutari, "  (PDF: 10806.22)");
  console.log("  Genel :", r.odenecekTutar, "  (PDF: 118868.46)");
  console.log("\n--- Kalemler ---");
  for (let i = 0; i < r.perLine.length; i++) {
    const pl = r.perLine[i];
    const l = usableLines[i];
    console.log(
      `  ${i + 1}) miktar=${l.qty} ${l.unit}  birimFiyat=${l.unitPrice} USD` +
        `  net=${l.net} USD  kdv=${l.taxAmount} USD` +
        `  → TL net=${pl.netTl}  kdv=${pl.taxTl}`
    );
  }
  const sumNet = r.perLine.reduce((s, x) => s + x.netTl, 0);
  const sumTax = r.perLine.reduce((s, x) => s + x.taxTl, 0);
  console.log("\nKalem TL toplam:", sumNet.toFixed(2), "+", sumTax.toFixed(2), "=", (sumNet + sumTax).toFixed(2));
  console.log("issuerTlUsed:", r.issuerTlUsed);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exitCode = 1;
});
