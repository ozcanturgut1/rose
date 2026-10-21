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

/**
 * Türk e-belge no parçaları: harf serisi + 4 haneli yıl + sıra.
 * Kısa yazım: SERİ + YY + kısa sıra (MYF26-1614 → MYF / 2026 / 1614).
 * @returns {{ prefix: string, year: string, serial: string } | null}
 */
export function parseEBelgeParts(raw) {
  const key = belgeNoKey(raw);
  if (!key) return null;
  const mFull = key.match(/^([A-Z]+)(20\d{2})(\d+)$/);
  if (mFull) {
    return {
      prefix: mFull[1],
      year: mFull[2],
      serial: String(parseInt(mFull[3], 10)),
    };
  }
  const mShort = key.match(/^([A-Z]+)(\d{2})(\d+)$/);
  if (mShort) {
    return {
      prefix: mShort[1],
      year: `20${mShort[2]}`,
      serial: String(parseInt(mShort[3], 10)),
    };
  }
  return null;
}

/** Orijinal key + mümkünse prefix+year+serial.padStart(9,"0") aday anahtarları. */
export function expandEBelgeCandidates(raw) {
  const key = belgeNoKey(raw);
  const out = [];
  if (key) out.push(key);
  const parts = parseEBelgeParts(raw);
  if (parts) {
    const expanded = `${parts.prefix}${parts.year}${parts.serial.padStart(9, "0")}`;
    if (!out.includes(expanded)) out.push(expanded);
  }
  return out;
}

export function belgeNosEquivalent(a, b) {
  const ka = belgeNoKey(a);
  const kb = belgeNoKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const pa = parseEBelgeParts(a);
  const pb = parseEBelgeParts(b);
  if (!pa || !pb) return false;
  return pa.prefix === pb.prefix && pa.year === pb.year && pa.serial === pb.serial;
}

/**
 * Listede belge no eşleşmesi: exact → expand exact → loose (tek aday).
 * Birden fazla loose adayda null (yanlış eşleşme yok).
 * @param {object[]} items
 * @param {string} wantRaw
 * @param {(it: object) => string|null} [getBelgeNo]
 */
export function pickBelgeNoMatch(items, wantRaw, getBelgeNo = itemBelgeNo) {
  const arr = Array.isArray(items) ? items : [];
  const want = belgeNoKey(wantRaw);
  if (!want) return null;

  const exact = arr.find((it) => belgeNoKey(getBelgeNo(it)) === want);
  if (exact) return exact;

  const candidates = expandEBelgeCandidates(wantRaw);
  for (const cand of candidates) {
    if (cand === want) continue;
    const hit = arr.find((it) => belgeNoKey(getBelgeNo(it)) === cand);
    if (hit) return hit;
  }

  const wantParts = parseEBelgeParts(wantRaw);
  if (!wantParts) return null;
  const loose = arr.filter((it) => {
    const bn = getBelgeNo(it);
    if (bn == null || bn === "") return false;
    return belgeNosEquivalent(wantRaw, bn);
  });
  if (loose.length === 1) return loose[0];
  return null;
}

/** Firestore doc id: despatch_<safeBelgeNo> */
export function despatchDocIdFromBelgeNo(belgeNo) {
  const safe = String(belgeNo || "").replace(/[/\\]/g, "_").trim();
  if (!safe) return null;
  return `despatch_${safe}`;
}

/** Kısa/uzun no için denenecek qnb_docs doc id listesi (ilk benzersiz). */
export function despatchDocIdCandidates(belgeNo) {
  const seen = new Set();
  const out = [];
  const add = (raw) => {
    const id = despatchDocIdFromBelgeNo(raw);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  add(belgeNo);
  for (const key of expandEBelgeCandidates(belgeNo)) add(key);
  const parts = parseEBelgeParts(belgeNo);
  if (parts) {
    // Kısa alias formları da dene (MYF26-1614 / MYF261614)
    add(`${parts.prefix}${parts.year.slice(2)}-${parts.serial}`);
    add(`${parts.prefix}${parts.year.slice(2)}${parts.serial}`);
  }
  return out;
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
    const item = pickBelgeNoMatch(items, belgeNo);
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
