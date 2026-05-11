import sql from "mssql";
import { resolveSqlTargets } from "./sqlDbTargets.js";

let readPoolPromise = null;
let writePoolPromise = null;
let cachedDefaults = null;
let validatedWriteProcedures = false;
let cachedStkkartColumnNames = null;
let validatedDenemeMuhasebeProcedure = false;

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
    return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00`);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function upper(s) {
  return String(s || "").toUpperCase();
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

function scoreHistoricalMatch(targetLine, candidateLine) {
  const itemNameTxt = String(targetLine.itemCode ?? "").trim();
  const satirAcik = String(targetLine.lineAciklama ?? targetLine.description ?? itemNameTxt).trim();
  const stokCinsiTxt = String(targetLine.stokCinsi ?? itemNameTxt).trim();
  const descScore = jaccardSimilarity(satirAcik, candidateLine.description);
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
  const total = weakDesc
    ? descScore * 0.25 + cinsiScore * 0.3 + codeScore * 0.35 + unitMatch * 0.03 + taxScore * 0.03 + priceScore * 0.04
    : descScore * 0.55 + cinsiScore * 0.2 + codeScore * 0.15 + unitMatch * 0.03 + taxScore * 0.03 + priceScore * 0.04;
  return { total, descScore, cinsiScore, codeScore, unitMatch, taxScore, priceScore, weakDesc };
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

  // NOTE:
  // ETA'daki mevcut sp_Fatura_Kayit prosedürü cari bakiye güncellemesinde yalnızca
  // ALIM / GIDER / ALIM IADE tiplerini destekliyor. TEVKIFATLI ALIS veya YURT DISI ALIM
  // gibi tipler Tanimsiz Fatura Tipi hatasına düşebildiği için, alış akışında güvenli varsayılan ALIM.
  const r = await pool
    .request()
    .query("SELECT TOP 1 FATFTNO FROM dbo.FATFISTIP WITH (NOLOCK) WHERE UPPER(FATFTKOD)='ALIM' ORDER BY FATFTNO");
  return r.recordset.length ? r.recordset[0].FATFTNO : 1;
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
    const item = firstOf(line.Item) || {};
    const nameKod = textNode(item.Name).trim();
    const noteParts = collectInvoiceLineNotes(line);
    const noteKod = noteParts.length ? noteParts.join(" | ") : "";
    /** UBL `cbc:Name` → ETA stok kodu (STKKOD); boşsa `InvoiceLine.Note`. */
    const itemCode = (nameKod || noteKod).slice(0, 40);
    /** UBL `cbc:Note` (InvoiceLine) + `cbc:Name` (Item) → satır açıklaması. */
    const lineAciklamaParts = [];
    if (noteKod) lineAciklamaParts.push(noteKod);
    if (nameKod) lineAciklamaParts.push(nameKod);
    const lineAciklama = lineAciklamaParts.join(" | ");
    const descParts = collectItemDescriptions(item);
    /** UBL `cbc:Description` (Item) → stok cinsi. Boşsa `InvoiceLine.Note` fallback. */
    const stokCinsi = (descParts.length ? descParts.join(" | ") : lineAciklama).trim();
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
      /** Geçmiş eşleştirme: satır açıklaması (FATHARACIKLAMA) ile karşılaştırma. */
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

function extractIrsaliyeNumaralari(data) {
  const out = [];
  const pushVal = (v) => {
    const s = String(v || "").trim();
    if (!s) return;
    if (!out.includes(s)) out.push(s);
  };

  const rel = data.relatedDespatches;
  if (Array.isArray(rel)) {
    for (const d of rel) {
      if (d && typeof d === "object") {
        pushVal(d.belgeNo || d.belgeNoStr || d.despatchNo || d.irsaliyeNo);
      }
    }
  }

  const q = data.qnbRaw && typeof data.qnbRaw === "object" ? data.qnbRaw : {};
  const qList = q.irsaliyeNumaralari || q.irsaliyeNoList || q.despatchNos;
  if (Array.isArray(qList)) {
    for (const x of qList) pushVal(x);
  } else if (typeof qList === "string") {
    for (const part of qList.split(/[;,]/)) pushVal(part);
  }

  return out.join(",");
}

/** `relatedDespatches[].issueDate` → ilk geçerli tarih (YYYYMMDD veya ISO). */
function extractFirstIrsaliyeTarihiFromRelated(data) {
  const rel = data.relatedDespatches;
  if (!Array.isArray(rel)) return null;
  for (const d of rel) {
    if (!d || typeof d !== "object") continue;
    const raw = d.issueDate ?? d.belgeTarihi ?? d.issue_date;
    const s = String(raw || "").trim();
    if (!s) continue;
    if (/^\d{8}$/.test(s)) {
      const dt = parseYmd(s);
      if (!Number.isNaN(dt.getTime())) return dt;
      continue;
    }
    const dt = new Date(s);
    if (!Number.isNaN(dt.getTime())) return dt;
  }
  return null;
}

/** Fatura UBL `cac:DespatchDocumentReference/cbc:IssueDate` (varsa). */
function extractFirstIrsaliyeTarihiFromUbl(data) {
  const up = data.ublParsed && typeof data.ublParsed === "object" ? data.ublParsed : {};
  const inv = firstOf(up.Invoice);
  if (!inv || typeof inv !== "object") return null;
  const ddr = inv.DespatchDocumentReference;
  const arr = Array.isArray(ddr) ? ddr : ddr ? [ddr] : [];
  for (const d of arr) {
    if (!d || typeof d !== "object") continue;
    const raw = d.IssueDate;
    const s = textNode(raw);
    if (!s) continue;
    if (/^\d{8}$/.test(s)) {
      const dt = parseYmd(s);
      if (!Number.isNaN(dt.getTime())) return dt;
      continue;
    }
    const dt = new Date(s.length >= 10 ? s.slice(0, 10) : s);
    if (!Number.isNaN(dt.getTime())) return dt;
  }
  return null;
}

function extractFirstIrsaliyeTarihi(data) {
  return extractFirstIrsaliyeTarihiFromRelated(data) || extractFirstIrsaliyeTarihiFromUbl(data);
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
 * `@IrsaliyeNumaralari` parametresini kullanmaz. Bu güncelleme Firestore `relatedDespatches` + qnb irsaliye listesini yansıtır.
 * İrsaliye numarası yoksa `FATFISIRSNO` temizlenir (fatura no tekrarı kalkar).
 */
async function patchFatFisIrsaliyeAlanlari(wPool, fatFisRefNo, afterData) {
  const joined = extractIrsaliyeNumaralari(afterData).trim();
  const firstNo = joined
    .split(/[,;]/)
    .map((x) => String(x || "").trim())
    .find(Boolean);
  const irTar = extractFirstIrsaliyeTarihi(afterData);
  const hasNo = Boolean(firstNo);
  const hasTar = Boolean(irTar);

  await wPool
    .request()
    .input("ref", sql.Int, fatFisRefNo)
    .input("irsno", sql.NVarChar(80), hasNo ? String(firstNo).slice(0, 80) : "")
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
  const isForeign = currencyCode && currencyCode !== "TRY" && kur > 0;
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
  const targetDesc = String(line.description || line.lineAciklama || line.stokCinsi || line.itemCode || "").trim();
  if (!targetDesc) return null;

  const lookbackMonths = Number(process.env.ETA_MATCH_LOOKBACK_MONTHS || 12);
  const candidateLimit = Number(process.env.ETA_MATCH_CANDIDATE_LIMIT || 300);
  const cariRs = await rPool
    .request()
    .input("vkn", sql.NVarChar(40), supplierVkn)
    .query(
      "SELECT TOP 1 CARKOD FROM dbo.CARKART WITH (NOLOCK) WHERE REPLACE(REPLACE(ISNULL(CARVERHESNO,''),' ',''),'-','')=@vkn ORDER BY CARKOD"
    );
  const carkod = String(cariRs.recordset[0]?.CARKOD || "").trim();
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
    fromDescription: String(best.row?.ACIKLAMA || ""),
  };
}

async function resolveCariKod(rPool, supplierVkn) {
  if (!supplierVkn) return null;
  const digits = supplierVkn.replace(/\D/g, "");
  if (!digits) return null;
  const rs = await rPool
    .request()
    .input("vkn", sql.NVarChar(40), digits)
    .query(
      "SELECT TOP 1 CARKOD FROM dbo.CARKART WITH (NOLOCK) WHERE REPLACE(REPLACE(ISNULL(CARVERHESNO,''),' ',''),'-','') = @vkn ORDER BY CARKOD"
    );
  return rs.recordset[0]?.CARKOD || null;
}

async function ensureWriteCariWithUnvan(wPool, candidateCode, supplierVkn, fallbackCode) {
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

  const a = await byCode(candidateCode);
  if (a) return a;

  const digits = String(supplierVkn || "").replace(/\D/g, "");
  if (digits) {
    const rs = await wPool
      .request()
      .input("vkn", sql.NVarChar(40), digits)
      .query(
        "SELECT TOP 1 CARKOD FROM dbo.CARKART WITH (NOLOCK) WHERE REPLACE(REPLACE(ISNULL(CARVERHESNO,''),' ',''),'-','')=@vkn AND ISNULL(LTRIM(RTRIM(CARUNVAN)),'')<>'' ORDER BY CARKOD"
      );
    const b = rs.recordset[0]?.CARKOD;
    if (b) return String(b).trim();
  }

  const c = await byCode(fallbackCode);
  if (c) return c;
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
  const erpCariKodu = await ensureWriteCariWithUnvan(
    wPool,
    await resolveCariKod(rPool, supplierVkn),
    supplierVkn,
    process.env.ETA_FALLBACK_CARI_KOD?.trim()
  );
  if (!erpCariKodu) {
    throw new Error(
      `Cari kart bulunamadı veya CARUNVAN boş (supplierVkn=${supplierVkn || "-"}). ETA_FALLBACK_CARI_KOD (CARUNVAN dolu) tanımlayın.`
    );
  }

  const cls = classifyInvoiceType(afterData);
  const erpFaturaTipiNo = await resolveErpFaturaTipNo(rPool, cls);
  const lines = extractInvoiceLines(afterData);
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
  const ublCurrencyCode = extractCurrencyCodeFromUbl(afterData);
  const paraBirimi = String(q.odenecekTutarDovizCinsi || q.paraBirimi || ublCurrencyCode || "").trim().toUpperCase();
  const ublDovizKuru = extractExchangeRateFromUbl(afterData);
  const dovizKuru = parseExchangeRate(q.dovizKuru ?? ublDovizKuru, 1);
  const isForeignCurrency = upper(paraBirimi) !== "TRY";
  const effectiveDovizKuru = isForeignCurrency && dovizKuru > 0 ? dovizKuru : 1;
  const docMalHizmetToplamTutari = usableLines.reduce((s, x) => s + (x.net || 0), 0);
  const toplamIskonto = 0;
  const docVergiTutari = usableLines.reduce((s, x) => s + (x.taxAmount || 0), 0);
  const docOdenecekTutar = parseNum(q.odenecekTutar, docMalHizmetToplamTutari + docVergiTutari);
  const malHizmetToplamTutari = docMalHizmetToplamTutari * effectiveDovizKuru;
  const vergiTutari = docVergiTutari * effectiveDovizKuru;
  const odenecekTutar = docOdenecekTutar * effectiveDovizKuru;
  const ublWithholding = extractWithholdingFromUbl(afterData);
  const tevkifatTutar = parseNum(q.tevkifatTutari ?? afterData?.tevkifatTutari ?? ublWithholding.tevkifatTutar, 0);
  const tevkifatOrani = parseNum(q.tevkifatOrani ?? afterData?.tevkifatOrani ?? ublWithholding.tevkifatOrani, 0);
  const tevkifatKodu = String(q.tevkifatKodu || afterData?.tevkifatKodu || ublWithholding.tevkifatKodu || "").trim();
  const ublOtvTutar = extractOtvFromUbl(afterData);
  const otvTutar = parseNum(q.otvTutari ?? afterData?.otvTutari ?? ublOtvTutar, 0);
  const not1 = String(afterData.onayAciklamaMuhasebe || "").trim();
  const not2 = String(afterData.onayAciklamaNihaiOnay || "").trim();
  const not3 = String(afterData.onayAciklamaAraOnay || "").trim();
  const istisna = String(
    q.vergiIstisnaMuafiyetSebebi || afterData?.vergiIstisnaMuafiyetSebebi || extractIstisnaFromUbl(afterData) || ""
  ).trim();

  const stkTopBtut = malHizmetToplamTutari;
  const stkTopIsk = toplamIskonto;
  const stkTopNtut = malHizmetToplamTutari - toplamIskonto;
  const stkTopKdv = vergiTutari;
  const stkTopKtut = stkTopNtut + stkTopKdv;
  const stkTopOtut = otvTutar;

  const connectorUser = (process.env.ETA_CONNECTOR_USER || "YMM").trim();
  const profile = String(q.faturaProfili || afterData?.faturaProfili || extractProfileFromUbl(afterData) || "TEMELFATURA").trim();
  const invoiceTypeCode = String(q.faturaTipi || cls.invType || "").trim();
  const irsaliyeNumaralari = extractIrsaliyeNumaralari(afterData);
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
    req.input("VergiTutari", sql.Decimal(18, 4), vergiTutari);
    req.input("OdenecekTutar", sql.Decimal(18, 4), odenecekTutar);
    req.input("TevkifatOrani", sql.Decimal(18, 4), tevkifatOrani);
    req.input("TevkifatKodu", sql.NVarChar(100), tevkifatKodu);
    req.input("TevkifatTutar", sql.Decimal(18, 4), tevkifatTutar);
    req.input("OtvTutar", sql.Decimal(18, 4), otvTutar);
    req.input("ParaBirimi", sql.NVarChar(sql.MAX), paraBirimi);
    req.input("DovizKuru", sql.Decimal(18, 4), dovizKuru);
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
    const rawItemCode = String(l.itemCode || "").trim().slice(0, 40);
    let itemCodeResolved = null;
    let matchSource = null;
    const historyMatch = supplierVkn
      ? await findStockCodeBySupplierHistory(rPool, {
          supplierVkn,
          line: l,
          invoiceClass: cls,
          currencyCode: paraBirimi,
        })
      : null;
    if (!refFatFisForMuhasebe && historyMatch?.refFatFisRefNo) {
      // Reference invoice for accounting pattern (DENEME only). Apply tevkifat threshold compatibility if needed.
      const limit = parseNum(process.env.ETA_TEVKIFAT_LIMIT_TL, 12000);
      const newMalTl = malHizmetToplamTutari; // already scaled to TL by effectiveDovizKuru
      let refMalTl = parseNum(historyMatch.refMalTop, 0);
      const refDov = String(historyMatch.refDovKod || "").trim().toUpperCase();
      const refKur = parseNum(historyMatch.refDovKur, 1);
      if (refDov && refDov !== "TRY" && refKur > 0) refMalTl = refMalTl * refKur;
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
    if (historyMatch?.stkkod) {
      const historyCode = String(historyMatch.stkkod || "").trim().slice(0, 40);
      itemCodeResolved = await resolveWriteStockCodeExact(wPool, historyCode);
      if (itemCodeResolved) {
        matchSource = "supplier_history_match";
      } else if (historyCode && allowAutoStk) {
        try {
          await tryCloneStkkartFromTemplate(
            wPool,
            historyCode,
            String(historyMatch.stkcinsi || l.stokCinsi || historyCode).trim() || historyCode,
            l.unit,
            stkTemplate
          );
        } catch {
          /* duplicate / şema */
        }
        itemCodeResolved = await resolveWriteStockCodeExact(wPool, historyCode);
        if (itemCodeResolved) matchSource = "supplier_history_clone";
      }
    }
    if (!itemCodeResolved) {
      itemCodeResolved = await resolveWriteStockCodeExact(wPool, rawItemCode);
      if (itemCodeResolved) matchSource = "direct_item_code";
    }
    if (!itemCodeResolved && rawItemCode && allowAutoStk) {
      try {
        await tryCloneStkkartFromTemplate(
          wPool,
          rawItemCode,
          String(l.stokCinsi || "").trim() || rawItemCode,
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
      score: historyMatch?.score || null,
      scoreBreakdown: historyMatch
        ? {
            baseScore: historyMatch.baseScore || null,
            descScore: historyMatch.descScore || null,
            cinsiScore: historyMatch.cinsiScore || null,
            codeScore: historyMatch.codeScore || null,
            weakDesc: historyMatch.weakDesc || false,
          }
        : null,
    });
    const qty = parseNum(l.qty, 1) || 1;
    const unitPrice = parseNum(l.unitPrice, 0);
    const taxPercent = parseNum(l.taxPercent, 0);
    const taxAmount = parseNum(l.taxAmount, 0);
    const unitPriceForSp = isForeignCurrency ? unitPrice * effectiveDovizKuru : unitPrice;
    const taxAmountForSp = isForeignCurrency ? taxAmount * effectiveDovizKuru : taxAmount;
    const lineAcik = String(l.lineAciklama || "").trim();
    const satirAcikSrc = String(lineAcik || l.stokCinsi || l.itemCode || "HIZMET").trim();
    const satirNotu = satirAcikSrc.slice(0, 50);
    const satirAcik = satirAcikSrc.slice(0, 255);
    lineCurrency.push({
      sira: i + 1,
      dovFiyat: unitPrice,
      dovTutar: parseNum(l.net, qty * unitPrice),
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

  await patchFatFisIrsaliyeAlanlari(wPool, fatFisRefNo, afterData);
  await patchCurrencyFields(wPool, fatFisRefNo, {
    currencyCode: paraBirimi,
    dovizKuru: effectiveDovizKuru,
    docOdenecekTutar,
    faturaTarihi,
    lineCurrency,
  });

  await wPool.request().input("FatFisRefNo", sql.Int, fatFisRefNo).execute("dbo.sp_FatFisToplam_Kayit");
  await tryAutoMuhasebeForDeneme(wPool, fatFisRefNo, { refFatFisRefNo: refFatFisForMuhasebe });

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
    muhasebeRefFatFisRefNo: refFatFisForMuhasebe || 0,
    lineCount: usableLines.length,
    lineMatches,
  };
}

