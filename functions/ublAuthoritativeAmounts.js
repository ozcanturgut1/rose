/**
 * Model A: UBL / qnbRaw başlık tutarları otorite; kalemler buna hizalanır.
 *
 * ETA_AMOUNT_MODEL=ubl   (varsayılan) — bu modül
 * ETA_AMOUNT_MODEL=aligned — kalem toplamından başlık (Model B)
 */
import { roundMoney } from "./tevkifatMuhasebe.js";

/** @returns {'ubl' | 'aligned'} */
export function resolveAmountModel() {
  const m = String(process.env.ETA_AMOUNT_MODEL ?? "ubl").trim().toLowerCase();
  return m === "aligned" ? "aligned" : "ubl";
}

/** Belge döviz tutarını ETA'ya yazılacak TL'ye çevirir (tek yuvarlama). */
export function docAmountToTl(docAmount, isForeignCurrency, kur) {
  const n = Number(docAmount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const doc = roundMoney(n);
  if (!isForeignCurrency || !Number.isFinite(Number(kur)) || Number(kur) <= 0) return doc;
  return roundMoney(doc * Number(kur));
}

/**
 * Kalem toplamı hedef TL'den saparsa farkı son anlamlı satıra yazar; birim fiyat güncellenir.
 * @param {Array<{ qty: number, netTl?: number, taxTl?: number, unitPrice?: number }>} perLine
 */
export function absorbRoundingDeltaIntoLastLine(perLine, targetSumTl, key = "netTl") {
  if (!Array.isArray(perLine) || !perLine.length) return perLine;
  const target = roundMoney(targetSumTl);
  if (target <= 0) return perLine;

  let sum = 0;
  for (const row of perLine) sum += Number(row[key]) || 0;
  sum = roundMoney(sum);
  const diff = roundMoney(target - sum);
  if (Math.abs(diff) < 0.001) return perLine;

  let idx = perLine.length - 1;
  while (idx > 0 && !(Number(perLine[idx][key]) > 0)) idx -= 1;

  perLine[idx][key] = roundMoney((Number(perLine[idx][key]) || 0) + diff);
  const qty = Number(perLine[idx].qty) || 1;
  if (qty > 0 && (key === "netTl" || key === "taxTl")) {
    if (key === "netTl") {
      perLine[idx].unitPrice = roundMoney(perLine[idx].netTl / qty);
    }
  }
  return perLine;
}

/**
 * Model A tutar paketi.
 *
 * @param {object} p
 * @param {Array} p.usableLines
 * @param {{ mal: number, kdv: number, payable: number }} p.docTotals — belge dövizi
 * @param {boolean} p.isForeignCurrency
 * @param {number} p.kur
 * @param {(line: object) => number} p.lineNetFromUbl
 * @param {(line: object) => number} p.lineTaxFromUbl
 * @param {(line: object, def?: number) => number} p.parseQty
 */
export function computeUblAuthoritativeAmounts(p) {
  const {
    usableLines,
    docTotals,
    isForeignCurrency,
    kur,
    lineNetFromUbl,
    lineTaxFromUbl,
    parseQty = (line) => {
      const q = Number(line?.qty);
      return Number.isFinite(q) && q > 0 ? q : 1;
    },
  } = p;

  const perLine = [];
  let lineMalDoc = 0;
  let lineKdvDoc = 0;

  for (const line of usableLines) {
    const qty = parseQty(line);
    const docNet = lineNetFromUbl(line);
    const docTax = lineTaxFromUbl(line);
    lineMalDoc += docNet;
    lineKdvDoc += docTax;
    const netTl = docAmountToTl(docNet, isForeignCurrency, kur);
    const taxTl = docAmountToTl(docTax, isForeignCurrency, kur);
    perLine.push({
      line,
      qty,
      unitPrice: qty > 0 ? roundMoney(netTl / qty) : 0,
      netTl,
      taxTl,
      docNet,
      docTax,
    });
  }

  const docMal = Number(docTotals?.mal) > 0 ? Number(docTotals.mal) : lineMalDoc;
  const docKdv = Number(docTotals?.kdv) > 0 ? Number(docTotals.kdv) : lineKdvDoc;
  const docPayable =
    Number(docTotals?.payable) > 0 ? Number(docTotals.payable) : roundMoney(docMal + docKdv);

  const malHizmetToplamTutari = docAmountToTl(docMal, isForeignCurrency, kur);
  const vergiTutari = docAmountToTl(docKdv, isForeignCurrency, kur);
  let odenecekTutar = docAmountToTl(docPayable, isForeignCurrency, kur);
  if (odenecekTutar <= 0) {
    odenecekTutar = roundMoney(malHizmetToplamTutari + vergiTutari);
  }

  absorbRoundingDeltaIntoLastLine(perLine, malHizmetToplamTutari, "netTl");
  absorbRoundingDeltaIntoLastLine(perLine, vergiTutari, "taxTl");

  return {
    perLine,
    malHizmetToplamTutari,
    vergiTutari,
    odenecekTutar,
    docPayable,
    docMal,
    docKdv,
  };
}
