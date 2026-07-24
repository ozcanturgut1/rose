import sql from "mssql";
import { getFirestore } from "firebase-admin/firestore";
import { resolveSqlTargets } from "./sqlDbTargets.js";
import {
  alignTevkifatSplitToPayable,
  computeTevkifatKdvSplit,
  convertDocAmountToTlIfNeeded,
  roundMoney,
} from "./tevkifatMuhasebe.js";
import {
  computeUblExactAmounts,
  strictLineNetFromUbl,
  strictLineTaxFromUbl,
  strictLineUnitPriceFromUbl,
} from "./ublExactAmounts.js";
import { resolveAmountModel } from "./ublAuthoritativeAmounts.js";
import {
  loadAracGiderKurallari,
  detectGiderTuru,
  giderMetniFromLines,
  binekHesaplarForTuru,
} from "./aracGiderKurallari.js";

let readPoolPromise = null;
let writePoolPromise = null;
let cachedDefaults = null;
let validatedWriteProcedures = false;
let cachedStkkartColumnNames = null;
let validatedDenemeMuhasebeProcedure = false;
let validatedBinekAracProcedure = false;

function sqlConfig(database) {
  const t = resolveSqlTargets();
  return {
    user: t.user,
    password: t.password,
    server: t.host,
    port: t.port,
    database,
    options: {
      encrypt: false,
      trustServerCertificate: true,
      enableArithAbort: true,
    },
    pool: {
      max: 5,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  };
}

async function readPool() {
  if (!readPoolPromise) {
    readPoolPromise = new sql.ConnectionPool(sqlConfig(resolveSqlTargets().readDb)).connect();
  }
  return await readPoolPromise;
}

async function writePool() {
  if (!writePoolPromise) {
    writePoolPromise = new sql.ConnectionPool(sqlConfig(resolveSqlTargets().writeDb)).connect();
  }
  return await writePoolPromise;
}

async function ensureWriteProcedures(pool) {
  if (validatedWriteProcedures) return;
  const required = [
    "sp_Fatura_Kayit",
    "sp_Fatura_Detay_Kayit",
    "sp_FatFisToplam_Kayit",
  ];
  const rs = await pool.request().query(
    `SELECT name FROM sys.procedures WHERE name IN (${required.map((n) => `'${n}'`).join(",")})`
  );
  const found = new Set(rs.recordset.map((r) => String(r.name)));
  const missing = required.filter((n) => !found.has(n));
  if (missing.length) {
    const dbName = resolveSqlTargets().writeDb;
    throw new Error(
      `Write DB '${dbName}' missing stored procedures: ${missing.join(", ")}`
    );
  }
  validatedWriteProcedures = true;
}

async function ensureDenemeMuhasebeProcedure(pool) {
  if (validatedDenemeMuhasebeProcedure) return;
  const rs = await pool
    .request()
    .query("SELECT TOP 1 name FROM sys.procedures WHERE name='sp_Fatura_Muhasebe_Bagla_Deneme'");
  if (!rs.recordset.length) {
    const dbName = resolveSqlTargets().writeDb;
    throw new Error(`Write DB '${dbName}' missing procedure: sp_Fatura_Muhasebe_Bagla_Deneme`);
  }
  validatedDenemeMuhasebeProcedure = true;
}

async function tryAutoMuhasebeForDeneme(wPool, fatFisRefNo, opts) {
  const writeDb = String(resolveSqlTargets().writeDb || "").trim().toLowerCase();
  const isDeneme = writeDb === "eta_deneme_2026";
  const enabled = String(process.env.ETA_DENEME_AUTO_MUHASEBE ?? "1").trim() !== "0";
  if (!isDeneme || !enabled) return;
  await ensureDenemeMuhasebeProcedure(wPool);
  const req = wPool.request();
  req.input("FatFisRefNo", sql.Int, fatFisRefNo);
  const refFatFisRefNo = Number(opts?.refFatFisRefNo || 0);
  req.input(
    "RefFatFisRefNo",
    sql.Int,
    Number.isFinite(refFatFisRefNo) && refFatFisRefNo > 0 ? refFatFisRefNo : null
  );
  req.output("MuhFisRefNo", sql.Int);
  await req.execute("dbo.sp_Fatura_Muhasebe_Bagla_Deneme");
}

async function ensureBinekAracProcedure(wPool) {
  if (validatedBinekAracProcedure) return;
  const rs = await wPool
    .request()
    .query("SELECT TOP 1 name FROM sys.procedures WHERE name='sp_Fatura_Muhasebe_Bagla_BinekArac'");
  if (!rs.recordset.length) {
    const dbName = resolveSqlTargets().writeDb;
    throw new Error(
      `Write DB '${dbName}' missing procedure: sp_Fatura_Muhasebe_Bagla_BinekArac. ` +
        `Deploy: node scripts/patchSpFaturaMuhasebeBaglaBinekArac.js --apply --confirm-write-db=${dbName}`
    );
  }
  validatedBinekAracProcedure = true;
}

/**
 * Binek araç gideri muhasebe fişini binek prosedürüyle oluşturur.
 * Tüm gider türleri işlenir: KIRA (aylık limit), diğerleri (%70/%30 + indirilemeyen
 * KDV). Yalnızca deneme write DB'de çalışır.
 * Dönüş: { skipped: bool, reason?, giderTuru, ... }
 */
async function tryBinekAracMuhasebe(wPool, fatFisRefNo, opts) {
  const writeDb = String(resolveSqlTargets().writeDb || "").trim().toLowerCase();
  const isDeneme = writeDb === "eta_deneme_2026";
  const enabled = String(process.env.ETA_DENEME_AUTO_MUHASEBE ?? "1").trim() !== "0";
  if (!isDeneme || !enabled) return { skipped: true, reason: "muhasebe_disabled" };

  const giderTuru = String(opts?.giderTuru || "DIGER").toUpperCase();
  const rules = opts?.rules || {};
  const h = rules.hesaplar || {};
  const { kabulHesap, kkegHesap } = binekHesaplarForTuru(giderTuru, h);
  const indirilemeyenKdv = h.indirilemeyenKdv;
  if (!kabulHesap || !kkegHesap || !indirilemeyenKdv) {
    return { skipped: true, reason: "hesap_kodu_eksik", giderTuru };
  }

  await ensureBinekAracProcedure(wPool);
  const req = wPool.request();
  req.input("FatFisRefNo", sql.Int, fatFisRefNo);
  req.output("MuhFisRefNo", sql.Int);
  req.input("GiderTuru", sql.NVarChar(10), giderTuru);
  req.input("KabulHesap", sql.VarChar(40), kabulHesap);
  req.input("KkegHesap", sql.VarChar(40), kkegHesap);
  req.input("IndirilemeyenKdvHesap", sql.VarChar(40), indirilemeyenKdv);
  req.input("KabulOrani", sql.Decimal(9, 4), Number(rules.giderKabulOrani) || 0.7);
  req.input("KiraLimiti", sql.Decimal(28, 2), Number(rules.kiraAylikLimit) || 46000);
  await req.execute("dbo.sp_Fatura_Muhasebe_Bagla_BinekArac");
  return { skipped: false, giderTuru, kabulHesap, kkegHesap };
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replaceAll("ı", "i")
    .trim();
}

function firstOf(x) {
  if (Array.isArray(x)) return x.length ? x[0] : null;
  return x ?? null;
}

function ublItemIdentificationId(ident) {
  if (!ident) return "";
  const node = firstOf(ident);
  if (!node) return "";
  if (typeof node === "object") {
    const idNode = firstOf(node.ID);
    return textNode(idNode || node).trim();
  }
  return textNode(node).trim();
}

function textNode(x) {
  const v = firstOf(x);
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    const m = v;
    const t = m["#text"] ?? m["#TEXT"] ?? m._ ?? m.value;
    if (t != null) return String(t).trim();
  }
  return "";
}

/** UBL `cbc:Description` (Item); birden fazlaysa birleştirilir. */
function collectItemDescriptions(item) {
  if (!item || typeof item !== "object") return [];
  const d = item.Description;
  const parts = [];
  const pushOne = (v) => {
    const s = textNode(v);
    if (s) parts.push(s);
  };
  if (typeof d === "string" || typeof d === "number") {
    pushOne(d);
    return parts;
  }
  if (Array.isArray(d)) {
    for (const x of d) pushOne(x);
    return parts;
  }
  if (d != null) pushOne(d);
  return parts;
}

/** UBL `cbc:Note` (InvoiceLine); birden fazlaysa birleştirilir. */
function collectInvoiceLineNotes(line) {
  if (!line || typeof line !== "object") return [];
  const n = line.Note;
  const parts = [];
  const pushOne = (v) => {
    const s = textNode(v);
    if (s) parts.push(s);
  };
  if (typeof n === "string" || typeof n === "number") {
    pushOne(n);
    return parts;
  }
  if (Array.isArray(n)) {
    for (const x of n) pushOne(x);
    return parts;
  }
  if (n != null) pushOne(n);
  return parts;
}

