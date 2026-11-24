/**
 * Fatura başlığındaki ek ücret ve iskonto (UBL AllowanceCharge).
 *
 * Ürün satırına yazılmayan kargo gibi tutarlar kendi satırı olur.
 * İskonto en büyük ürün satırının matrahından düşülür.
 * Satır neti + KDV − tevkifat ödenecek tutarı tutmuyorsa fiş yazılmaz.
 */
import { roundMoney } from "./tevkifatMuhasebe.js";

function firstOf(x) {
  if (Array.isArray(x)) return x.length ? x[0] : null;
  return x ?? null;
}

function textNode(x) {
  const v = firstOf(x);
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v).trim();
  if (typeof v === "object") {
    const t = v["#text"] ?? v["#TEXT"] ?? v._ ?? v.value;
    if (t != null) return String(t).trim();
  }
  return "";
}

function parseNum(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim().replace(/\s+/g, "");
  if (!s) return 0;
  let n = s;
  const c = s.lastIndexOf(",");
  const d = s.lastIndexOf(".");
  if (c >= 0 && d >= 0) n = c > d ? s.replaceAll(".", "").replace(",", ".") : s.replaceAll(",", "");
  else if (c >= 0) n = s.replace(",", ".");
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

function invoiceNode(data) {
  const inv = firstOf(data?.ublParsed?.Invoice);
  return inv && typeof inv === "object" ? inv : null;
}

function liste(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

/** true ek ücret, false iskonto, null belirsiz. */
function chargeIndicator(node) {
  const raw = node?.ChargeIndicator;
  if (raw === true) return true;
  if (raw === false) return false;
  const t = textNode(raw).toLowerCase();
  if (t === "true" || t === "1") return true;
  if (t === "false" || t === "0") return false;
  return null;
}

function yakin(a, b) {
  return Math.abs(roundMoney(a) - roundMoney(b)) < 0.02;
}

function toplam(rows, key = "amount") {
  return roundMoney(rows.reduce((s, r) => s + (Number(r[key]) || 0), 0));
}

function kdvYuzdesi(matrah, vergi) {
  if (!(matrah > 0) || !(vergi > 0)) return 0;
  const yuzde = roundMoney((vergi / matrah) * 100);
  for (const oran of [20, 10, 8, 1, 18]) {
    if (Math.abs(yuzde - oran) < 0.06) return oran;
  }
  return yuzde;
}

function baslikEkleri(inv) {
  return liste(inv.AllowanceCharge)
    .map((node) => {
      const amount = roundMoney(parseNum(textNode(firstOf(node?.Amount))));
      if (!(amount > 0)) return null;
      const reason = textNode(node?.AllowanceChargeReason).slice(0, 255);
      return { amount, reason, charge: chargeIndicator(node) };
    })
    .filter(Boolean);
}

function sinifla(ekler, lineExt, taxExc) {
  const charges = [];
  const allowances = [];
  const unknown = [];
  for (const e of ekler) {
    if (e.charge === true) charges.push(e);
    else if (e.charge === false) allowances.push(e);
    else unknown.push(e);
  }
  if (!unknown.length) return { charges, allowances, belirsiz: false };
  if (!(lineExt > 0) || !(taxExc > 0)) return { charges, allowances, belirsiz: true };

  const rest = roundMoney(taxExc - lineExt - toplam(charges) + toplam(allowances));
  const unknownSum = toplam(unknown);
  if (yakin(rest, unknownSum)) return { charges: charges.concat(unknown), allowances, belirsiz: false };
  if (yakin(rest, -unknownSum)) return { charges, allowances: allowances.concat(unknown), belirsiz: false };
  if (unknown.length === 1 && yakin(Math.abs(rest), unknownSum)) {
    if (rest >= 0) charges.push(unknown[0]);
    else allowances.push(unknown[0]);
    return { charges, allowances, belirsiz: false };
  }
  return { charges, allowances, belirsiz: true };
}

function enBuyukNet(lines) {
  let idx = 0;
  for (let i = 1; i < lines.length; i++) {
    if ((Number(lines[i].net) || 0) > (Number(lines[idx].net) || 0)) idx = i;
  }
  return idx;
}

/**
 * Başlık eklerini ürün satırlarına uygular. Belirsizse satırlara dokunmaz.
 * @param {Array} lines ürün satırları; ek ücret satırı bu diziye eklenir
 */
export function baslikEkleriniSatiraYaz(lines, data) {
  const bos = { uygulandi: false, belirsiz: false, mal: 0, kdv: 0, lines };
  if (!Array.isArray(lines) || !lines.length) return bos;
  const inv = invoiceNode(data);
  if (!inv) return bos;
  const ekler = baslikEkleri(inv);
  if (!ekler.length) return bos;

  const lmt = inv.LegalMonetaryTotal || {};
  const lineExt = parseNum(textNode(firstOf(lmt.LineExtensionAmount)));
  const taxExc = parseNum(textNode(firstOf(lmt.TaxExclusiveAmount)));
  const docTax = parseNum(textNode(firstOf(firstOf(inv.TaxTotal)?.TaxAmount)));
  const sinif = sinifla(ekler, lineExt, taxExc);
  if (sinif.belirsiz || (!sinif.charges.length && !sinif.allowances.length)) {
    return { ...bos, belirsiz: sinif.belirsiz };
  }

  const productTax = roundMoney(lines.reduce((s, l) => s + (Number(l.taxAmount) || 0), 0));
  let remainder = docTax > 0 ? roundMoney(docTax - productTax) : 0;
  const allowanceNet = toplam(sinif.allowances);
  if (allowanceNet > 0) {
    const idx = enBuyukNet(lines);
    const net = Number(lines[idx].net) || 0;
    if (net + 0.001 < allowanceNet) return { ...bos, belirsiz: true };
    lines[idx].net = roundMoney(net - allowanceNet);
    const qty = Number(lines[idx].qty) || 1;
    lines[idx].unitPrice = qty > 0 ? roundMoney(lines[idx].net / qty) : lines[idx].net;
    if (remainder < 0) {
      const tax = Number(lines[idx].taxAmount) || 0;
      const cut = Math.min(tax, roundMoney(-remainder));
      lines[idx].taxAmount = roundMoney(tax - cut);
      remainder = roundMoney(remainder + cut);
    }
  }

  const charges = sinif.charges.map((c) => ({ ...c, tax: 0 }));
  if (charges.length && remainder > 0) {
    const base = toplam(charges);
    let allocated = 0;
    for (let i = 0; i < charges.length; i++) {
      const tax =
        i === charges.length - 1
          ? roundMoney(remainder - allocated)
          : base > 0
            ? roundMoney((charges[i].amount / base) * remainder)
            : 0;
      charges[i].tax = tax;
      allocated = roundMoney(allocated + tax);
    }
  }

  for (const c of charges) {
    const percent = kdvYuzdesi(c.amount, c.tax);
    const ad = c.reason || "Ek ücret";
    lines.push({
      ekUcret: true,
      itemCode: "",
      description: ad,
      stokCinsi: ad,
      lineAciklama: ad,
      qty: 1,
      unit: "AD",
      unitPrice: c.amount,
      net: c.amount,
      taxAmount: c.tax,
      taxPercent: percent,
      taxPercentExplicit: true,
    });
  }

  const mal = roundMoney(lines.reduce((s, l) => s + (Number(l.net) || 0), 0));
  const kdv = roundMoney(lines.reduce((s, l) => s + (Number(l.taxAmount) || 0), 0));
  return { uygulandi: true, belirsiz: false, mal, kdv, lines };
}

/** Satır TL toplamı ödenecek tutarla kuruşu kuruşuna tutuyor mu. */
export function tutarKapisi(perLine, odenecek, tevkifat = 0) {
  let net = 0;
  let kdv = 0;
  for (const row of perLine || []) {
    net += Number(row.netTl ?? row.net) || 0;
    kdv += Number(row.taxTl ?? row.taxAmount) || 0;
  }
  const satirToplam = roundMoney(net + kdv - (Number(tevkifat) || 0));
  const hedef = roundMoney(odenecek);
  const fark = roundMoney(satirToplam - hedef);
  return { uyar: Math.abs(fark) < 0.005, satirToplam, odenecek: hedef, fark };
}

export function tutarKapisiMesaji(kapi) {
  const tl = (n) =>
    Math.abs(roundMoney(n)).toLocaleString("tr-TR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  return (
    `Ödenecek tutar ${tl(kapi.odenecek)} TL, satırların toplamı ${tl(kapi.satirToplam)} TL. ` +
    `Fark ${tl(kapi.fark)} TL. Fiş yazılmadı.`
  );
}
