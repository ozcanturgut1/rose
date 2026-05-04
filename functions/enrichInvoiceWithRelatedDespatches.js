import { onRequest } from "firebase-functions/v2/https";
import { ensureAdmin } from "./adminInit.js";
ensureAdmin();

import { logger } from "firebase-functions";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import AdmZip from "adm-zip";
import { getQnbConnectorClient } from "./qnbSoapClient.js";
import { callConnector } from "./qnbCall.js";
import {
  extractRelatedBelgeNosFromInvoiceUbl,
  extractRelatedDespatchRefsFromInvoiceUbl,
} from "./extractRelatedBelgeNos.js";
import { ublToFullJson } from "./ublToStructuredJson.js";
import { requireAuth, requireRole } from "./requireAuth.js";

const db = getFirestore();

const looksLikeDespatchXml = (s) => /^\s*<\?xml|^\s*<(\w+:)?DespatchAdvice\s|^\s*<DespatchAdvice\s/.test((s || "").slice(0, 2048));

function extractDespatchXmlFromRaw(raw) {
  if (raw == null) return null;
  const str = String(raw);
  if (looksLikeDespatchXml(str)) return str;

  let buf;
  try {
    buf = Buffer.from(str, "base64");
  } catch (_) {
    return null;
  }
  if (!buf || buf.length === 0) return null;

  const asUtf8 = buf.toString("utf-8");
  if (looksLikeDespatchXml(asUtf8)) return asUtf8;

  // gelenBelgeleriIndirExt çoğunlukla base64 ZIP döner; ilk uygun Despatch XML bulunur.
  const isZip = buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b;
  if (!isZip) return null;
  try {
    const zip = new AdmZip(buf);
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    for (const entry of entries) {
      const txt = entry.getData().toString("utf-8");
      if (looksLikeDespatchXml(txt)) return txt;
    }
  } catch (_) {}
  return null;
}

/** Firestore qnb_docs irsaliye dokümanından ETTN (UUID formatı); belge no externalId sayılmaz. */
function ettnFromQnbDocsData(d) {
  if (!d || typeof d !== "object") return null;
  const raw = d.ettn ?? d.qnbRaw?.ettn ?? d.qnbRaw?.ETTN;
  const t = raw ? String(raw).trim() : "";
  if (t && /^[0-9A-Fa-f-]{30,}$/.test(t)) return t;
  const ext = d.externalId != null ? String(d.externalId).trim() : "";
  if (ext && /^[0-9A-Fa-f-]{30,}$/.test(ext)) return ext;
  return null;
}

/**
 * qnb_docs/despatch_<belgeNo> içinde kayıtlı ETTN (syncAllDespatches / manuel kayıt).
 * @param {string} belgeNo
 * @returns {Promise<string|null>}
 */
export async function readEttnFromQnbDocsForDespatch(belgeNo) {
  const safe = String(belgeNo).replace(/[/\\]/g, "_");
  const snap = await db.collection("qnb_docs").doc(`despatch_${safe}`).get();
  if (!snap.exists) return null;
  return ettnFromQnbDocsData(snap.data() || {});
}

function normalizeListItems(resp) {
  if (!resp) return [];
  let raw = resp.return ?? resp.belgeListesi ?? resp.list ?? resp;
  if (raw?.belgeListesi) raw = raw.belgeListesi;
  if (raw?.belge) raw = Array.isArray(raw.belge) ? raw.belge : [raw.belge];
  if (raw?.item) raw = Array.isArray(raw.item) ? raw.item : [raw.item];
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.length !== undefined) return Array.from(raw);
  if (raw && typeof raw === "object" && Object.keys(raw).length) {
    const vals = Object.values(raw);
    if (vals.every((v) => v && typeof v === "object")) return vals;
  }
  return [];
}

function itemBelgeNo(it) {
  const v = it?.belgeNo ?? it?.belgeNoStr ?? it?.belgeNumarasi ?? it?.irsaliyeNo ?? it?.ID ?? it?.id;
  if (v == null) return null;
  return typeof v === "string" ? v.trim() : String(v).trim();
}

function itemEttn(it) {
  return it?.ettn ?? it?.ETTN ?? it?.uuid ?? it?.UUID ?? it?.belgeOid ?? it?.externalId ?? it?.id;
}

