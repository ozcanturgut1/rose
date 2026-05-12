/**
 * Otomatik fatura/irsaliye ak\u0131\u015f\u0131 (zamanlanm\u0131\u015f).
 *
 * Her 30 dakikada bir tetiklenir ve son_10_fatura_screen'deki 4 buton ak\u0131\u015f\u0131n\u0131 ayn\u0131 s\u0131rayla
 * otomatik olarak \u00e7al\u0131\u015ft\u0131r\u0131r:
 *
 *  1) suppliers/iplik + suppliers/kumas dok\u00fcmanlar\u0131ndaki VKN'lere ait son 10 g\u00fcnde portala
 *     d\u00fc\u015fen faturalar qnb_invoices'a yaz\u0131l\u0131r ve UBL ile zenginle\u015ftirilir.
 *  2) qnb_docs irsaliye \u00f6nbelle\u011fi portala g\u00f6re g\u00fcncellenir (cursor tabanl\u0131 sayfalama,
 *     qnb_sync_state/app.despatchNextStart ile devam eder).
 *  3) qnb_invoices/{id}/despatches alt\u0131ndaki irsaliyelerin ETTN'leri qnb_docs'tan okunup yaz\u0131l\u0131r.
 *  4) ETTN'i dolu olan irsaliyelerin UBL'i (varsa qnb_docs, yoksa portal) despatches'e yaz\u0131l\u0131r.
 *
 * Tasar\u0131m kararlar\u0131:
 *  - Pencere: son 10 g\u00fcn (bug\u00fcn dahil) — son_10_fatura_screen.dart varsay\u0131lan\u0131 ile uyumlu.
 *  - VKN filtresi: yaln\u0131z 1. ad\u0131ma uygulan\u0131r; 2-3-4. ad\u0131mlar qnb_invoices \u00fczerinden ilerledi\u011fi
 *    i\u00e7in zaten dolayl\u0131 olarak s\u00fcz\u00fclm\u00fc\u015f olur.
 *  - Kilit: qnb_sync_state/auto_pipeline.lockedUntilMs ile e\u015fzamanl\u0131 ko\u015fmay\u0131 engeller.
 *  - Yumu\u015fak son tarih: her ad\u0131m\u0131n ayr\u0131 b\u00fctcesi vard\u0131r; b\u00fctceyi a\u015fan ad\u0131m mevcut i\u015fi kayd\u0131n\u0131
 *    yaparak \u00e7\u0131kar, bir sonraki tetiklemede devam eder.
 *  - "Modul y\u00fcklenirken a\u011f \u00e7a\u011fr\u0131s\u0131 yapma" kural\u0131na uygundur: t\u00fcm a\u011f \u00e7a\u011fr\u0131lar\u0131 handler i\u00e7indedir.
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import { ensureAdmin } from "./adminInit.js";
ensureAdmin();

import { getFirestore, FieldValue, FieldPath } from "firebase-admin/firestore";
import { callConnector } from "./qnbCall.js";
import {
  enrichOne,
  fetchDespatchUblByEttn,
  readDespatchFromQnbDocs,
  readEttnFromQnbDocsForDespatch,
} from "./enrichInvoiceWithRelatedDespatches.js";

const db = getFirestore();

// ---------------------------------------------------------------------------
// Sabitler
// ---------------------------------------------------------------------------

const STATE_DOC = db.collection("qnb_sync_state").doc("auto_pipeline");
/** Adım 1 — portala düşen fatura tarama penceresi (gün). */
const ROLLING_WINDOW_DAYS = 10;
/**
 * Adım 2 — her irsaliye referansı için issueDate etrafında uygulanan dar pencere.
 * `gelenBelgeleriListeleExt` IRSALIYE çağrısı portalda max ~100 satır döner ve
 * IRSALIYE'de `sonAlinanBelgeSiraNumarasi` pagination çalışmıyor (NPE atıyor).
 * Bu nedenle irsaliye'yi 100 satır limiti içinde garantili bulmak için tarihe
 * göre dar pencerede ayrı ayrı sorgulanır.
 *
 *   pencere = [issueDate - LOOKBEHIND, issueDate + LOOKAHEAD]
 *
 * - LOOKBEHIND: irsaliye portala düzenleme tarihinden bir gün önce de düşmüş
 *   olabilir (saat dilimi/UTC farkı).
 * - LOOKAHEAD: irsaliye düzenleyen tedarikçi belgeyi 1-2 gün geç upload edebilir.
 *   7 günlük yasal fatura kuralı + portal gecikmesi için 5 gün tampon yeterli.
 */
