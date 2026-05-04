/**
 * UBL (Invoice veya DespatchAdvice) XML'ini Firebase'e kaydedilecek
 * yapılandırılmış JSON formatına çevirir (belgeBilgileri, tedarikci, musteri, toplamlar vb.).
 *
 * İleride yapı değişirse: belgeOzet._version ile hangi şema olduğu anlaşılır;
 * contentUbl varsa yeniden parse edilip belgeOzet güncellenebilir (kaynak: UBL).
 */
import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

function val(node) {
  if (node == null) return null;
  if (typeof node === "object" && "#text" in node) return node["#text"];
  if (typeof node === "string" || typeof node === "number") return node;
  return null;
}

function str(node) {
  const v = val(node);
  return v != null ? String(v).trim() : null;
}

function adres(party) {
  if (!party?.PostalAddress) return null;
  const a = party.PostalAddress;
  const o = {};
  if (str(a.StreetName)) o.StreetName = str(a.StreetName);
  if (str(a.BuildingName)) o.BuildingName = str(a.BuildingName);
  if (str(a.BuildingNumber)) o.BuildingNumber = str(a.BuildingNumber);
  if (str(a.Room)) o.Room = str(a.Room);
  if (str(a.CitySubdivisionName)) o.CitySubdivisionName = str(a.CitySubdivisionName);
  if (str(a.CityName)) o.CityName = str(a.CityName);
  if (str(a.PostalZone)) o.PostalZone = str(a.PostalZone);
  if (str(a.Region)) o.Region = str(a.Region);
  if (a.Country?.Name) o.Country = str(a.Country.Name);
  return Object.keys(o).length ? o : null;
}

function partyToTaraf(party) {
  if (!party?.Party) return null;
  const p = party.Party;
  const id = p.PartyIdentification?.ID;
  const vkn = id != null ? String(val(id) ?? "").trim() : null;
  const scheme = p.PartyIdentification?.ID?.["@_schemeID"];
  const name = p.PartyName?.Name;
  const out = {
    VKN: scheme === "VKN" ? vkn : null,
    TCKN: scheme === "TCKN" ? vkn : null,
    Unvan: str(name) || vkn,
    Adres: adres(p),
    VergiDairesi: p.PartyTaxScheme?.TaxScheme?.Name ? str(p.PartyTaxScheme.TaxScheme.Name) : null,
    ElectronicMail: str(p.Contact?.ElectronicMail),
    Telefon: str(p.Contact?.Telephone),
    WebsiteURI: str(p.WebsiteURI),
  };
  if (!out.VKN && !out.TCKN && vkn) out.VKN = vkn;
  return out;
}

function invoiceLineToOzet(line) {
  if (!line) return null;
  const qty = line.InvoicedQuantity;
  const amount = line.LineExtensionAmount;
  const item = line.Item;
  return {
    ID: val(line.ID),
    InvoicedQuantity: val(qty) != null ? Number(val(qty)) : null,
    unitCode: line.InvoicedQuantity?.["@_unitCode"] || null,
    LineExtensionAmount: val(amount) != null ? Number(val(amount)) : null,
    currencyID: amount?.["@_currencyID"] || null,
    Item: item ? {
      Name: str(item.Name),
      SellersItemIdentification: str(item.SellersItemIdentification?.ID),
      BuyersItemIdentification: str(item.BuyersItemIdentification?.ID),
    } : null,
    TaxAmount: val(line.TaxTotal?.TaxAmount) != null ? Number(val(line.TaxTotal.TaxAmount)) : null,
    KDV: line.TaxTotal?.TaxSubtotal ? {
      Percent: val(line.TaxTotal.TaxSubtotal.Percent) != null ? Number(val(line.TaxTotal.TaxSubtotal.Percent)) : null,
      TaxTypeCode: val(line.TaxTotal.TaxSubtotal.TaxCategory?.TaxScheme?.TaxTypeCode),
    } : null,
  };
}

