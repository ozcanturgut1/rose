import { onRequest } from "firebase-functions/v2/https";
import { requireAuth, requireRole, ROLES_QNB_READ } from "./requireAuth.js";
import { callConnector } from "./qnbCall.js";

const setCors = (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

function normalizeListItems(listResponse) {
  const items =
    listResponse?.return || listResponse?.["return"] || listResponse?.["return[]"] || [];
  const arr = Array.isArray(items) ? items : [items];
  return arr.filter((x) => x != null && typeof x === "object");
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

function isConnectorFault(e) {
  const msg = String(e?.message || e || "");
  return /NullPointerException|ns2:Server|SOAP\s*Fault/i.test(msg);
}

function toYyyyMmDd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function yyyyMmDdCompactFromYmd(ymdHyphen) {
  const t = String(ymdHyphen).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return t.replace(/-/g, "");
}

function parseQueryYyyyMmDd(s) {
  if (s == null || s === "") return null;
  const t = String(s).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const [y, m, d] = t.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return t;
}

/** Ertesi takvim günü (YYYY-MM-DD). Tek günlük sorguda QNB bitişi genelde hariç tuttuğu için kullanılır. */
function addOneCalendarDayYmd(ymdHyphen) {
  const t = String(ymdHyphen).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const [y, m, d] = t.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + 1);
  return toYyyyMmDd(dt);
}

/**
 * Geliş tarihini YYYY-MM-DD yapar; [dateSortKeyTutar] / portal biçimleriyle uyumlu.
 * Yalnızca ilk 8 haneyi YYYY-MM-DD saymak (ör. dd.mm.yyyy) hatalı sonuç verir.
 */
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

  if (/^\d{4}-\d{2}-\d{2}/.test(t)) {
    return t.slice(0, 10);
  }

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

/**
 * Tek günlük sorguda süzüm. Hiçbir satırda geliş tarihi çözülemiyorsa (format bilinmiyor) ham listeyi ver;
 * çözülen var ama hiçbiri seçilen güne denk gelmiyorsa boş dönmek doğrudur.
 */
function filterItemsToSingleGelisDay(items, ymd) {
  const filtered = items.filter((it) => {
    const g = gelisYyyyMmDdFromAnyItem(it);
    return g != null && g === ymd;
  });
  if (filtered.length > 0) return filtered;
  if (items.length === 0) return filtered;
  const anyParsed = items.some((it) => gelisYyyyMmDdFromAnyItem(it) != null);
  if (!anyParsed) {
    console.warn("listGelenBelgeleriExt: tek gün süzümü — geliş tarihi çözülemedi, ham liste", {
      count: items.length,
      ymd,
    });
    return items;
  }
  return filtered;
}

function buildParametrelerExtRolling(vknTckn, start, onayDurum, gelisDays) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - gelisDays);
  const parametreler = {
    vergiTcKimlikNo: String(vknTckn),
    belgeTuru: "FATURA",
    sonAlinanBelgeSiraNumarasi: String(start),
    donusTipiVersiyon: "6.0",
    gelisTarihiBaslangic: yyyyMmDdCompactFromYmd(toYyyyMmDd(from)),
    gelisTarihiBitis: yyyyMmDdCompactFromYmd(toYyyyMmDd(to)),
  };
  if (onayDurum) parametreler.onayDurum = onayDurum;
  return parametreler;
}

function buildParametrelerExtDates(vknTckn, start, onayDurum, baslangicYmd, bitisYmd) {
  const parametreler = {
    vergiTcKimlikNo: String(vknTckn),
    belgeTuru: "FATURA",
    sonAlinanBelgeSiraNumarasi: String(start),
    donusTipiVersiyon: "6.0",
    gelisTarihiBaslangic: yyyyMmDdCompactFromYmd(baslangicYmd),
    gelisTarihiBitis: yyyyMmDdCompactFromYmd(bitisYmd),
  };
  if (onayDurum) parametreler.onayDurum = onayDurum;
  return parametreler;
}

async function callGelenBelgeleriListeleExtParam(p, useParametrelerWrapper) {
  if (useParametrelerWrapper) {
    return await callConnector("gelenBelgeleriListeleExt", { parametreler: p });
  }
  return await callConnector("gelenBelgeleriListeleExt", p);
}