const DESPATCH_ISSUE_LOOKBEHIND_DAYS = 1;
const DESPATCH_ISSUE_LOOKAHEAD_DAYS = 5;
/** issueDate bilgisi yoksa kullanılacak yedek pencere (gün, today-N → today). */
const DESPATCH_FALLBACK_WINDOW_DAYS = 21;

const STEP_BUDGET_MS = {
  step1: 90_000,
  step2: 150_000,
  step3: 150_000,
  step4: 150_000,
};

const INVOICE_PAGE_ALL = 300;
const RUN_LOCK_MAX_MS = 9 * 60_000;

const ETTN_REGEX = /^[0-9A-Fa-f-]{30,}$/;
const looksLikeDespatchXml = (s) =>
  /^\s*<\?xml|^\s*<(\w+:)?DespatchAdvice\s|^\s*<DespatchAdvice\s/.test(
    (s || "").slice(0, 2048)
  );

// ---------------------------------------------------------------------------
// Yard\u0131mc\u0131lar
// ---------------------------------------------------------------------------

function toYyyyMmDd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ymdCompact(ymd) {
  return String(ymd).replace(/-/g, "");
}

function rollingWindow(days) {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - (days - 1));
  return { from: toYyyyMmDd(from), to: toYyyyMmDd(now) };
}

function digitsOnly(raw) {
  if (raw == null) return "";
  return String(raw).replace(/\D/g, "");
}

function gondericiVknFromItem(it) {
  if (!it || typeof it !== "object") return null;
  const cand =
    it.gondericiVkn ??
    it.gondericiVergiNumarasi ??
    it.gonderenVkn ??
    it.supplierVkn ??
    it.vkn ??
    null;
  const s = digitsOnly(cand);
  return s || null;
}

function invoiceDocIdForKey(it) {
  const belgeNo =
    it?.belgeNo != null && String(it.belgeNo).trim() !== ""
      ? String(it.belgeNo).trim()
      : null;
  const externalId =
    it?.ettn || it?.ETTN || it?.belgeOid || it?.belgeNo || it?.uuid || it?.id;
  const key = belgeNo || (externalId ? String(externalId) : null);
  return key ? `invoice_${key.replace(/[/\\]/g, "_")}` : null;
}

function despatchDocIdFromBelgeNo(belgeNo) {
  const safe = String(belgeNo || "").replace(/[/\\]/g, "_").trim();
  if (!safe) return null;
  return `despatch_${safe}`;
}

/**
 * BelgeNo karşılaştırma anahtarı: portal bazen "BRS 2026 000000074" gibi
 * boşluklu döner, UBL'den "BRS2026000000074" çıkar. Hepsini boşluk/sınırlayıcı
 * temizleyip büyük harfle eşleştirilir.
 */
function belgeNoKey(s) {
  if (s == null) return "";
  return String(s).replace(/[\s.\-/_]/g, "").toUpperCase();
}

function itemBelgeNo(it) {
  return (
    it?.belgeNo ??
    it?.belgeNoStr ??
    it?.irsaliyeNo ??
    it?.belgeNumarasi ??
    null
  );
}

/** issueDate (YYYY-MM-DD veya YYYYMMDD) varsa onun etrafında dar pencere. */
function safeDespatchSearchWindow(issueDateRaw) {
  let ymd = null;
  if (typeof issueDateRaw === "string") {
    const t = issueDateRaw.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) ymd = t.slice(0, 10);
    else if (/^\d{8}$/.test(t)) {
      ymd = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
    }
  }
  if (!ymd) return rollingWindow(DESPATCH_FALLBACK_WINDOW_DAYS);
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  const base = new Date(y, m - 1, d);
  const fromD = new Date(base);
  fromD.setDate(fromD.getDate() - DESPATCH_ISSUE_LOOKBEHIND_DAYS);
  const toD = new Date(base);
  toD.setDate(toD.getDate() + DESPATCH_ISSUE_LOOKAHEAD_DAYS);
  // Geleceğe taşma: bugünden öteye gitme.
  const now = new Date();
  if (toD > now) toD.setTime(now.getTime());
  return { from: toYyyyMmDd(fromD), to: toYyyyMmDd(toD) };
}