function despatchLineToOzet(line) {
  if (!line) return null;
  const qty = line.DeliveredQuantity;
  const item = line.Item;
  return {
    ID: val(line.ID),
    DeliveredQuantity: val(qty) != null ? Number(val(qty)) : null,
    unitCode: line.DeliveredQuantity?.["@_unitCode"] || null,
    Item: item ? {
      Name: str(item.Name),
      SellersItemIdentification: str(item.SellersItemIdentification?.ID),
    } : null,
  };
}

/**
 * Invoice UBL -> Firebase'e kaydedilecek yapılandırılmış özet
 */
function invoiceToStructuredJson(inv) {
  if (!inv) return null;
  const lines = inv.InvoiceLine;
  const lineArr = Array.isArray(lines) ? lines : (lines ? [lines] : []);
  const firstLine = lineArr[0];

  const additionalRefs = inv.AdditionalDocumentReference;
  const addArr = Array.isArray(additionalRefs) ? additionalRefs : (additionalRefs ? [additionalRefs] : []);
  const additionalDocRef = addArr.map((r) => ({
    ID: str(r.ID),
    IssueDate: str(r.IssueDate),
    DocumentType: str(r.DocumentType),
    DocumentTypeCode: str(r.DocumentTypeCode),
    filename: r.Attachment?.EmbeddedDocumentBinaryObject?.["@_filename"] || null,
  }));

  let signatoryParty = null;
  if (inv.Signature?.SignatoryParty) {
    const sp = inv.Signature.SignatoryParty;
    const sid = sp.PartyIdentification?.ID;
    signatoryParty = {
      VKN_TCKN: sid ? String(val(sid) ?? "").trim() : null,
      Unvan: str(sp.PartyName?.Name),
      Adres: sp.PostalAddress ? [
        str(sp.PostalAddress.StreetName),
        str(sp.PostalAddress.CitySubdivisionName),
        str(sp.PostalAddress.CityName),
        sp.PostalAddress.Country?.Name ? str(sp.PostalAddress.Country.Name) : null,
      ].filter(Boolean).join(", ") : null,
    };
  }

  const taxTotal = inv.TaxTotal;
  const taxSub = taxTotal?.TaxSubtotal;
  const taxSubArr = Array.isArray(taxSub) ? taxSub : (taxSub ? [taxSub] : []);

  const legalTotal = inv.LegalMonetaryTotal || {};

  return {
    _version: "1.0",
    belgeBilgileri: {
      ID: str(inv.ID),
      UUID: str(inv.UUID),
      UBLVersionID: val(inv.UBLVersionID) != null ? String(val(inv.UBLVersionID)) : null,
      CustomizationID: str(inv.CustomizationID),
      ProfileID: str(inv.ProfileID),
      IssueDate: str(inv.IssueDate),
      IssueTime: str(inv.IssueTime),
      InvoiceTypeCode: str(inv.InvoiceTypeCode),
      DocumentCurrencyCode: str(inv.DocumentCurrencyCode),
      Note: str(inv.Note),
      LineCountNumeric: val(inv.LineCountNumeric) != null ? Number(val(inv.LineCountNumeric)) : null,
    },
    irsaliyeReferansi: (() => {
      const refs = inv.DespatchDocumentReference;
      const arr = Array.isArray(refs) ? refs : (refs ? [refs] : []);
      if (arr.length === 0) return null;
      const withDate = arr.map((r) => ({ ID: str(r?.ID), IssueDate: str(r?.IssueDate) })).filter((r) => r.ID);
      const sorted = [...withDate].sort((a, b) => {
        if (!a.IssueDate) return 1;
        if (!b.IssueDate) return -1;
        return b.IssueDate.localeCompare(a.IssueDate);
      });
      const primary = sorted[0] || withDate[0];
      return {
        DespatchDocumentReference: primary,
        DespatchDocumentReferenceList: withDate.length > 1 ? withDate : undefined,
      };
    })(),
    donem: inv.InvoicePeriod ? {
      InvoicePeriod: {
        StartDate: str(inv.InvoicePeriod.StartDate),
        EndDate: str(inv.InvoicePeriod.EndDate),
      },
    } : null,
    siparisReferansi: inv.OrderReference ? {
      OrderReference: {
        ID: str(inv.OrderReference.ID),
        IssueDate: str(inv.OrderReference.IssueDate),
      },
    } : null,
    tedarikci: partyToTaraf(inv.AccountingSupplierParty),
    musteri: partyToTaraf(inv.AccountingCustomerParty),
    odemeKosullari: inv.PaymentTerms?.SettlementPeriod ? {
      SettlementPeriod: {
        StartDate: str(inv.PaymentTerms.SettlementPeriod.StartDate),
        EndDate: str(inv.PaymentTerms.SettlementPeriod.EndDate),
        DurationMeasure: val(inv.PaymentTerms.SettlementPeriod.DurationMeasure) != null ? Number(val(inv.PaymentTerms.SettlementPeriod.DurationMeasure)) : null,
        unitCode: inv.PaymentTerms.SettlementPeriod.DurationMeasure?.["@_unitCode"] || null,
      },
    } : null,
    vergi: taxTotal ? {
      TaxAmount: val(taxTotal.TaxAmount) != null ? Number(val(taxTotal.TaxAmount)) : null,
      currencyID: taxTotal.TaxAmount?.["@_currencyID"] || null,
      TaxSubtotal: taxSubArr.map((t) => ({
        TaxableAmount: val(t.TaxableAmount) != null ? Number(val(t.TaxableAmount)) : null,
        TaxAmount: val(t.TaxAmount) != null ? Number(val(t.TaxAmount)) : null,
        Percent: val(t.Percent) != null ? Number(val(t.Percent)) : null,
        TaxScheme: t.TaxCategory?.TaxScheme ? { Name: str(t.TaxCategory.TaxScheme.Name), TaxTypeCode: val(t.TaxCategory.TaxScheme.TaxTypeCode) } : null,
      })),
    } : null,
    toplamlar: {
      LineExtensionAmount: val(legalTotal.LineExtensionAmount) != null ? Number(val(legalTotal.LineExtensionAmount)) : null,
      TaxExclusiveAmount: val(legalTotal.TaxExclusiveAmount) != null ? Number(val(legalTotal.TaxExclusiveAmount)) : null,
      TaxInclusiveAmount: val(legalTotal.TaxInclusiveAmount) != null ? Number(val(legalTotal.TaxInclusiveAmount)) : null,
      AllowanceTotalAmount: val(legalTotal.AllowanceTotalAmount) != null ? Number(val(legalTotal.AllowanceTotalAmount)) : null,
      PayableAmount: val(legalTotal.PayableAmount) != null ? Number(val(legalTotal.PayableAmount)) : null,
      currencyID: legalTotal.PayableAmount?.["@_currencyID"] || inv.DocumentCurrencyCode ? str(inv.DocumentCurrencyCode) : null,
    },
    faturaSatiri: firstLine ? invoiceLineToOzet(firstLine) : null,
    faturaSatirlari: lineArr.length > 1 ? lineArr.map(invoiceLineToOzet) : null,
    imzaTaraf: signatoryParty,
    AdditionalDocumentReference: additionalDocRef.length ? additionalDocRef : null,
  };
}