/** Boşluk/nokta/tire kaldırarak belge no karşılaştırması (portal "BRS 2026 000000074" dönebilir) */
function belgeNoKey(s) {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[.-]/g, "")
    .toUpperCase();
}

function addDaysYyyyMmDd(str, days) {
  if (!str || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const d = new Date(`${str}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** DespatchDocumentReference IssueDate → YYYY-MM-DD */
function parseDespatchIssueDate(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

function yyyyMmDdCompactFromYmd(ymd) {
  if (!ymd || typeof ymd !== "string") return null;
  const t = ymd.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return t.replace(/-/g, "");
}

/**
 * Üçüncü argüman: { issueDate } veya { from, to } (fetchAndSaveDespatch ile uyumlu).
 * issueDate: irsaliye tarihi; portala geliş gecikmesi için ± gün penceresi.
 */
function resolveListDateRange(opts) {
  if (!opts || typeof opts !== "object") return null;
  const from = opts.from != null ? String(opts.from).trim().slice(0, 10) : "";
  const to = opts.to != null ? String(opts.to).trim().slice(0, 10) : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { from, to };
  }
  const id = parseDespatchIssueDate(opts.issueDate);
  if (id) {
    return { from: addDaysYyyyMmDd(id, -14), to: addDaysYyyyMmDd(id, 30) };
  }
  return null;
}

/** gelenBelgeleriListeleExt + IRSALIYE + tarih (geliş veya fatura tarihi) */
async function listIrsaliyeGelenBelgeleriExt(vknTckn, fromYmd, toYmd) {
  const gb = yyyyMmDdCompactFromYmd(fromYmd);
  const bt = yyyyMmDdCompactFromYmd(toYmd);
  if (!gb || !bt) return [];
  const base = {
    vergiTcKimlikNo: String(vknTckn),
    belgeTuru: "IRSALIYE",
    sonAlinanBelgeSiraNumarasi: "0",
    donusTipiVersiyon: "6.0",
    onayDurum: "HEPSI",
  };
  const variants = [
    { ...base, gelisTarihiBaslangic: gb, gelisTarihiBitis: bt },
    { ...base, faturaTarihiBaslangic: gb, faturaTarihiBitis: bt },
  ];
  for (const parametreler of variants) {
    try {
      let listResp;
      try {
        listResp = await callConnector("gelenBelgeleriListeleExt", { parametreler });
      } catch (_) {
        listResp = await callConnector("gelenBelgeleriListeleExt", parametreler);
      }
      const pageItems = normalizeListItems(listResp);
      if (pageItems.length) {
        logger.info("listIrsaliyeGelenBelgeleriExt hit", {
          count: pageItems.length,
          gelis: !!parametreler.gelisTarihiBaslangic,
        });
        return pageItems;
      }
    } catch (e) {
      logger.warn("listIrsaliyeGelenBelgeleriExt variant failed", { err: String(e?.message || e) });
    }
  }
  return [];
}

/**
 * ETTN ile doğrudan irsaliye UBL indirir (liste API'si gerekmez). Fatura gibi tek adım.
 * @param {string} vknTckn
 * @param {string} ettn
 * @returns {{ contentUbl: string, ublParsed: object } | null}
 */
export async function fetchDespatchUblByEttn(vknTckn, ettn) {
  if (!ettn || !vknTckn) return null;
  // 1) Öncelik: gelenBelgeleriIndirExt (QNB portalında daha uyumlu yol).
  try {
    const indirExtResp = await callConnector("gelenBelgeleriIndirExt", {
      parametreler: {
        vergiTcKimlikNo: String(vknTckn),
        belgeTuru: "IRSALIYE",
        belgeFormati: "UBL",
        donusTipiVersiyon: "6.0",
        ettn: [String(ettn)],
      },
    });
    const xmlFromExt = extractDespatchXmlFromRaw(indirExtResp?.return);
    if (xmlFromExt) {
      const ublParsed = ublToFullJson(xmlFromExt);
      return { contentUbl: xmlFromExt, ublParsed: ublParsed ?? {} };
    }
  } catch (e) {
    logger.warn("fetchDespatchUblByEttn ext path failed", {
      ettn: String(ettn).slice(0, 12),
      error: String(e?.message || e),
    });
  }

  // 2) Fallback: gelenIrsaliyeIndir
  let raw;
  try {
    const indirResp = await callConnector("gelenIrsaliyeIndir", {
      arg0: String(vknTckn),
      arg1: String(ettn),
      arg2: "UBL",
    });
    raw = indirResp?.return ?? indirResp?.belgeIcerik ?? indirResp?.belge ?? indirResp?.content ?? indirResp;
  } catch (e) {
    const errMsg = String(e?.message || e);
    if (/not found|Connector op/.test(errMsg)) {
      try {
        const client = await getQnbConnectorClient();
        const fn = client.gelenIrsaliyeIndirAsync ?? client.gelenIrsaliyeIndir;
        if (typeof fn === "function") {
          const [resp] = await fn.call(client, { arg0: String(vknTckn), arg1: String(ettn), arg2: "UBL" });
          raw = resp?.return ?? resp?.belgeIcerik ?? resp?.belge ?? resp?.content ?? resp;
        }
      } catch (_) {}
    }
    if (!raw) {
      logger.warn("fetchDespatchUblByEttn failed", { ettn: String(ettn).slice(0, 12), error: errMsg });
      return null;
    }
  }
  if (!raw) return null;
  const xml = extractDespatchXmlFromRaw(raw);
  if (!xml || !looksLikeDespatchXml(xml)) return null;
  const ublParsed = ublToFullJson(xml);
  return { contentUbl: xml, ublParsed: ublParsed ?? {} };
}

/**
 * syncAllDespatches / fetchAndSaveDespatchByBelgeNo ile doldurulan qnb_docs önbelleği.
 * @param {string} belgeNo
 * @returns {Promise<{ contentUbl: string, ublParsed: object } | null>}
 */
export async function readDespatchFromQnbDocs(belgeNo) {
  const safe = String(belgeNo).replace(/[/\\]/g, "_");
  const snap = await db.collection("qnb_docs").doc(`despatch_${safe}`).get();
  if (!snap.exists) return null;
  const d = snap.data() || {};
  const xml = d.contentUbl;
  if (!xml || typeof xml !== "string" || !looksLikeDespatchXml(xml)) return null;
  let ublParsed =
    d.ublParsed && typeof d.ublParsed === "object" && Object.keys(d.ublParsed).length > 0
      ? d.ublParsed
      : null;
  if (!ublParsed) {
    try {
      ublParsed = ublToFullJson(xml) ?? {};
    } catch (_) {
      ublParsed = {};
    }
  }
  return { contentUbl: xml, ublParsed };
}

/**
 * İrsaliye UBL: önce qnb_docs (UBL veya yalnızca ETTN), yoksa portaldan belge no + tarih.
 * @param {string} vknTckn
 * @param {string} belgeNo
 * @param {{ from?: string, to?: string, issueDate?: string }} [opts]
 * @returns {Promise<{ contentUbl: string, ublParsed: object } | { errorCode: string, errorDetail?: string } | null>}
 */
export async function resolveDespatchUblHybrid(vknTckn, belgeNo, opts) {
  const fromDoc = await readDespatchFromQnbDocs(belgeNo);
  if (fromDoc?.contentUbl) {
    logger.info("irsaliye UBL kaynağı=qnb_docs (contentUbl)", { belgeNo: String(belgeNo).slice(0, 32) });
    return fromDoc;
  }
  if (vknTckn) {
    const safe = String(belgeNo).replace(/[/\\]/g, "_");
    const snap = await db.collection("qnb_docs").doc(`despatch_${safe}`).get();
    if (snap.exists) {
      const d = snap.data() || {};
      const raw = d.ettn ?? d.qnbRaw?.ettn ?? d.qnbRaw?.ETTN;
      const t = raw ? String(raw).trim() : "";
      if (t && /^[0-9A-Fa-f-]{30,}$/.test(t)) {
        const byEttn = await fetchDespatchUblByEttn(vknTckn, t);
        if (byEttn?.contentUbl) {
          logger.info("irsaliye UBL kaynağı=qnb_docs ETTN+gelenIrsaliyeIndir", {
            belgeNo: String(belgeNo).slice(0, 32),
          });
          return byEttn;
        }
      }
    }
  }
  if (!vknTckn) return null;
  return await fetchDespatchUblByBelgeNo(vknTckn, belgeNo, opts);
}

/**
 * Fatura ile ilişkili irsaliye için portal yolu: belge no + (varsa) irsaliye tarihi ile liste → ETTN → UBL indir.
 * Önce (varsa) irsaliye tarihi / tarih aralığı ile `gelenBelgeleriListeleExt` dener;
 * sonra `gelenBelgeleriListeleNew` sayfaları.
 * @param {string} vknTckn
 * @param {string} belgeNo
 * @param {{ from?: string, to?: string, issueDate?: string }} [opts] - issueDate: fatura UBL'deki irsaliye IssueDate
 * @returns {{ contentUbl: string, ublParsed: object } | { errorCode: string, errorDetail?: string } | null}
 */
export async function fetchDespatchUblByBelgeNo(vknTckn, belgeNo, opts) {
  const want = belgeNoKey(belgeNo);
  let items = [];
  let item = null;
  let listError = null;

  const range = resolveListDateRange(opts);
  if (range) {
    try {
      const extItems = await listIrsaliyeGelenBelgeleriExt(vknTckn, range.from, range.to);
      item = extItems.find((it) => belgeNoKey(itemBelgeNo(it)) === want);
      if (item) {
        items = extItems;
        logger.info("fetchDespatchUblByBelgeNo: eşleşme (gelenBelgeleriListeleExt)", {
          belgeNo,
          from: range.from,
          to: range.to,
        });
      }
    } catch (e) {
      logger.warn("fetchDespatchUblByBelgeNo Ext list error", { belgeNo, err: String(e?.message || e) });
    }
  }

  // Kuyruk listesi (tarih filtresi yok); sayfa başları — eski irsaliyeler için geniş aralık
  const pageStarts = [0, 50, 100, 200, 400, 800, 1200];
  if (!item) {
    for (const start of pageStarts) {
      try {
        const listResp = await callConnector("gelenBelgeleriListeleNew", {
          vergiTcKimlikNo: vknTckn,
          sonAlinanBelgeSiraNumarasi: String(start),
          belgeTuru: "IRSALIYE",
        });
        const pageItems = normalizeListItems(listResp);
        if (pageItems.length === 0 && start > 0) break;
        const seen = new Set(items.map((it) => itemEttn(it) || itemBelgeNo(it)));
        for (const it of pageItems) {
          const key = itemEttn(it) || itemBelgeNo(it);
          if (key && !seen.has(key)) {
            seen.add(key);
            items.push(it);
          }
        }
        item = items.find((it) => belgeNoKey(itemBelgeNo(it)) === want);
        if (item) break;
        if (pageItems.length === 0) break;
      } catch (e) {
        if (start === 0) listError = String(e?.message || e);
        logger.warn("enrich irsaliye list (BelgeleriListeleNew) failed", { belgeNo, start, error: String(e?.message || e) });
      }
    }
    if (!item) item = items.find((it) => belgeNoKey(itemBelgeNo(it)) === want);
  }
  logger.info("enrich irsaliye list toplam aday", { belgeNo, count: items.length, matched: !!item });

  if (!item) {
    logger.warn("enrich irsaliye item not found in list", { belgeNo, want });
    if (listError) {
      return { errorCode: "LIST_QUERY_FAILED", errorDetail: listError };
    }
    return {
      errorCode: "ITEM_NOT_IN_LIST",
      errorDetail: `Listede bu irsaliye numarası bulunamadı (${belgeNo}). Portaldaki "yeni gelen belgeler" listesinde yok; irsaliye faturaya bağlıysa fatura detayından "İlgili irsaliyeler" ile açmayı deneyin.`,
    };
  }

  const ettn = itemEttn(item);
  if (!ettn) {
    logger.warn("enrich irsaliye ettn missing", { belgeNo });
    return { errorCode: "ETTN_MISSING", errorDetail: "Listede ETTN/UUID yok" };
  }

  let raw;
  try {
    const indirResp = await callConnector("gelenIrsaliyeIndir", {
      arg0: vknTckn,
      arg1: String(ettn),
      arg2: "UBL",
    });
    raw = indirResp?.return ?? indirResp?.belgeIcerik ?? indirResp?.belge ?? indirResp?.content ?? indirResp;
  } catch (e) {
    const errMsg = String(e?.message || e);
    if (/not found|Connector op/.test(errMsg)) {
      try {
        const client = await getQnbConnectorClient();
        const fn = client.gelenIrsaliyeIndirAsync ?? client.gelenIrsaliyeIndir;
        if (typeof fn === "function") {
          const [resp] = await fn.call(client, { arg0: vknTckn, arg1: String(ettn), arg2: "UBL" });
          raw = resp?.return ?? resp?.belgeIcerik ?? resp?.belge ?? resp?.content ?? resp;
        }
      } catch (e2) {
        logger.warn("enrich irsaliye indir (client fallback) failed", { belgeNo, error: String(e2?.message || e2) });
      }
    }
    if (!raw) {
      logger.warn("enrich irsaliye indir failed", { belgeNo, ettn: String(ettn).slice(0, 8), error: errMsg });
      return { errorCode: "INDIR_FAILED", errorDetail: errMsg };
    }
  }

  if (!raw) {
    logger.warn("enrich irsaliye indir empty response", { belgeNo });
    return { errorCode: "INDIR_EMPTY", errorDetail: "Portal indirme cevabı boş" };
  }

  const xml = typeof raw === "string"
    ? (raw.startsWith("<?xml") || raw.trimStart().startsWith("<") ? raw : Buffer.from(raw, "base64").toString("utf-8"))
    : Buffer.from(String(raw), "base64").toString("utf-8");
  if (!xml || !looksLikeDespatchXml(xml)) {
    logger.warn("enrich irsaliye content not DespatchAdvice XML", { belgeNo, peek: (xml || "").slice(0, 80) });
    return { errorCode: "CONTENT_INVALID", errorDetail: "İndirilen içerik irsaliye UBL değil" };
  }
  const ublParsed = ublToFullJson(xml);
  return { contentUbl: xml, ublParsed: ublParsed ?? {} };
}

const setCors = (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

/** Tek fatura doc için UBL'den irsaliye referanslarını çıkarıp doc'a yazar. Sync'ten veya batch'ten çağrılabilir. */
export async function enrichOne(docId) {
  const invRef = db.collection("qnb_invoices").doc(docId);
  const invSnap = await invRef.get();
  if (!invSnap.exists) return false;
  const data = invSnap.data();
  if (data.type !== "invoice") return false;

  let fullXmlStr = null;
  const looksLikeXml = (s) => /^\s*<\?xml|^\s*<(\w+:)?Invoice\s|^\s*<Invoice\s/.test((s || "").slice(0, 4096));

  // 1) Dokümanda zaten UBL varsa (contentUbl veya önceki indirme) onu kullan
  if (data.contentUbl && typeof data.contentUbl === "string" && looksLikeXml(data.contentUbl)) {
    fullXmlStr = data.contentUbl;
  }

  // 2) Yoksa portaldan indir. gelenFaturaIndir 3. argüman = çıktı formatı (UBL/PDF/HTML), belge türü değil
  //    (viewQnbDoc.js / onQnbDocCreated.js ile aynı sözleşme)
  if (!fullXmlStr) {
    const vknTckn = process.env.QNB_VKN_TCKN;
    if (!vknTckn) return false;
    const client = await getQnbConnectorClient();
    const idForDownload = data.ettn || data.externalId;
    if (!idForDownload) return false;
    const vkn = String(vknTckn);
    const extId = String(idForDownload);
    const formats = ["UBL", "PDF", "HTML"];
    const candidates = [];
    for (const fmt of formats) {
      candidates.push([vkn, extId, fmt]);
      candidates.push([extId, vkn, fmt]);
      candidates.push([vkn, fmt, extId]);
      candidates.push([extId, fmt, vkn]);
    }
    for (const args of candidates) {
      try {
        const [resp] = await client.gelenFaturaIndirAsync({
          arg0: args[0],
          arg1: args[1],
          arg2: args[2],
        });
        const ret = resp?.return ?? resp;
        if (!ret) continue;
        const buf = Buffer.from(ret, "base64");
        const decoded = buf.toString("utf8");
        if (looksLikeXml(decoded)) {
          fullXmlStr = decoded;
          break;
        }
      } catch (_) {}
    }
    if (!fullXmlStr) return false;
  }

  const extractedIds = extractRelatedBelgeNosFromInvoiceUbl(fullXmlStr);
  const fromUbl = extractedIds.map((x) => String(x).trim()).filter(Boolean);
  const relatedBelgeNosFromUbl = fromUbl.length ? fromUbl : undefined;

  const ublKeyValue = ublToFullJson(fullXmlStr);
  // Fatura numarası sadece UBL'deki Invoice/ID'den; list cevabına güvenilmez
  let belgeNoFromUbl = null;
  const toStr = (v) => {
    if (v == null) return null;
    if (typeof v === "string") return v.trim() || null;
    if (typeof v === "object" && v["#text"] != null) return String(v["#text"]).trim() || null;
    return String(v).trim() || null;
  };
  if (ublKeyValue?.Invoice) {
    const idVal = ublKeyValue.Invoice.ID;
    if (idVal != null) {
      const s = toStr(idVal);
      if (s) belgeNoFromUbl = s;
    }
  }

  const update = {
    relatedBelgeNos: fromUbl,
    ...(relatedBelgeNosFromUbl != null && { relatedBelgeNosFromUbl }),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (fullXmlStr) update.contentUbl = fullXmlStr;
  if (ublKeyValue) update.ublParsed = ublKeyValue;
  if (belgeNoFromUbl) update.belgeNo = belgeNoFromUbl;
  await invRef.set(update, { merge: true });

  const vknTckn = process.env.QNB_VKN_TCKN;

  const relatedDespatchEttns = [];

  // İrsaliye: faturadan numara + tarih; önce qnb_docs (günlük syncAllDespatches), yoksa portal.
  const despatchCol = invRef.collection("despatches");
  const despatchRefs = extractRelatedDespatchRefsFromInvoiceUbl(fullXmlStr);
  const batch = db.batch();
  let batchOpCount = 0;
  const existingDespatches = await despatchCol.get();
  existingDespatches.docs.forEach((d) => {
    batch.delete(d.ref);
    batchOpCount++;
  });
  for (const dr of despatchRefs) {
    const belgeNo = String(dr.id || "").trim();
    if (!belgeNo) continue;
    const issueDateRaw = dr.issueDate && String(dr.issueDate).trim() !== "" ? String(dr.issueDate).trim() : null;
    let ettn = null;
    const despatchDocId = String(belgeNo).replace(/[/\\]/g, "_");
    const payload = {
      invoiceId: docId,
      belgeNo,
      issueDate: issueDateRaw,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    };
    const ettnFromQnbStore = await readEttnFromQnbDocsForDespatch(belgeNo);
    try {
      const irsaliyeTarihOpts = issueDateRaw ? { issueDate: issueDateRaw } : {};
      const despatchUbl = await resolveDespatchUblHybrid(vknTckn || null, belgeNo, irsaliyeTarihOpts);
      if (despatchUbl?.contentUbl) {
        payload.contentUbl = despatchUbl.contentUbl;
        if (despatchUbl?.ublParsed && Object.keys(despatchUbl.ublParsed).length) payload.ublParsed = despatchUbl.ublParsed;
        const da = despatchUbl.ublParsed?.DespatchAdvice;
        const rawUuid = da?.UUID ?? da?.Uuid ?? da?.uuid;
        const ettnFromFetched =
          rawUuid != null ? String(typeof rawUuid === "object" && rawUuid["#text"] != null ? rawUuid["#text"] : rawUuid).trim() : "";
        if (ettnFromFetched && /^[0-9A-Fa-f-]{30,}$/.test(ettnFromFetched)) {
          payload.ettn = ettnFromFetched;
          ettn = ettnFromFetched;
        }
      }
    } catch (_) { /* irsaliye UBL yoksa sadece ref alanları yazılır */ }
    // UBL'den UUID çıkmadıysa qnb_docs'taki ettn/externalId (UUID) despatches'e yazılsın
    if (!payload.ettn && ettnFromQnbStore) {
      payload.ettn = ettnFromQnbStore;
      ettn = ettnFromQnbStore;
    }
    relatedDespatchEttns.push({ belgeNo, ettn: payload.ettn || ettn || null });
    batch.set(despatchCol.doc(despatchDocId), payload, { merge: true });
    batchOpCount++;
  }
  if (batchOpCount > 0) {
    await batch.commit();
  }

  if (relatedDespatchEttns.length > 0) {
    await invRef.set(
      { relatedDespatchEttns, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  }

  return { extractedIds, relatedBelgeNos: fromUbl };
}

/**
 * Fatura belgesini indirir; içerik XML ise UBL'den irsaliye referanslarını çıkarıp
 * invoice doc'a relatedDespatchIds, relatedBelgeNos, relatedDespatches yazar.
 * ?batch=1&limit=10 ile irsaliye bilgisi olmayan faturaları toplu zenginleştirir.
 * Tek doc denemesi: ?testDoc=invoice_XXX veya ?docId=invoice_XXX (GET/POST).
 */
export const enrichInvoiceWithRelatedDespatches = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    try {
      setCors(req, res);
      if (req.method === "OPTIONS") return res.status(204).send("");
      if (req.method !== "POST" && req.method !== "GET") return res.status(405).send("Method Not Allowed");

      const user = await requireAuth(req);
      await requireRole(user.uid, ["admin", "manager", "accounting"]);

      // Tek doc denemesi: ?testDoc=invoice_XXX veya ?docId=invoice_XXX
      let docId = req.query?.docId || req.body?.docId;
      if (!docId && req.query?.testDoc) docId = String(req.query.testDoc).trim();
      const batch = req.query?.batch === "1" || req.query?.batch === "true";
      const batchLimit = Math.min(Number(req.query?.limit) || 20, 50);

      // Default year: current UTC year. Used by batch mode when year is not provided.
      const yearParam = req.query?.year ? String(req.query.year).slice(0, 4) : "";
      const currentYear = String(new Date().getUTCFullYear());
      const year = /^\d{4}$/.test(yearParam) ? yearParam : currentYear;

      if (batch) {
        const parseInvoiceYear = (data) => {
          // 1) Prefer UBL IssueDate if present
          const issueDate = data?.ublParsed?.Invoice?.IssueDate;
          if (typeof issueDate === "string" && issueDate.length >= 4) {
            const y = issueDate.slice(0, 4);
            if (/^\d{4}$/.test(y)) return y;
          }
          // 2) Fallback: QNB raw belgeTarihi (commonly YYYYMMDD)
          const bt = data?.qnbRaw?.belgeTarihi ?? data?.qnbRaw?.BelgeTarihi;
          if (bt != null) {
            const s = String(bt).trim();
            if (/^\d{8}$/.test(s)) return s.slice(0, 4);
            if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(0, 4);
          }
          return null;
        };

        // Batch enrich should target the actual invoices collection
        const snap = await db
          .collection("qnb_invoices")
          .orderBy("updatedAt", "desc")
          .limit(500)
          .get();

        const toEnrich = snap.docs
          .filter((d) => {
            const data = d.data() || {};
            if (String(data.type) !== "invoice") return false;

            // Only selected year (invoice date)
            const y = parseInvoiceYear(data);
            if (y && y !== year) return false;
            // If we cannot determine year yet (no ublParsed and no belgeTarihi), skip to avoid cross-year noise
            if (!y) return false;

            const hasRelated = Array.isArray(data.relatedBelgeNos) && data.relatedBelgeNos.length > 0;
            const hasUbl = typeof data.contentUbl === "string" && data.contentUbl.trim().length > 0;
            return !(hasRelated && hasUbl);
          })
          .slice(0, batchLimit)
          .map((d) => d.id);
        let enriched = 0;
        for (const id of toEnrich) {
          try {
            if (await enrichOne(id)) enriched++;
          } catch (_) { /* skip */ }
        }
        return res.status(200).json({ success: true, year, enriched, processed: toEnrich.length });
      }

      if (!docId || !String(docId).startsWith("invoice_")) {
        return res.status(400).json({ error: "docId is required and must be an invoice doc id (invoice_...)" });
      }

      const result = await enrichOne(docId);
      if (!result) return res.status(502).json({ error: "Could not download invoice content" });
      return res.status(200).json({
        success: true,
        docId,
        fromUbl: result.extractedIds,
        relatedBelgeNos: result.relatedBelgeNos,
      });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  }
);
