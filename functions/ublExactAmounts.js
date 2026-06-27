/**
 * UBL / e-Fatura kağıt çıktısı ile birebir tutar hizalama.
 *
 * Dövizli faturalarda TL toplamları UBL AdditionalDocumentReference alanlarından okunur
 * (LINEEXTENSIONAMOUNT, PAYABLEAMOUNT, KDV vb.) — XSLT/PDF ile aynı kaynak.
 * Kalem TL tutarları bu toplamlara, kalem döviz tutarı oranında dağıtılır.
 */
import { roundMoney } from "./tevkifatMuhasebe.js";

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
    if (commaIdx > dotIdx) {
      normalized = s.replaceAll(".", "").replace(",", ".");
    } else {
      normalized = s.replaceAll(",", "");
    }
  } else if (commaIdx >= 0) {
    normalized = s.replace(",", ".");
  } else {
    normalized = s;
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : def;
}

function getInvoiceNode(data) {
  const up = data?.ublParsed && typeof data.ublParsed === "object" ? data.ublParsed : {};
  const inv = firstOf(up.Invoice);
  return inv && typeof inv === "object" ? inv : null;
}

/**
 * e-Fatura XSLT'nin PDF'e yazdığı TL toplamları (AdditionalDocumentReference).
 * @returns {{ malTl: number, kdvTl: number, payableTl: number, taxInclusiveTl: number } | null}
 */
export function extractIssuerTlTotalsFromUbl(data) {
  const inv = getInvoiceNode(data);
  if (!inv) return null;

  const refsRaw = inv.AdditionalDocumentReference;
  const refs = Array.isArray(refsRaw) ? refsRaw : refsRaw ? [refsRaw] : [];
  const out = { malTl: 0, kdvTl: 0, payableTl: 0, taxInclusiveTl: 0 };

  for (const r of refs) {
    if (!r || typeof r !== "object") continue;
    const typ = String(textNode(r.DocumentType) || "").trim().toUpperCase();
    const id = parseNum(textNode(r.ID), 0);
    const desc = String(textNode(r.DocumentDescription) || "").trim().toUpperCase();

    if (typ === "LINEEXTENSIONAMOUNT" && id > 0) out.malTl = id;
    else if (typ === "TAXEXCLUSIVEAMOUNT" && id > 0 && out.malTl <= 0) out.malTl = id;
    else if (typ === "TAXINCLUSIVEAMOUNT" && id > 0) out.taxInclusiveTl = id;
    else if (typ === "PAYABLEAMOUNT" && id > 0) out.payableTl = id;
    else if (desc === "KDV" && id > 0) out.kdvTl = id;
  }

  if (out.kdvTl <= 0 && out.payableTl > 0 && out.malTl > 0) {
    out.kdvTl = roundMoney(out.payableTl - out.malTl);
  }
  if (out.payableTl <= 0 && out.taxInclusiveTl > 0) out.payableTl = out.taxInclusiveTl;
  if (out.malTl <= 0 && out.payableTl <= 0) return null;
  return out;
}

/** Kalem neti: yalnızca UBL LineExtensionAmount (miktar×fiyat değil). */
export function strictLineNetFromUbl(line) {
  const net = parseNum(line?.net, 0);
  if (net > 0) return net;
  const qty = parseNum(line?.qty, 1) || 1;
  const unitPrice = parseNum(line?.unitPrice, 0);
  return qty > 0 && unitPrice > 0 ? roundMoney(qty * unitPrice) : 0;
}

/** Kalem KDV: yalnızca UBL TaxAmount; yoksa orandan tek yuvarlama. */
export function strictLineTaxFromUbl(line) {
  const rawTax = parseNum(line?.taxAmount, 0);
  if (rawTax > 0) return rawTax;
  const net = strictLineNetFromUbl(line);
  const pct = parseNum(line?.taxPercent, 0);
  const frac = pct > 0 && pct <= 1 ? pct : pct / 100;
  return frac > 0 && net > 0 ? roundMoney(net * frac) : 0;
}

/** UBL PriceAmount (döviz birim fiyat); yoksa LineExtension / miktar. */
export function strictLineUnitPriceFromUbl(line) {
  const up = parseNum(line?.unitPrice, 0);
  if (up > 0) return up;
  const qty = parseNum(line?.qty, 1) || 1;
  const net = strictLineNetFromUbl(line);
  return qty > 0 && net > 0 ? roundMoney(net / qty) : 0;
}

/**
 * Hedef TL'yi kalem döviz tutarı oranında dağıtır; son satırda kalan farkı yazar.
 */