function normalizeListItems(resp) {
  const items = resp?.return ?? resp?.["return"] ?? resp?.["return[]"] ?? [];
  const arr = Array.isArray(items) ? items : [items];
  return arr.filter((x) => x != null && typeof x === "object");
}

function dateSortKey(it) {
  const raw =
    it?.gelisTarihi ??
    it?.gonderimTarihi ??
    it?.receivedDate ??
    it?.belgeTarihi ??
    it?.issueDate ??
    it?.IssueDate ??
    it?.faturaTarihi ??
    "";
  const t = String(raw).trim();
  if (!t) return "00000000";
  const noSep = t.replace(/[-./]/g, "");
  if (/^\d{8}$/.test(noSep)) return noSep;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t.replace(/-/g, "");
  const ddmmyyyy = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (ddmmyyyy)
    return (
      ddmmyyyy[3] + ddmmyyyy[2].padStart(2, "0") + ddmmyyyy[1].padStart(2, "0")
    );
  return noSep || "00000000";
}

function deadlineExceeded(startedAtMs, budgetMs) {
  return Date.now() - startedAtMs > budgetMs;
}

// ---------------------------------------------------------------------------
// suppliers/{iplik|kumas} VKN k\u00fcmesi
// ---------------------------------------------------------------------------

function consumeVknValue(raw, out) {
  if (raw == null) return;
  if (Array.isArray(raw)) {
    for (const e of raw) {
      const v = digitsOnly(e);
      if (v) out.add(v);
    }
    return;
  }
  const s = String(raw).trim();
  if (!s) return;
  if (s.includes(",") || s.includes(";")) {
    for (const part of s.split(/[,;]\s*/)) {
      const v = digitsOnly(part);
      if (v) out.add(v);
    }
    return;
  }
  const v = digitsOnly(s);
  if (v) out.add(v);
}