async function fetchExtOnePageWithParams(vknTckn, onayDurum, buildP) {
  let useWrapper = true;
  try {
    const p = buildP();
    return await callGelenBelgeleriListeleExtParam(p, useWrapper);
  } catch (e) {
    if (!useWrapper) throw e;
    const p = buildP();
    return await callGelenBelgeleriListeleExtParam(p, false);
  }
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

function mapTutarItemForClient(it) {
  const gelRaw = it.faturaGelisTarihi ?? it.gelisTarihi ?? it.gonderimTarihi ?? "";
  const gelDigits = String(gelRaw).replace(/\D/g, "");
  const faturaGelisTarihi =
    gelDigits.length >= 8 ? gelDigits.slice(0, 17) : (it.faturaGelisTarihi ?? gelRaw);

  /** gelenBelgeTutarBilgileri: bazen saticiUnvan null; unvan alanları PascalCase gelebilir */
  const unvan =
    it.saticiUnvan ??
    it.SaticiUnvan ??
    it.gondericiUnvan ??
    it.GondericiUnvan ??
    it.gonderenUnvan ??
    it.gondericiIsim ??
    it.gonderenIsim;

  const { attributes: _attrs, ...rest } = it;

  return {
    ...rest,
    saticiUnvan: unvan != null && String(unvan).trim() !== "" ? String(unvan).trim() : null,
    faturaGelisTarihi,
    odenecekTutarDovizCinsi: it.odenecekTutarDovizCinsi ?? it.paraBirimi,
  };
}

async function fetchViaTutarBilgileriRange(vknTckn, lim, baslangicYmd, bitisYmd) {
  let listResp;
  try {
    listResp = await callConnector("gelenBelgeTutarBilgileriSorgula", {
      vergiTcKimlikNo: String(vknTckn),
      belgeTuru: "FATURA",
      baslangicGelisTarihi: baslangicYmd,
      bitisGelisTarihi: bitisYmd,
    });
  } catch (e) {
    const errStr = String(e?.message || e);
    if (/NullPointerException|ns2:Server/i.test(errStr)) {
      return [];
    }
    throw e;
  }

  let items = normalizeListItems(listResp);
  items = items.slice().sort((a, b) => dateSortKeyTutar(b).localeCompare(dateSortKeyTutar(a)));
  items = items.slice(0, lim);
  return items.map(mapTutarItemForClient);
}

async function fetchViaTutarBilgileriRolling(vknTckn, lim, daysBack) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - daysBack);
  return fetchViaTutarBilgileriRange(vknTckn, lim, toYyyyMmDd(from), toYyyyMmDd(to));
}

/** Aynı faturayı iki kaynaktan birleştirirken tekrarları elemek için. */
function invoiceDedupeKey(it) {
  const bn =
    it.belgeNo != null && String(it.belgeNo).trim() !== ""
      ? String(it.belgeNo).trim()
      : null;
  if (bn) return `b:${bn}`;
  const e = it.ettn ?? it.ETTN;
  if (e != null && String(e).trim() !== "") return `e:${String(e).trim()}`;
  const oid = it.belgeOid ?? it.uuid ?? it.id;
  if (oid != null && String(oid).trim() !== "") return `o:${String(oid).trim()}`;
  return null;
}

/**
 * gelenBelgeTutarBilgileriSorgula tek yanıtta (çoğu ortamda ~150) sınırlı döner.
 * [lim]'e ulaşana kadar gelenBelgeleriListeleExt ile sonAlinanBelgeSiraNumarasi sayfalanır.
 */
