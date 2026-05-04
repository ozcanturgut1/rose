/**
 * Portaldaki tüm irsaliyeleri sayfalı çeker. Her çağrıda bir sayfa (pageSize adet) alır, qnb_docs'a yazar ve UBL indirir.
 * Flutter hasMore=true ve nextStart ile tekrar çağırarak tüm irsaliyeler bitene kadar recursive devam eder.
 * Öneri: günlük Cloud Scheduler ile bir veya daha fazla sayfa çekilerek önbellek taze tutulur; fatura zenginleştirme qnb_docs'tan okur.
 * GET/POST ?start=0&pageSize=50
 */
import { onRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, FieldPath } from "firebase-admin/firestore";
import { requireAuth, requireRole, ROLES_QNB_MUTATE } from "./requireAuth.js";
import { callConnector } from "./qnbCall.js";
import { fetchDespatchUblByEttn } from "./enrichInvoiceWithRelatedDespatches.js";

const db = getFirestore();

const setCors = (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

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

function normalizeListItems(listResponse) {
  const items =
    listResponse?.return || listResponse?.["return"] || listResponse?.["return[]"] || [];
  let arr = Array.isArray(items) ? items : [items];
  return arr.slice().sort((a, b) => dateSortKey(b).localeCompare(dateSortKey(a)));
}

function parseYmd(s) {
  const t = String(s ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return t;
}

function ymdCompact(ymd) {
  return String(ymd).replace(/-/g, "");
}

function despatchDocIdForKey(it) {
  const belgeNo =
    it.belgeNo ?? it.belgeNoStr ?? it.irsaliyeNo ?? it.belgeNumarasi;
  const hasNo = belgeNo != null && String(belgeNo).trim() !== "";
  const key = hasNo ? String(belgeNo).trim() : (it.ettn || it.ETTN || it.belgeOid || it.uuid || it.id);
  if (!key) return null;
  return `despatch_${String(key).replace(/[/\\]/g, "_")}`;
}

/**
 * qnb_invoices içinde en az bir faturada referansı olan irsaliye belge no / ETTN kümeleri.
 * Kaynak: relatedBelgeNos, relatedDespatchEttns[].belgeNo / .ettn
 */
async function loadDespatchAllowListFromQnbInvoices(db) {
  const belgeNos = new Set();
  const ettns = new Set();
  let lastDoc = null;
  const pageSize = 400;
  while (true) {
    let q = db
      .collection("qnb_invoices")
      .select("relatedBelgeNos", "relatedDespatchEttns")
      .orderBy(FieldPath.documentId())
      .limit(pageSize);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      const d = doc.data();
      if (Array.isArray(d.relatedBelgeNos)) {
        for (const x of d.relatedBelgeNos) {
          if (x != null && String(x).trim() !== "") belgeNos.add(String(x).trim());
        }
      }
      if (Array.isArray(d.relatedDespatchEttns)) {
        for (const r of d.relatedDespatchEttns) {
          if (r && r.belgeNo != null && String(r.belgeNo).trim() !== "") {
            belgeNos.add(String(r.belgeNo).trim());
          }
          if (r && r.ettn != null && String(r.ettn).trim() !== "") {
            ettns.add(String(r.ettn).trim());
          }
        }
      }
    }
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < pageSize) break;
  }
  return { belgeNos, ettns };
}

function despatchAllowKeys(it) {
  const belgeNo =
    it.belgeNo ?? it.belgeNoStr ?? it.irsaliyeNo ?? it.belgeNumarasi;
  const hasNo = belgeNo != null && String(belgeNo).trim() !== "";
  const bn = hasNo ? String(belgeNo).trim() : null;
  const et = it.ettn ?? it.ETTN;
  const ettn = et != null && String(et).trim() !== "" ? String(et).trim() : null;
  return { belgeNo: bn, ettn };
}

function isDespatchLinkedToKnownInvoice(it, allow) {
  const { belgeNo, ettn } = despatchAllowKeys(it);
  if (belgeNo && allow.belgeNos.has(belgeNo)) return true;
  if (ettn && allow.ettns.has(ettn)) return true;
  return false;
}

