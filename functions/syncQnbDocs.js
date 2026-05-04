import { onRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { requireAuth, requireRole } from "./requireAuth.js";
import { callConnector } from "./qnbCall.js";
import { enrichOne, fetchDespatchUblByEttn } from "./enrichInvoiceWithRelatedDespatches.js";

const db = getFirestore();

const setCors = (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

function toYyyyMmDd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDaysYyyyMmDd(str, days) {
  if (!str || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const d = new Date(`${str}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isFromAfterTo(fromStr, toStr) {
  const a = String(fromStr || "").replace(/-/g, "");
  const b = String(toStr || "").replace(/-/g, "");
  if (!/^\d{8}$/.test(a) || !/^\d{8}$/.test(b)) return false;
  return a > b;
}

export const syncQnbDocs = onRequest({ region: "europe-west1" }, async (req, res) => {
  try {
    setCors(req, res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const user = await requireAuth(req);
    await requireRole(user.uid, ["admin", "manager", "accounting"]);

    const stateRef = db.collection("qnb_sync_state").doc("app");

    const vknTckn = process.env.QNB_VKN_TCKN;
    if (!vknTckn) return res.status(500).json({ error: "QNB_VKN_TCKN missing in .env" });

    // Tarih aralığı:
    // - explicit ?from&to verilirse o aralık çalışır
    // - explicit verilmezse cursor (invoiceNextFrom) ile GUNLUK ilerler; her çağrıda 1 gün
    //   (recursive çağrılarla tüm portal faturaları çekilir, tekrar aynı gün istenmez)
    const stateSnap = await stateRef.get();
    const state = stateSnap.exists ? (stateSnap.data() || {}) : {};
    const today = new Date();
    const todayStr = toYyyyMmDd(today);
    const defaultFromStr = "2018-01-01";
    const explicitFrom = req.query.from ? String(req.query.from).slice(0, 10) : null;
    const explicitTo = req.query.to ? String(req.query.to).slice(0, 10) : null;
    const resetInvoiceCursor = String(req.query.resetInvoiceCursor || "").toLowerCase() === "1"
      || String(req.query.resetInvoiceCursor || "").toLowerCase() === "true";
    const hasExplicitRange = explicitFrom != null || explicitTo != null;
    const storedNextFrom = typeof state.invoiceNextFrom === "string" ? state.invoiceNextFrom.slice(0, 10) : null;
    const from = explicitFrom ?? (resetInvoiceCursor ? defaultFromStr : (storedNextFrom ?? defaultFromStr));
    const invoiceChunkDays = Math.min(90, Math.max(1, parseInt(req.query.invoiceChunkDays, 10) || 30));
    const chunkTo = addDaysYyyyMmDd(from, invoiceChunkDays - 1);
    const to = explicitTo ?? (hasExplicitRange ? todayStr : (isFromAfterTo(chunkTo, todayStr) ? todayStr : chunkTo));

    // Fatura için default limit yok (tüm kayıtları al). Query'de limit verilirse uygulanır.
    const invoiceLimitRaw = req.query.limit != null ? parseInt(req.query.limit, 10) : null;
    const invoiceLimit = Number.isFinite(invoiceLimitRaw) && invoiceLimitRaw > 0 ? Math.min(invoiceLimitRaw, 5000) : null;
    const irsaliyeLimit = Math.min(Math.max(1, parseInt(req.query.irsaliyeLimit, 10) || 100), 100);

    // Tarih sıralama anahtarı: YYYYMMDD string (büyük = daha güncel). İrsaliyede geliş tarihi öncelikli (en son gelen en önce).
    const dateSortKey = (it) => {
      const raw =
        it.gelisTarihi ??
        it.gonderimTarihi ??
        it.receivedDate ??
        it.belgeTarihi ??
        it.issueDate ??
        it.IssueDate ??
        it.faturaTarihi ??
        "";
      const t = String(raw).trim();
      if (!t) return "00000000";
      const noSep = t.replace(/-/g, "").replace(/\./g, "").replace(/\//g, "");
      if (/^\d{8}$/.test(noSep)) return noSep;
      if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t.replace(/-/g, "");
      const ddmmyyyy = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
      if (ddmmyyyy) return ddmmyyyy[3] + ddmmyyyy[2].padStart(2, "0") + ddmmyyyy[1].padStart(2, "0");
      return noSep || "00000000";
    };

    function normalizeListItems(listResponse) {
      const items =
        listResponse?.return || listResponse?.["return"] || listResponse?.["return[]"] || [];
      let arr = Array.isArray(items) ? items : [items];
      return arr.slice().sort((a, b) => dateSortKey(b).localeCompare(dateSortKey(a)));
    }

    // --- Fatura: portaldan çek, qnb_invoices'a yaz ---
    let invoiceArr = [];
    let invoiceFetchError = null;
    let invoiceRangeSkipped = false;
    if (!isFromAfterTo(from, to)) {
      try {
        const invoiceListResponse = await callConnector("gelenBelgeTutarBilgileriSorgula", {
          vergiTcKimlikNo: String(vknTckn),
          belgeTuru: "FATURA",
          baslangicGelisTarihi: String(from),
          bitisGelisTarihi: String(to),
        });
        invoiceArr = normalizeListItems(invoiceListResponse);
        if (invoiceLimit != null && invoiceArr.length > 0) invoiceArr = invoiceArr.slice(0, invoiceLimit);
      } catch (e) {
        const errStr = String(e?.message || e);
        invoiceFetchError = errStr;
        // QNB tarafı bazı tarih bloklarında java.lang.NullPointerException dönebiliyor.
        // Bu durumda sync'i kırmayalım; cursor bir sonraki blokla devam etsin.
        if (/NullPointerException|ns2:Server/i.test(errStr) && !hasExplicitRange) {
          invoiceRangeSkipped = true;
          invoiceArr = [];
        } else {
          throw e;
        }
      }
    }

    function invoiceDocIdForKey(it) {
      const belgeNo = it.belgeNo != null && String(it.belgeNo).trim() !== "" ? String(it.belgeNo).trim() : null;
      const externalId = it.ettn || it.ETTN || it.belgeOid || it.belgeNo || it.uuid || it.id;
      const key = belgeNo || (externalId ? String(externalId) : null);
      return key ? `invoice_${key.replace(/[/\\]/g, "_")}` : null;
    }

    const batch = db.batch();

    for (const it of invoiceArr) {
      const externalId = it.ettn || it.ETTN || it.belgeOid || it.belgeNo || it.uuid || it.id;
      if (!externalId) continue;
      const docId = invoiceDocIdForKey(it);
      if (!docId) continue;
      const invoiceRef = db.collection("qnb_invoices").doc(docId);
      const payload = {
        type: "invoice",
        externalId: String(externalId),
        status: "PENDING",
        qnbRaw: it,
        updatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
        qnbBelgeTuru: "FATURA",
      };
      if (it.belgeNo) payload.belgeNo = String(it.belgeNo);
      if (it.ettn || it.ETTN) payload.ettn = String(it.ettn || it.ETTN);
      batch.set(invoiceRef, payload, { merge: true });
    }

    // --- İrsaliye: portaldan çek (birden fazla sayfa), en güncel tarihten başlayarak; en son gelen irsaliyeler en önce. qnb_docs'a yaz. ---
    let despatchArr = [];
    try {
      const pageStarts = [0, 50, 100, 200];
      const seen = new Set();
      for (const start of pageStarts) {
        const irsaliyeListResponse = await callConnector("gelenBelgeleriListeleNew", {
          vergiTcKimlikNo: String(vknTckn),
          sonAlinanBelgeSiraNumarasi: String(start),
          belgeTuru: "IRSALIYE",
        });
        const pageItems = normalizeListItems(irsaliyeListResponse);
        if (pageItems.length === 0 && start > 0) break;
        for (const it of pageItems) {
          const key = it.ettn || it.ETTN || it.belgeNo || it.belgeNoStr || it.irsaliyeNo || it.uuid || it.id;
          if (key && !seen.has(String(key))) {
            seen.add(String(key));
            despatchArr.push(it);
          }
        }
      }
      // En güncel en önce: tarihe göre azalan sıra (gelisTarihi / belgeTarihi), sonra ilk N adet
      despatchArr = despatchArr.slice().sort((a, b) => dateSortKey(b).localeCompare(dateSortKey(a)));
      if (despatchArr.length > 0) despatchArr = despatchArr.slice(0, irsaliyeLimit);
    } catch (e) {
      console.warn("syncQnbDocs irsaliye list failed", e?.message || e);
    }

    function despatchDocIdForKey(it) {
      const belgeNo =
        it.belgeNo ?? it.belgeNoStr ?? it.irsaliyeNo ?? it.belgeNumarasi;
      const hasNo = belgeNo != null && String(belgeNo).trim() !== "";
      const key = hasNo ? String(belgeNo).trim() : (it.ettn || it.ETTN || it.belgeOid || it.uuid || it.id);
      if (!key) return null;
      return `despatch_${String(key).replace(/[/\\]/g, "_")}`;
    }

    for (const it of despatchArr) {
      const docId = despatchDocIdForKey(it);
      if (!docId) continue;
      const externalId = it.ettn || it.ETTN || it.belgeOid || it.belgeNo || it.belgeNoStr || it.irsaliyeNo || it.uuid || it.id;
      const ref = db.collection("qnb_docs").doc(docId);
      const payload = {
        type: "despatch",
        externalId: externalId ? String(externalId) : docId,
        status: "PENDING",
        qnbRaw: it,
        updatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
        qnbBelgeTuru: "IRSALIYE",
      };
      if (it.belgeNo != null) payload.belgeNo = String(it.belgeNo);
      if (it.belgeNoStr != null) payload.belgeNoStr = String(it.belgeNoStr);
      if (it.irsaliyeNo != null) payload.irsaliyeNo = String(it.irsaliyeNo);
      if (it.ettn || it.ETTN) payload.ettn = String(it.ettn || it.ETTN);
      batch.set(ref, payload, { merge: true });
    }

    await batch.commit();

    await stateRef.set(
      {
        lastRunStatus: "OK",
        lastUsedBelgeTuru: "FATURA",
        lastSyncFrom: from,
        lastSyncTo: to,
        invoiceLastFrom: from,
        invoiceLastTo: to,
        ...(resetInvoiceCursor ? { invoiceCursorResetAt: FieldValue.serverTimestamp() } : {}),
        ...(hasExplicitRange ? {} : { invoiceNextFrom: addDaysYyyyMmDd(to, 1) }),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    let enrichedCount = 0;
    const lastSyncedDespatchIds = despatchArr.map((it) => despatchDocIdForKey(it)).filter(Boolean);

    // Fatura: her biri için UBL indir (enrichOne = contentUbl + ublParsed + relatedBelgeNos)
    if (invoiceArr.length > 0) {
      const invoiceDocIds = invoiceArr.map((it) => invoiceDocIdForKey(it)).filter(Boolean);
      const toEnrich = invoiceLimit != null ? invoiceDocIds.slice(0, invoiceLimit) : invoiceDocIds;
      const results = await Promise.allSettled(toEnrich.map((id) => enrichOne(id)));
      enrichedCount = results.filter((r) => r.status === "fulfilled" && r.value).length;
      await stateRef.set(
        {
          lastSyncedInvoiceIds: invoiceDocIds.slice(0, invoiceLimit),
          lastSyncedDespatchIds,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } else {
      await stateRef.set(
        { lastSyncedDespatchIds, updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    }

    // İrsaliye: her biri için UBL indir, contentUbl + ublParsed yaz (tüm detaylarıyla)
    let despatchUblCount = 0;
    const concurrency = 5;
    for (let i = 0; i < despatchArr.length; i += concurrency) {
      const chunk = despatchArr.slice(i, i + concurrency);
      const outcomes = await Promise.allSettled(
        chunk.map(async (it) => {
          const ettn = it.ettn || it.ETTN;
          if (!ettn) return 0;
          const docId = despatchDocIdForKey(it);
          if (!docId) return 0;
          const fetched = await fetchDespatchUblByEttn(vknTckn, String(ettn));
          if (!fetched?.contentUbl) return 0;
          const ref = db.collection("qnb_docs").doc(docId);
          await ref.set(
            {
              contentUbl: fetched.contentUbl,
              ublParsed: fetched.ublParsed || null,
              contentFetchedAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          return 1;
        })
      );
      despatchUblCount += outcomes.filter((r) => r.status === "fulfilled" && r.value === 1).length;
    }

    return res.status(200).json({
      success: true,
      from,
      to,
      hasMoreInvoices: !hasExplicitRange && !isFromAfterTo(addDaysYyyyMmDd(to, 1), todayStr),
      nextInvoiceFrom: !hasExplicitRange ? addDaysYyyyMmDd(to, 1) : null,
      invoice: { fetchedCount: invoiceArr.length, upsertedApprox: invoiceArr.length, withUbl: enrichedCount },
      ...(invoiceRangeSkipped ? { invoiceRangeSkipped: true, invoiceFetchError } : {}),
      despatch: { fetchedCount: despatchArr.length, upsertedApprox: despatchArr.length, withUbl: despatchUblCount },
      enrichedCount,
    });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ error: e.message || "FAILED" });
  }
});
