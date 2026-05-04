/**
 * Portaldaki tüm faturaları sayfalı/recursive şekilde çeker.
 * İrsaliye akışındaki syncAllDespatches ile aynı sözleşmeyi kullanır:
 * - hasMore
 * - nextStart
 * - start
 * - pageSize
 * - fetchedInThisCall
 * - withUbl
 *
 * Not: QNB fatura API'sinde start tabanlı sayfalama olmadığı için burada start değeri
 * "tarih bloğu indeksi" olarak kullanılır.
 * GET/POST ?start=0&pageSize=50
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

export const syncAllInvoices = onRequest(
  { region: "europe-west1", timeoutSeconds: 300 },
  async (req, res) => {
    try {
      setCors(req, res);
      if (req.method === "OPTIONS") return res.status(204).send("");
      if (req.method !== "GET" && req.method !== "POST") return res.status(405).send("Method Not Allowed");

      const user = await requireAuth(req);
      await requireRole(user.uid, ROLES_QNB_MUTATE);

      const vknTckn = process.env.QNB_VKN_TCKN;
      if (!vknTckn) return res.status(500).json({ error: "QNB_VKN_TCKN missing in .env" });

      // --- Yearly mode ---
      // Default: current UTC year (so daily sync stays within this year's invoices)
      const yearParam = req.query.year ? String(req.query.year).slice(0, 4) : "";
      const currentYear = String(new Date().getUTCFullYear());
      const year = /^\d{4}$/.test(yearParam) ? yearParam : currentYear;
      const resetYearCursor =
        String(req.query.resetYearCursor || "").toLowerCase() === "1" ||
        String(req.query.resetYearCursor || "").toLowerCase() === "true";

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
        if (resetYearCursor) {
          start = 0;
        } else {
          const stored = byYear[year];
          start = Math.max(0, typeof stored === "number" ? stored : parseInt(stored, 10) || 0);
        }
      }

      // Fatura hacmi yüksek olabildiği için default limiti yüksek tutuyoruz.
      // (önceki 50 limiti toplam senkronu erken/eksik bırakabiliyordu)
      const pageSize = Math.min(5000, Math.max(100, parseInt(req.query.pageSize, 10) || 1000));
      const windowDays = Math.min(90, Math.max(1, parseInt(req.query.windowDays, 10) || 7));
      const enrichParam = String(req.query.enrich ?? "").toLowerCase();
const enrich = enrichParam === ""
  ? true
  : (enrichParam === "1" || enrichParam === "true");

      // Limit sync date window to the selected year: [YYYY-01-01 .. min(YYYY-12-31, today)]
      const base = new Date(Date.UTC(Number(year), 0, 1));
      const today = new Date();
      const yearEnd = new Date(Date.UTC(Number(year), 11, 31));
      const hardEnd = yearEnd < today ? yearEnd : today;
      const fromDate = addDays(base, start * windowDays);
      const toCandidate = addDays(fromDate, windowDays - 1);
      const toDate = toCandidate > hardEnd ? hardEnd : toCandidate;
      const from = toYyyyMmDd(fromDate);
      const to = toYyyyMmDd(toDate);

      let items = [];
      let rangeSkipped = false;
      let rangeError = null;
      // If cursor window is beyond the year's end, stop without calling QNB
      if (fromDate > hardEnd) {
        items = [];
      } else {
        try {
          const listResp = await callConnector("gelenBelgeTutarBilgileriSorgula", {
            vergiTcKimlikNo: String(vknTckn),
            belgeTuru: "FATURA",
            baslangicGelisTarihi: from,
            bitisGelisTarihi: to,
          });
          items = normalizeListItems(listResp).slice(0, pageSize);
        } catch (e) {
          rangeError = String(e?.message || e);
          if (/NullPointerException|ns2:Server/i.test(rangeError)) {
            rangeSkipped = true;
            items = [];
          } else {
            throw e;
          }
        }
      }

      let batch = db.batch();
      let batchCount = 0;
      for (const it of items) {
        const docId = invoiceDocIdForKey(it);
        if (!docId) continue;
        const externalId = it.ettn || it.ETTN || it.belgeOid || it.belgeNo || it.uuid || it.id;
        if (!externalId) continue;
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
      if (batchCount > 0) {
        await batch.commit();
      }

      // İsteğe bağlı: UBL indir (enrichOne). Büyük hacimde default kapalı tutulur.
      let withUbl = 0;
      if (enrich) {
        const concurrency = 5;
        const invoiceIds = items.map((it) => invoiceDocIdForKey(it)).filter(Boolean);
        for (let i = 0; i < invoiceIds.length; i += concurrency) {
          const chunk = invoiceIds.slice(i, i + concurrency);
          const outcomes = await Promise.allSettled(chunk.map((id) => enrichOne(id)));
          withUbl += outcomes.filter((r) => r.status === "fulfilled" && r.value).length;
        }
      }

      const nextStart = start + 1;
      const hasMore = toDate < hardEnd;
      await stateRef.set(
        {
          invoicePageStartByYear: { [year]: nextStart },
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
        pageSize,
        fetchedInThisCall: items.length,
        withUbl,
        enrich,
        from,
        to,
        ...(rangeSkipped ? { rangeSkipped: true, rangeError } : {}),
      });
    } catch (e) {
      const status = e.status || 500;
      return res.status(status).json({
        success: false,
        error: e.message || "FAILED",
        hasMore: false,
        nextStart: null,
      });
    }
  }
);