export const syncAllDespatches = onRequest(
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

      const stateRef = db.collection("qnb_sync_state").doc("app");
      let start;
      if (req.query.start != null) {
        start = Math.max(0, parseInt(req.query.start, 10) || 0);
      } else {
        const stateSnap = await stateRef.get();
        const stored = stateSnap.exists ? stateSnap.data().despatchNextStart : null;
        start = Math.max(0, typeof stored === "number" ? stored : parseInt(stored, 10) || 0);
      }
      const pageSize = Math.min(100, Math.max(10, parseInt(req.query.pageSize, 10) || 50));
      const fromYmd = parseYmd(req.query.from);
      const toYmd = parseYmd(req.query.to);
      const hasDateRange = !!fromYmd && !!toYmd;
      if ((fromYmd && !toYmd) || (!fromYmd && toYmd)) {
        return res.status(400).json({ error: "from ve to birlikte verilmelidir (YYYY-MM-DD)." });
      }
      if (hasDateRange && fromYmd > toYmd) {
        return res.status(400).json({ error: "from, to'dan büyük olamaz." });
      }
      // Tarihli modda state cursor (despatchNextStart) kullanılmaz; arama baştan yapılır.
      if (hasDateRange) {
        start = 0;
      }

      let items = [];
      if (hasDateRange) {
        // QNB'de tarihli irsaliye sorgusu Ext ile (parametreler wrapper) ve start olmadan çalışıyor.
        const p = {
          vergiTcKimlikNo: String(vknTckn),
          belgeTuru: "IRSALIYE",
          donusTipiVersiyon: "6.0",
          gelisTarihiBaslangic: ymdCompact(fromYmd),
          gelisTarihiBitis: ymdCompact(toYmd),
          onayDurum: "HEPSI",
        };
        try {
          const listResponse = await callConnector("gelenBelgeleriListeleExt", { parametreler: p });
          items = normalizeListItems(listResponse).slice(0, pageSize);
        } catch (_) {
          // Bazı ortamlarda wrapper yerine flat payload çalışabilir.
          const listResponse = await callConnector("gelenBelgeleriListeleExt", p);
          items = normalizeListItems(listResponse).slice(0, pageSize);
        }
      } else {
        const listResponse = await callConnector("gelenBelgeleriListeleNew", {
          vergiTcKimlikNo: String(vknTckn),
          sonAlinanBelgeSiraNumarasi: String(start),
          belgeTuru: "IRSALIYE",
        });
        items = normalizeListItems(listResponse).slice(0, pageSize);
      }

      const allow = await loadDespatchAllowListFromQnbInvoices(db);
      const linkedItems = items.filter((it) => isDespatchLinkedToKnownInvoice(it, allow));
      const skippedNoInvoice = items.length - linkedItems.length;

      const batch = db.batch();
      for (const it of linkedItems) {
        const docId = despatchDocIdForKey(it);
        if (!docId) continue;
        const externalId =
          it.ettn || it.ETTN || it.belgeOid || it.belgeNo || it.belgeNoStr || it.irsaliyeNo || it.uuid || it.id;
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
      if (linkedItems.length > 0) {
        await batch.commit();
      }

      let withUbl = 0;
      const concurrency = 5;
      for (let i = 0; i < linkedItems.length; i += concurrency) {
        const chunk = linkedItems.slice(i, i + concurrency);
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
        withUbl += outcomes.filter((r) => r.status === "fulfilled" && r.value === 1).length;
      }

      const fetchedInThisCall = linkedItems.length;
      const hasMore = hasDateRange ? false : items.length >= pageSize;
      const nextStart = hasDateRange ? null : (start + pageSize);

      await stateRef.set(
        {
          despatchLastStart: start,
          despatchNextStart: nextStart ?? start,
          despatchLastRunAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return res.status(200).json({
        success: true,
        hasMore,
        nextStart: hasMore ? nextStart : null,
        start,
        pageSize,
        from: hasDateRange ? fromYmd : null,
        to: hasDateRange ? toYmd : null,
        /** qnb_docs'a yazılan (faturada referansı olan) irsaliye sayısı */
        fetchedInThisCall,
        /** Portaldan gelen satır sayısı (süzüm öncesi) */
        portalListCount: items.length,
        /** qnb_invoices'ta ilişkili fatura referansı bulunmayan irsaliye sayısı */
        skippedNotLinkedToInvoice: skippedNoInvoice,
        withUbl,
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