function parseNum(v, def = 0) {
  if (v == null) return def;
  if (typeof v === "number") return Number.isFinite(v) ? v : def;
  const raw = String(v).trim();
  if (!raw) return def;
  const s = raw.replace(/\s+/g, "");
  let normalized = s;
  const commaIdx = s.lastIndexOf(",");
  const dotIdx = s.lastIndexOf(".");
  if (commaIdx >= 0 && dotIdx >= 0) {
    if (commaIdx > dotIdx) {
      // 1.234,56 -> 1234.56
      normalized = s.replaceAll(".", "").replace(",", ".");
    } else {
      // 1,234.56 -> 1234.56
      normalized = s.replaceAll(",", "");
    }
  } else if (commaIdx >= 0) {
    // 1234,56 -> 1234.56
    normalized = s.replace(",", ".");
  } else {
    // 1234.56 or 123456
    normalized = s;
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : def;
}

function parseExchangeRate(v, def = 1) {
  if (v == null || v === "") return def;
  if (typeof v === "number") {
    return Number.isFinite(v) && v > 0 ? v : def;
  }
  const raw = String(v).trim();
  if (!raw) return def;
  const s = raw.replace(/\s+/g, "");
  let normalized = s;
  const commaIdx = s.lastIndexOf(",");
  const dotIdx = s.lastIndexOf(".");
  if (commaIdx >= 0 && dotIdx >= 0) {
    if (commaIdx > dotIdx) {
      normalized = s.replaceAll(".", "").replace(",", ".");
    } else {
      normalized = s.replaceAll(",", "");
    }
  } else if (commaIdx >= 0) {
    normalized = s.replace(",", ".");
  }
  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function parseYmd(raw) {
  const s = String(raw || "").trim();
  if (!s) return new Date();
  if (/^\d{8}$/.test(s)) {
    // UTC midnight: mssql (useUTC=true default) Date'i UTC bileşenleriyle gönderir;
    // lokal-midnight üretirsek TR (+03) ile 1 gün öncesine kayar.
    const y = Number(s.slice(0, 4));
    const m = Number(s.slice(4, 6));
    const d = Number(s.slice(6, 8));
    return new Date(Date.UTC(y, m - 1, d));
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function upper(s) {
  return String(s || "").toUpperCase();
}

/** Fatura yurtiçi TL ise (döviz dışı): kod boş, TRY veya TL. */
function isDomesticTryOrTl(currencyCode) {
  const c = String(currencyCode || "").trim().toUpperCase();
  return c === "" || c === "TRY" || c === "TL";
}

/** QNB + UBL birleşik fatura döviz kodu. */
function extractInvoiceCurrency(afterData) {
  const q = afterData?.qnbRaw && typeof afterData.qnbRaw === "object" ? afterData.qnbRaw : {};
  const ubl = extractCurrencyCodeFromUbl(afterData);
  return String(q.odenecekTutarDovizCinsi || q.paraBirimi || ubl || "").trim().toUpperCase();
}

function normalizeVknDigits(supplierVkn) {
  return String(supplierVkn || "").replace(/\D/g, "");
}

const VKN_CARI_SQL =
  "REPLACE(REPLACE(ISNULL(CARVERHESNO,''),' ',''),'-','') = @vkn";

// Gerçek kişi (TCKN'li) carilerde CARVERHESNO boş olabilir; TC kimlik no ETA'da
// KIMLIKLER tablosunda (KIMMODUL=2, cari kimlikleri) KIMMERNISNO alanında,
// KIMKOD = CARKOD ilişkisiyle tutulur. Bu koşul, VKN eşleşmesine EK olarak kullanılır.
const KIMLIK_TCKN_SQL =
  "REPLACE(REPLACE(ISNULL(k.KIMMERNISNO,''),' ',''),'-','') = @vkn";

async function listCariKodsForVkn(pool, supplierVkn) {
  const digits = normalizeVknDigits(supplierVkn);
  if (!digits) return [];
  const rs = await pool
    .request()
    .input("vkn", sql.NVarChar(40), digits)
    .query(
      `SELECT CARKOD FROM (
         SELECT CARKOD FROM dbo.CARKART WITH (NOLOCK) WHERE ${VKN_CARI_SQL}
         UNION
         SELECT k.KIMKOD AS CARKOD
           FROM dbo.KIMLIKLER k WITH (NOLOCK)
           INNER JOIN dbo.CARKART c WITH (NOLOCK) ON c.CARKOD = k.KIMKOD
          WHERE k.KIMMODUL = 2 AND ${KIMLIK_TCKN_SQL}
       ) q
       ORDER BY CARKOD`
    );
  return (rs.recordset || []).map((r) => String(r.CARKOD || "").trim()).filter(Boolean);
}

/** Read DB: VKN + FATFISDOVKOD geçmişine göre en uygun cari. */
async function pickCariByDovizHistoryForVkn(rPool, supplierVkn, currencyCode) {
  const digits = normalizeVknDigits(supplierVkn);
  if (!digits) return null;
  const dovKod = isDomesticTryOrTl(currencyCode)
    ? "TRY"
    : String(currencyCode || "").trim().toUpperCase();
  const rs = await rPool
    .request()
    .input("vkn", sql.NVarChar(40), digits)
    .input("dovKod", sql.NVarChar(10), dovKod)
    .query(`
      SELECT TOP 1 F.FATFISCARKOD AS CARKOD, COUNT(*) AS CNT
      FROM dbo.FATFIS F WITH (NOLOCK)
      INNER JOIN dbo.CARKART C WITH (NOLOCK) ON C.CARKOD = F.FATFISCARKOD
      WHERE (
              REPLACE(REPLACE(ISNULL(C.CARVERHESNO,''),' ',''),'-','') = @vkn
              OR EXISTS (
                SELECT 1 FROM dbo.KIMLIKLER k WITH (NOLOCK)
                 WHERE k.KIMMODUL = 2 AND k.KIMKOD = C.CARKOD
                   AND ${KIMLIK_TCKN_SQL}
              )
            )
        AND UPPER(ISNULL(NULLIF(LTRIM(RTRIM(F.FATFISDOVKOD)), ''), 'TRY')) =
            UPPER(ISNULL(NULLIF(LTRIM(RTRIM(@dovKod)), ''), 'TRY'))
      GROUP BY F.FATFISCARKOD
      ORDER BY COUNT(*) DESC, F.FATFISCARKOD
    `);
  const row = rs.recordset[0];
  const carkod = String(row?.CARKOD || "").trim();
  if (!carkod) return null;
  return { carkod, reason: `history_dov_${dovKod}` };
}

function normalizeMatchText(s) {
  return String(s || "")
    .toLowerCase()
    .replaceAll("ı", "i")
    .replaceAll("İ", "i")
    .replaceAll("ğ", "g")
    .replaceAll("Ğ", "g")
    .replaceAll("ü", "u")
    .replaceAll("Ü", "u")
    .replaceAll("ş", "s")
    .replaceAll("Ş", "s")
    .replaceAll("ö", "o")
    .replaceAll("Ö", "o")
    .replaceAll("ç", "c")
    .replaceAll("Ç", "c")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(s) {
  const t = normalizeMatchText(s);
  if (!t) return new Set();
  return new Set(t.split(" "));
}

function jaccardSimilarity(a, b) {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const x of sa) {
    if (sb.has(x)) inter++;
  }
  const uni = sa.size + sb.size - inter;
  return uni > 0 ? inter / uni : 0;
}

function relativeDiff(a, b) {
  const x = parseNum(a, 0);
  const y = parseNum(b, 0);
  if (x <= 0 || y <= 0) return 1;
  return Math.abs(x - y) / Math.max(x, y);
}

function isCodeLikeText(s) {
  const t = String(s || "").trim();
  if (!t) return false;
  if (t.length <= 3) return true;
  return /^[0-9\-_.\/]+$/.test(t);
}

function codeSimilarity(a, b) {
  const x = upper(a).trim();
  const y = upper(b).trim();
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.7;
  return 0;
}

/** Stok kartı ailesi öneki: A1, A3, B2 (STKKOD, "A3 75/72…" veya yalnızca "A3"). */
function parseStokAilePrefix(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const fromKod = t.match(/^([A-Za-z][0-9]?)-/i);
  if (fromKod) return fromKod[1].toUpperCase();
  const fromNote = t.match(/^([A-Za-z][0-9]?)\s+/);
  if (fromNote) return fromNote[1].toUpperCase();
  const exact = t.match(/^([A-Za-z][0-9]?)$/);
  if (exact) return exact[1].toUpperCase();
  return null;
}

/** Kullanıcı notu, satır açıklaması (A3 | …) veya description'dan aile öneki. */
function stokAilePrefixFromLine(line) {
  const sources = [
    line?.kullaniciKalemAciklama,
    line?.lineAciklama,
    line?.description,
  ];
  for (const raw of sources) {
    const t = String(raw || "").trim();
    if (!t) continue;
    const direct = parseStokAilePrefix(t);
    if (direct) return direct;
    const head = t.split("|")[0].trim();
    const fromHead = parseStokAilePrefix(head);
    if (fromHead) return fromHead;
  }
  return null;
}

function swapStokAilePrefix(stkKod, newPrefix) {
  const k = String(stkKod || "").trim();
  const p = String(newPrefix || "").trim().toUpperCase();
  const m = k.match(/^([A-Za-z][0-9]?)-(.+)$/i);
  if (!m || !p) return null;
  return `${p}-${m[2]}`;
}

/** Geçmiş eşleşme A1 iken kullanıcı notu A3 ise STKKART'ta A3-{suffix} dene. */
async function preferStockCodeForUserFamilyPrefix(wPool, stkKod, line) {
  const code = String(stkKod || "").trim();
  if (!code) return { code: null, remappedFrom: null };
  const want = stokAilePrefixFromLine(line);
  if (!want) return { code, remappedFrom: null };
  const have = parseStokAilePrefix(code);
  if (have === want) return { code, remappedFrom: null };
  const alt = swapStokAilePrefix(code, want);
  if (!alt) return { code, remappedFrom: null };
  const resolved = await resolveWriteStockCodeExact(wPool, alt);
  if (resolved) return { code: resolved, remappedFrom: code };
  return { code, remappedFrom: null };
}

function scoreHistoricalMatch(targetLine, candidateLine) {
  const primaryAcik = primaryKalemAciklama(targetLine);
  const itemNameTxt = String(targetLine.itemCode ?? "").trim();
  const satirAcik = primaryAcik || String(targetLine.lineAciklama ?? targetLine.description ?? itemNameTxt).trim();
  const stokCinsiTxt = String(targetLine.stokCinsi ?? satirAcik ?? itemNameTxt).trim();
  const candDesc = String(candidateLine.description || candidateLine.stkCinsi || "").trim();
  const descScore = Math.max(
    jaccardSimilarity(satirAcik, candDesc),
    jaccardSimilarity(satirAcik, candidateLine.stkCinsi)
  );
  const codeScore = codeSimilarity(targetLine.itemCode, candidateLine.stkKod);
  const cinsiScore = jaccardSimilarity(stokCinsiTxt, candidateLine.stkCinsi);
  const hasUnit = String(candidateLine.unit || "").trim().length > 0;
  const hasTax = candidateLine.taxPercent !== null && candidateLine.taxPercent !== undefined;
  const hasPrice = candidateLine.unitPrice !== null && candidateLine.unitPrice !== undefined;
  const unitMatch = hasUnit ? (upper(targetLine.unit) === upper(candidateLine.unit) ? 1 : 0) : 0;
  const taxDiff = hasTax ? Math.abs(parseNum(targetLine.taxPercent, 0) - parseNum(candidateLine.taxPercent, 0)) : 999;
  const taxScore = hasTax ? (taxDiff <= 0.1 ? 1 : taxDiff <= 1 ? 0.6 : taxDiff <= 3 ? 0.2 : 0) : 0;
  const priceScore = hasPrice ? Math.max(0, 1 - relativeDiff(targetLine.unitPrice, candidateLine.unitPrice)) : 0;
  const weakDesc = isCodeLikeText(satirAcik || stokCinsiTxt);
  const hasUserNote = Boolean(String(targetLine.kullaniciKalemAciklama || "").trim());
  const userFam = stokAilePrefixFromLine(targetLine);
  const candFam = parseStokAilePrefix(candidateLine.stkKod);
  const familyBonus =
    userFam && candFam ? (userFam === candFam ? 0.12 : -0.06) : 0;
  const total =
    (weakDesc
      ? descScore * 0.25 + cinsiScore * 0.3 + codeScore * 0.35 + unitMatch * 0.03 + taxScore * 0.03 + priceScore * 0.04
      : hasUserNote
        ? descScore * 0.75 + cinsiScore * 0.12 + codeScore * 0.05 + unitMatch * 0.03 + taxScore * 0.03 + priceScore * 0.02
        : descScore * 0.68 + cinsiScore * 0.17 + codeScore * 0.08 + unitMatch * 0.03 + taxScore * 0.02 + priceScore * 0.02) + familyBonus;
  return { total, descScore, cinsiScore, codeScore, unitMatch, taxScore, priceScore, weakDesc, familyBonus };
}

function classifyInvoiceType(data) {
  const q = data.qnbRaw && typeof data.qnbRaw === "object" ? data.qnbRaw : {};
  const up = data.ublParsed && typeof data.ublParsed === "object" ? data.ublParsed : {};
  const inv = firstOf(up.Invoice);
  const ublInvoiceTypeCode = textNode(inv?.InvoiceTypeCode).trim();
  const invType = upper(q.faturaTipi || q.invoiceTypeCode || data.invoiceTypeCode || ublInvoiceTypeCode || "");
  const hasTevkifat = parseNum(q.tevkifatTutari ?? data.tevkifatTutari, 0) > 0 || invType.includes("TEVK");
  const isIade = invType.includes("IADE") || invType.includes("RETURN") || invType.includes("CREDIT");
  const isIstisna = invType.includes("ISTISNA") || invType.includes("EXEMPT");
  return { invType, hasTevkifat, isIade, isIstisna };
}

async function resolveErpFaturaTipNo(pool, cls) {
  const req = pool.request();
  if (cls.isIade) {
    const r = await req.query(
      "SELECT TOP 1 FATFTNO FROM dbo.FATFISTIP WITH (NOLOCK) WHERE UPPER(FATFTKOD) LIKE UPPER('%IADE%') ORDER BY FATFTNO"
    );
    if (r.recordset.length) return r.recordset[0].FATFTNO;
  }

  // NOTE: sp_Fatura_Kayit cari adımı ETA_DENEME_2026'da tüm FATFISTIP kodlarıyla uyumlu
  // olacak şekilde yamalanmıştır (patchSpFaturaKayitCariBakiyeAllTypes.js). Fallback
  // yine güvenli varsayılan: İADE ailesi veya ALIM.
  const r = await pool
    .request()
    .query("SELECT TOP 1 FATFTNO FROM dbo.FATFISTIP WITH (NOLOCK) WHERE UPPER(FATFTKOD)='ALIM' ORDER BY FATFTNO");
  return r.recordset.length ? r.recordset[0].FATFTNO : 1;
}

/**
 * Çoğunluk oyu için geçerli FATFTNO kümesi: FATFISTIP'taki tüm fiş tipleri.
 * (sp_Fatura_Kayit yamalı sürümde cari güncellemesi İADE/IADE ayrımıyla tüm kodları kabul eder.)
 */
async function loadSpFaturaKayitSafeFatftNoSet(pool) {
  const rs = await pool.request().query(
    "SELECT FATFTNO FROM dbo.FATFISTIP WITH (NOLOCK)"
  );
  return new Set(
    (rs.recordset || [])
      .map((r) => Number(r.FATFTNO) || 0)
      .filter((n) => n > 0)
  );
}

/**
 * Eşlenen geçmiş faturaların FATFISTIPI değerlerinden çoğunluk oyu ile fiş tipi
 * seçer. Yalnızca yeni faturanın sınıfı (isIade/isIstisna/hasTevkifat) ile birebir
 * uyan kayıtlar oya katılır; çelişkili match'ler atılır. Eşitlikte daha küçük
 * FATTIP tercih edilir. `allowedFatft` verilmişse yalnızca bu kümedeki FATFTNO'lar
 * sayılır (FATFISTIP ile uyum). Hiç geçerli oy yoksa 0 döner — çağıran taraf
 * `resolveErpFaturaTipNo` akışına düşmelidir.
 */
function pickFatFisTipiFromHistory(historyMatches, cls, allowedFatft) {
  if (!Array.isArray(historyMatches) || historyMatches.length === 0) return 0;
  if (!cls || typeof cls !== "object") return 0;
  const allowed =
    allowedFatft instanceof Set && allowedFatft.size > 0 ? allowedFatft : null;
  const counts = new Map();
  for (const m of historyMatches) {
    if (!m) continue;
    const fatTip = Number(m.refFatTip || 0) || 0;
    if (!fatTip) continue;
    if (allowed && !allowed.has(fatTip)) continue;
    const sameClass =
      Boolean(m.refIsIade) === Boolean(cls.isIade) &&
      Boolean(m.refIsIstisna) === Boolean(cls.isIstisna) &&
      Boolean(m.refHasTevkifat) === Boolean(cls.hasTevkifat);
    if (!sameClass) continue;
    counts.set(fatTip, (counts.get(fatTip) || 0) + 1);
  }
  if (counts.size === 0) return 0;
  let bestKey = 0;
  let bestCount = -1;
  for (const [k, c] of counts.entries()) {
    if (c > bestCount || (c === bestCount && (bestKey === 0 || k < bestKey))) {
      bestKey = k;
      bestCount = c;
    }
  }
  return bestKey;
}

/** Firestore `kalemKullaniciAciklamalari` anahtarı (Flutter ile aynı). */
function kalemSatirAnahtari(line, index) {
  const satirNo = String(line?.satirNo || "").trim();
  if (satirNo) return `satir_${satirNo}`;
  const seller = String(line?.saticiKalemKodu || "").trim();
  if (seller) return `sku_seller_${seller}`.slice(0, 120);
  const buyer = String(line?.aliciKalemKodu || "").trim();
  if (buyer) return `sku_buyer_${buyer}`.slice(0, 120);
  const ad = String(line?.aciklama || line?.description || line?.itemCode || "").trim();
  if (ad) {
    const slug = ad
      .slice(0, 80)
      .replace(/[^\p{L}\p{N}._-]+/gu, "_")
      .replace(/_+/g, "_");
    if (slug) return `ad_${slug}`;
  }
  return `idx_${index}`;
}

function applyKalemKullaniciAciklamalari(lines, afterData) {
  const raw = afterData?.kalemKullaniciAciklamalari;
  if (!raw || typeof raw !== "object" || !Array.isArray(lines)) return lines;
  return lines.map((l, i) => {
    const key = kalemSatirAnahtari(l, i);
    const entry = raw[key];
    const userNote = String(entry?.aciklama || "").trim();
    if (!userNote) return l;
    const prevDesc = String(l.description || "").trim();
    const prevLine = String(l.lineAciklama || "").trim();
    return {
      ...l,
      kullaniciKalemAciklama: userNote,
      description: prevDesc ? `${userNote} | ${prevDesc}` : userNote,
      lineAciklama: prevLine ? `${userNote} | ${prevLine}` : userNote,
    };
  });
}

/**
 * Stok eşleştirmede birincil metin: onay kalem açıklaması → satır metni → UBL Item/Name.
 * Onay notu yokken Item/Name çoğu zaman gönderici ünvanıdır (kargo vb.); geçmiş eşleşmede öne alınmaz.
 */
function primaryKalemAciklama(line) {
  const user = String(line?.kullaniciKalemAciklama || "").trim();
  if (user) return user;
  const la = String(line?.lineAciklama || "").trim();
  const desc = String(line?.description || "").trim();
  for (const t of [la, desc]) {
    if (t && !isCodeLikeText(t)) return t;
  }
  const cinsi = String(line?.stokCinsi || "").trim();
  if (cinsi) return cinsi;
  if (la) return la;
  if (desc) return desc;
  return String(line?.itemCode || "").trim();
}

function hasUserKalemAciklama(line) {
  return Boolean(String(line?.kullaniciKalemAciklama || "").trim());
}

/** UBL LineExtensionAmount öncelikli kalem neti (miktar×birim fiyat ile örtüşmese de). */
function lineNetFromUbl(line) {
  const qty = parseNum(line?.qty, 1) || 1;
  const unitPrice = parseNum(line?.unitPrice, 0);
  const net = parseNum(line?.net, 0);
  if (net > 0) return net;
  return roundMoney(qty * unitPrice);
}

/** KDV: UBL TaxAmount bazen matrah ile aynı gelir; o durumda orandan hesapla. */
function lineTaxFromUbl(line) {
  const net = lineNetFromUbl(line);
  const pct = parseNum(line?.taxPercent, 0);
  const frac = pct > 0 && pct <= 1 ? pct : pct / 100;
  const rawTax = parseNum(line?.taxAmount, 0);
  const fromRate = frac > 0 && net > 0 ? roundMoney(net * frac) : 0;
  if (fromRate <= 0) return rawTax;
  if (rawTax <= 0) return fromRate;
  if (net > 0 && Math.abs(rawTax - net) / net < 0.05) return fromRate;
  if (net > 0 && rawTax >= net * 0.45 && frac > 0 && frac <= 0.3) return fromRate;
  return rawTax;
}

/** SP satır neti = miktar × birim fiyat; UBL netine uyması için efektif birim fiyat. */
function unitPriceForEtaLine(line, isForeignCurrency, kur) {
  const qty = parseNum(line?.qty, 1) || 1;
  const net = lineNetFromUbl(line);
  const effective = qty > 0 ? net / qty : parseNum(line?.unitPrice, 0);
  const n = roundMoney(effective);
  return isForeignCurrency && kur > 0 ? roundMoney(n * kur) : n;
}

/** sp_Fatura_Detay_Kayit ile aynı: miktar × yuvarlanmış birim fiyat (TL). */
function etaLineNetTl(line, isForeignCurrency, kur) {
  const qty = parseNum(line?.qty, 1) || 1;
  const unitPrice = unitPriceForEtaLine(line, isForeignCurrency, kur);
  return roundMoney(qty * unitPrice);
}

/** Kalem KDV tutarı (TL); dövizlide satır vergisi × kur. */
function etaLineTaxTl(line, isForeignCurrency, kur) {
  const lineTax = lineTaxFromUbl(line);
  return isForeignCurrency && kur > 0 ? roundMoney(lineTax * kur) : lineTax;
}

/**
 * Başlık tutarlarını kalem bazlı (SP ile örtüşen) yuvarlama ile hesaplar.
 * Toplam = Σ kalem; başlıkta ayrıca roundMoney uygulanmaz.
 */
function computeAlignedInvoiceAmounts(usableLines, isForeignCurrency, effectiveDovizKuru) {
  const perLine = [];
  let malHizmetToplamTutari = 0;
  let vergiTutari = 0;
  for (const line of usableLines) {
    const qty = parseNum(line?.qty, 1) || 1;
    const unitPrice = unitPriceForEtaLine(line, isForeignCurrency, effectiveDovizKuru);
    const netTl = roundMoney(qty * unitPrice);
    const taxTl = etaLineTaxTl(line, isForeignCurrency, effectiveDovizKuru);
    perLine.push({ line, qty, unitPrice, netTl, taxTl });
    malHizmetToplamTutari += netTl;
    vergiTutari += taxTl;
  }
  return {
    perLine,
    malHizmetToplamTutari,
    vergiTutari,
    odenecekTutar: malHizmetToplamTutari + vergiTutari,
  };
}

/** Kalemler yazıldıktan sonra FATFIS / cari / stok başlığını hizalar (Model A: UBL başlık; Model B: FATHAR). */
async function syncFatFisHeaderFromFathar(wPool, fatFisRefNo, opts = {}) {
  const ref = Number(fatFisRefNo);
  if (!Number.isFinite(ref) || ref <= 0) return null;

  const rs = await wPool.request().input("ref", sql.Int, ref).query(`
    SELECT
      F.FATFISCARREFNO,
      F.FATFISSTKREFNO,
      ISNULL(SUM(ISNULL(H.FATHARNETTUTAR, ISNULL(H.FATHARKDVMATRAH, H.FATHARTUTAR))), 0) AS mal,
      ISNULL(SUM(ISNULL(H.FATHARKDVTUTAR, 0)), 0) AS kdv
    FROM dbo.FATFIS F WITH (NOLOCK)
    LEFT JOIN dbo.FATHAR H WITH (NOLOCK) ON H.FATHARREFNO = F.FATFISREFNO
    WHERE F.FATFISREFNO = @ref
    GROUP BY F.FATFISCARREFNO, F.FATFISSTKREFNO
  `);
  const row = rs.recordset[0];
  if (!row) return null;

  const useUblHeader = Boolean(opts.useUblHeader);
  const malFromHar = Number(row.mal) || 0;
  const kdvFromHar = Number(row.kdv) || 0;
  const malOpt = Number(opts.malTop);
  const kdvOpt = Number(opts.kdvTop);
  const mal =
    useUblHeader && Number.isFinite(malOpt) && malOpt >= 0 ? malOpt : malFromHar;
  const kdv =
    useUblHeader && Number.isFinite(kdvOpt) && kdvOpt >= 0 ? kdvOpt : kdvFromHar;
  let gen = Number(opts.odenecekTutar);
  if (!Number.isFinite(gen) || gen <= 0) {
    gen = mal + kdv;
  }
  const tev = Number(opts.tevkifatTutar);
  const hasTev = Number.isFinite(tev) && tev > 0;

  const req = wPool.request();
  req.input("ref", sql.Int, ref);
  req.input("mal", sql.Decimal(18, 4), mal);
  req.input("kdv", sql.Decimal(18, 4), kdv);
  req.input("gen", sql.Decimal(18, 4), gen);
  req.input("tev", sql.Decimal(18, 4), hasTev ? tev : 0);
  req.input("tevFlag", sql.Bit, hasTev ? 1 : 0);
  await req.query(`
    UPDATE dbo.FATFIS
    SET
      FATFISMALTOP = @mal,
      FATFISKDVMATRAHI = @mal,
      FATFISBRUTTOPLAM = @mal,
      FATFISKDVTUTARI = @kdv,
      FATFISARATOPLAM = @gen,
      FATFISGENTOPLAM = @gen,
      FATFISTEVTUTAR = CASE WHEN @tevFlag = 1 THEN @tev ELSE FATFISTEVTUTAR END,
      FATFISTEVKIFATFLAG = CASE WHEN @tevFlag = 1 THEN 1 ELSE FATFISTEVKIFATFLAG END
    WHERE FATFISREFNO = @ref
  `);

  const carRef = Number(row.FATFISCARREFNO) || 0;
  if (carRef > 0) {
    await wPool
      .request()
      .input("carRef", sql.Int, carRef)
      .input("gen", sql.Decimal(18, 4), gen)
      .input("kdv", sql.Decimal(18, 4), kdv)
      .query(`
        UPDATE dbo.CARFIS SET CARFISALACAKTOP = @gen WHERE CARFISREFNO = @carRef;
        UPDATE dbo.CARHAR
        SET CARHARTUTAR = @gen, CARHARKDVTUTAR = @kdv, CARHARKALAN = @gen
        WHERE CARHARREFNO = @carRef
      `);
  }

  const stkRef = Number(row.FATFISSTKREFNO) || 0;
  if (stkRef > 0) {
    await wPool
      .request()
      .input("stkRef", sql.Int, stkRef)
      .input("mal", sql.Decimal(18, 4), mal)
      .input("kdv", sql.Decimal(18, 4), kdv)
      .input("gen", sql.Decimal(18, 4), gen)
      .query(`
        UPDATE dbo.STKFIS
        SET STKFISTOPNTUT = @mal, STKFISTOPKDV = @kdv, STKFISTOPKTUT = @gen
        WHERE STKFISREFNO = @stkRef
      `);
  }

  return { mal, kdv, gen };
}

function pickDominantSupplierHistoryMatch(rows, stkFreq) {
  if (!rows?.length || !stkFreq?.size) return null;
  let topStk = null;
  let topCnt = 0;
  for (const [k, v] of stkFreq) {
    if (v > topCnt) {
      topCnt = v;
      topStk = k;
    }
  }
  if (!topStk) return null;
  const row = rows.find((r) => String(r.STKKOD || "").trim() === topStk);
  if (!row) return null;
  return {
    total: 0,
    baseScore: 0,
    descScore: 0,
    cinsiScore: 0,
    codeScore: 0,
    weakDesc: false,
    stkkod: topStk,
    stkcinsi: String(row.STKCINSI || "").trim(),
    row,
    dominantFallback: true,
  };
}

/** Anlamlı kalem açıklaması varken UBL Name koduna doğrudan düşülmesin. */
function shouldUseDirectItemCodeFallback(line, rawItemCode) {
  const primary = primaryKalemAciklama(line);
  const kod = String(rawItemCode || "").trim();
  if (!kod) return false;
  if (!primary) return true;
  if (isCodeLikeText(primary)) return true;
  if (codeSimilarity(primary, kod) >= 0.7) return true;
  return false;
}

function extractInvoiceLines(data) {
  const out = [];
  const up = data.ublParsed && typeof data.ublParsed === "object" ? data.ublParsed : {};
  const inv = firstOf(up.Invoice);
  if (!inv || typeof inv !== "object") return out;
  const linesRaw = inv.InvoiceLine;
  const lines = Array.isArray(linesRaw) ? linesRaw : linesRaw ? [linesRaw] : [];
  for (const ln of lines) {
    const line = ln && typeof ln === "object" ? ln : {};
    const satirNo = textNode(line.ID).trim();
    const item = firstOf(line.Item) || {};
    const sellerSku = ublItemIdentificationId(item.SellersItemIdentification);
    const buyerSku = ublItemIdentificationId(item.BuyersItemIdentification);
    const nameKod = textNode(item.Name).trim();
    const descParts = collectItemDescriptions(item);
    const descText = descParts.length ? descParts.join(" | ") : "";
    const noteParts = collectInvoiceLineNotes(line);
    const noteKod = noteParts.length ? noteParts.join(" | ") : "";
    /** UBL `cbc:Name` → stok cinsi; `cbc:Description` → satır açıklaması. */
    const stokCinsi = (nameKod || "").trim();
    const lineAciklamaParts = [];
    if (descText) lineAciklamaParts.push(descText);
    if (noteKod) lineAciklamaParts.push(noteKod);
    const lineAciklama = lineAciklamaParts.join(" | ");
    /** Satıcı/alıcı kalem kodu; UBL Name artık stok kodu adayı değil. */
    const itemCode = (sellerSku || buyerSku || "").slice(0, 40);
    const qtyNode = firstOf(line.InvoicedQuantity);
    const qty = parseNum(textNode(qtyNode), 1);
    const unit = (qtyNode && typeof qtyNode === "object" ? qtyNode["@_unitCode"] : null) || "AD";
    const priceNode = firstOf(line.Price)?.PriceAmount ?? firstOf(line.PriceAmount);
    const unitPrice = parseNum(textNode(priceNode), 0);
    const lineExt = firstOf(line.LineExtensionAmount);
    const lineNet = parseNum(textNode(lineExt), Math.max(0, qty * unitPrice));
    const taxNode = firstOf(line.TaxTotal);
    const taxAmount = parseNum(textNode(firstOf(taxNode?.TaxAmount)), 0);
    const sub = firstOf(firstOf(firstOf(line.TaxTotal)?.TaxSubtotal)?.Percent);
    const taxPercent = parseNum(textNode(sub), 10);
    out.push({
      itemCode,
      ...(satirNo ? { satirNo } : {}),
      ...(sellerSku ? { saticiKalemKodu: sellerSku } : {}),
      ...(buyerSku ? { aliciKalemKodu: buyerSku } : {}),
      ...(descText ? { aciklama: descText } : {}),
      /** Geçmiş eşleştirme: FATHARACIKLAMA / STKCINSI ile karşılaştırma. */
      description: lineAciklama,
      stokCinsi,
      lineAciklama,
      qty: qty || 1,
      unit: String(unit || "AD"),
      unitPrice: unitPrice || 0,
      net: lineNet || 0,
      taxAmount: taxAmount || 0,
      taxPercent: taxPercent || 10,
    });
  }
  return out;
}

function parseIrsaliyeDateRaw(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^\d{8}$/.test(s)) {
    const dt = parseYmd(s);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const dt = new Date(s.length >= 10 ? s.slice(0, 10) : s);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * `qnb_invoices/{docId}/despatches` alt koleksiyonundan irsaliye listesini okur.
 * Sıralama önceliği:
 *   1) `qnb_invoices/{docId}.relatedBelgeNos` (UBL sırası) varsa onu izler.
 *   2) Aksi halde issueDate ASC, sonra belgeNo ASC.
 *
 * Dönüş: `[{ belgeNo, issueDate (Date|null) }, ...]`
 */
async function loadDespatchesFromSubcollection(docId) {
  if (!docId) return [];
  const db = getFirestore();
  const invRef = db.collection("qnb_invoices").doc(docId);
  const [invSnap, subSnap] = await Promise.all([
    invRef.get(),
    invRef.collection("despatches").get(),
  ]);
  if (subSnap.empty) return [];

  const byBelgeNo = new Map();
  for (const d of subSnap.docs) {
    const data = d.data() || {};
    const belgeNo = String(data.belgeNo ?? data.belgeNoStr ?? "").trim();
    if (!belgeNo || byBelgeNo.has(belgeNo)) continue;
    byBelgeNo.set(belgeNo, {
      belgeNo,
      issueDate: parseIrsaliyeDateRaw(data.issueDate ?? data.belgeTarihi ?? null),
    });
  }
  if (!byBelgeNo.size) return [];

  const invData = invSnap.exists ? invSnap.data() || {} : {};
  const order = Array.isArray(invData.relatedBelgeNos) ? invData.relatedBelgeNos : [];
  const ordered = [];
  for (const bn of order) {
    const s = String(bn || "").trim();
    if (!s) continue;
    const m = byBelgeNo.get(s);
    if (m) {
      ordered.push(m);
      byBelgeNo.delete(s);
    }
  }
  const remaining = Array.from(byBelgeNo.values()).sort((a, b) => {
    const va = a.issueDate ? a.issueDate.getTime() : Number.POSITIVE_INFINITY;
    const vb = b.issueDate ? b.issueDate.getTime() : Number.POSITIVE_INFINITY;
    if (va !== vb) return va - vb;
    return a.belgeNo.localeCompare(b.belgeNo);
  });
  return ordered.concat(remaining);
}

function joinDespatchBelgeNos(despatches) {
  return (Array.isArray(despatches) ? despatches : [])
    .map((d) => String(d?.belgeNo || "").trim())
    .filter(Boolean)
    .join(",");
}

function extractLegalMonetaryFromUbl(data) {
  const inv = getInvoiceNodeFromUbl(data);
  if (!inv) return null;
  const lmt = inv.LegalMonetaryTotal || {};
  return {
    lineExtension: parseNum(textNode(firstOf(lmt.LineExtensionAmount)), 0),
    taxExclusive: parseNum(textNode(firstOf(lmt.TaxExclusiveAmount)), 0),
    taxInclusive: parseNum(textNode(firstOf(lmt.TaxInclusiveAmount)), 0),
    payable: parseNum(textNode(firstOf(lmt.PayableAmount)), 0),
  };
}

/** Fatura düzeyi TaxTotal (belge dövizi); OTV alt kalemleri ayrı işlenir. */
function extractDocTaxTotalFromUbl(data) {
  const inv = getInvoiceNodeFromUbl(data);
  if (!inv) return 0;
  const tt = firstOf(inv.TaxTotal);
  if (!tt) return 0;
  return parseNum(textNode(firstOf(tt.TaxAmount)), 0);
}

/**
 * Belge dövizinde matrah / KDV / ödenecek — öncelik UBL LegalMonetaryTotal (qnbRaw yedek).
 */
function buildDocTotalsForAmountModel(afterData, q, usableLines) {
  const lmt = extractLegalMonetaryFromUbl(afterData);
  const lineMalSum = usableLines.reduce((s, x) => s + strictLineNetFromUbl(x), 0);
  const lineTaxSum = usableLines.reduce((s, x) => s + strictLineTaxFromUbl(x), 0);
  const ublTax = extractDocTaxTotalFromUbl(afterData);
  const qnbMal = parseNum(q.malHizmetToplamTutari ?? afterData?.malHizmetToplamTutari, 0);
  const qnbKdv = parseNum(q.kdvToplamTutari ?? afterData?.kdvToplamTutari, 0);
  const qnbPay = parseNum(q.odenecekTutar, 0);

  const mal =
    lmt?.lineExtension > 0 ? lmt.lineExtension : lineMalSum > 0 ? lineMalSum : qnbMal;
  const kdv = ublTax > 0 ? ublTax : lineTaxSum > 0 ? lineTaxSum : qnbKdv;
  const payable =
    lmt?.payable > 0 ? lmt.payable : mal + kdv > 0 ? roundMoney(mal + kdv) : qnbPay;

  return { mal, kdv, payable };
}

function extractExchangeRateFromUbl(data) {
  const up = data.ublParsed && typeof data.ublParsed === "object" ? data.ublParsed : {};
  const inv = firstOf(up.Invoice);
  if (!inv || typeof inv !== "object") return null;
  const candidates = [
    firstOf(inv.PricingExchangeRate),
    firstOf(inv.PaymentExchangeRate),
    firstOf(inv.TaxExchangeRate),
  ].filter(Boolean);
  for (const ex of candidates) {
    const rateNode = ex?.CalculationRate ?? ex?.calculationRate ?? ex?.Rate ?? ex?.rate;
    const n = parseNum(textNode(rateNode) || rateNode, 0);
    if (n > 0) return n;
  }
  return null;
}

function getInvoiceNodeFromUbl(data) {
  const up = data?.ublParsed && typeof data.ublParsed === "object" ? data.ublParsed : {};
  const inv = firstOf(up.Invoice);
  return inv && typeof inv === "object" ? inv : null;
}

function extractCurrencyCodeFromUbl(data) {
  const inv = getInvoiceNodeFromUbl(data);
  if (!inv) return "";
  return String(textNode(inv.DocumentCurrencyCode) || "").trim().toUpperCase();
}

function extractProfileFromUbl(data) {
  const inv = getInvoiceNodeFromUbl(data);
  if (!inv) return "";
  return String(textNode(inv.ProfileID) || textNode(inv.CustomizationID) || "").trim();
}

function extractWithholdingFromUbl(data) {
  const inv = getInvoiceNodeFromUbl(data);
  if (!inv) return { tevkifatTutar: null, tevkifatOrani: null, tevkifatKodu: "" };
  const wt = firstOf(inv.WithholdingTaxTotal);
  if (!wt || typeof wt !== "object") return { tevkifatTutar: null, tevkifatOrani: null, tevkifatKodu: "" };
  const tevkifatTutar = parseNum(textNode(firstOf(wt.TaxAmount)), 0);
  const sub = firstOf(wt.TaxSubtotal);
  const tevkifatOrani = sub ? parseNum(textNode(firstOf(sub.Percent)), 0) : 0;
  const cat = firstOf(sub?.TaxCategory);
  const sch = firstOf(cat?.TaxScheme);
  const tevkifatKodu = String(textNode(firstOf(sch?.TaxTypeCode)) || textNode(firstOf(sch?.Name)) || "").trim();
  return {
    tevkifatTutar: tevkifatTutar > 0 ? tevkifatTutar : null,
    tevkifatOrani: tevkifatOrani > 0 ? tevkifatOrani : null,
    tevkifatKodu,
  };
}

function extractOtvFromUbl(data) {
  const inv = getInvoiceNodeFromUbl(data);
  if (!inv) return null;
  const taxTotalsRaw = inv.TaxTotal;
  const taxTotals = Array.isArray(taxTotalsRaw) ? taxTotalsRaw : taxTotalsRaw ? [taxTotalsRaw] : [];
  let sum = 0;
  for (const tt of taxTotals) {
    const subsRaw = tt?.TaxSubtotal;
    const subs = Array.isArray(subsRaw) ? subsRaw : subsRaw ? [subsRaw] : [];
    for (const s of subs) {
      const cat = firstOf(s?.TaxCategory);
      const sch = firstOf(cat?.TaxScheme);
      const taxTypeCode = upper(textNode(firstOf(sch?.TaxTypeCode)));
      const taxName = upper(textNode(firstOf(sch?.Name)));
      const isOtv = taxTypeCode === "0071" || taxName.includes("OTV") || taxName.includes("OZEL TUKETIM");
      if (!isOtv) continue;
      sum += parseNum(textNode(firstOf(s.TaxAmount)), 0);
    }
  }
  return sum > 0 ? sum : null;
}

function extractIstisnaFromUbl(data) {
  const inv = getInvoiceNodeFromUbl(data);
  if (!inv) return "";
  const taxTotalsRaw = inv.TaxTotal;
  const taxTotals = Array.isArray(taxTotalsRaw) ? taxTotalsRaw : taxTotalsRaw ? [taxTotalsRaw] : [];
  for (const tt of taxTotals) {
    const subsRaw = tt?.TaxSubtotal;
    const subs = Array.isArray(subsRaw) ? subsRaw : subsRaw ? [subsRaw] : [];
    for (const s of subs) {
      const cat = firstOf(s?.TaxCategory);
      const reason = String(textNode(firstOf(cat?.TaxExemptionReason)) || textNode(firstOf(cat?.TaxExemptionReasonCode)) || "").trim();
      if (reason) return reason;
    }
  }
  return "";
}

/**
 * `sp_Fatura_Kayit` FATFISIRSTAR / FATFISIRSNO alanlarını fatura tarihi/numarasına yazar ve
 * `@IrsaliyeNumaralari` parametresini kullanmaz. Bu güncelleme `qnb_invoices/{docId}/despatches`
 * alt koleksiyonundan okunan listenin ILK kaydını yansıtır (belgeNo + issueDate).
 * İrsaliye numarası yoksa `FATFISIRSNO` temizlenir (fatura no tekrarı kalkar).
 */
async function patchFatFisIrsaliyeAlanlari(wPool, fatFisRefNo, despatches) {
  const first = (Array.isArray(despatches) ? despatches : [])[0] || null;
  const firstNo = String(first?.belgeNo || "").trim();
  const irTar = first?.issueDate instanceof Date ? first.issueDate : null;
  const hasNo = Boolean(firstNo);
  const hasTar = Boolean(irTar);

  await wPool
    .request()
    .input("ref", sql.Int, fatFisRefNo)
    .input("irsno", sql.NVarChar(80), hasNo ? firstNo.slice(0, 80) : "")
    .input("irstar", sql.DateTime, hasTar ? irTar : new Date("1900-01-01"))
    .input("applyTar", sql.Bit, hasTar ? 1 : 0)
    .query(`
      UPDATE dbo.FATFIS
      SET
        FATFISIRSNO = @irsno,
        FATFISIRSTAR = CASE WHEN @applyTar = 1 THEN @irstar ELSE FATFISIRSTAR END
      WHERE FATFISREFNO = @ref
    `);
}

async function patchCurrencyFields(wPool, fatFisRefNo, opts) {
  const currencyCode = String(opts?.currencyCode || "").trim().toUpperCase();
  const currencyType = String(opts?.currencyType || "MBNKSAT").trim().toUpperCase();
  const kur = parseNum(opts?.dovizKuru, 1);
  const isForeign = !isDomesticTryOrTl(currencyCode) && kur > 0;
  if (!isForeign) return;

  const dovizGenTop = parseNum(opts?.docOdenecekTutar, 0);
  const faturaTarihi = opts?.faturaTarihi instanceof Date ? opts.faturaTarihi : new Date();

  await wPool
    .request()
    .input("ref", sql.Int, fatFisRefNo)
    .input("kod", sql.NVarChar(10), currencyCode.slice(0, 10))
    .input("tur", sql.NVarChar(20), currencyType.slice(0, 20))
    .input("kur", sql.Decimal(18, 8), kur)
    .input("dovTop", sql.Decimal(18, 4), dovizGenTop)
    .input("dovTar", sql.DateTime, faturaTarihi)
    .query(`
      UPDATE dbo.FATFIS
      SET
        FATFISDOVKOD = @kod,
        FATFISDOVTUR = @tur,
        FATFISDOVKUR = @kur,
        FATFISDOVTAR = @dovTar,
        FATFISGENDOVTOP = @dovTop
      WHERE FATFISREFNO = @ref
    `);

  const lines = Array.isArray(opts?.lineCurrency) ? opts.lineCurrency : [];
  for (const ln of lines) {
    const sira = Number(ln?.sira || 0);
    if (!Number.isFinite(sira) || sira <= 0) continue;
    const dovFiyat = parseNum(ln?.dovFiyat, 0);
    const dovTutar = parseNum(ln?.dovTutar, 0);
    await wPool
      .request()
      .input("ref", sql.Int, fatFisRefNo)
      .input("sira", sql.Int, sira)
      .input("kod", sql.NVarChar(10), currencyCode.slice(0, 10))
      .input("tur", sql.NVarChar(20), currencyType.slice(0, 20))
      .input("kur", sql.Decimal(18, 8), kur)
      .input("fyt", sql.Decimal(18, 6), dovFiyat)
      .input("tut", sql.Decimal(18, 4), dovTutar)
      .query(`
        UPDATE dbo.FATHAR
        SET
          FATHARDOVKOD = @kod,
          FATHARDOVTUR = @tur,
          FATHARDOVKUR = @kur,
          FATHARDOVFIYAT = @fyt,
          FATHARDOVTUTAR = @tut
        WHERE FATHARREFNO = @ref AND FATHARSIRANO = @sira
      `);
  }
}

/** Dövizli fatura: FATFIS döviz alanlarını bağlı CARFIS / CARHAR satırına yansıtır (üretim ETA şablonu). */
async function patchCariCurrencyFromFatFis(wPool, fatFisRefNo) {
  const rs = await wPool
    .request()
    .input("ref", sql.Int, fatFisRefNo)
    .query(`
      SELECT
        FATFISCARREFNO,
        FATFISDOVKOD,
        FATFISDOVTUR,
        FATFISDOVKUR,
        FATFISGENDOVTOP,
        FATFISDOVTAR
      FROM dbo.FATFIS WITH (NOLOCK)
      WHERE FATFISREFNO = @ref
    `);
  const row = rs.recordset[0];
  if (!row) return;

  const carRef = Number(row.FATFISCARREFNO) || 0;
  const kod = String(row.FATFISDOVKOD || "").trim().toUpperCase();
  const kur = parseNum(row.FATFISDOVKUR, 0);
  if (!carRef || !kod || isDomesticTryOrTl(kod) || kur <= 0) return;

  const dovTop = parseNum(row.FATFISGENDOVTOP, 0);
  if (dovTop <= 0) return;

  const tur = String(row.FATFISDOVTUR || "MBNKSAT").trim().toUpperCase().slice(0, 20);
  const dovTar = row.FATFISDOVTAR instanceof Date ? row.FATFISDOVTAR : new Date();

  await wPool
    .request()
    .input("carRef", sql.Int, carRef)
    .input("kod", sql.NVarChar(10), kod.slice(0, 10))
    .input("tur", sql.NVarChar(20), tur)
    .input("kur", sql.Decimal(18, 8), kur)
    .input("dovTop", sql.Decimal(18, 4), dovTop)
    .input("dovTar", sql.DateTime, dovTar)
    .query(`
      UPDATE dbo.CARHAR
      SET
        CARHARDOVKOD = @kod,
        CARHARDOVTUR = @tur,
        CARHARDOVTUTAR = @dovTop,
        CARHARDOVKUR = @kur
      WHERE CARHARREFNO = @carRef;

      UPDATE dbo.CARFIS
      SET
        CARFISDOVTAR = @dovTar,
        CARFISDOVALACAKTOP = CASE
          WHEN ISNULL(CARFISALACAKTOP, 0) >= ISNULL(CARFISBORCTOP, 0) THEN @dovTop
          ELSE CARFISDOVALACAKTOP
        END,
        CARFISDOVBORCTOP = CASE
          WHEN ISNULL(CARFISBORCTOP, 0) > ISNULL(CARFISALACAKTOP, 0) THEN @dovTop
          ELSE CARFISDOVBORCTOP
        END
      WHERE CARFISREFNO = @carRef;
    `);
}

async function loadDefaults(rPool, wPool) {
  if (cachedDefaults) return cachedDefaults;
  const depoEnv = process.env.ETA_DEFAULT_DEPO_KOD?.trim();
  const stokEnv = process.env.ETA_DEFAULT_STK_KOD?.trim();

  const depo = depoEnv
    ? depoEnv
    : (
        await wPool
          .request()
          .query("SELECT TOP 1 DEPKOD FROM dbo.DEPO WITH (NOLOCK) WHERE ISNULL(DEPKOD,'')<>'' ORDER BY DEPKOD")
      ).recordset[0]?.DEPKOD ||
      (
        await rPool
          .request()
          .query("SELECT TOP 1 DEPKOD FROM dbo.DEPO WITH (NOLOCK) WHERE ISNULL(DEPKOD,'')<>'' ORDER BY DEPKOD")
      ).recordset[0]?.DEPKOD;
  const stok = stokEnv
    ? stokEnv
    : (
        await wPool
          .request()
          .query("SELECT TOP 1 STKKOD FROM dbo.STKKART WITH (NOLOCK) WHERE ISNULL(STKKOD,'')<>'' ORDER BY STKKOD")
      ).recordset[0]?.STKKOD ||
      (
        await rPool
          .request()
          .query("SELECT TOP 1 STKKOD FROM dbo.STKKART WITH (NOLOCK) WHERE ISNULL(STKKOD,'')<>'' ORDER BY STKKOD")
      ).recordset[0]?.STKKOD;
  if (!depo || !stok) {
    throw new Error("ETA defaults not found. Set ETA_DEFAULT_DEPO_KOD and ETA_DEFAULT_STK_KOD.");
  }
  cachedDefaults = { depo, stok };
  return cachedDefaults;
}

async function ensureWriteStockCode(wPool, candidateCode, fallbackCode) {
  const check = async (code) => {
    const c = String(code || "").trim();
    if (!c) return null;
    const rs = await wPool
      .request()
      .input("stk", sql.NVarChar(40), c)
      .query("SELECT TOP 1 STKKOD FROM dbo.STKKART WITH (NOLOCK) WHERE STKKOD=@stk");
    return rs.recordset[0]?.STKKOD || null;
  };
  const a = await check(candidateCode);
  if (a) return a;
  const b = await check(fallbackCode);
  if (b) return b;
  const rs = await wPool
    .request()
    .query("SELECT TOP 1 STKKOD FROM dbo.STKKART WITH (NOLOCK) WHERE ISNULL(STKKOD,'')<>'' ORDER BY STKKOD");
  return rs.recordset[0]?.STKKOD || null;
}

async function resolveWriteStockCodeExact(wPool, code) {
  const c = String(code || "").trim();
  if (!c) return null;
  const rs = await wPool
    .request()
    .input("stk", sql.NVarChar(40), c)
    .query("SELECT TOP 1 STKKOD FROM dbo.STKKART WITH (NOLOCK) WHERE STKKOD=@stk");
  return rs.recordset[0]?.STKKOD || null;
}

/** Tedarikçi geçmişinden gelen STKKOD; kullanıcı aile öneki (A3 vb.) ile STKKART alternatifi. */
async function resolveStockFromHistoryMatch(wPool, historyMatch, line, opts) {
  const allowAutoStk = opts?.allowAutoStk !== false;
  const stkTemplate = opts?.stkTemplate || "";
  let matchSource = null;
  let itemCodeResolved = null;
  let stokFamilyRemapFrom = null;
  if (!historyMatch?.stkkod) {
    return { itemCodeResolved, matchSource, stokFamilyRemapFrom };
  }

  const rawHistory = String(historyMatch.stkkod || "").trim().slice(0, 40);
  const { code: historyCode, remappedFrom } = await preferStockCodeForUserFamilyPrefix(
    wPool,
    rawHistory,
    line
  );
  if (remappedFrom) stokFamilyRemapFrom = remappedFrom;

  itemCodeResolved = await resolveWriteStockCodeExact(wPool, historyCode);
  if (itemCodeResolved) {
    matchSource = "supplier_history_match";
  } else if (historyCode && allowAutoStk) {
    try {
      await tryCloneStkkartFromTemplate(
        wPool,
        historyCode,
        String(historyMatch.stkcinsi || line.stokCinsi || historyCode).trim() || historyCode,
        line.unit,
        stkTemplate
      );
    } catch {
      /* duplicate / şema */
    }
    itemCodeResolved = await resolveWriteStockCodeExact(wPool, historyCode);
    if (itemCodeResolved) matchSource = "supplier_history_clone";
  }

  return { itemCodeResolved, matchSource, stokFamilyRemapFrom };
}

/**
 * Write DB STKKART: birincil kalem açıklaması → STKCINSI eşlemesi.
 * Önce tam eşleşme; yoksa kelime parçalarıyla aday çekip Jaccard benzerliği (esnek eşleşme).
 * @returns {{ stkkod: string, mode: 'exact'|'fuzzy', score?: number } | null}
 */
async function resolveWriteStockByStkcinsi(wPool, cinsi) {
  const c = String(cinsi || "").trim().slice(0, 80);
  if (!c || c.length < 3 || isCodeLikeText(c)) return null;

  const exactRs = await wPool
    .request()
    .input("cinsi", sql.NVarChar(80), c)
    .query(
      "SELECT TOP 1 STKKOD FROM dbo.STKKART WITH (NOLOCK) WHERE LTRIM(RTRIM(STKCINSI)) = LTRIM(RTRIM(@cinsi))"
    );
  const exactKod = String(exactRs.recordset[0]?.STKKOD || "").trim();
  if (exactKod) return { stkkod: exactKod, mode: "exact", score: 1 };

  const tokens = [...tokenSet(c)]
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length)
    .slice(0, 5);
  if (!tokens.length) return null;

  const candidateLimit = Math.min(
    200,
    Math.max(10, Number(process.env.ETA_STKCINSI_CANDIDATE_LIMIT || 80))
  );
  const req = wPool.request();
  const likeParts = tokens.map((tok, i) => {
    req.input(`tok${i}`, sql.NVarChar(80), `%${tok}%`);
    return `STKCINSI LIKE @tok${i}`;
  });
  req.input("lim", sql.Int, candidateLimit);
  const fuzzyRs = await req.query(`
    SELECT TOP (@lim) STKKOD, STKCINSI
    FROM dbo.STKKART WITH (NOLOCK)
    WHERE ISNULL(LTRIM(RTRIM(STKCINSI)), '') <> ''
      AND (${likeParts.join(" OR ")})
  `);

  const minScore = parseNum(process.env.ETA_STKCINSI_MATCH_MIN_SCORE, 0.45);
  let best = null;
  for (const row of fuzzyRs.recordset || []) {
    const stkKod = String(row.STKKOD || "").trim();
    const stkCinsi = String(row.STKCINSI || "").trim();
    if (!stkKod || !stkCinsi) continue;
    const score = jaccardSimilarity(c, stkCinsi);
    if (!best || score > best.score) {
      best = { stkkod: stkKod, score, stkCinsi };
    }
  }
  if (best?.stkkod && best.score >= minScore) {
    return { stkkod: best.stkkod, mode: "fuzzy", score: Number(best.score.toFixed(4)) };
  }
  return null;
}

async function getStkkartColumnNames(wPool) {
  if (cachedStkkartColumnNames?.length) return cachedStkkartColumnNames;
  const rs = await wPool.request().query(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = N'dbo' AND TABLE_NAME = N'STKKART'
    ORDER BY ORDINAL_POSITION
  `);
  cachedStkkartColumnNames = rs.recordset.map((r) => String(r.COLUMN_NAME));
  return cachedStkkartColumnNames;
}

/**
 * Şablon `STKKART` satırını kopyalayarak yeni stok kartı oluşturur (STKKOD, STKCINSI, STKBIRIM UBL'den).
 * `ETA_STKKART_TEMPLATE_KOD` yoksa `defaults.stok` şablon kullanılır.
 */
async function tryCloneStkkartFromTemplate(wPool, newKod, stkcinsi, birim, templateKod) {
  const kod = String(newKod || "").trim().slice(0, 40);
  const tpl = String(templateKod || "").trim().slice(0, 40);
  if (!kod || !tpl) return false;
  const cols = await getStkkartColumnNames(wPool);
  if (!cols.length) return false;
  const insertList = cols.map((c) => `[${c}]`).join(", ");
  const selectList = cols
    .map((c) => {
      if (c === "STKKOD") return "@newKod";
      if (c === "STKCINSI") return "@cinsi";
      if (c === "STKBIRIM") return "@brm";
      return `T.[${c}]`;
    })
    .join(", ");
  await wPool
    .request()
    .input("newKod", sql.VarChar(40), kod)
    .input("cinsi", sql.VarChar(80), String(stkcinsi || kod).trim().slice(0, 80))
    .input("brm", sql.VarChar(40), String(birim || "AD").trim().slice(0, 40))
    .input("tpl", sql.VarChar(40), tpl)
    .query(
      `INSERT INTO dbo.STKKART (${insertList}) SELECT ${selectList} FROM dbo.STKKART AS T WITH (UPDLOCK, HOLDLOCK) WHERE T.STKKOD = @tpl`
    );
  return true;
}

async function findStockCodeBySupplierHistory(rPool, opts) {
  const supplierVkn = String(opts?.supplierVkn || "").replace(/\D/g, "");
  const line = opts?.line || {};
  const invoiceClass = opts?.invoiceClass || {};
  const invoiceCurrency = String(opts?.currencyCode || "").trim().toUpperCase();
  if (!supplierVkn) return null;
  const targetDesc = primaryKalemAciklama(line);
  if (!targetDesc) return null;

  const lookbackMonths = Number(process.env.ETA_MATCH_LOOKBACK_MONTHS || 12);
  const candidateLimit = Number(process.env.ETA_MATCH_CANDIDATE_LIMIT || 300);
  const cariResolved = await resolveCariKod(rPool, supplierVkn, invoiceCurrency);
  const carkod = String(cariResolved?.carkod || "").trim();
  if (!carkod) return null;

  const makeCandidates = async (mode) => {
    const req = rPool.request();
    req.input("carkod", sql.NVarChar(40), carkod);
    req.input("lookbackMonths", sql.Int, Number.isFinite(lookbackMonths) ? lookbackMonths : 12);
    req.input("candidateLimit", sql.Int, Number.isFinite(candidateLimit) ? candidateLimit : 300);
    req.input("isIade", sql.Bit, invoiceClass?.isIade ? 1 : 0);
    req.input("hasTevkifat", sql.Bit, invoiceClass?.hasTevkifat ? 1 : 0);
    req.input("isIstisna", sql.Bit, invoiceClass?.isIstisna ? 1 : 0);
    req.input("dovKod", sql.NVarChar(10), invoiceCurrency || "");
    req.input("applyType", sql.Bit, mode === "strict" || mode === "type_only" ? 1 : 0);
    req.input("applyCurrency", sql.Bit, mode === "strict" ? 1 : 0);
    const rs = await req.query(`
      SELECT TOP (@candidateLimit)
        F.FATFISREFNO AS FATFISREFNO,
        ISNULL(F.FATFISMUHREFNO, 0) AS MUHREFNO,
        ISNULL(F.FATFISTIPI, 0) AS FATTIP,
        CASE WHEN ISNULL(F.FATFISTEVTUTAR, 0) > 0 THEN 1 ELSE 0 END AS HAS_TEV,
        CASE WHEN ISNULL(F.FATFISTIPI, 0) IN (2,4,6) THEN 1 ELSE 0 END AS IS_IADE,
        CASE WHEN ISNULL(F.FATFISTIPI, 0) IN (11) THEN 1 ELSE 0 END AS IS_ISTISNA,
        ISNULL(F.FATFISMALTOP, 0) AS MALTOP,
        ISNULL(F.FATFISGENTOPLAM, 0) AS GENTOP,
        ISNULL(NULLIF(LTRIM(RTRIM(F.FATFISDOVKOD)), ''), 'TRY') AS DOVKOD,
        ISNULL(F.FATFISDOVKUR, 1) AS DOVKUR,
        H.FATHARSTKKOD AS STKKOD,
        ISNULL(H.FATHARSTKCINS,'') AS STKCINSI,
        ISNULL(H.FATHARACIKLAMA,'') AS ACIKLAMA
      FROM dbo.FATHAR H WITH (NOLOCK)
      INNER JOIN dbo.FATFIS F WITH (NOLOCK) ON F.FATFISREFNO = H.FATHARREFNO
      WHERE F.FATFISCARKOD = @carkod
        AND ISNULL(H.FATHARSTKKOD, '') <> ''
        AND (
          ISNULL(H.FATHARACIKLAMA, '') <> ''
          OR ISNULL(H.FATHARSTKCINS, '') <> ''
        )
        AND (
          @applyType = 0 OR (
            (CASE WHEN ISNULL(F.FATFISTEVTUTAR, 0) > 0 THEN 1 ELSE 0 END) = @hasTevkifat
            AND (CASE WHEN ISNULL(F.FATFISTIPI, 0) IN (11) THEN 1 ELSE 0 END) = @isIstisna
            AND (CASE WHEN ISNULL(F.FATFISTIPI, 0) IN (2,4,6) THEN 1 ELSE 0 END) = @isIade
          )
        )
        AND (
          @applyCurrency = 0 OR (
            UPPER(ISNULL(NULLIF(LTRIM(RTRIM(F.FATFISDOVKOD)), ''), 'TRY')) = UPPER(ISNULL(NULLIF(@dovKod, ''), 'TRY'))
          )
        )
      ORDER BY H.FATHARREFNO DESC
    `);
    return rs.recordset || [];
  };

  // strict: type + currency, type_only: only invoice class, loose: only supplier history
  let rows = await makeCandidates("strict");
  if (!rows.length) rows = await makeCandidates("type_only");
  if (!rows.length) rows = await makeCandidates("loose");
  if (!rows.length) return null;

  const stkFreq = new Map();
  for (const row of rows) {
    const k = String(row.STKKOD || "").trim();
    if (!k) continue;
    stkFreq.set(k, (stkFreq.get(k) || 0) + 1);
  }
  const maxFreq = Math.max(...Array.from(stkFreq.values()), 1);

  let best = null;
  for (const row of rows) {
    const scored = scoreHistoricalMatch(line, {
      description: String(row.ACIKLAMA || row.STKCINSI || row.STKKOD || "").trim(),
      stkKod: row.STKKOD,
      stkCinsi: row.STKCINSI,
      unit: null,
      taxPercent: null,
      unitPrice: null,
    });
    const freq = stkFreq.get(String(row.STKKOD || "").trim()) || 0;
    const freqBonus = maxFreq > 0 ? (freq / maxFreq) * 0.1 : 0;
    const total = scored.total + freqBonus;
    if (!best || total > best.total) {
      best = {
        total,
        baseScore: scored.total,
        descScore: scored.descScore,
        cinsiScore: scored.cinsiScore,
        codeScore: scored.codeScore,
        weakDesc: scored.weakDesc,
        stkkod: String(row.STKKOD || "").trim(),
        stkcinsi: String(row.STKCINSI || "").trim(),
        row,
      };
    }
  }

  if (!best?.stkkod) return null;

  const minScore = parseNum(process.env.ETA_MATCH_MIN_SCORE, 0.28);
  const primary = primaryKalemAciklama(line);
  const hasUserNote = hasUserKalemAciklama(line);

  // Onay kalem açıklaması boşsa düşük metin skoru ile geçmiş eşleşmeyi eleme;
  // tedarikçinin baskın stok koduna düş (ör. kargo → NAKLİYE GİDERİ).
  if (!hasUserNote && best.total < minScore) {
    const dom = pickDominantSupplierHistoryMatch(rows, stkFreq);
    if (dom) best = dom;
  }

  if (hasUserNote && !isCodeLikeText(primary) && best.total < minScore) return null;

  return {
    stkkod: best.stkkod,
    stkcinsi: best.stkcinsi,
    refFatFisRefNo: Number(best.row?.FATFISREFNO || 0) || 0,
    refMuhRefNo: Number(best.row?.MUHREFNO || 0) || 0,
    refFatTip: Number(best.row?.FATTIP || 0) || 0,
    refHasTevkifat: Number(best.row?.HAS_TEV || 0) > 0,
    refIsIade: Number(best.row?.IS_IADE || 0) > 0,
    refIsIstisna: Number(best.row?.IS_ISTISNA || 0) > 0,
    refMalTop: parseNum(best.row?.MALTOP, 0),
    refGenTop: parseNum(best.row?.GENTOP, 0),
    refDovKod: String(best.row?.DOVKOD || "").trim(),
    refDovKur: parseNum(best.row?.DOVKUR, 1),
    score: Number(best.total.toFixed(4)),
    baseScore: Number(best.baseScore.toFixed(4)),
    descScore: Number(best.descScore.toFixed(4)),
    cinsiScore: Number(best.cinsiScore.toFixed(4)),
    codeScore: Number(best.codeScore.toFixed(4)),
    weakDesc: Boolean(best.weakDesc),
    dominantFallback: Boolean(best.dominantFallback),
    fromDescription: String(best.row?.ACIKLAMA || ""),
  };
}

/**
 * VKN için cari seçimi. Döviz: read DB FATFIS geçmişi; yoksa tek cari veya alfabetik ilk.
 * @returns {{ carkod: string, reason: string } | null}
 */
async function resolveCariKod(rPool, supplierVkn, currencyCode = "") {
  const digits = normalizeVknDigits(supplierVkn);
  if (!digits) return null;

  const codes = await listCariKodsForVkn(rPool, digits);
  if (!codes.length) return null;

  const fromHistory = await pickCariByDovizHistoryForVkn(rPool, digits, currencyCode);
  if (fromHistory?.carkod && codes.includes(fromHistory.carkod)) {
    return { carkod: fromHistory.carkod, reason: fromHistory.reason, candidateCodes: codes };
  }

  if (codes.length === 1) {
    return { carkod: codes[0], reason: "single_cari", candidateCodes: codes };
  }

  return {
    carkod: codes[0],
    reason: "fallback_first_carkod",
    candidateCodes: codes,
  };
}

/** Döviz kodu yurtiçi (TL/TRY) dışında mı? */
function isForeignCurrencyCode(code) {
  return !isDomesticTryOrTl(code);
}

/**
 * Fatura satırlarında "kur farkı" ibaresi var mı? (vade/fiyat farkı tetiklemez.)
 * Gelen UBL satırının Name/Description/Note metinlerine bakar.
 */
export function isKurFarkiInvoice(lines) {
  if (!Array.isArray(lines)) return false;
  return lines.some((l) => {
    const text = normalizeMatchText(
      `${l?.stokCinsi || ""} ${l?.description || ""} ${l?.lineAciklama || ""}`
    );
    return /kur\s*fark/.test(text);
  });
}

/**
 * Verilen CARKOD listesi için FATFIS geçmişinden döviz kırılımı yükler.
 * @returns {Map<string, {byCur: Record<string, number>, total: number, foreign: number}>}
 */
async function loadCariCurrencyProfile(rPool, codes) {
  const map = new Map();
  for (const c of codes) map.set(c, { byCur: {}, total: 0, foreign: 0 });
  if (!codes.length) return map;

  const req = rPool.request();
  const params = codes.map((c, i) => {
    req.input(`c${i}`, sql.NVarChar(40), c);
    return `@c${i}`;
  });
  const rs = await req.query(`
    SELECT FATFISCARKOD AS CARKOD,
           ISNULL(NULLIF(LTRIM(RTRIM(FATFISDOVKOD)),''),'TRY') AS DOV,
           COUNT(*) AS CNT
    FROM dbo.FATFIS WITH (NOLOCK)
    WHERE FATFISCARKOD IN (${params.join(",")})
    GROUP BY FATFISCARKOD, ISNULL(NULLIF(LTRIM(RTRIM(FATFISDOVKOD)),''),'TRY')
  `);
  for (const x of rs.recordset || []) {
    const ck = String(x.CARKOD || "").trim();
    if (!map.has(ck)) map.set(ck, { byCur: {}, total: 0, foreign: 0 });
    const o = map.get(ck);
    const cur = String(x.DOV || "TRY").toUpperCase();
    const cnt = Number(x.CNT) || 0;
    o.byCur[cur] = (o.byCur[cur] || 0) + cnt;
    o.total += cnt;
    if (isForeignCurrencyCode(cur)) o.foreign += cnt;
  }
  return map;
}

/**
 * Kur farkı faturası için cari seçimi.
 *
 * Kural (read DB gerçek kayıtlarına göre doğrulandı, ~%98 isabet):
 *  - Hedef döviz: fatura dövizliyse kendi para birimi; TL ise VKN'nin baskın döviz cinsi.
 *  - Hedef dövizde faturası olan cari:
 *      tek ise      -> o cariye yaz,
 *      birden çoksa -> BLOKE (kaydetme, arayüzde neden göster),
 *      hiç yoksa    -> başka döviz cari(ler)i: tek ise yaz, çoksa BLOKE.
 *  - Hiç döviz cari yoksa null döner (çağıran normal resolveCariKod'a düşer).
 *
 * @returns {Promise<null | {carkod?: string, reason: string, candidateCodes: string[],
 *   blocked?: boolean, blockDetail?: {target?: string, adaylar: string[]}}>}
 */
export async function resolveCariKodForKurFarki(rPool, supplierVkn, kfCurrency) {
  const digits = normalizeVknDigits(supplierVkn);
  if (!digits) return null;

  const codes = await listCariKodsForVkn(rPool, digits);
  if (!codes.length) return null;
  if (codes.length === 1) {
    return { carkod: codes[0], reason: "kurfarki_tek_cari", candidateCodes: codes };
  }

  const profile = await loadCariCurrencyProfile(rPool, codes);

  // Hedef döviz cinsini belirle
  let target = isForeignCurrencyCode(kfCurrency)
    ? String(kfCurrency).trim().toUpperCase()
    : null;
  if (!target) {
    const agg = {};
    for (const o of profile.values()) {
      for (const [cur, n] of Object.entries(o.byCur)) {
        if (isForeignCurrencyCode(cur)) agg[cur] = (agg[cur] || 0) + n;
      }
    }
    let best = null;
    let bn = 0;
    for (const [cur, n] of Object.entries(agg)) {
      if (n > bn) {
        bn = n;
        best = cur;
      }
    }
    target = best;
  }
  // VKN'de hiç döviz geçmişi yok: kur farkı ayrımı yapılamaz, normal mantığa bırak.
  if (!target) return null;

  const inTarget = codes.filter((c) => (profile.get(c)?.byCur[target] || 0) > 0);
  if (inTarget.length === 1) {
    return { carkod: inTarget[0], reason: `kurfarki_dov_${target}`, candidateCodes: codes };
  }
  if (inTarget.length > 1) {
    return {
      blocked: true,
      reason: `kurfarki_belirsiz_dov_${target}`,
      blockDetail: { target, adaylar: inTarget },
      candidateCodes: codes,
    };
  }

  // Hedef dövizde cari yok ama başka döviz cari(ler)i var: baskın dövizliye yaz.
  const fg = codes
    .filter((c) => (profile.get(c)?.foreign || 0) > 0)
    .sort((a, b) => (profile.get(b)?.foreign || 0) - (profile.get(a)?.foreign || 0));
  if (fg.length === 1) {
    return { carkod: fg[0], reason: "kurfarki_baskin_dov", candidateCodes: codes };
  }
  if (fg.length > 1) {
    return {
      blocked: true,
      reason: "kurfarki_belirsiz_baskin_dov",
      blockDetail: { adaylar: fg },
      candidateCodes: codes,
    };
  }
  return null;
}

async function ensureWriteCariWithUnvan(wPool, resolved, supplierVkn, fallbackCode) {
  const byCode = async (code) => {
    const c = String(code || "").trim();
    if (!c) return null;
    const rs = await wPool
      .request()
      .input("carkod", sql.NVarChar(40), c)
      .query(
        "SELECT TOP 1 CARKOD, CARUNVAN FROM dbo.CARKART WITH (NOLOCK) WHERE CARKOD=@carkod"
      );
    const row = rs.recordset[0];
    const unv = String(row?.CARUNVAN || "").trim();
    if (!row || !unv) return null;
    return String(row.CARKOD).trim();
  };

  const tryOrder = [];
  const push = (code) => {
    const c = String(code || "").trim();
    if (c && !tryOrder.includes(c)) tryOrder.push(c);
  };
  push(resolved?.carkod);
  for (const c of resolved?.candidateCodes || []) push(c);

  const digits = normalizeVknDigits(supplierVkn);
  if (digits) {
    const writeCodes = await listCariKodsForVkn(wPool, digits);
    for (const c of writeCodes) push(c);
  }
  push(fallbackCode);

  for (const code of tryOrder) {
    const found = await byCode(code);
    if (found) return found;
  }
  return null;
}

async function getExistingFatFisRef(wPool, evrakNo) {
  const rs = await wPool
    .request()
    .input("evrak", sql.NVarChar(80), evrakNo)
    .query("SELECT TOP 1 FATFISREFNO FROM dbo.FATFIS WITH (NOLOCK) WHERE FATFISEVRAKNO1=@evrak ORDER BY FATFISREFNO DESC");
  return rs.recordset[0]?.FATFISREFNO || null;
}

async function getFatFisHeaderByEvrakNo(wPool, evrakNo) {
  const rs = await wPool
    .request()
    .input("evrak", sql.NVarChar(80), evrakNo)
    .query(
      "SELECT TOP 1 FATFISREFNO, FATFISSTKREFNO FROM dbo.FATFIS WITH (NOLOCK) WHERE FATFISEVRAKNO1=@evrak ORDER BY FATFISREFNO DESC"
    );
  return rs.recordset[0] || null;
}

async function getFaturaLineCount(wPool, fatFisRefNo) {
  const rs = await wPool
    .request()
    .input("fatRef", sql.Int, fatFisRefNo)
    .query("SELECT COUNT(*) AS cnt FROM dbo.FATHAR WITH (NOLOCK) WHERE FATHARREFNO=@fatRef");
  return Number(rs.recordset[0]?.cnt || 0);
}

/**
 * ETA'ya yazmadan stok kodu seçimini simüle eder (sync ile aynı lineMatches mantığı).
 */
export async function previewStockLineMatches(afterData) {
  const rPool = await readPool();
  const wPool = await writePool();
  const q = afterData.qnbRaw && typeof afterData.qnbRaw === "object" ? afterData.qnbRaw : {};
  const defaults = await loadDefaults(rPool, wPool);
  const supplierVkn = String(afterData.supplierVkn || q.gondericiVkn || q.vknTckn || "").trim();
  const cls = classifyInvoiceType(afterData);
  const lines = applyKalemKullaniciAciklamalari(extractInvoiceLines(afterData), afterData);
  const usableLines = lines.length
    ? lines
    : [
        {
          itemCode: defaults.stok,
          description: "",
          stokCinsi: "UBL kalemi bulunamadı",
          lineAciklama: "",
          qty: 1,
          unit: "AD",
          unitPrice: parseNum(q.odenecekTutar, 0),
          net: parseNum(q.odenecekTutar, 0),
          taxAmount: 0,
          taxPercent: 0,
        },
      ];

  const paraBirimiRaw = extractInvoiceCurrency(afterData);
  const isForeignCurrency = !isDomesticTryOrTl(paraBirimiRaw);

  const preMatchedHistories = [];
  for (const l of usableLines) {
    if (!supplierVkn) {
      preMatchedHistories.push(null);
      continue;
    }
    const m = await findStockCodeBySupplierHistory(rPool, {
      supplierVkn,
      line: l,
      invoiceClass: cls,
      currencyCode: isForeignCurrency ? paraBirimiRaw : "",
    });
    preMatchedHistories.push(m || null);
  }

  const allowAutoStk = String(process.env.ETA_AUTO_CREATE_STKKART ?? "1").trim() !== "0";
  const stkTemplate = (process.env.ETA_STKKART_TEMPLATE_KOD || "").trim() || defaults.stok;
  const lineMatches = [];

  for (let i = 0; i < usableLines.length; i++) {
    const l = usableLines[i];
    const rawItemCode = String(l.itemCode || "").trim().slice(0, 40);
    let itemCodeResolved = null;
    let matchSource = null;
    let cinsiHit = null;
    const historyMatch = preMatchedHistories[i] ?? null;
    let stokFamilyRemapFrom = null;

    const histResolved = await resolveStockFromHistoryMatch(wPool, historyMatch, l, {
      allowAutoStk,
      stkTemplate,
    });
    itemCodeResolved = histResolved.itemCodeResolved;
    matchSource = histResolved.matchSource;
    if (historyMatch?.dominantFallback && matchSource) {
      matchSource = "supplier_history_dominant";
    }
    stokFamilyRemapFrom = histResolved.stokFamilyRemapFrom;

    if (!itemCodeResolved) {
      const primaryAcik = primaryKalemAciklama(l);
      if (primaryAcik && !isCodeLikeText(primaryAcik)) {
        cinsiHit = await resolveWriteStockByStkcinsi(wPool, primaryAcik);
        if (cinsiHit?.stkkod) {
          let cinsiKod = cinsiHit.stkkod;
          const fam = await preferStockCodeForUserFamilyPrefix(wPool, cinsiKod, l);
          if (fam.remappedFrom) {
            stokFamilyRemapFrom = fam.remappedFrom;
            cinsiKod = fam.code || cinsiKod;
          }
          itemCodeResolved = await resolveWriteStockCodeExact(wPool, cinsiKod);
          if (itemCodeResolved) {
            matchSource =
              cinsiHit.mode === "exact" ? "stkkart_cinsi_exact" : "stkkart_cinsi_fuzzy";
          }
        }
      }
    }
    if (!itemCodeResolved && shouldUseDirectItemCodeFallback(l, rawItemCode)) {
      itemCodeResolved = await resolveWriteStockCodeExact(wPool, rawItemCode);
      if (itemCodeResolved) matchSource = "direct_item_code";
    }
    if (!itemCodeResolved && rawItemCode && allowAutoStk) {
      try {
        await tryCloneStkkartFromTemplate(
          wPool,
          rawItemCode,
          String(primaryKalemAciklama(l) || l.stokCinsi || "").trim() || rawItemCode,
          l.unit,
          stkTemplate
        );
      } catch {
        /* duplicate */
      }
      itemCodeResolved = await resolveWriteStockCodeExact(wPool, rawItemCode);
      if (itemCodeResolved) matchSource = "new_stkkart_clone";
    }
    if (!itemCodeResolved) {
      itemCodeResolved = await ensureWriteStockCode(wPool, null, defaults.stok);
      matchSource = "default_fallback";
    }

    lineMatches.push({
      lineNo: i + 1,
      source: matchSource || "unknown",
      selectedStkKod: itemCodeResolved ? String(itemCodeResolved).slice(0, 40) : null,
      primaryKalemAciklama: primaryKalemAciklama(l),
      rawItemCode: rawItemCode || null,
      historyCandidateStk: historyMatch?.stkkod || null,
      ...(stokFamilyRemapFrom
        ? { stokFamilyRemapFrom, stokFamilyRemapTo: itemCodeResolved }
        : {}),
      historyScore: historyMatch?.score ?? null,
      cinsiMatchMode: cinsiHit?.mode || null,
      cinsiMatchScore: cinsiHit?.score ?? null,
      score: historyMatch?.score || null,
      scoreBreakdown: historyMatch
        ? {
            baseScore: historyMatch.baseScore || null,
            descScore: historyMatch.descScore || null,
            cinsiScore: historyMatch.cinsiScore || null,
            codeScore: historyMatch.codeScore || null,
            weakDesc: historyMatch.weakDesc || false,
            dominantFallback: historyMatch.dominantFallback || false,
          }
        : null,
      linePreview: {
        stokCinsi: l.stokCinsi || null,
        lineAciklama: l.lineAciklama || null,
        kullaniciKalemAciklama: l.kullaniciKalemAciklama || null,
      },
    });
  }

  return {
    supplierVkn,
    lineCount: usableLines.length,
    lines: usableLines,
    lineMatches,
  };
}

export async function syncApprovedInvoiceToEta(afterData, docId) {
  const rPool = await readPool();
  const wPool = await writePool();
  await ensureWriteProcedures(wPool);

  const q = afterData.qnbRaw && typeof afterData.qnbRaw === "object" ? afterData.qnbRaw : {};
  const belgeNo = String(afterData.belgeNo || q.belgeNo || "").trim();
  if (!belgeNo) throw new Error("belgeNo missing.");

  const existingHeader = await getFatFisHeaderByEvrakNo(wPool, belgeNo);
  const existingRef = existingHeader?.FATFISREFNO || null;
  const existingStokRef = existingHeader?.FATFISSTKREFNO || 0;
  const existingLineCount = existingRef ? await getFaturaLineCount(wPool, existingRef) : 0;
  const repairMode = Boolean(existingRef) && existingLineCount === 0;
  if (existingRef && !repairMode) {
    return { status: "already_exists", fatFisRefNo: existingRef, docId, lineCount: existingLineCount };
  }

  const defaults = await loadDefaults(rPool, wPool);
  const supplierVkn = String(afterData.supplierVkn || q.gondericiVkn || q.vknTckn || "").trim();
  const paraBirimiRaw = extractInvoiceCurrency(afterData);
  const isForeignCurrencyEarly = !isDomesticTryOrTl(paraBirimiRaw);

  // Kur farkı faturaları: kendi para birimine (çoğunlukla TL) değil, VKN'nin döviz
  // carisine yönlendirilir. Hedef döviz birden çok cariye denk gelirse kayıt YAPILMAZ.
  let cariResolved;
  const isKurFarki = isKurFarkiInvoice(extractInvoiceLines(afterData));
  if (isKurFarki) {
    const kf = await resolveCariKodForKurFarki(rPool, supplierVkn, paraBirimiRaw);
    if (kf?.blocked) {
      const adaylar = (kf.blockDetail?.adaylar || []).join(", ");
      const dovMetin = kf.blockDetail?.target ? `${kf.blockDetail.target} dövizinde ` : "";
      return {
        status: "blocked_kurfarki",
        blocked: true,
        blockReason: kf.reason,
        blockDetail: kf.blockDetail || null,
        blockMessage:
          `Kur farkı faturası: bu tedarikçide (VKN ${supplierVkn || "-"}) ${dovMetin}` +
          `birden fazla cari bulunduğu için hangi cariye yazılacağı belirlenemedi ` +
          `(adaylar: ${adaylar || "-"}). Otomatik kayıt yapılmadı; doğru cari elle seçilmelidir.`,
        docId,
      };
    }
    // kf null ise (tek cari / hiç döviz cari yok) normal mantığa düş.
    cariResolved =
      kf ||
      (await resolveCariKod(rPool, supplierVkn, isForeignCurrencyEarly ? paraBirimiRaw : ""));
  } else {
    cariResolved = await resolveCariKod(
      rPool,
      supplierVkn,
      isForeignCurrencyEarly ? paraBirimiRaw : ""
    );
  }

  const erpCariKodu = await ensureWriteCariWithUnvan(
    wPool,
    cariResolved,
    supplierVkn,
    process.env.ETA_FALLBACK_CARI_KOD?.trim()
  );
  if (!erpCariKodu) {
    throw new Error(
      `Cari kart bulunamadı veya CARUNVAN boş (supplierVkn=${supplierVkn || "-"}). ETA_FALLBACK_CARI_KOD (CARUNVAN dolu) tanımlayın.`
    );
  }

  const cls = classifyInvoiceType(afterData);
  // erpFaturaTipiNo aşağıda paraBirimi hesabından sonra, eşlenen geçmiş fatura
  // çoğunluk oyu ile belirleniyor (kullanıcı talebi 12 May 2026).
  const lines = applyKalemKullaniciAciklamalari(extractInvoiceLines(afterData), afterData);
  const usableLines = lines.length
    ? lines
    : [
        {
          itemCode: defaults.stok,
          description: "",
          stokCinsi: "UBL kalemi bulunamadı",
          lineAciklama: "",
          qty: 1,
          unit: "AD",
          unitPrice: parseNum(q.odenecekTutar, 0),
          net: parseNum(q.odenecekTutar, 0),
          taxAmount: 0,
          taxPercent: 0,
        },
      ];

  const faturaTarihi = parseYmd(q.belgeTarihi || afterData.belgeTarihi);
  const vadeTarihi = q.vadeTarihi ? parseYmd(q.vadeTarihi) : faturaTarihi;
  const ublDovizKuru = extractExchangeRateFromUbl(afterData);
  const dovizKuru = parseExchangeRate(q.dovizKuru ?? ublDovizKuru, 1);
  const isForeignCurrency = !isDomesticTryOrTl(paraBirimiRaw);
  const effectiveDovizKuru = isForeignCurrency && dovizKuru > 0 ? dovizKuru : 1;
  const amountModel = resolveAmountModel();
  const toplamIskonto = 0;

  let aligned;
  let docOdenecekTutar;
  let docTotals = null;

  if (amountModel === "ubl") {
    docTotals = buildDocTotalsForAmountModel(afterData, q, usableLines);
    aligned = computeUblExactAmounts({
      usableLines,
      docTotals,
      afterData,
      isForeignCurrency,
      kur: effectiveDovizKuru,
      parseQty: (line) => parseNum(line?.qty, 1) || 1,
    });
    docOdenecekTutar = aligned.docPayable;
  } else {
    aligned = computeAlignedInvoiceAmounts(usableLines, isForeignCurrency, effectiveDovizKuru);
    const docVergiFromQnb = parseNum(q.kdvToplamTutari ?? afterData?.kdvToplamTutari, 0);
    const docVergiFromLines = usableLines.reduce((s, x) => s + lineTaxFromUbl(x), 0);
    const docVergiTutari = docVergiFromQnb > 0 ? docVergiFromQnb : docVergiFromLines;
    docOdenecekTutar = parseNum(
      q.odenecekTutar,
      usableLines.reduce((s, x) => s + lineNetFromUbl(x), 0) + docVergiTutari
    );
  }

  const malHizmetToplamTutari = aligned.malHizmetToplamTutari;
  const vergiTutari = aligned.vergiTutari;
  const odenecekTutar = aligned.odenecekTutar;
  const ublWithholding = extractWithholdingFromUbl(afterData);
  const tevkifatOrani = parseNum(q.tevkifatOrani ?? afterData?.tevkifatOrani ?? ublWithholding.tevkifatOrani, 0);
  const tevkifatKodu = String(q.tevkifatKodu || afterData?.tevkifatKodu || ublWithholding.tevkifatKodu || "").trim();
  let kdvSplit = null;
  let tevkifatTutar = 0;
  if (cls?.hasTevkifat) {
    const payableTl =
      docOdenecekTutar > 0
        ? isForeignCurrency
          ? roundMoney(docOdenecekTutar * effectiveDovizKuru)
          : roundMoney(docOdenecekTutar)
        : 0;
    kdvSplit = computeTevkifatKdvSplit({
      malHizmetToplam: malHizmetToplamTutari,
      kdvOrani: usableLines[0]?.taxPercent ?? 0,
      tevkifatOrani,
    });
    if (vergiTutari > 0) {
      kdvSplit = { ...kdvSplit, toplamKdv: vergiTutari };
    }
    if (payableTl > 0) {
      kdvSplit = alignTevkifatSplitToPayable(kdvSplit, payableTl);
    }
    tevkifatTutar = kdvSplit?.tevkifatTutar ?? 0;
  }
  const vergiTutariKayit = kdvSplit ? kdvSplit.toplamKdv : vergiTutari;
  const odenecekTutarKayit = kdvSplit ? kdvSplit.odenecekTutar : odenecekTutar;
  const ublOtvTutar = extractOtvFromUbl(afterData);
  let otvTutar = parseNum(q.otvTutari ?? afterData?.otvTutari ?? ublOtvTutar, 0);
  otvTutar = convertDocAmountToTlIfNeeded(otvTutar, {
    isForeignCurrency,
    kur: effectiveDovizKuru,
    tlReferenceAmount: malHizmetToplamTutari,
  });
  const not1 = String(afterData.onayAciklamaMuhasebe || "").trim();
  const not2 = String(afterData.onayAciklamaNihaiOnay || "").trim();
  const not3 = String(afterData.onayAciklamaAraOnay || "").trim();
  const istisna = String(
    q.vergiIstisnaMuafiyetSebebi || afterData?.vergiIstisnaMuafiyetSebebi || extractIstisnaFromUbl(afterData) || ""
  ).trim();

  const stkTopBtut = malHizmetToplamTutari;
  const stkTopIsk = toplamIskonto;
  const stkTopNtut = malHizmetToplamTutari - toplamIskonto;
  const stkTopKdv = vergiTutariKayit;
  const stkTopKtut = stkTopNtut + stkTopKdv;
  const stkTopOtut = otvTutar;

  const connectorUser = (process.env.ETA_CONNECTOR_USER || "YMM").trim();
  const profile = String(q.faturaProfili || afterData?.faturaProfili || extractProfileFromUbl(afterData) || "TEMELFATURA").trim();
  const invoiceTypeCode = String(q.faturaTipi || cls.invType || "").trim();
  const despatchesFromSubcol = await loadDespatchesFromSubcollection(docId);
  const irsaliyeNumaralari = joinDespatchBelgeNos(despatchesFromSubcol);

  // [KULLANICI TALEBİ - 12 May 2026] Yeni faturanın fiş tipi (ErpFaturaTipi),
  // tedarikçi geçmişindeki eşlenen faturaların FATFISTIPI değerlerinden çoğunluk
  // oyu ile belirlenir. Sınıf (IADE/ISTISNA/TEVKIFAT) çelişen match'ler atılır;
  // hiç geçerli match yoksa mevcut resolveErpFaturaTipNo akışına düşülür.
  //
  // sp_Fatura_Kayit çağrısı satır loop'undan ÖNCE çalıştığı için satır eşleşmelerini
  // burada toplu hesaplıyoruz; line loop bu sonuçları (preMatchedHistories[i])
  // doğrudan kullanır — extra sorgu yapılmaz, davranış aynıdır.
  const preMatchedHistories = [];
  for (const l of usableLines) {
    if (!supplierVkn) {
      preMatchedHistories.push(null);
      continue;
    }
    const m = await findStockCodeBySupplierHistory(rPool, {
      supplierVkn,
      line: l,
      invoiceClass: cls,
      // Yurtiçi faturalarda döviz kodu göndermeyelim; geçmiş eşlemede TRY ile aynı mantık (boş → TRY).
      currencyCode: isForeignCurrency ? paraBirimiRaw : "",
    });
    preMatchedHistories.push(m || null);
  }
  const spSafeFatft = await loadSpFaturaKayitSafeFatftNoSet(rPool);
  const historicalFatTipPick = pickFatFisTipiFromHistory(
    preMatchedHistories,
    cls,
    spSafeFatft
  );
  const erpFaturaTipiNo =
    historicalFatTipPick > 0 && spSafeFatft.has(historicalFatTipPick)
      ? historicalFatTipPick
      : await resolveErpFaturaTipNo(rPool, cls);

  const lineMatches = [];
  const lineCurrency = [];
  let refFatFisForMuhasebe = 0;

  let fatFisRefNo = existingRef || null;
  let stokFisRefNo = existingStokRef || 0;
  if (!repairMode) {
    const req = wPool.request();
    req.input("ErpCariKodu", sql.NVarChar(sql.MAX), erpCariKodu);
    req.input("ErpDepoKodu", sql.NVarChar(sql.MAX), defaults.depo);
    req.input("KonnektorKullaniciAdi", sql.NVarChar(sql.MAX), connectorUser);
    req.input("VknTckn", sql.NVarChar(11), supplierVkn || "");
    req.input("FaturaProfili", sql.NVarChar(50), profile);
    req.input("FaturaTipi", sql.NVarChar(50), invoiceTypeCode);
    req.input("ErpFaturaTipi", sql.NVarChar(50), String(erpFaturaTipiNo));
    req.input("FaturaNumarasi", sql.NVarChar(16), belgeNo.slice(0, 16));
    req.input("FaturaTarihi", sql.DateTime, faturaTarihi);
    req.input("IrsaliyeNumaralari", sql.NVarChar(510), irsaliyeNumaralari);
    req.input("VadeTarihi", sql.DateTime, vadeTarihi);
    req.input("MalHizmetToplamTutari", sql.Decimal(18, 4), malHizmetToplamTutari);
    req.input("ToplamIskonto", sql.Decimal(18, 4), toplamIskonto);
    req.input("VergiOrani", sql.Decimal(18, 4), usableLines[0]?.taxPercent || 0);
    req.input("VergiTutari", sql.Decimal(18, 4), vergiTutariKayit);
    req.input("OdenecekTutar", sql.Decimal(18, 4), odenecekTutarKayit);
    req.input("TevkifatOrani", sql.Decimal(18, 4), tevkifatOrani);
    req.input("TevkifatKodu", sql.NVarChar(100), tevkifatKodu);
    req.input("TevkifatTutar", sql.Decimal(18, 4), tevkifatTutar);
    req.input("OtvTutar", sql.Decimal(18, 4), otvTutar);
    req.input("ParaBirimi", sql.NVarChar(sql.MAX), isForeignCurrency ? paraBirimiRaw : "");
    req.input("DovizKuru", sql.Decimal(18, 4), isForeignCurrency ? dovizKuru : 0);
    req.input("Not1", sql.NVarChar(sql.MAX), not1);
    req.input("Not2", sql.NVarChar(sql.MAX), not2);
    req.input("Not3", sql.NVarChar(sql.MAX), not3);
    req.input("VergiIstisnaMuafiyetSebebi", sql.NVarChar(255), istisna);
    req.input("STKFISTOPBTUT", sql.Decimal(18, 4), stkTopBtut);
    req.input("STKFISTOPISK", sql.Decimal(18, 4), stkTopIsk);
    req.input("STKFISTOPNTUT", sql.Decimal(18, 4), stkTopNtut);
    req.input("STKFISTOPKDV", sql.Decimal(18, 4), stkTopKdv);
    req.input("STKFISTOPKTUT", sql.Decimal(18, 4), stkTopKtut);
    req.input("STKFISTOPOTUT", sql.Decimal(18, 4), stkTopOtut);
    req.output("DonusDegeri1", sql.Int);
    req.output("DonusDegeri2", sql.Int);
    await req.execute("dbo.sp_Fatura_Kayit");

    fatFisRefNo = req.parameters.DonusDegeri1.value;
    stokFisRefNo = req.parameters.DonusDegeri2.value || 0;
    if (!fatFisRefNo) {
      // Some DB variants do not reliably set output params; fallback by invoice no.
      fatFisRefNo = await getExistingFatFisRef(wPool, belgeNo);
    }
    if (!fatFisRefNo) {
      throw new Error("sp_Fatura_Kayit did not return DonusDegeri1 and FATFIS row was not found.");
    }
  }

  const allowAutoStk = String(process.env.ETA_AUTO_CREATE_STKKART ?? "1").trim() !== "0";
  const stkTemplate = (process.env.ETA_STKKART_TEMPLATE_KOD || "").trim() || defaults.stok;

  for (let i = 0; i < usableLines.length; i++) {
    const l = usableLines[i];
    const alignedLine = aligned.perLine[i];
    const rawItemCode = String(l.itemCode || "").trim().slice(0, 40);
    let itemCodeResolved = null;
    let matchSource = null;
    // Eşleşme yukarıda toplu hesaplandı (preMatchedHistories); cache'ten kullan.
    const historyMatch = preMatchedHistories[i] ?? null;
    if (!refFatFisForMuhasebe && historyMatch?.refFatFisRefNo) {
      // Reference invoice for accounting pattern (DENEME only). Apply tevkifat threshold compatibility if needed.
      const limit = parseNum(process.env.ETA_TEVKIFAT_LIMIT_TL, 12000);
      const newMalTl = malHizmetToplamTutari; // already scaled to TL by effectiveDovizKuru
      let refMalTl = parseNum(historyMatch.refMalTop, 0);
      const refDov = String(historyMatch.refDovKod || "").trim().toUpperCase();
      const refKur = parseNum(historyMatch.refDovKur, 1);
      if (refDov && !isDomesticTryOrTl(refDov) && refKur > 0) refMalTl = refMalTl * refKur;
      const sameClass =
        Boolean(historyMatch.refHasTevkifat) === Boolean(cls?.hasTevkifat) &&
        Boolean(historyMatch.refIsIade) === Boolean(cls?.isIade) &&
        Boolean(historyMatch.refIsIstisna) === Boolean(cls?.isIstisna);
      const newBucket = cls?.hasTevkifat ? (newMalTl >= limit ? "GE" : "LT") : "NA";
      const refBucket = cls?.hasTevkifat ? (refMalTl >= limit ? "GE" : "LT") : "NA";
      if (sameClass && (!cls?.hasTevkifat || newBucket === refBucket)) {
        refFatFisForMuhasebe = Number(historyMatch.refFatFisRefNo || 0) || 0;
      }
    }
    let stokFamilyRemapFrom = null;
    const histResolved = await resolveStockFromHistoryMatch(wPool, historyMatch, l, {
      allowAutoStk,
      stkTemplate,
    });
    itemCodeResolved = histResolved.itemCodeResolved;
    matchSource = histResolved.matchSource;
    if (historyMatch?.dominantFallback && matchSource) {
      matchSource = "supplier_history_dominant";
    }
    stokFamilyRemapFrom = histResolved.stokFamilyRemapFrom;

    if (!itemCodeResolved) {
      const primaryAcik = primaryKalemAciklama(l);
      if (primaryAcik && !isCodeLikeText(primaryAcik)) {
        const cinsiHit = await resolveWriteStockByStkcinsi(wPool, primaryAcik);
        if (cinsiHit?.stkkod) {
          let cinsiKod = cinsiHit.stkkod;
          const fam = await preferStockCodeForUserFamilyPrefix(wPool, cinsiKod, l);
          if (fam.remappedFrom) {
            stokFamilyRemapFrom = fam.remappedFrom;
            cinsiKod = fam.code || cinsiKod;
          }
          itemCodeResolved = await resolveWriteStockCodeExact(wPool, cinsiKod);
          if (itemCodeResolved) {
            matchSource =
              cinsiHit.mode === "exact" ? "stkkart_cinsi_exact" : "stkkart_cinsi_fuzzy";
          }
        }
      }
    }
    if (!itemCodeResolved && shouldUseDirectItemCodeFallback(l, rawItemCode)) {
      itemCodeResolved = await resolveWriteStockCodeExact(wPool, rawItemCode);
      if (itemCodeResolved) matchSource = "direct_item_code";
    }
    if (!itemCodeResolved && rawItemCode && allowAutoStk) {
      try {
        await tryCloneStkkartFromTemplate(
          wPool,
          rawItemCode,
          String(primaryKalemAciklama(l) || l.stokCinsi || "").trim() || rawItemCode,
          l.unit,
          stkTemplate
        );
      } catch {
        /* duplicate / şema */
      }
      itemCodeResolved = await resolveWriteStockCodeExact(wPool, rawItemCode);
      if (itemCodeResolved) matchSource = "new_stkkart_clone";
    }
    if (!itemCodeResolved) {
      itemCodeResolved = await ensureWriteStockCode(wPool, null, defaults.stok);
      matchSource = "default_fallback";
    }
    if (!itemCodeResolved) {
      throw new Error("No valid STKKOD found in write DB for invoice line.");
    }
    const itemCode = itemCodeResolved.slice(0, 40);
    lineMatches.push({
      lineNo: i + 1,
      source: matchSource || "unknown",
      selectedStkKod: itemCode,
      ...(stokFamilyRemapFrom
        ? { stokFamilyRemapFrom, stokFamilyRemapTo: itemCode }
        : {}),
      score: historyMatch?.score || null,
      scoreBreakdown: historyMatch
        ? {
            baseScore: historyMatch.baseScore || null,
            descScore: historyMatch.descScore || null,
            cinsiScore: historyMatch.cinsiScore || null,
            codeScore: historyMatch.codeScore || null,
            weakDesc: historyMatch.weakDesc || false,
            dominantFallback: historyMatch.dominantFallback || false,
          }
        : null,
    });
    const qty = alignedLine?.qty ?? (parseNum(l.qty, 1) || 1);
    const taxPercent = parseNum(l.taxPercent, 0);
    const lineTax = alignedLine?.taxTl ?? etaLineTaxTl(l, isForeignCurrency, effectiveDovizKuru);
    const unitPriceForSp = alignedLine?.unitPrice ?? unitPriceForEtaLine(l, isForeignCurrency, effectiveDovizKuru);
    const taxAmountForSp = lineTax;
    const lineAcik = String(l.lineAciklama || "").trim();
    const satirAcikSrc = String(lineAcik || l.stokCinsi || l.itemCode || "HIZMET").trim();
    const satirNotu = satirAcikSrc.slice(0, 50);
    const satirAcik = satirAcikSrc.slice(0, 255);
    const docLineNet = alignedLine?.docNet ?? strictLineNetFromUbl(l);
    const docLineUnit = alignedLine?.docUnitPrice ?? strictLineUnitPriceFromUbl(l);
    lineCurrency.push({
      sira: i + 1,
      dovFiyat: docLineUnit,
      dovTutar: docLineNet,
    });

    const dr = wPool.request();
    dr.input("FatFisRefNo", sql.Int, fatFisRefNo);
    dr.input("StokFisRefNo", sql.Int, stokFisRefNo);
    dr.input("SiraNumarasi", sql.Int, i + 1);
    dr.input("FaturaTuru", sql.Int, 1);
    dr.input("FaturaTarihi", sql.DateTime, faturaTarihi);
    dr.input("ErpCariKodu", sql.NVarChar(sql.MAX), erpCariKodu);
    dr.input("ErpDepoKodu", sql.NVarChar(sql.MAX), defaults.depo);
    dr.input("ErpFaturaTipi", sql.NVarChar(50), String(erpFaturaTipiNo));
    dr.input("KonnektorKullaniciAdi", sql.NVarChar(sql.MAX), connectorUser);
    dr.input("ErpUrunKodu", sql.NVarChar(255), itemCode);
    dr.input("MalHizmetMiktar", sql.Decimal(18, 4), qty);
    dr.input("BirimKodu", sql.NVarChar(10), String(l.unit || "AD").slice(0, 10));
    dr.input("BirimFiyat", sql.Decimal(18, 6), unitPriceForSp);

    for (let k = 1; k <= 6; k++) {
      dr.input(`IskontoOrani${k}`, sql.Decimal(18, 4), 0);
      dr.input(`IskontoTutari${k}`, sql.Decimal(18, 4), 0);
      dr.input(`FaturaAltiIskontoOrani${k}`, sql.Decimal(18, 4), 0);
      dr.input(`FaturaAltiIskontoTutari${k}`, sql.Decimal(18, 4), 0);
    }
    dr.input("VergiOrani", sql.Decimal(18, 6), taxPercent);
    dr.input("VergiTutari", sql.Decimal(18, 6), taxAmountForSp);
    dr.input("OtvOrani", sql.Decimal(18, 4), 0);
    dr.input("OtvTutari", sql.Decimal(18, 4), 0);
    dr.input("SatirNotu", sql.NVarChar(50), satirNotu);
    dr.input("SatirAciklamasi", sql.NVarChar(255), satirAcik);
    dr.input("SatirTevkifatOrani", sql.Decimal(18, 4), tevkifatOrani);
    dr.input("SatirTevkifatKodu", sql.NVarChar(100), tevkifatKodu);
    dr.input("SatirTevkifatTutari", sql.Decimal(18, 4), 0);
    await dr.execute("dbo.sp_Fatura_Detay_Kayit");

    const skipFatharPatch = String(process.env.ETA_SKIP_FATHAR_PATCH ?? "").trim() === "1";
    if (
      amountModel === "ubl" &&
      !skipFatharPatch &&
      alignedLine &&
      (alignedLine.netTl > 0 || alignedLine.taxTl > 0)
    ) {
      const netPatch = roundMoney(alignedLine.netTl);
      const taxPatch = roundMoney(alignedLine.taxTl);
      const dovTutar = roundMoney(alignedLine.docNet ?? 0);
      const dovFiyat = roundMoney(alignedLine.docUnitPrice ?? 0);
      await wPool
        .request()
        .input("ref", sql.Int, fatFisRefNo)
        .input("sira", sql.Int, i + 1)
        .input("net", sql.Decimal(18, 4), netPatch)
        .input("tax", sql.Decimal(18, 4), taxPatch)
        .input("dovTut", sql.Decimal(18, 4), dovTutar)
        .input("dovFyt", sql.Decimal(18, 6), dovFiyat)
        .query(`
          UPDATE dbo.FATHAR
          SET
            FATHARTUTAR = @net,
            FATHARNETTUTAR = @net,
            FATHARKDVMATRAH = @net,
            FATHARKDVTUTAR = @tax,
            FATHARDOVTUTAR = CASE WHEN @dovTut > 0 THEN @dovTut ELSE FATHARDOVTUTAR END,
            FATHARDOVFIYAT = CASE WHEN @dovFyt > 0 THEN @dovFyt ELSE FATHARDOVFIYAT END
          WHERE FATHARREFNO = @ref AND FATHARSIRANO = @sira
        `);
    }

    const stkc = String(l.stokCinsi || "").trim().slice(0, 80);
    const ac = lineAcik;
    if (stkc || ac) {
      await wPool
        .request()
        .input("ref", sql.Int, fatFisRefNo)
        .input("sira", sql.Int, i + 1)
        .input("stkc", sql.NVarChar(80), stkc)
        .input("ac0", sql.NVarChar(80), ac.slice(0, 80))
        .input("ac1", sql.NVarChar(80), ac.length > 80 ? ac.slice(80, 160) : "")
        .query(`
          UPDATE dbo.FATHAR
          SET
            FATHARSTKCINS = CASE WHEN @stkc = N'' THEN FATHARSTKCINS ELSE @stkc END,
            FATHARACIKLAMA = @ac0,
            FATHARACIKLAMA1 = @ac1
          WHERE FATHARREFNO = @ref AND FATHARSIRANO = @sira
        `);
    }
  }

  await patchFatFisIrsaliyeAlanlari(wPool, fatFisRefNo, despatchesFromSubcol);
  await patchCurrencyFields(wPool, fatFisRefNo, {
    currencyCode: paraBirimiRaw,
    dovizKuru: effectiveDovizKuru,
    docOdenecekTutar,
    faturaTarihi,
    lineCurrency,
  });

  await wPool.request().input("FatFisRefNo", sql.Int, fatFisRefNo).execute("dbo.sp_FatFisToplam_Kayit");

  await syncFatFisHeaderFromFathar(wPool, fatFisRefNo, {
    useUblHeader: amountModel === "ubl",
    malTop: malHizmetToplamTutari,
    kdvTop: vergiTutariKayit,
    odenecekTutar: odenecekTutarKayit,
    tevkifatTutar: kdvSplit?.tevkifatTutar,
  });

  await patchCariCurrencyFromFatFis(wPool, fatFisRefNo);

  // Binek araç gideri (yakıt/kira): %70/%30 + KKEG + indirilemeyen KDV kuralıyla
  // ayrı binek prosedürü çağrılır. Ticari/araç dışı faturalar mevcut normal
  // muhasebe akışını (hiç değişmeden) kullanır.
  const aracTipi = String(afterData?.aracTespit?.aracTipi || "").trim().toLowerCase();
  // ALIM (FATFISTIPI=1): muhasebe her zaman kalem bazlı; referans SP'ye gönderilmez.
  const muhasebeRefForSp = Number(erpFaturaTipiNo) === 1 ? 0 : refFatFisForMuhasebe;
  let binekMuhasebe = null;
  if (aracTipi === "binek" && !cls?.hasTevkifat) {
    const rules = await loadAracGiderKurallari(getFirestore());
    const giderTuru = detectGiderTuru(giderMetniFromLines(usableLines));
    binekMuhasebe = await tryBinekAracMuhasebe(wPool, fatFisRefNo, { giderTuru, rules });
    if (binekMuhasebe?.skipped) {
      console.warn(
        "syncApprovedInvoiceToEta: binek araç muhasebe atlandı (normal SP çağrılmadı)",
        docId,
        binekMuhasebe.reason,
        binekMuhasebe.giderTuru
      );
    }
  } else {
    await tryAutoMuhasebeForDeneme(wPool, fatFisRefNo, {
      refFatFisRefNo: muhasebeRefForSp,
    });
  }

  const verify = await wPool
    .request()
    .input("fatRef", sql.Int, fatFisRefNo)
    .query("SELECT TOP 1 FATFISREFNO, FATFISEVRAKNO1, FATFISMUHREFNO FROM dbo.FATFIS WITH (NOLOCK) WHERE FATFISREFNO=@fatRef");

  return {
    status: repairMode ? "repaired" : "inserted",
    docId,
    fatFisRefNo,
    stokFisRefNo,
    muhFisRefNo: verify.recordset[0]?.FATFISMUHREFNO || 0,
    muhasebeRefFatFisRefNo: muhasebeRefForSp || 0,
    ...(binekMuhasebe && { binekAracMuhasebe: binekMuhasebe }),
    erpCariKodu,
    cariResolveReason: cariResolved?.reason || null,
    lineCount: usableLines.length,
    lineMatches,
  };
}