export function allocateProportionalTl(perLine, targetTl, docKey, tlKey) {
  if (!Array.isArray(perLine) || !perLine.length) return perLine;
  const target = roundMoney(targetTl);
  if (target <= 0) return perLine;

  let docSum = 0;
  for (const row of perLine) docSum += Number(row[docKey]) || 0;
  if (docSum <= 0) return perLine;

  let allocated = 0;
  for (let i = 0; i < perLine.length; i++) {
    if (i === perLine.length - 1) {
      perLine[i][tlKey] = roundMoney(target - allocated);
    } else {
      const share = roundMoney(((Number(perLine[i][docKey]) || 0) / docSum) * target);
      perLine[i][tlKey] = share;
      allocated = roundMoney(allocated + share);
    }
  }
  return perLine;
}

/** Belge döviz tutarını TL'ye çevirir (UBL TL toplamı yoksa yedek). */
export function docAmountToTl(docAmount, isForeignCurrency, kur) {
  const n = Number(docAmount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const doc = roundMoney(n);
  if (!isForeignCurrency || !Number.isFinite(Number(kur)) || Number(kur) <= 0) return doc;
  return roundMoney(doc * Number(kur));
}

/**
 * UBL birebir tutar paketi (kağıt/PDF ile aynı kaynak).
 */
export function computeUblExactAmounts(p) {
  const {
    usableLines,
    docTotals,
    afterData,
    isForeignCurrency,
    kur,
    parseQty = (line) => {
      const q = Number(line?.qty);
      return Number.isFinite(q) && q > 0 ? q : 1;
    },
  } = p;

  const issuerTl = isForeignCurrency ? extractIssuerTlTotalsFromUbl(afterData) : null;
  const perLine = [];
  let docMalSum = 0;
  let docKdvSum = 0;

  for (const line of usableLines) {
    const qty = parseQty(line);
    const docNet = strictLineNetFromUbl(line);
    const docTax = strictLineTaxFromUbl(line);
    const docUnitPrice = strictLineUnitPriceFromUbl(line);
    docMalSum += docNet;
    docKdvSum += docTax;
    perLine.push({
      line,
      qty,
      docNet,
      docTax,
      docUnitPrice,
      netTl: 0,
      taxTl: 0,
      unitPrice: 0,
    });
  }

  const docMal = Number(docTotals?.mal) > 0 ? Number(docTotals.mal) : roundMoney(docMalSum);
  const docKdv = Number(docTotals?.kdv) > 0 ? Number(docTotals.kdv) : roundMoney(docKdvSum);
  const docPayable =
    Number(docTotals?.payable) > 0 ? Number(docTotals.payable) : roundMoney(docMal + docKdv);

  let malHizmetToplamTutari;
  let vergiTutari;
  let odenecekTutar;

  if (isForeignCurrency && issuerTl?.malTl > 0) {
    malHizmetToplamTutari = roundMoney(issuerTl.malTl);
    vergiTutari =
      issuerTl.kdvTl > 0
        ? roundMoney(issuerTl.kdvTl)
        : roundMoney((issuerTl.payableTl || 0) - malHizmetToplamTutari);
    odenecekTutar =
      issuerTl.payableTl > 0
        ? roundMoney(issuerTl.payableTl)
        : roundMoney(malHizmetToplamTutari + vergiTutari);
  } else if (isForeignCurrency) {
    malHizmetToplamTutari = docAmountToTl(docMal, true, kur);
    vergiTutari = docAmountToTl(docKdv, true, kur);
    odenecekTutar = docAmountToTl(docPayable, true, kur);
    if (odenecekTutar <= 0) odenecekTutar = roundMoney(malHizmetToplamTutari + vergiTutari);
  } else {
    malHizmetToplamTutari = roundMoney(docMal);
    vergiTutari = roundMoney(docKdv);
    odenecekTutar = roundMoney(docPayable);
    if (odenecekTutar <= 0) odenecekTutar = roundMoney(malHizmetToplamTutari + vergiTutari);
  }

  allocateProportionalTl(perLine, malHizmetToplamTutari, "docNet", "netTl");
  allocateProportionalTl(perLine, vergiTutari, "docTax", "taxTl");

  for (const row of perLine) {
    row.unitPrice = row.qty > 0 ? roundMoney(row.netTl / row.qty) : roundMoney(row.netTl);
  }

  return {
    perLine,
    malHizmetToplamTutari,
    vergiTutari,
    odenecekTutar,
    docPayable,
    docMal,
    docKdv,
    issuerTlUsed: Boolean(issuerTl?.malTl > 0),
  };
}
