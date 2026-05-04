/**
 * 2026 faturalarını indirir + her faturayı enrich eder.
 * GET/POST
 * Query:
 *  - start: (opsiyonel) 0..n (tarih penceresi index'i)
 *  - windowDays: (opsiyonel) default 7, max 90
 *  - pageSize: (opsiyonel) default 1000, max 5000
 *  - resetYearCursor: true/1 ise state cursor'ını sıfırlar
 *  - enrichConcurrency: (opsiyonel) default 5, max 20
 */
import { onRequest } from "firebase-functions/v2/https";
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

function toYyyyMmDd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// syncAllInvoices.js'teki ile uyumlu: tarih alanları farklı isimlerle gelebiliyor.
// Amaç: listeyi stabil bir şekilde sıralamak.
function dateSortKey(it) {
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
}

function normalizeListItems(resp) {
  const items = resp?.return || resp?.["return"] || resp?.["return[]"] || [];
  const arr = Array.isArray(items) ? items : [items];
  return arr.slice().sort((a, b) => dateSortKey(b).localeCompare(dateSortKey(a)));
}

function invoiceDocIdForKey(it) {
  const belgeNo = it.belgeNo != null && String(it.belgeNo).trim() !== "" ? String(it.belgeNo).trim() : null;
  const externalId = it.ettn || it.ETTN || it.belgeOid || it.belgeNo || it.uuid || it.id;
  const key = belgeNo || (externalId ? String(externalId) : null);
  return key ? `invoice_${key.replace(/[/\\]/g, "_")}` : null;
}

async function runWithConcurrency(items, concurrency, fn) {
  let ok = 0;
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const outcomes = await Promise.allSettled(chunk.map(fn));
    ok += outcomes.filter((r) => r.status === "fulfilled" && r.value).length;
  }
  return ok;
}

export const syncAndEnrichInvoices2026 = onRequest(
  { region: "europe-west1", timeoutSeconds: 540 },
  async (req, res) => {
    try {
      setCors(req, res);
      if (req.method === "OPTIONS") return res.status(204).send("");
      if (req.method !== "GET" && req.method !== "POST") return res.status(405).send("Method Not Allowed");

      const user = await requireAuth(req);
      await requireRole(user.uid, ROLES_QNB_MUTATE);

      const vknTckn = process.env.QNB_VKN_TCKN;
      if (!vknTckn) return res.status(500).json({ error: "QNB_VKN_TCKN missing in .env" });

      // ---- fixed year: 2026
      const year = "2026";

      const resetYearCursor =
        String(req.query.resetYearCursor || "").toLowerCase() === "1" ||
        String(req.query.resetYearCursor || "").toLowerCase() === "true";

      const pageSize = Math.min(5000, Math.max(100, parseInt(req.query.pageSize, 10) || 1000));
      const windowDays = Math.min(90, Math.max(1, parseInt(req.query.windowDays, 10) || 7));
      const enrichConcurrency = Math.min(20, Math.max(1, parseInt(req.query.enrichConcurrency, 10) || 5));

      // Cursor (start) kaynağı: query varsa onu kullan, yoksa state'ten 2026 cursor'ını oku
      const stateRef = db.collection("qnb_sync_state").doc("app");
      const stateSnap = await stateRef.get();
      const state = stateSnap.exists ? (stateSnap.data() || {}) : {};

      let start;
      if (req.query.start != null) {
        start = Math.max(0, parseInt(req.query.start, 10) || 0);
      } else {
        const byYear =
          state.invoicePageStartByYear && typeof state.invoicePageStartByYear === "object"
            ? state.invoicePageStartByYear
            : {};
        if (resetYearCursor) start = 0;
        else {
          const stored = byYear[year];
          start = Math.max(0, typeof stored === "number" ? stored : parseInt(stored, 10) || 0);
        }
      }

      // 2026 sınırları
      const base = new Date(Date.UTC(Number(year), 0, 1));
      const yearEnd = new Date(Date.UTC(Number(year), 11, 31));
      const hardEnd = yearEnd; // 2026'nın sonuna kadar tarar

      const fromDate = addDays(base, start * windowDays);
      const toCandidate = addDays(fromDate, windowDays - 1);
      const toDate = toCandidate > hardEnd ? hardEnd : toCandidate;

      if (fromDate > hardEnd) {
        // yıl bitti
        return res.status(200).json({
          success: true,
          year,
          done: true,
          hasMore: false,
          nextStart: null,
          start,
          windowDays,
          pageSize,
          fetchedInThisCall: 0,
          withUbl: 0,
          from: null,
          to: null,
        });
      }

      const from = toYyyyMmDd(fromDate);
      const to = toYyyyMmDd(toDate);

      // 1) Listele (FATURA)
      const listResp = await callConnector("gelenBelgeTutarBilgileriSorgula", {
        vergiTcKimlikNo: String(vknTckn),
        belgeTuru: "FATURA",
        baslangicGelisTarihi: from,
        bitisGelisTarihi: to,
      });

      const items = normalizeListItems(listResp).slice(0, pageSize);

      // 2) Firestore'a yaz
      let batch = db.batch();
      let batchCount = 0;

      const invoiceDocIds = [];
      for (const it of items) {
        const docId = invoiceDocIdForKey(it);
        if (!docId) continue;

        const externalId = it.ettn || it.ETTN || it.belgeOid || it.belgeNo || it.uuid || it.id;
        if (!externalId) continue;

        invoiceDocIds.push(docId);

        const ref = db.collection("qnb_invoices").doc(docId);
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

        batch.set(ref, payload, { merge: true });
        batchCount++;

        if (batchCount >= 400) {
          await batch.commit();
          batch = db.batch();
          batchCount = 0;
        }
      }
      if (batchCount > 0) await batch.commit();

      // 3) Enrich (her zaman aktif)
      const withUbl = await runWithConcurrency(invoiceDocIds, enrichConcurrency, (id) => enrichOne(id));

      // 4) Cursor ilerlet
      const nextStart = start + 1;
      const hasMore = toDate < hardEnd;

      await stateRef.set(
        {
          invoicePageStartByYear: { [year]: hasMore ? nextStart : nextStart },
          invoicePageLastStartByYear: { [year]: start },
          invoicePageLastFromByYear: { [year]: from },
          invoicePageLastToByYear: { [year]: to },
          invoicePageLastRunAtByYear: { [year]: FieldValue.serverTimestamp() },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return res.status(200).json({
        success: true,
        year,
        resetYearCursor,
        hasMore,
        nextStart: hasMore ? nextStart : null,
        start,
        windowDays,
        pageSize,
        enrichConcurrency,
        fetchedInThisCall: items.length,
        invoicesWritten: invoiceDocIds.length,
        withUbl,
        from,
        to,
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  }
);