/**
 * DespatchAdvice UBL -> Firebase'e kaydedilecek yapılandırılmış özet
 * (Parsed obje veya UBL XML'den belgeOzet üretmek için dışarıdan kullanılabilir.)
 */
export function despatchToStructuredJson(despatch) {
  if (!despatch) return null;
  const lines = despatch.DespatchLine;
  const lineArr = Array.isArray(lines) ? lines : (lines ? [lines] : []);
  const firstLine = lineArr[0];

  const shipment = despatch.Shipment;
  const delivery = despatch.Delivery;

  return {
    _version: "1.0",
    belgeBilgileri: {
      ID: str(despatch.ID),
      UUID: str(despatch.UUID),
      UBLVersionID: val(despatch.UBLVersionID) != null ? String(val(despatch.UBLVersionID)) : null,
      CustomizationID: str(despatch.CustomizationID),
      ProfileID: str(despatch.ProfileID),
      IssueDate: str(despatch.IssueDate),
      IssueTime: str(despatch.IssueTime),
      DocumentCurrencyCode: str(despatch.DocumentCurrencyCode),
    },
    gonderici: partyToTaraf(despatch.DespatchSupplierParty),
    alici: partyToTaraf(despatch.DeliveryCustomerParty || despatch.DespatchCustomerParty),
    teslimat: delivery ? {
      ActualDeliveryDate: str(delivery.ActualDeliveryDate),
      ActualDeliveryTime: str(delivery.ActualDeliveryTime),
      DeliveryAddress: adres(delivery),
    } : null,
    shipment: shipment ? {
      ID: str(shipment.ID),
      ShippingPriorityLevelCode: str(shipment.ShippingPriorityLevelCode),
      HandlingInstruction: str(shipment.HandlingInstruction),
    } : null,
    irsaliyeSatiri: firstLine ? despatchLineToOzet(firstLine) : null,
    irsaliyeSatirlari: lineArr.length > 1 ? lineArr.map(despatchLineToOzet) : null,
  };
}

