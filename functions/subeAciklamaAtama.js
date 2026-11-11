import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { extractPlakalarFromUbl } from "./plakaTespit.js";

/**
 * Aynı VKN iki şubede de kayıtlıysa faturayı tek ekrana bırakır.
 * Dart liste süzmesi (`son_10_fatura_screen.dart`) aynı kuralı uygular.
 *
 * Özel:
 * - NEGO TEMİZLİK: açıklamada FABRİKA varsa elif, yoksa yasin.
 * - İSTANBUL OLUKLU: kalemde ÇORLU veya FABRİKA varsa ayse, yoksa iplik.
 * - İLERİ AMBALAJ: açıklamada ÇORLU veya FABRİKA varsa ayse, yoksa iplik.
 * - KAZIM AKDAĞ: plakanın company_vehicles.kullanimYeri değeri.
 *   fabrika → ayse, merkez → iplik, giyim → giyim. Plaka yoksa atanmaz.
 * - ARAS KARGO: Teknik Filament fatura adresinde (alıcı tarafı) ÇORLU varsa elif,
 *   yoksa İSTANBUL varsa yasin. İkisi birden varsa ÇORLU esas alınır.
 *
 * Özel kuralı olmayan ve hem fabrika hem merkez biriminde duran VKN:
 * içerikte ÇORLU, TEKİRDAĞ veya FABRİKA varsa fabrika birimi, yoksa merkez birimi.
 */
const NEGO_VKN = "6301027360";
const OLUKLU_VKN = "4810588203";
const ILERI_VKN = "4710403705";
const KAZIM_VKN = "19615423326";
const ARAS_VKN = "0720039666";

function normMetin(raw) {
  let s = String(raw ?? "").trim().replaceAll("İ", "i").replaceAll("I", "ı");
  s = s.toLowerCase();
  return s
    .replaceAll("ı", "i")
    .replaceAll("ş", "s")
    .replaceAll("ğ", "g")
    .replaceAll("ü", "u")
    .replaceAll("ö", "o")
    .replaceAll("ç", "c");
}

function vknOf(data) {
  const top = String(data?.supplierVkn || "").replace(/\D/g, "");
  if (top) return top;
  const q = data?.qnbRaw && typeof data.qnbRaw === "object" ? data.qnbRaw : {};
  return String(q.gondericiVkn || "").replace(/\D/g, "");
}

function notMetni(data) {
  const parts = [];
  const ubl = typeof data?.contentUbl === "string" ? data.contentUbl : "";
  if (ubl) {
    const re = /<cbc:Note[^>]*>([\s\S]*?)<\/cbc:Note>/gi;
    let m;
    while ((m = re.exec(ubl))) parts.push(m[1]);
  }
  const up = data?.ublParsed && typeof data.ublParsed === "object" ? data.ublParsed : null;
  const inv = up?.Invoice;
  const note = inv && typeof inv === "object" ? inv.Note : null;
  if (note != null) parts.push(JSON.stringify(note));
  return parts.join(" ");
}

function musteriAdresMetni(data) {
  const ubl = typeof data?.contentUbl === "string" ? data.contentUbl : "";
  if (ubl) {
    const m = ubl.match(/<cac:AccountingCustomerParty\b[\s\S]*?<\/cac:AccountingCustomerParty>/i);
    if (m) return m[0];
  }
  const up = data?.ublParsed && typeof data.ublParsed === "object" ? data.ublParsed : null;
  const inv = up?.Invoice;
  if (inv && typeof inv === "object") return JSON.stringify(inv.AccountingCustomerParty ?? "");
  return "";
}

function kalemMetni(data) {
  const ubl = typeof data?.contentUbl === "string" ? data.contentUbl : "";
  if (ubl) {
    const parts = [];
    const re = /<cac:InvoiceLine\b[\s\S]*?<\/cac:InvoiceLine>/gi;
    let m;
    while ((m = re.exec(ubl))) parts.push(m[0]);
    if (parts.length) return parts.join(" ");
  }
  const up = data?.ublParsed && typeof data.ublParsed === "object" ? data.ublParsed : null;
  const inv = up?.Invoice;
  if (!inv || typeof inv !== "object") return "";
  return JSON.stringify(inv.InvoiceLine ?? "");
}

function fabrikaIsareti(metin, tekirdag) {
  const n = normMetin(metin);
  if (n.includes("fabrika") || n.includes("corlu")) return true;
  return tekirdag && n.includes("tekirdag");
}

function plakaYeri(data, harita) {
  const plakalar = extractPlakalarFromUbl(data?.ublParsed, data?.contentUbl);
  const yerler = new Set();
  for (const p of plakalar) {
    const yer = harita.get(p);
    if (yer) yerler.add(yer);
  }
  if (yerler.size !== 1) return "";
  return [...yerler][0];
}