async function loadAllowedSupplierVkns() {
  const out = new Set();
  for (const docId of ["iplik", "kumas"]) {
    const snap = await db.collection("suppliers").doc(docId).get();
    if (!snap.exists) {
      logger.warn(`autoPipeline: suppliers/${docId} bulunamad\u0131`);
      continue;
    }
    const d = snap.data() || {};
    consumeVknValue(d.vkns, out);
    consumeVknValue(d.vkn, out);
    consumeVknValue(d.vknList, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Ad\u0131m: VKN-s\u00fczml\u00fc fatura listele + qnb_invoices'a yaz + enrich
// ---------------------------------------------------------------------------

async function listInvoicesForGelisRange(vknTckn, fromYmd, toYmd) {
  let items = [];
  let source = "gelenBelgeTutarBilgileriSorgula";
  try {
    const listResp = await callConnector("gelenBelgeTutarBilgileriSorgula", {
      vergiTcKimlikNo: String(vknTckn),
      belgeTuru: "FATURA",
      baslangicGelisTarihi: fromYmd,
      bitisGelisTarihi: toYmd,
    });
    items = normalizeListItems(listResp);
  } catch (e) {
    logger.warn("autoPipeline step1: tutar sorgu hatas\u0131 (Ext denenecek)", {
      err: String(e?.message || e).slice(0, 300),
    });
    items = [];
  }

  if (items.length === 0) {
    try {
      const p = {
        vergiTcKimlikNo: String(vknTckn),
        belgeTuru: "FATURA",
        sonAlinanBelgeSiraNumarasi: "0",
        donusTipiVersiyon: "6.0",
        gelisTarihiBaslangic: ymdCompact(fromYmd),
        gelisTarihiBitis: ymdCompact(toYmd),
        onayDurum: "HEPSI",
      };
      let listResp;
      try {
        listResp = await callConnector("gelenBelgeleriListeleExt", {
          parametreler: p,
        });
      } catch (_) {
        listResp = await callConnector("gelenBelgeleriListeleExt", p);
      }
      items = normalizeListItems(listResp);
      source = "gelenBelgeleriListeleExt";
    } catch (e) {
      logger.warn("autoPipeline step1: Ext liste hatas\u0131", {
        err: String(e?.message || e).slice(0, 300),
      });
      items = [];
      source = "none";
    }
  }
  items.sort((a, b) => dateSortKey(b).localeCompare(dateSortKey(a)));
  return { items, source };
}

/**
 * Mükerrer ingest engelleme: archiveCompletedInvoice ile `qnb_invoices_archive`'a
 * taşınmış (ETA SQL kaydı tamamlanmış) faturalar tekrar ingest edilmez. Aksi halde
 * portal listesi 10 günlük pencerede aynı belgeyi yeniden dönerse onay/ETA döngüsü
 * baştan tetiklenir.
 */
async function isInvoiceArchived(docId) {
  if (!docId) return false;
  const snap = await db.collection("qnb_invoices_archive").doc(docId).get();
  return snap.exists;
}

async function upsertInvoiceDoc(it) {
  const docId = invoiceDocIdForKey(it);
  if (!docId) return null;
  if (await isInvoiceArchived(docId)) {
    return { docId, skipped: "archived" };
  }
  const ref = db.collection("qnb_invoices").doc(docId);
  const snap = await ref.get();
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
  if (!snap.exists) {
    payload.status = "PENDING";
    payload.createdAt = FieldValue.serverTimestamp();
  }
  if (it.belgeNo) payload.belgeNo = String(it.belgeNo);
  if (it.ettn || it.ETTN) payload.ettn = String(it.ettn || it.ETTN);
  await ref.set(payload, { merge: true });
  return { docId, skipped: null };
}

async function runStep1IngestSupplierInvoices(startedAtMs) {
  const vknTckn = process.env.QNB_VKN_TCKN;
  if (!vknTckn) {
    return { skipped: true, reason: "QNB_VKN_TCKN missing in env" };
  }
  const allowed = await loadAllowedSupplierVkns();
  if (allowed.size === 0) {
    return {
      skipped: true,
      reason: "suppliers/iplik+kumas i\u00e7inde VKN bulunamad\u0131",
    };
  }
  const { from, to } = rollingWindow(ROLLING_WINDOW_DAYS);
  const { items: rawItems, source } = await listInvoicesForGelisRange(
    vknTckn,
    from,
    to
  );
  const filtered = rawItems.filter((it) => {
    const v = gondericiVknFromItem(it);
    return v != null && allowed.has(v);
  });

  const upsertedDocIds = [];
  const upsertErrors = [];
  let skippedArchived = 0;
  for (const it of filtered) {
    if (deadlineExceeded(startedAtMs, STEP_BUDGET_MS.step1)) break;
    try {
      const r = await upsertInvoiceDoc(it);
      if (!r) continue;
      if (r.skipped === "archived") {
        skippedArchived++;
        continue;
      }
      upsertedDocIds.push(r.docId);
    } catch (e) {
      upsertErrors.push(String(e?.message || e).slice(0, 200));
    }
  }

  let enriched = 0;
  const concurrency = 5;
  for (let i = 0; i < upsertedDocIds.length; i += concurrency) {
    if (deadlineExceeded(startedAtMs, STEP_BUDGET_MS.step1)) break;
    const chunk = upsertedDocIds.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map((id) =>
        enrichOne(id).catch((err) => {
          logger.warn("autoPipeline step1 enrichOne failed", {
            id,
            err: String(err?.message || err).slice(0, 200),
          });
          return false;
        })
      )
    );
    enriched += results.filter(
      (r) => r.status === "fulfilled" && r.value
    ).length;
  }

  return {
    skipped: false,
    window: { from, to },
    allowedVknCount: allowed.size,
    listSource: source,
    totalListed: rawItems.length,
    matchedBySupplier: filtered.length,
    skippedAlreadyArchived: skippedArchived,
    upsertedDocs: upsertedDocIds.length,
    enriched,
    upsertErrors: upsertErrors.length,
  };
}

// ---------------------------------------------------------------------------
// 2. Adım: qnb_invoices'taki her fatura için referansladığı irsaliyeleri,
// irsaliye düzenleme tarihi etrafında dar pencerede portaldan sorgulayıp
// qnb_docs'a yazar; ETTN ile UBL'i de indirir.
// ---------------------------------------------------------------------------

async function findDespatchItemInPortal(vknTckn, belgeNo, issueDateYmd) {
  const { from, to } = safeDespatchSearchWindow(issueDateYmd);
  const p = {
    vergiTcKimlikNo: String(vknTckn),
    belgeTuru: "IRSALIYE",
    donusTipiVersiyon: "6.0",
    gelisTarihiBaslangic: ymdCompact(from),
    gelisTarihiBitis: ymdCompact(to),
    onayDurum: "HEPSI",
  };
  let listResponse;
  try {
    try {
      listResponse = await callConnector("gelenBelgeleriListeleExt", {
        parametreler: p,
      });
    } catch (_) {
      listResponse = await callConnector("gelenBelgeleriListeleExt", p);
    }
  } catch (e) {
    return {
      window: { from, to },
      error: String(e?.message || e).slice(0, 200),
      item: null,
      totalCount: 0,
    };
  }
  const items = normalizeListItems(listResponse);
  const want = belgeNoKey(belgeNo);
  const item = items.find((it) => belgeNoKey(itemBelgeNo(it)) === want) || null;
  return { window: { from, to }, error: null, item, totalCount: items.length };
}

function buildDespatchPayloadFromPortalItem(it, fallbackBelgeNo) {
  const ettn = it?.ettn || it?.ETTN || null;
  const externalId =
    ettn ||
    it?.belgeOid ||
    it?.belgeNo ||
    it?.belgeNoStr ||
    it?.irsaliyeNo ||
    it?.uuid ||
    it?.id ||
    fallbackBelgeNo;
  const { attributes: _a, ...rawClean } = it || {};
  const payload = {
    type: "despatch",
    externalId: externalId ? String(externalId) : null,
    status: "PENDING",
    qnbRaw: rawClean,
    qnbBelgeTuru: "IRSALIYE",
    updatedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
  };
  if (it?.belgeNo != null) payload.belgeNo = String(it.belgeNo);
  else if (fallbackBelgeNo) payload.belgeNo = String(fallbackBelgeNo);
  if (it?.belgeNoStr != null) payload.belgeNoStr = String(it.belgeNoStr);
  if (it?.irsaliyeNo != null) payload.irsaliyeNo = String(it.irsaliyeNo);
  if (ettn) payload.ettn = String(ettn);
  return payload;
}

/**
 * Tek bir irsaliye referansını işler:
 *   - Geçerli qnb_docs cache varsa atlar.
 *   - Yoksa issueDate etrafında dar pencerede portaldan listeler, eşleştirir.
 *   - Bulunan kaydı qnb_docs'a yazar; ETTN ile UBL'i indirir.
 *
 * @returns {"cachedValid"|"matchedNew"|"notFound"|"portalError"|"ublFailed"|"writtenNoUbl"|"writtenWithUbl"}
 */
async function processDespatchTarget(vknTckn, belgeNo, issueDateYmd) {
  const docId = despatchDocIdFromBelgeNo(belgeNo);
  if (!docId) return "notFound";

  const docRef = db.collection("qnb_docs").doc(docId);
  const cached = await docRef.get();
  if (cached.exists) {
    const cd = cached.data() || {};
    const hasEttn = ETTN_REGEX.test(String(cd.ettn || "").trim());
    const hasUbl =
      typeof cd.contentUbl === "string" && looksLikeDespatchXml(cd.contentUbl);
    if (hasEttn && hasUbl) return "cachedValid";
  }

  const found = await findDespatchItemInPortal(vknTckn, belgeNo, issueDateYmd);
  if (found.error) {
    logger.warn("autoPipeline step2 portal listele hatas\u0131", {
      belgeNo,
      window: found.window,
      err: found.error,
    });
    return "portalError";
  }
  if (!found.item) {
    return "notFound";
  }

  const payload = buildDespatchPayloadFromPortalItem(found.item, belgeNo);
  await docRef.set(payload, { merge: true });

  const ettn = payload.ettn;
  if (!ettn) return "writtenNoUbl";

  let fetched;
  try {
    fetched = await fetchDespatchUblByEttn(String(vknTckn), String(ettn));
  } catch (e) {
    logger.warn("autoPipeline step2 UBL indirme hatas\u0131", {
      belgeNo,
      err: String(e?.message || e).slice(0, 200),
    });
    return "ublFailed";
  }
  if (!fetched?.contentUbl || !looksLikeDespatchXml(fetched.contentUbl)) {
    return "ublFailed";
  }
  await docRef.set(
    {
      contentUbl: fetched.contentUbl,
      ublParsed: fetched.ublParsed || null,
      contentFetchedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return "writtenWithUbl";
}

async function runStep2SyncDespatches(startedAtMs) {
  const vknTckn = process.env.QNB_VKN_TCKN;
  if (!vknTckn) return { skipped: true, reason: "QNB_VKN_TCKN missing" };

  const stateRef = db.collection("qnb_sync_state").doc("app");

  const result = {
    skipped: false,
    mode: "perInvoiceNarrowWindow",
    invoicesScanned: 0,
    invoiceDocPages: 0,
    targetsTotal: 0,
    cachedValid: 0,
    matched: 0,
    notFound: 0,
    portalError: 0,
    writtenWithUbl: 0,
    writtenNoUbl: 0,
    ublFailed: 0,
    completed: true,
  };

  let lastDoc = null;
  // benzer belgeNo'lar farklı faturalarda görünebilir; aynı koşuda tekrar
  // sorgulamamak için tek koşu içi memo (yalnız "cachedValid" sayılmaz ama
  // ağ çağrısı tekrarlanmaz).
  const processedBelgeNos = new Set();

  while (true) {
    if (deadlineExceeded(startedAtMs, STEP_BUDGET_MS.step2)) {
      result.completed = false;
      break;
    }
    let q = db
      .collection("qnb_invoices")
      .orderBy(FieldPath.documentId())
      .limit(INVOICE_PAGE_ALL);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;
    result.invoiceDocPages++;

    for (const invDoc of snap.docs) {
      if (deadlineExceeded(startedAtMs, STEP_BUDGET_MS.step2)) {
        result.completed = false;
        break;
      }
      const data = invDoc.data() || {};
      if (String(data.type) !== "invoice") continue;
      result.invoicesScanned++;

      const subSnap = await invDoc.ref.collection("despatches").get();
      for (const sd of subSnap.docs) {
        if (deadlineExceeded(startedAtMs, STEP_BUDGET_MS.step2)) {
          result.completed = false;
          break;
        }
        const x = sd.data() || {};
        const belgeNo = (x.belgeNo ?? x.belgeNoStr ?? "").toString().trim();
        if (!belgeNo) continue;
        result.targetsTotal++;
        if (processedBelgeNos.has(belgeNo)) continue;
        processedBelgeNos.add(belgeNo);

        const issueDate = x.issueDate ? String(x.issueDate).trim() : "";
        const outcome = await processDespatchTarget(
          String(vknTckn),
          belgeNo,
          issueDate
        );
        switch (outcome) {
          case "cachedValid":
            result.cachedValid++;
            break;
          case "writtenWithUbl":
            result.matched++;
            result.writtenWithUbl++;
            break;
          case "writtenNoUbl":
            result.matched++;
            result.writtenNoUbl++;
            break;
          case "ublFailed":
            result.matched++;
            result.ublFailed++;
            break;
          case "notFound":
            result.notFound++;
            break;
          case "portalError":
            result.portalError++;
            break;
          default:
            break;
        }
      }
    }

    if (!result.completed) break;
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < INVOICE_PAGE_ALL) break;
  }

  await stateRef.set(
    { despatchLastRunAt: FieldValue.serverTimestamp() },
    { merge: true }
  );

  return result;
}

// ---------------------------------------------------------------------------
// 3. Ad\u0131m: qnb_invoices/{id}/despatches ETTN'lerini qnb_docs'tan yaz
// ---------------------------------------------------------------------------

async function applyEttnFromQnbDocsForInvoice(invRef) {
  const stats = {
    despatchesScanned: 0,
    updated: 0,
    skippedNoBelgeNo: 0,
    skippedNoQnbDocs: 0,
    unchanged: 0,
  };
  const snap = await invRef.collection("despatches").get();
  for (const d of snap.docs) {
    stats.despatchesScanned++;
    const data = d.data() || {};
    const belgeNo = (data.belgeNo ?? data.belgeNoStr ?? "")
      .toString()
      .trim();
    if (!belgeNo) {
      stats.skippedNoBelgeNo++;
      continue;
    }
    const ettnFromStore = await readEttnFromQnbDocsForDespatch(belgeNo);
    if (!ettnFromStore) {
      stats.skippedNoQnbDocs++;
      continue;
    }
    const prev = data.ettn != null ? String(data.ettn).trim() : "";
    if (ETTN_REGEX.test(prev) && prev === ettnFromStore) {
      stats.unchanged++;
      continue;
    }
    await d.ref.set(
      { ettn: ettnFromStore, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    stats.updated++;
  }
  return stats;
}

async function runStep3BackfillEttn(startedAtMs) {
  const total = {
    invoicesProcessed: 0,
    invoiceDocPages: 0,
    despatchesScanned: 0,
    updated: 0,
    skippedNoBelgeNo: 0,
    skippedNoQnbDocs: 0,
    unchanged: 0,
    completed: true,
  };
  let lastDoc = null;
  while (true) {
    if (deadlineExceeded(startedAtMs, STEP_BUDGET_MS.step3)) {
      total.completed = false;
      break;
    }
    let q = db
      .collection("qnb_invoices")
      .orderBy(FieldPath.documentId())
      .limit(INVOICE_PAGE_ALL);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;
    total.invoiceDocPages++;
    for (const invDoc of snap.docs) {
      if (deadlineExceeded(startedAtMs, STEP_BUDGET_MS.step3)) {
        total.completed = false;
        break;
      }
      const data = invDoc.data() || {};
      if (String(data.type) !== "invoice") continue;
      total.invoicesProcessed++;
      const part = await applyEttnFromQnbDocsForInvoice(invDoc.ref);
      total.despatchesScanned += part.despatchesScanned;
      total.updated += part.updated;
      total.skippedNoBelgeNo += part.skippedNoBelgeNo;
      total.skippedNoQnbDocs += part.skippedNoQnbDocs;
      total.unchanged += part.unchanged;
    }
    if (!total.completed) break;
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < INVOICE_PAGE_ALL) break;
  }
  return total;
}

// ---------------------------------------------------------------------------
// 4. Ad\u0131m: ETTN'i dolu olan irsaliyelerin UBL'ini despatches'e yaz
// ---------------------------------------------------------------------------

async function enrichUblForInvoiceDespatches(invRef, vknTckn) {
  const stats = {
    despatchesScanned: 0,
    ublWritten: 0,
    skippedNoBelgeNo: 0,
    skippedNoEttn: 0,
    skippedAlreadyHasUbl: 0,
    fromQnbDocs: 0,
    fromPortal: 0,
    fetchFailed: 0,
  };
  const snap = await invRef.collection("despatches").get();
  for (const d of snap.docs) {
    stats.despatchesScanned++;
    const data = d.data() || {};
    const belgeNo = (data.belgeNo ?? data.belgeNoStr ?? "")
      .toString()
      .trim();
    if (!belgeNo) {
      stats.skippedNoBelgeNo++;
      continue;
    }
    const ettn = data.ettn != null ? String(data.ettn).trim() : "";
    if (!ETTN_REGEX.test(ettn)) {
      stats.skippedNoEttn++;
      continue;
    }
    const existing =
      data.contentUbl && typeof data.contentUbl === "string"
        ? data.contentUbl
        : "";
    if (existing && looksLikeDespatchXml(existing)) {
      stats.skippedAlreadyHasUbl++;
      continue;
    }
    const fromDoc = await readDespatchFromQnbDocs(belgeNo);
    if (fromDoc?.contentUbl && looksLikeDespatchXml(fromDoc.contentUbl)) {
      await d.ref.set(
        {
          contentUbl: fromDoc.contentUbl,
          ublParsed: fromDoc.ublParsed || null,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      stats.ublWritten++;
      stats.fromQnbDocs++;
      continue;
    }
    if (!vknTckn) {
      stats.fetchFailed++;
      continue;
    }
    const fetched = await fetchDespatchUblByEttn(vknTckn, ettn);
    if (!fetched?.contentUbl || !looksLikeDespatchXml(fetched.contentUbl)) {
      stats.fetchFailed++;
      continue;
    }
    await d.ref.set(
      {
        contentUbl: fetched.contentUbl,
        ublParsed: fetched.ublParsed || null,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    stats.ublWritten++;
    stats.fromPortal++;
  }
  return stats;
}

async function runStep4EnrichDespatchUbl(startedAtMs) {
  const vknTckn = process.env.QNB_VKN_TCKN
    ? String(process.env.QNB_VKN_TCKN).trim()
    : "";
  const total = {
    invoicesProcessed: 0,
    invoiceDocPages: 0,
    despatchesScanned: 0,
    ublWritten: 0,
    skippedNoBelgeNo: 0,
    skippedNoEttn: 0,
    skippedAlreadyHasUbl: 0,
    fromQnbDocs: 0,
    fromPortal: 0,
    fetchFailed: 0,
    vknConfigured: Boolean(vknTckn),
    completed: true,
  };
  let lastDoc = null;
  while (true) {
    if (deadlineExceeded(startedAtMs, STEP_BUDGET_MS.step4)) {
      total.completed = false;
      break;
    }
    let q = db
      .collection("qnb_invoices")
      .orderBy(FieldPath.documentId())
      .limit(INVOICE_PAGE_ALL);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;
    total.invoiceDocPages++;
    for (const invDoc of snap.docs) {
      if (deadlineExceeded(startedAtMs, STEP_BUDGET_MS.step4)) {
        total.completed = false;
        break;
      }
      const data = invDoc.data() || {};
      if (String(data.type) !== "invoice") continue;
      total.invoicesProcessed++;
      const part = await enrichUblForInvoiceDespatches(invDoc.ref, vknTckn);
      total.despatchesScanned += part.despatchesScanned;
      total.ublWritten += part.ublWritten;
      total.skippedNoBelgeNo += part.skippedNoBelgeNo;
      total.skippedNoEttn += part.skippedNoEttn;
      total.skippedAlreadyHasUbl += part.skippedAlreadyHasUbl;
      total.fromQnbDocs += part.fromQnbDocs;
      total.fromPortal += part.fromPortal;
      total.fetchFailed += part.fetchFailed;
    }
    if (!total.completed) break;
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < INVOICE_PAGE_ALL) break;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Kilit + ana ak\u0131\u015f
// ---------------------------------------------------------------------------

async function acquireRunLock(now) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(STATE_DOC);
    const data = snap.exists ? snap.data() : {};
    if (data && data.disabled === true) {
      return { acquired: false, reason: "disabled" };
    }
    const lockedUntilMs =
      typeof data?.lockedUntilMs === "number" ? data.lockedUntilMs : 0;
    if (lockedUntilMs > now) {
      return { acquired: false, reason: "already_running", lockedUntilMs };
    }
    tx.set(
      STATE_DOC,
      {
        running: true,
        lockedUntilMs: now + RUN_LOCK_MAX_MS,
        lastRunAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { acquired: true };
  });
}

async function releaseRunLock(extra) {
  try {
    await STATE_DOC.set(
      {
        running: false,
        lockedUntilMs: 0,
        lastFinishedAt: FieldValue.serverTimestamp(),
        ...extra,
      },
      { merge: true }
    );
  } catch (e) {
    logger.warn("autoPipeline: releaseRunLock failed", {
      err: String(e?.message || e).slice(0, 200),
    });
  }
}

export const autoSupplierInvoicePipeline = onSchedule(
  {
    schedule: "every 30 minutes",
    timeZone: "Europe/Istanbul",
    region: "europe-west1",
    timeoutSeconds: 540,
    memory: "1GiB",
    retryCount: 0,
    concurrency: 1,
  },
  async (event) => {
    const startedAtMs = Date.now();
    const lock = await acquireRunLock(startedAtMs);
    if (!lock.acquired) {
      logger.info("autoPipeline: skip (lock)", {
        reason: lock.reason,
        lockedUntilMs: lock.lockedUntilMs || null,
        jobName: event?.jobName || null,
      });
      return;
    }

    const summary = {
      step1: null,
      step2: null,
      step3: null,
      step4: null,
      errors: [],
      elapsedMs: 0,
    };

    try {
      try {
        summary.step1 = await runStep1IngestSupplierInvoices(startedAtMs);
      } catch (e) {
        const msg = String(e?.message || e);
        summary.errors.push({ step: "step1", error: msg.slice(0, 400) });
        logger.error("autoPipeline step1 failed", { err: msg });
      }

      try {
        summary.step2 = await runStep2SyncDespatches(Date.now());
      } catch (e) {
        const msg = String(e?.message || e);
        summary.errors.push({ step: "step2", error: msg.slice(0, 400) });
        logger.error("autoPipeline step2 failed", { err: msg });
      }

      try {
        summary.step3 = await runStep3BackfillEttn(Date.now());
      } catch (e) {
        const msg = String(e?.message || e);
        summary.errors.push({ step: "step3", error: msg.slice(0, 400) });
        logger.error("autoPipeline step3 failed", { err: msg });
      }

      try {
        summary.step4 = await runStep4EnrichDespatchUbl(Date.now());
      } catch (e) {
        const msg = String(e?.message || e);
        summary.errors.push({ step: "step4", error: msg.slice(0, 400) });
        logger.error("autoPipeline step4 failed", { err: msg });
      }
    } finally {
      summary.elapsedMs = Date.now() - startedAtMs;
      logger.info("autoPipeline: completed", summary);
      await releaseRunLock({
        lastSummary: summary,
        lastSuccessAt:
          summary.errors.length === 0
            ? FieldValue.serverTimestamp()
            : FieldValue.delete(),
      });
    }
  }
);