/**
 * UBL XML'i parse eder; hiçbir bilgi süzülmez, tüm etiketler JSON'da kalır.
 * Çok büyük Base64 metinleri (imza, ek) yerine [Base64, length=N] yazılır (Firestore 1MB sınırı).
 */
function stripHugeBase64(o, maxLen = 500) {
  if (o == null) return o;
  if (typeof o === "string") {
    if (o.length > maxLen && /^[A-Za-z0-9+/=\s]+$/.test(o.trim().slice(0, 200))) return `[Base64, length=${o.length}]`;
    return o;
  }
  if (Array.isArray(o)) return o.map((x) => stripHugeBase64(x, maxLen));
  if (typeof o === "object") {
    const out = {};
    for (const [k, v] of Object.entries(o)) out[k] = stripHugeBase64(v, maxLen);
    return out;
  }
  return o;
}

/**
 * UBL'deki bilgilerin tamamını JSON'da döndürür (süzme yok, sadece çok büyük Base64 kısaltılır).
 * @param {string} xmlStr - UBL XML
 * @returns {object | null} Tam parse edilmiş obje (Invoice veya DespatchAdvice kökü)
 */
export function ublToFullJson(xmlStr) {
  if (!xmlStr || typeof xmlStr !== "string") return null;
  let obj;
  try {
    obj = parser.parse(xmlStr);
  } catch {
    return null;
  }
  if (!obj?.Invoice && !obj?.DespatchAdvice) return null;
  return stripHugeBase64(obj);
}

/**
 * UBL XML string alır; Invoice veya DespatchAdvice ise yapılandırılmış özet JSON döner.
 * @param {string} xmlStr - UBL XML
 * @returns {{ type: 'invoice'|'despatch', belgeOzet: object } | null}
 */
export function ublToStructuredJson(xmlStr) {
  if (!xmlStr || typeof xmlStr !== "string") return null;
  let obj;
  try {
    obj = parser.parse(xmlStr);
  } catch {
    return null;
  }
  if (obj?.Invoice && !obj?.DespatchAdvice) {
    const belgeOzet = invoiceToStructuredJson(obj.Invoice);
    return belgeOzet ? { type: "invoice", belgeOzet } : null;
  }
  if (obj?.DespatchAdvice) {
    const belgeOzet = despatchToStructuredJson(obj.DespatchAdvice);
    return belgeOzet ? { type: "despatch", belgeOzet } : null;
  }
  return null;
}