async function fetchExtPagedFillToLimit({
  vknTckn,
  onayDurum,
  apiBaslangic,
  apiBitis,
  singleDayYmd,
  lim,
  seed,
}) {
  const seen = new Set();
  const out = [];
  for (const it of seed) {
    const k = invoiceDedupeKey(it);
    if (k != null && seen.has(k)) continue;
    if (k != null) seen.add(k);
    out.push(it);
  }
  let start = 0;
  const maxPages = 40;
  for (let page = 0; page < maxPages && out.length < lim; page++) {
    let listResp;
    try {
      listResp = await fetchExtOnePageWithParams(vknTckn, onayDurum, () =>
        buildParametrelerExtDates(vknTckn, start, onayDurum, apiBaslangic, apiBitis)
      );
    } catch (e) {
      if (!isConnectorFault(e)) throw e;
      console.warn("listGelenBelgeleriExt: Ext paged page failed", {
        start,
        err: String(e?.message || e).slice(0, 200),
      });
      break;
    }
    let arr = normalizeListItems(listResp);
    arr = arr.slice().sort((a, b) => gelisSortKey(b).localeCompare(gelisSortKey(a)));
    if (singleDayYmd != null) {
      arr = filterItemsToSingleGelisDay(arr, singleDayYmd);
    }
    let addedNew = 0;
    for (const raw of arr) {
      if (out.length >= lim) break;
      const k = invoiceDedupeKey(raw);
      if (k != null && seen.has(k)) continue;
      if (k != null) seen.add(k);
      out.push(mapTutarItemForClient(raw));
      addedNew++;
    }
    if (arr.length === 0) break;
    start += arr.length;
    if (arr.length > 0 && addedNew === 0) {
      // Yinelenen sayfa; ilerleme yok — döngüyü kır (sonsuz döngü önlemi).
      break;
    }
  }
  return out.slice(0, lim);
}

