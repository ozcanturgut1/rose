import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { ensureAdmin } from "./adminInit.js";
ensureAdmin();

import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { requireAuth, requireRole, ROLES_QNB_MUTATE } from "./requireAuth.js";
import { callConnector } from "./qnbCall.js";
import { enrichOne } from "./enrichInvoiceWithRelatedDespatches.js";

const db = getFirestore();

const setCors = (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

function normalizeListItems(resp) {
  const items = resp?.return || resp?.["return"] || resp?.["return[]"] || [];
  const arr = Array.isArray(items) ? items : [items];
  return arr.filter((x) => x != null && typeof x === "object");
}

function yyyyMmDdCompactFromYmd(ymdHyphen) {
  const t = String(ymdHyphen).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return t.replace(/-/g, "");
}

function toYyyyMmDd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Tek gün aralığında portal bitişini ertesi güne genişletmek için. */
function addOneCalendarDayYmd(ymdHyphen) {
  const t = String(ymdHyphen).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const [y, m, d] = t.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + 1);
  return toYyyyMmDd(dt);
}

function gelisYyyyMmDdFromAnyItem(it) {
  const raw =
    it.faturaGelisTarihi ??
    it.gelisTarihi ??
    it.gonderimTarihi ??
    it.receivedDate ??
    it.belgeTarihi ??
    it.issueDate ??
    it.IssueDate ??
    it.faturaTarihi ??
    "";
  const t = String(raw).trim();
  if (!t) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const noSep = t.replace(/-/g, "").replace(/\./g, "").replace(/\//g, "");
  if (/^\d{8}$/.test(noSep)) {
    return `${noSep.slice(0, 4)}-${noSep.slice(4, 6)}-${noSep.slice(6, 8)}`;
  }
  if (/^\d{14,}$/.test(noSep)) {
    return `${noSep.slice(0, 4)}-${noSep.slice(4, 6)}-${noSep.slice(6, 8)}`;
  }
  const ddmmyyyy = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (ddmmyyyy) {
    const y = ddmmyyyy[3];
    const mo = ddmmyyyy[2].padStart(2, "0");
    const da = ddmmyyyy[1].padStart(2, "0");
    return `${y}-${mo}-${da}`;
  }
  return null;
}

function filterItemsToSingleGelisDay(items, ymd) {
  const filtered = items.filter((it) => {
    const g = gelisYyyyMmDdFromAnyItem(it);
    return g != null && g === ymd;
  });
  if (filtered.length > 0) return filtered;
  if (items.length === 0) return filtered;
  const anyParsed = items.some((it) => gelisYyyyMmDdFromAnyItem(it) != null);
  if (!anyParsed) return items;
  return filtered;
}

function gelisSortKey(it) {
  const raw =
    it.faturaGelisTarihi ??
    it.gelisTarihi ??
    it.gonderimTarihi ??
    it.belgeTarihi ??
    it.issueDate ??
    it.IssueDate ??
    "";
  const t = String(raw).trim();
  if (!t) return "0";
  return t.replace(/\D/g, "") || "0";
}

const dateSortKeyTutar = (it) => {
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

function buildParametrelerExtDates(vknTckn, start, baslangicYmd, bitisYmd) {
  return {
    vergiTcKimlikNo: String(vknTckn),
    belgeTuru: "FATURA",
    sonAlinanBelgeSiraNumarasi: String(start),
    donusTipiVersiyon: "6.0",
    gelisTarihiBaslangic: yyyyMmDdCompactFromYmd(baslangicYmd),
    gelisTarihiBitis: yyyyMmDdCompactFromYmd(bitisYmd),
    onayDurum: "HEPSI",
  };
}

async function callGelenBelgeleriListeleExtParam(p, useParametrelerWrapper) {
  if (useParametrelerWrapper) {
    return await callConnector("gelenBelgeleriListeleExt", { parametreler: p });
  }
  return await callConnector("gelenBelgeleriListeleExt", p);
}

/**
 * listGelenBelgeleriExt ile aynı mantık: önce gelenBelgeTutarBilgileriSorgula;
 * boş veya bilinen portal hatalarında gelenBelgeleriListeleExt (geliş tarihi aralığı).
 */
async function listInvoicesForGelisRange(vknTckn, from, to, limit) {
  const singleDayYmd = from === to ? from : null;
  const apiFrom = from;
  const apiTo = singleDayYmd != null ? addOneCalendarDayYmd(from) : to;
  let items = [];
  let source = "gelenBelgeTutarBilgileriSorgula";

  try {
    const listResp = await callConnector("gelenBelgeTutarBilgileriSorgula", {
      vergiTcKimlikNo: String(vknTckn),
      belgeTuru: "FATURA",
      baslangicGelisTarihi: apiFrom,
      bitisGelisTarihi: apiTo,
    });
    items = normalizeListItems(listResp);
    items = items.slice().sort((a, b) => dateSortKeyTutar(b).localeCompare(dateSortKeyTutar(a)));
    if (singleDayYmd != null) {
      items = filterItemsToSingleGelisDay(items, singleDayYmd);
    }
  } catch (e) {
    logger.warn("backfill: gelenBelgeTutarBilgileriSorgula failed (Ext denenecek)", {
      from,
      to,
      err: String(e?.message || e).slice(0, 400),
    });
    items = [];
  }

  if (items.length === 0) {
    try {
      let listResp;
      try {
        const p = buildParametrelerExtDates(vknTckn, 0, apiFrom, apiTo);
        listResp = await callGelenBelgeleriListeleExtParam(p, true);
      } catch (e1) {
        const p = buildParametrelerExtDates(vknTckn, 0, apiFrom, apiTo);
        listResp = await callGelenBelgeleriListeleExtParam(p, false);
      }
      let arr = normalizeListItems(listResp);
      arr = arr.slice().sort((a, b) => gelisSortKey(b).localeCompare(gelisSortKey(a)));
      if (singleDayYmd != null) {
        arr = filterItemsToSingleGelisDay(arr, singleDayYmd);
      }
      items = arr;
      source = "gelenBelgeleriListeleExt";
    } catch (e) {
      logger.warn("backfill: Ext range fallback failed", { err: String(e?.message || e).slice(0, 400) });
      items = [];
      source = "none";
    }
  }

  if (items.length > limit) items = items.slice(0, limit);
  return { items, source };
}

function invoiceDocIdForKey(it) {
  const belgeNo =
    it.belgeNo != null && String(it.belgeNo).trim() !== ""
      ? String(it.belgeNo).trim()
      : null;
  const externalId =
    it.ettn || it.ETTN || it.belgeOid || it.belgeNo || it.uuid || it.id;
  const key = belgeNo || (externalId ? String(externalId) : null);
  return key ? `invoice_${key.replace(/[/\\]/g, "_")}` : null;
}

/** @returns {string|null} YYYY-MM-DD veya geçersizse null */
function parseDateParamStrict(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) {
    const day = m[1].padStart(2, "0");
    const mon = m[2].padStart(2, "0");
    const year = m[3];
    return `${year}-${mon}-${day}`;
  }
  return null;
}

/**
 * Flutter: `docIds=NO1,NO2` (virgülle ayrılmış belge no veya `invoice_*` doc id soneki).
 * Boş veya yoksa filtre uygulanmaz (tüm liste).
 * @returns {Set<string>|null}
 */
function parseDocIdsFilter(q) {
  const raw = q.docIds;
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (!s) return null;
  const parts = s
    .split(",")
    .map((x) => String(x).trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const set = new Set();
  for (let p of parts) {
    if (p.toLowerCase().startsWith("invoice_")) {
      p = p.slice("invoice_".length);
    }
    set.add(p);
  }
  return set.size > 0 ? set : null;
}

/** @param {Set<string>|null} filterSet */
function itemMatchesDocIdFilter(it, filterSet) {
  if (!filterSet || filterSet.size === 0) return true;
  const bn = it.belgeNo != null ? String(it.belgeNo).trim() : "";
  if (bn && filterSet.has(bn)) return true;
  const ettn = String(it.ettn || it.ETTN || "").trim();
  if (ettn && filterSet.has(ettn)) return true;
  const docId = invoiceDocIdForKey(it);
  if (docId) {
    const suffix = docId.replace(/^invoice_/, "");
    if (filterSet.has(suffix)) return true;
  }
  return false;
}

export const backfillInvoicesFullByDateRange = onRequest(
  { region: "europe-west1", timeoutSeconds: 300 },
  async (req, res) => {
    try {
      setCors(req, res);
      if (req.method === "OPTIONS") return res.status(204).send("");
      if (req.method !== "GET" && req.method !== "POST") {
        return res.status(405).send("Method Not Allowed");
      }

      const user = await requireAuth(req);
      await requireRole(user.uid, ROLES_QNB_MUTATE);

      const vknTckn = process.env.QNB_VKN_TCKN;
      if (!vknTckn) {
        return res
          .status(500)
          .json({ error: "QNB_VKN_TCKN missing in .env" });
      }

      const q = req.method === "GET" ? req.query : req.body || {};
      const fromRaw = q.from != null ? String(q.from).trim() : "";
      const toRaw = q.to != null ? String(q.to).trim() : "";
      if (!fromRaw || !toRaw) {
        return res.status(400).json({
          error:
            "from ve to zorunludur (YYYY-MM-DD). Portala geliş tarihi aralığı (baslangicGelisTarihi / bitisGelisTarihi).",
        });
      }
      const from = parseDateParamStrict(fromRaw);
      const to = parseDateParamStrict(toRaw);
      if (!from || !to) {
        return res.status(400).json({
          error: "from veya to geçersiz. Beklenen format: YYYY-MM-DD.",
        });
      }
      if (from > to) {
        return res.status(400).json({ error: "from, to tarihinden büyük olamaz." });
      }

      const rawLimit = Number(q.limit);
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(rawLimit, 2000)
          : 1000;

      /** Virgülle ayrılmış belge no / doc id — yalnızca bunlar işlenir (admin seçimi). */
      const docIdFilter = parseDocIdsFilter(q);

      // 1) Portaldan geliş tarihine göre faturaları listele (listGelenBelgeleriExt ile aynı strateji).
      const { items, source: listSource } = await listInvoicesForGelisRange(
        vknTckn,
        from,
        to,
        limit
      );

      let itemsToProcess = items;
      if (docIdFilter) {
        itemsToProcess = items.filter((it) => itemMatchesDocIdFilter(it, docIdFilter));
      }

      const upsertedDocIds = [];

      // 2) Her fatura için qnb_invoices altında dokümanı oluştur/güncelle.
      const upsertErrors = [];
      for (const it of itemsToProcess) {
        const docId = invoiceDocIdForKey(it);
        if (!docId) continue;

        try {
          const ref = db.collection("qnb_invoices").doc(docId);
          const snap = await ref.get();
          const exists = snap.exists;

          const externalId =
            it.ettn || it.ETTN || it.belgeOid || it.belgeNo || it.uuid || it.id;

          const { attributes: _attrs, ...qnbRawClean } = it;

          const payload = {
            type: "invoice",
            externalId: externalId ? String(externalId) : docId,
            qnbRaw: qnbRawClean,
            qnbBelgeTuru: "FATURA",
            updatedAt: FieldValue.serverTimestamp(),
          };

          if (!exists) {
            payload.status = "PENDING";
            payload.createdAt = FieldValue.serverTimestamp();
          }

          if (it.belgeNo) payload.belgeNo = String(it.belgeNo);
          if (it.ettn || it.ETTN) payload.ettn = String(it.ettn || it.ETTN);

          await ref.set(payload, { merge: true });
          upsertedDocIds.push(docId);
        } catch (upErr) {
          logger.error("backfill qnb_invoices set failed", {
            docId,
            err: String(upErr?.message || upErr),
          });
          upsertErrors.push({ docId, error: String(upErr?.message || upErr) });
        }
      }

      // 3) Her fatura için tam UBL/XML ve tüm alanları çekip dokümana yaz (enrichOne).
      let enriched = 0;
      const concurrency = 5;
      for (let i = 0; i < upsertedDocIds.length; i += concurrency) {
        const chunk = upsertedDocIds.slice(i, i + concurrency);
        const results = await Promise.allSettled(
          chunk.map(async (id) => {
            try {
              return await enrichOne(id);
            } catch (err) {
              logger.error("backfill enrichOne failed", { docId: id, err: String(err?.message || err) });
              return false;
            }
          })
        );
        enriched += results.filter(
          (r) => r.status === "fulfilled" && r.value
        ).length;
      }

      return res.status(200).json({
        success: true,
        collection: "qnb_invoices",
        listSource,
        gelisTarihiAraligi: { from, to },
        totalListed: items.length,
        ...(docIdFilter
          ? {
              docIdsFilterActive: true,
              docIdsFilterCount: docIdFilter.size,
              matchedAfterDocIdsFilter: itemsToProcess.length,
            }
          : {}),
        upsertedDocs: upsertedDocIds.length,
        enriched,
        ...(upsertErrors.length > 0 ? { upsertErrors } : {}),
      });
    } catch (e) {
      const code = e?.status;
      const status =
        typeof code === "number" && code >= 400 && code < 600 ? code : 500;
      if (status === 401 || status === 403) {
        return res.status(status).send(e.message || String(e));
      }
      logger.error("backfillInvoicesFullByDateRange failed", {
        err: String(e?.message || e),
      });
      return res.status(500).json({ error: String(e?.message || e) });
    }
  }
);