let aracCache = null;
async function aracHaritasi(db) {
  if (aracCache) return aracCache;
  const snap = await db.collection("company_vehicles").get();
  const map = new Map();
  for (const d of snap.docs) {
    const x = d.data() || {};
    if (x.aktif === false) continue;
    const key = String(x.plakaNormalize || d.id || "")
      .trim()
      .toUpperCase()
      .replaceAll("İ", "I")
      .replace(/[^A-Z0-9]/g, "");
    const yer = normMetin(x.kullanimYeri);
    if (key && yer) map.set(key, yer);
  }
  aracCache = map;
  return map;
}

async function birimSubeleri(db) {
  const snap = await db.collection("user_profiles").get();
  const sube = new Map();
  for (const d of snap.docs) {
    const x = d.data() || {};
    const birim = String(x.birim || "").trim();
    const yer = normMetin(x.sube);
    if (birim && (yer === "fabrika" || yer === "merkez")) sube.set(birim, yer);
  }
  return sube;
}

async function vknBirimleri(db) {
  const snap = await db.collection("suppliers").get();
  /** @type {Map<string, Set<string>>} */
  const out = new Map();
  for (const d of snap.docs) {
    const x = d.data() || {};
    const raw = x.vkns ?? x.vkn ?? x.vknList;
    const list = Array.isArray(raw) ? raw : String(raw || "").split(/[,;]/);
    for (const e of list) {
      const v = String(e || "").replace(/\D/g, "");
      if (!v) continue;
      if (!out.has(v)) out.set(v, new Set());
      out.get(v).add(d.id);
    }
  }
  return out;
}

function genelHedef(vkn, data, subeByBirim, birimlerByVkn) {
  const birimler = birimlerByVkn.get(vkn);
  if (!birimler) return "";
  const fabrika = [];
  const merkez = [];
  for (const birim of birimler) {
    const yer = subeByBirim.get(birim);
    if (yer === "fabrika") fabrika.push(birim);
    else if (yer === "merkez") merkez.push(birim);
  }
  const f = [...new Set(fabrika)];
  const m = [...new Set(merkez)];
  if (f.length !== 1 || m.length !== 1) return "";
  const tum = typeof data?.contentUbl === "string" && data.contentUbl
    ? data.contentUbl
    : `${notMetni(data)} ${kalemMetni(data)}`;
  return fabrikaIsareti(tum, true) ? f[0] : m[0];
}

/**
 * @returns {Promise<string>} hedef birim veya boş (kural yok / plaka ayrılmadı)
 */
export async function hedefSubeBirimi(db, data) {
  const vkn = vknOf(data);
  if (!vkn) return "";
  if (vkn === NEGO_VKN) return fabrikaIsareti(notMetni(data), false) ? "elif" : "yasin";
  if (vkn === ARAS_VKN) {
    const adres = normMetin(musteriAdresMetni(data));
    if (adres.includes("corlu")) return "elif";
    if (adres.includes("istanbul")) return "yasin";
    return "";
  }
  if (vkn === OLUKLU_VKN) return fabrikaIsareti(kalemMetni(data), false) ? "ayse" : "iplik";
  if (vkn === ILERI_VKN) return fabrikaIsareti(notMetni(data), false) ? "ayse" : "iplik";
  if (vkn === KAZIM_VKN) {
    const yer = plakaYeri(data, await aracHaritasi(db));
    if (yer === "fabrika") return "ayse";
    if (yer === "merkez") return "iplik";
    if (yer === "giyim") return "giyim";
    return "";
  }
  return genelHedef(vkn, data, await birimSubeleri(db), await vknBirimleri(db));
}

async function uidByBirim(db, birim) {
  const snap = await db.collection("user_profiles").where("birim", "==", birim).limit(2).get();
  if (snap.size !== 1) return "";
  return snap.docs[0].id;
}

/**
 * Henüz elle yönlendirilmemiş ve onay durumu boş faturayı kurala göre atar.
 * Elle yönlendirme (`araOnayYonlendirenUid`) bu atamayı ezmez.
 */
export async function applyAciklamaSubeAtamasi(docId) {
  const db = getFirestore();
  const ref = db.collection("qnb_invoices").doc(docId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const data = snap.data() || {};
  if (String(data.onayDurumu || "").trim()) return false;
  if (String(data.araOnayYonlendirenUid || "").trim()) return false;
  const hedef = await hedefSubeBirimi(db, data);
  if (!hedef) return false;
  const uid = await uidByBirim(db, hedef);
  if (!uid) return false;
  const assigned = String(data.araOnayAtananUid || "").trim();
  const otomatik = data.subeAtamaKaynagi === "aciklama";
  if (assigned && !otomatik) return false;
  if (assigned === uid && data.subeAtamaBirim === hedef) return false;
  await ref.set(
    {
      araOnayAtananUid: uid,
      subeAtamaKaynagi: "aciklama",
      subeAtamaBirim: hedef,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return true;
}