export const listGelenBelgeleriExt = onRequest({ region: "europe-west1" }, async (req, res) => {
  try {
    setCors(req, res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

    const user = await requireAuth(req);
    await requireRole(user.uid, ROLES_QNB_READ);

    const vknTckn = process.env.QNB_VKN_TCKN;
    if (!vknTckn) return res.status(500).json({ error: "QNB_VKN_TCKN missing in .env" });

    const gelisBaslangic = parseQueryYyyyMmDd(req.query.gelisBaslangic ?? req.query.from);
    const gelisBitis = parseQueryYyyyMmDd(req.query.gelisBitis ?? req.query.to);
    const hasExplicitRange = gelisBaslangic != null && gelisBitis != null;
    const hasPartialRange = (gelisBaslangic != null) !== (gelisBitis != null);

    if (hasPartialRange) {
      return res.status(400).json({
        error: "Tarih aralığı için hem gelisBaslangic hem gelisBitis gerekli (YYYY-MM-DD).",
      });
    }

    let lim = 10;
    const limMax = hasExplicitRange ? 2000 : 50;
    if (req.query.limit != null) {
      const n = Number(req.query.limit);
      if (Number.isFinite(n) && n > 0) lim = Math.min(n, limMax);
    } else if (hasExplicitRange) {
      // Tarih aralığında tek istekte en fazla kayıt (Flutter / QnbApi ile uyumlu üst sınır: 2000).
      lim = 2000;
    }

    const onayParam = req.query.onayDurum != null ? String(req.query.onayDurum).trim() : "";
    const onayDurum =
      onayParam === "ONAYBEKLEYEN" || onayParam === "ONAYLANAN" || onayParam === "HEPSI"
        ? onayParam
        : "HEPSI";

    let merged = [];
    let source = "gelenBelgeTutarBilgileriSorgula";
    let rangeMeta = null;

    if (hasExplicitRange) {
      if (gelisBaslangic > gelisBitis) {
        return res.status(400).json({ error: "gelisBaslangic, gelisBitis’ten büyük olamaz." });
      }
      rangeMeta = { gelisBaslangic, gelisBitis };
      // Tek gün: portala bitiş = başlangıç verilince boş dönebiliyor; bitişi ertesi güne alıp yalnız o güne süz.
      const singleDayYmd = gelisBaslangic === gelisBitis ? gelisBaslangic : null;
      const apiBaslangic = gelisBaslangic;
      const apiBitis = singleDayYmd != null ? addOneCalendarDayYmd(gelisBaslangic) : gelisBitis;

      merged = await fetchViaTutarBilgileriRange(vknTckn, lim, apiBaslangic, apiBitis);
      if (singleDayYmd != null) {
        merged = filterItemsToSingleGelisDay(merged, singleDayYmd);
      }

      // Bazı ortamlarda tek gün için başlangıç=bitiş tutar sorgusu dolu döner; +1 gün stratejisi boşsa dene.
      if (merged.length === 0 && singleDayYmd != null) {
        const alt = await fetchViaTutarBilgileriRange(
          vknTckn,
          lim,
          gelisBaslangic,
          gelisBitis,
        );
        let altFiltered = filterItemsToSingleGelisDay(alt, singleDayYmd);
        merged = altFiltered.length > 0 ? altFiltered : alt;
      }

      if (merged.length === 0) {
        try {
          const listResp = await fetchExtOnePageWithParams(vknTckn, onayDurum, () =>
            buildParametrelerExtDates(vknTckn, 0, onayDurum, apiBaslangic, apiBitis)
          );
          let arr = normalizeListItems(listResp);
          arr = arr.slice().sort((a, b) => gelisSortKey(b).localeCompare(gelisSortKey(a)));
          merged = arr.slice(0, lim);
          if (singleDayYmd != null) {
            merged = filterItemsToSingleGelisDay(merged, singleDayYmd);
          }
          source = "gelenBelgeleriListeleExt";
        } catch (e) {
          if (!isConnectorFault(e)) throw e;
          console.warn("listGelenBelgeleriExt: Ext range fallback failed", e?.message);
        }
      }

      // Tek gün: Ext’te genişletilmiş tarih boş döndüyse aynı başlangıç/bitiş (YYYYMMDD) ile bir kez daha dene.
      if (merged.length === 0 && singleDayYmd != null) {
        try {
          const listRespSame = await fetchExtOnePageWithParams(vknTckn, onayDurum, () =>
            buildParametrelerExtDates(vknTckn, 0, onayDurum, gelisBaslangic, gelisBitis)
          );
          let arr = normalizeListItems(listRespSame);
          arr = arr.slice().sort((a, b) => gelisSortKey(b).localeCompare(gelisSortKey(a)));
          merged = arr.slice(0, lim);
          merged = filterItemsToSingleGelisDay(merged, singleDayYmd);
          if (merged.length > 0) {
            source = "gelenBelgeleriListeleExt";
          }
        } catch (e) {
          if (!isConnectorFault(e)) throw e;
          console.warn("listGelenBelgeleriExt: Ext tek gün (aynı tarih) fallback failed", e?.message);
        }
      }

      // gelenBelgeTutarBilgileriSorgula tek yanıtta çoğu ortamda ~150 satırla sınırlı; lim'e ulaşana kadar Ext ile sayfala.
      if (merged.length < lim) {
        try {
          const before = merged.length;
          merged = await fetchExtPagedFillToLimit({
            vknTckn,
            onayDurum,
            apiBaslangic,
            apiBitis,
            singleDayYmd,
            lim,
            seed: merged,
          });
          if (merged.length > before) {
            source = source.includes("gelenBelgeleriListeleExt")
              ? "gelenBelgeleriListeleExt (sayfalı)"
              : `${source} + gelenBelgeleriListeleExt (sayfalı)`;
          }
        } catch (e) {
          if (!isConnectorFault(e)) throw e;
          console.warn("listGelenBelgeleriExt: Ext sayfalı tamamlama başarısız", e?.message);
        }
      }
    } else {
      merged = await fetchViaTutarBilgileriRolling(vknTckn, lim, 90);
      if (merged.length < lim) {
        const wider = await fetchViaTutarBilgileriRolling(vknTckn, lim, 365);
        if (wider.length > merged.length) merged = wider;
      }

      if (merged.length === 0) {
        try {
          const listResp = await fetchExtOnePageWithParams(vknTckn, onayDurum, () =>
            buildParametrelerExtRolling(vknTckn, 0, onayDurum, 365)
          );
          let arr = normalizeListItems(listResp);
          arr = arr.slice().sort((a, b) => gelisSortKey(b).localeCompare(gelisSortKey(a)));
          merged = arr.slice(0, lim);
          source = "gelenBelgeleriListeleExt";
        } catch (e) {
          if (!isConnectorFault(e)) throw e;
          console.warn("listGelenBelgeleriExt: Ext rolling fallback failed", e?.message);
        }
      }
    }

    const items = merged.slice(0, lim);

    return res.status(200).json({
      source,
      belgeTuru: "FATURA",
      donusTipiVersiyon: source === "gelenBelgeleriListeleExt" ? "6.0" : null,
      onayDurum,
      ...rangeMeta,
      count: items.length,
      items,
    });
  } catch (error) {
    const code = error?.status;
    const status = typeof code === "number" && code >= 400 && code < 600 ? code : 500;
    if (status === 401 || status === 403) {
      return res.status(status).send(error.message || "Unauthorized");
    }
    console.error("listGelenBelgeleriExt:", error);
    return res.status(500).json({ error: error.message || "Internal Server Error" });
  }
});
