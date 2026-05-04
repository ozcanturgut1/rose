import { XMLParser } from "fast-xml-parser";

export function extractRelatedBelgeNosFromInvoiceUbl(xmlStr) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
  });

  let obj;
  try {
    obj = parser.parse(xmlStr);
  } catch {
    return [];
  }

  // Sadece fatura (Invoice) UBL'inde irsaliye referansı arıyoruz; irsaliye (DespatchAdvice) belgesinde değil
  if (obj?.DespatchAdvice && !obj?.Invoice) return [];

  const invoice = obj?.Invoice || obj;
  if (!invoice) return [];

  const seen = new Set();
  const withDate = [];

  function toStr(v) {
    if (v == null) return "";
    if (typeof v === "string") return v.trim();
    if (typeof v === "object" && v["#text"] != null) return String(v["#text"]).trim();
    return String(v).trim();
  }

  function addRef(idVal, issueDateVal) {
    const s = toStr(idVal);
    if (!s || seen.has(s)) return;
    seen.add(s);
    withDate.push({ id: s, issueDate: toStr(issueDateVal) });
  }

  // 1) UBL: Invoice/cac:DespatchDocumentReference (standart yer; birden fazla olabilir)
  const refs = invoice?.DespatchDocumentReference;
  const arr1 = Array.isArray(refs) ? refs : (refs ? [refs] : []);
  for (const r of arr1) addRef(r?.ID, r?.IssueDate);

  // 2) UBL: Invoice/cac:Delivery/cac:DespatchDocumentReference
  const deliveries = invoice?.Delivery;
  const arrDelivery = Array.isArray(deliveries) ? deliveries : (deliveries ? [deliveries] : []);
  for (const del of arrDelivery) {
    const dRefs = del?.DespatchDocumentReference;
    const dArr = Array.isArray(dRefs) ? dRefs : (dRefs ? [dRefs] : []);
    for (const r of dArr) addRef(r?.ID, r?.IssueDate);
  }

  // 3) AdditionalDocumentReference: DocumentType "irsaliye" veya "despatch" ise ID'yi al
  const add = invoice?.AdditionalDocumentReference;
  const arr2 = Array.isArray(add) ? add : (add ? [add] : []);
  for (const r of arr2) {
    const docType = r?.DocumentType;
    const id = r?.ID;
    if (toStr(id) && typeof docType === "string" && /irsaliye|despatch|waybill/i.test(docType)) {
      addRef(id, r?.IssueDate);
    }
  }

  // En güncel (IssueDate büyük) önce gelsin; böylece asıl irsaliye numarası başta görünsün
  withDate.sort((a, b) => {
    if (!a.issueDate) return 1;
    if (!b.issueDate) return -1;
    return b.issueDate.localeCompare(a.issueDate);
  });

  return withDate.map((x) => x.id);
}

/**
 * Fatura UBL'den irsaliye referanslarını tam döndürür (irsaliye no + tarih).
 * ETTN faturada aranmaz; portaldan belge no + tarih ile çözülür.
 * @param {string} xmlStr - Fatura UBL XML
 * @returns {{ id: string, issueDate: string }[]}
 */
export function extractRelatedDespatchRefsFromInvoiceUbl(xmlStr) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
  });
  let obj;
  try {
    obj = parser.parse(xmlStr);
  } catch {
    return [];
  }
  if (obj?.DespatchAdvice && !obj?.Invoice) return [];
  const invoice = obj?.Invoice || obj;
  if (!invoice) return [];

  function toStr(v) {
    if (v == null) return "";
    if (typeof v === "string") return v.trim();
    if (typeof v === "object" && v["#text"] != null) return String(v["#text"]).trim();
    return String(v).trim();
  }

  const seen = new Set();
  const result = [];

  function add(r) {
    const id = toStr(r?.ID);
    if (!id || seen.has(id)) return;
    seen.add(id);
    result.push({
      id,
      issueDate: toStr(r?.IssueDate) || "",
    });
  }

  const refs = invoice?.DespatchDocumentReference;
  const arr = Array.isArray(refs) ? refs : refs ? [refs] : [];
  for (const r of arr) add(r);
  const deliveries = invoice?.Delivery;
  const arrDel = Array.isArray(deliveries) ? deliveries : deliveries ? [deliveries] : [];
  for (const del of arrDel) {
    const dRefs = del?.DespatchDocumentReference;
    const dArr = Array.isArray(dRefs) ? dRefs : dRefs ? [dRefs] : [];
    for (const r of dArr) add(r);
  }
  const addDocRefs = invoice?.AdditionalDocumentReference;
  const arrAdd = Array.isArray(addDocRefs) ? addDocRefs : addDocRefs ? [addDocRefs] : [];
  for (const r of arrAdd) {
    const docType = r?.DocumentType;
    if (typeof docType === "string" && /irsaliye|despatch|waybill/i.test(docType)) add(r);
  }
  result.sort((a, b) => {
    if (!a.issueDate) return 1;
    if (!b.issueDate) return -1;
    return b.issueDate.localeCompare(a.issueDate);
  });
  return result;
}