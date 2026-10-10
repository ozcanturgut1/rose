/**
 * Gelen irsaliyeyi portal listesinde belge numarasıyla bulur.
 *
 * `gelenBelgeleriListeleExt` (IRSALIYE) bir çağrıda en fazla ~100 satır döner ve
 * IRSALIYE'de `sonAlinanBelgeSiraNumarasi` ile sayfalama çalışmaz. Geniş bir tarih
 * aralığı tek çağrıda sorgulanırsa yoğun günlerde aranan irsaliye kesilen kısma
 * düşer ve sessizce "bulunamadı" sayılır (ör. ERD2026000002480'in irsaliyeleri:
 * 6 günlük pencere 100'de kesildi, 2 günlük dilimde bulundu).
 *
 * Bu yüzden arama küçük sorgulara bölünür ve ilk eşleşmede durulur:
 *   1) Belge tarihi biliniyorsa (fatura UBL'indeki DespatchDocumentReference/IssueDate)
 *      [tarih, tarih+1] belge tarihi sorgusu. İrsaliye portala ne zaman düşerse düşsün
 *      belge tarihi değişmez; çoğu durumda tek çağrı yeterlidir.
 *   2) Geliş tarihine göre 2 günlük dilimler.
 * Aynı gün (başlangıç == bitiş) sorgusu portalda 0 satır döndüğü için her dilim iki gündür.
 *
 * Modül yüklenirken ağ çağrısı yapmaz; çağrılar yalnızca fonksiyon içinde.
 */
import { logger } from "firebase-functions";
import { callConnector } from "./qnbCall.js";

export const PORTAL_LIST_CAP = 100;
const ISSUE_LOOKBEHIND_DAYS = 1;
const ISSUE_LOOKAHEAD_DAYS = 5;

export function belgeNoKey(s) {
  if (s == null) return "";
  return String(s).replace(/[\s.\-/_]/g, "").toUpperCase();
}

export function itemBelgeNo(it) {
  return it?.belgeNo ?? it?.belgeNoStr ?? it?.irsaliyeNo ?? it?.belgeNumarasi ?? null;
}

function normalizeListItems(resp) {
  if (!resp) return [];
  let raw = resp.return ?? resp.belgeListesi ?? resp.list ?? resp;
  if (raw?.belgeListesi) raw = raw.belgeListesi;
  if (raw?.belge) raw = Array.isArray(raw.belge) ? raw.belge : [raw.belge];
  if (raw?.item) raw = Array.isArray(raw.item) ? raw.item : [raw.item];
  const arr = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  return arr.filter((x) => x != null && typeof x === "object");
}

/** YYYY-MM-DD, YYYYMMDD, ISO veya GG.AA.YYYY → YYYY-MM-DD */
export function parseYmd(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

function addDays(ymd, days) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayIstanbul() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" }).format(new Date());
}

const compact = (ymd) => ymd.replace(/-/g, "");

/** [from..to] aralığını ardışık 2 günlük dilimlere böler; son dilim tek güne düşerse bir gün geri kayar. */
function twoDaySlices(from, to) {
  if (to < from) return [];
  if (to === from) return [{ from, to: addDays(from, 1) }];
  const out = [];
  let start = from;
  while (start <= to) {
    let end = addDays(start, 1);
    let s = start;
    if (end > to) {
      end = to;
      s = addDays(to, -1);
    }
    out.push({ from: s, to: end });
    start = addDays(start, 2);
  }
  return out;
}

/**
 * Sorgu planı. Tarih bilgisi yoksa ve `fallbackWindowDays` verilmemişse plan boştur
 * (çağıran taraf kendi yedek yoluna geçer).
 */
export function planDespatchQueries({ issueDate, from, to, fallbackWindowDays } = {}) {
  const today = todayIstanbul();
  const issue = parseYmd(issueDate);
  const queries = [];
  let window = null;

  if (issue) {
    queries.push({ by: "belgeTarihi", from: issue, to: addDays(issue, 1) });
  }

  const f = parseYmd(from);
  const t = parseYmd(to);
  if (f && t) {
    window = { from: f, to: t };
  } else if (issue) {
    const end = addDays(issue, ISSUE_LOOKAHEAD_DAYS);
    window = { from: addDays(issue, -ISSUE_LOOKBEHIND_DAYS), to: end > today ? today : end };
  } else if (fallbackWindowDays > 0) {
    window = { from: addDays(today, -(fallbackWindowDays - 1)), to: today };
  }

  if (window) {
    for (const s of twoDaySlices(window.from, window.to)) queries.push({ by: "gelisTarihi", ...s });
  }
  return { queries, window };
}

async function listDespatches(vknTckn, q) {
  const p = {
    vergiTcKimlikNo: String(vknTckn),
    belgeTuru: "IRSALIYE",
    donusTipiVersiyon: "6.0",
    onayDurum: "HEPSI",
  };
  if (q.by === "belgeTarihi") {
    p.faturaTarihiBaslangic = compact(q.from);
    p.faturaTarihiBitis = compact(q.to);
  } else {
    p.gelisTarihiBaslangic = compact(q.from);
    p.gelisTarihiBitis = compact(q.to);
  }
  let resp;
  try {
    resp = await callConnector("gelenBelgeleriListeleExt", { parametreler: p });
  } catch (_) {
    resp = await callConnector("gelenBelgeleriListeleExt", p);
  }
  return normalizeListItems(resp);
}

/**
 * @param {string} vknTckn
 * @param {string} belgeNo
 * @param {{ issueDate?: string, from?: string, to?: string, fallbackWindowDays?: number }} [opts]
 * @returns {Promise<{ item: object|null, error: string|null, window: {from:string,to:string}|null,
 *   queries: Array<{by:string, from:string, to:string, count?:number, error?:string}> }>}
 *   `error` yalnızca eşleşme yoksa ve en az bir sorgu hata verdiyse doludur; bu durumda
 *   "bulunamadı" kesin değildir.
 */
export async function findDespatchInPortal(vknTckn, belgeNo, opts = {}) {
  const want = belgeNoKey(belgeNo);
  const { queries, window } = planDespatchQueries(opts);
  const done = [];
  let lastError = null;

  for (const q of queries) {
    let items;
    try {
      items = await listDespatches(vknTckn, q);
    } catch (e) {
      lastError = String(e?.message || e).slice(0, 200);
      done.push({ ...q, error: lastError });
      continue;
    }
    done.push({ ...q, count: items.length });
    const item = items.find((it) => belgeNoKey(itemBelgeNo(it)) === want) || null;
    if (item) return { item, error: null, window, queries: done };
    if (items.length >= PORTAL_LIST_CAP) {
      logger.warn("findDespatchInPortal: dilim liste sınırına ulaştı, sonuç eksik olabilir", {
        belgeNo,
        ...q,
        count: items.length,
      });
    }
  }
  return { item: null, error: lastError, window, queries: done };
}
