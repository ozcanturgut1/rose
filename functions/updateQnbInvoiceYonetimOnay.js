import { onRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { ensureAdmin } from "./adminInit.js";
ensureAdmin();

import { requireAuth, requireRole, ROLES_QNB_MUTATE } from "./requireAuth.js";

const db = getFirestore();

/** @param {string} uid */
async function yazarGorunenAd(uid) {
  try {
    const u = await getAuth().getUser(uid);
    const n = u.displayName && String(u.displayName).trim();
    if (n) return n;
    const e = u.email && String(u.email).trim();
    if (e) return e;
  } catch (_) {
    /* ignore */
  }
  const p = await db.collection("user_profiles").doc(uid).get();
  if (p.exists) {
    const d = p.data() || {};
    const ad =
      (d.displayName && String(d.displayName).trim()) ||
      (d.name && String(d.name).trim()) ||
      (d.fullName && String(d.fullName).trim());
    if (ad) return ad;
  }
  return uid;
}

/** Onaya sunan kişinin ekranda görünen birimi. Sonraki onay bu alanı ezmez. */
function onayaSunanKaydi(uid, callerData) {
  const birim = String(callerData?.birim || "").trim();
  /** @type {Record<string, unknown>} */
  const out = { onayaSunanUid: uid };
  if (birim) out.onayaSunanBirim = birim;
  return out;
}

/**
 * Onaya sunma ve reddi `onayZinciri` dizisinin sonuna ekler.
 * Dizi boşsa, daha önce yazılmış tek `onayaSunanUid` ilk adım olarak korunur.
 * `serverTimestamp` dizi elemanında kullanılamadığı için saat sunucuda üretilir.
 * @param {Record<string, unknown>} data
 * @param {string} uid
 * @param {Record<string, unknown>} callerData
 * @param {"onaya_sundu" | "reddetti"} islem
 */
export function onayZinciriEkle(data, uid, callerData, islem) {
  const birim = String(callerData?.birim || "").trim();
  const now = Timestamp.now();
  /** @type {{ uid: string, islem: string, at: Timestamp, birim?: string }[]} */
  const adimlar = [];
  const mevcut = Array.isArray(data?.onayZinciri) ? data.onayZinciri : [];
  if (mevcut.length === 0) {
    const eskiUid = String(data?.onayaSunanUid || "").trim();
    const eskiBirim = String(data?.onayaSunanBirim || "").trim();
    const ayniSunus = eskiUid === uid && islem === "onaya_sundu";
    if (eskiUid && !ayniSunus) {
      /** @type {{ uid: string, islem: string, at: Timestamp, birim?: string }} */
      const eski = {
        uid: eskiUid,
        islem: "onaya_sundu",
        at: Timestamp.fromMillis(now.toMillis() - 1),
      };
      if (eskiBirim) eski.birim = eskiBirim;
      adimlar.push(eski);
    }
  }
  /** @type {{ uid: string, islem: string, at: Timestamp, birim?: string }} */
  const adim = { uid, islem, at: now };
  if (birim) adim.birim = birim;
  adimlar.push(adim);
  return { onayZinciri: FieldValue.arrayUnion(...adimlar) };
}

/** @param {string | undefined} raw */
function normalizeProfileRole(raw) {
  if (raw == null) return "";
  return String(raw).trim().toLowerCase().replace(/\s+/g, "_");
}

/** Olcay, Eda, Yeliz, Elif, Ayşe onaya sununca fatura Erdem'e gider. Erdem onaya sununca Sinan'a. */
const ILK_ARA_BIRIMLER = new Set(["olcay", "eda", "yeliz", "elif", "ayse"]);

/** Dart liste süzmesi ile aynı: büyük İ ve Türkçe harfler. */
export function normBirim(raw) {
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

/**
 * `onaya_sunuldu` kararının gideceği birim.
 * Boş dize: iplik, kumaş, giyim ve diğerleri — `onayDurumu` doğrudan `onaya sunuldu` olur.
 * @param {string} birimNorm
 * @returns {"erdem" | "sinan" | ""}
 */
export function onayaSunHedefBirim(birimNorm) {
  if (ILK_ARA_BIRIMLER.has(birimNorm)) return "erdem";
  if (birimNorm === "erdem") return "sinan";
  return "";
}

/**
 * @param {string} birimNorm
 * @param {string} preferredRole
 */
async function findProfileUidByBirim(birimNorm, preferredRole) {
  const snap = await db.collection("user_profiles").get();
  /** @type {{ uid: string, role: string }[]} */
  const matches = [];
  for (const doc of snap.docs) {
    const d = doc.data() || {};
    if (normBirim(d.birim) !== birimNorm) continue;
    matches.push({ uid: doc.id, role: normalizeProfileRole(d.role) });
  }
  if (matches.length === 0) {
    const err = new Error(`Birimi ${birimNorm} olan kullanıcı bulunamadı`);
    // @ts-ignore
    err.status = 409;
    throw err;
  }
  const preferred = matches.filter((m) => m.role === preferredRole);
  const pool = preferred.length ? preferred : matches;
  if (pool.length !== 1) {
    const err = new Error(`Birimi ${birimNorm} olan birden fazla kullanıcı var`);
    // @ts-ignore
    err.status = 409;
    throw err;
  }
  return pool[0].uid;
}

/** Ara/nihai onay (user_profiles) veya eski users.roles. */
async function requireInvoiceOnayPermission(uid) {
  const p = await db.collection("user_profiles").doc(uid).get();
  if (p.exists) {
    const r = normalizeProfileRole(p.data()?.role);
    if (["admin", "ara_onay", "ikinci_ara_onay", "nihai_onay", "muhasebe"].includes(r)) return;
  }
  await requireRole(uid, ROLES_QNB_MUTATE);
}

const setCors = (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

/**
 * qnb_invoices/{invoice_*} belgesine yönetim onayı / red / araya sunma kaydı yazar (portal yok).
 * POST JSON: { docId, decision, note?, aciklamaRole?: "ara_onay" | "nihai_onay" | "muhasebe" | "admin" }
 * Açıklama: ara / nihai / muhasebe ayrı alanlar; admin → onayAciklama
 * Firestore onayDurumu: onaylandı | reddedildi | onaya sunuldu
 * Birimi olcay, eda, yeliz, elif, ayse olan ara onay `onaya_sunuldu` yazmaz;
 * faturayı birimi erdem olan kullanıcıya atar (`araOnayAtananUid`).
 * Birimi erdem olan kullanıcı `onaya_sunuldu` ile faturayı birimi sinan olan nihai onaya yazar
 * (`nihaiOnayAtananUid`). İplik, kumaş ve giyim bu ayrımı kullanmaz.
 * Red (ara/nihai): `reddedenRol` (`ara_onay` | `ikinci_ara_onay` | `nihai_onay`), `reddedenUid`
 */
export const updateQnbInvoiceYonetimOnay = onRequest({ region: "europe-west1" }, async (req, res) => {
  try {
    setCors(req, res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const user = await requireAuth(req);
    await requireInvoiceOnayPermission(user.uid);

    const body = typeof req.body === "object" && req.body ? req.body : {};
    const docId = body.docId != null ? String(body.docId).trim() : "";
    const decision = body.decision != null ? String(body.decision).trim() : "";
    const noteRaw = body.note != null ? String(body.note).trim() : "";
    const aciklamaRole =
      body.aciklamaRole != null ? normalizeProfileRole(String(body.aciklamaRole)) : "";

    /** API kararı → qnb_invoices.onayDurumu alanı */
    const onayDurumuByDecision = {
      onaylandı: "onaylandı",
      reddedildi: "reddedildi",
      onaya_sunuldu: "onaya sunuldu",
    };

    if (!docId.startsWith("invoice_")) {
      return res.status(400).json({ error: "docId must start with invoice_" });
    }
    if (!Object.prototype.hasOwnProperty.call(onayDurumuByDecision, decision)) {
      return res.status(400).json({
        error: 'decision must be "onaylandı", "reddedildi", or "onaya_sunuldu"',
      });
    }
    const onayDurumu = onayDurumuByDecision[decision];

    const ref = db.collection("qnb_invoices").doc(docId);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ error: "Invoice document not found" });
    }
    const data = snap.data() || {};
    if (String(data.type) !== "invoice") {
      return res.status(400).json({ error: "Document is not type=invoice" });
    }

    const callerProf = await db.collection("user_profiles").doc(user.uid).get();
    const callerData = callerProf.exists ? callerProf.data() || {} : {};
    const callerBirim = normBirim(callerData.birim);
    const hedefBirim = decision === "onaya_sunuldu" ? onayaSunHedefBirim(callerBirim) : "";
    const noteRole = aciklamaRole === "ikinci_ara_onay" ? "ara_onay" : aciklamaRole;

    /** @type {Record<string, unknown>} */
    const patch = {
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (noteRaw) {
      const yazarAd = await yazarGorunenAd(user.uid);
      const redNotu = onayDurumu === "reddedildi";
      if (noteRole === "ara_onay") {
        patch.onayAciklamaAraOnay = noteRaw;
        patch.onayAciklamaAraOnayYazanAd = yazarAd;
        patch.onayAciklamaAraOnayReddi = redNotu;
      } else if (noteRole === "nihai_onay") {
        patch.onayAciklamaNihaiOnay = noteRaw;
        patch.onayAciklamaNihaiOnayYazanAd = yazarAd;
        patch.onayAciklamaNihaiOnayReddi = redNotu;
      } else if (noteRole === "muhasebe") {
        patch.onayAciklamaMuhasebe = noteRaw;
        patch.onayAciklamaMuhasebeYazanAd = yazarAd;
        patch.onayAciklamaMuhasebeReddi = redNotu;
      } else {
        patch.onayAciklama = noteRaw;
        patch.onayAciklamaYazanAd = yazarAd;
        patch.onayAciklamaReddi = redNotu;
      }
    }

    if (hedefBirim === "erdem" || hedefBirim === "sinan") {
      const mevcutOnay = String(data.onayDurumu || "").trim();
      if (mevcutOnay) {
        return res.status(409).json({ error: "Bu fatura ara onay kuyruğunda değil" });
      }
      if (hedefBirim === "erdem") {
        const erdemUid = await findProfileUidByBirim("erdem", "ikinci_ara_onay");
        patch.araOnayAtananUid = erdemUid;
        patch.araOnayYonlendirenUid = user.uid;
        patch.araOnayYonlendirildiAt = FieldValue.serverTimestamp();
      } else {
        const sinanUid = await findProfileUidByBirim("sinan", "nihai_onay");
        patch.onayDurumu = "onaya sunuldu";
        patch.onayTarihi = FieldValue.serverTimestamp();
        patch.onaylayanUid = user.uid;
        patch.nihaiOnayAtananUid = sinanUid;
      }
      Object.assign(patch, onayaSunanKaydi(user.uid, callerData));
      Object.assign(patch, onayZinciriEkle(data, user.uid, callerData, "onaya_sundu"));
      await ref.set(patch, { merge: true });
      return res.status(200).json({
        success: true,
        docId,
        onayDurumu: hedefBirim === "sinan" ? "onaya sunuldu" : mevcutOnay,
        routedToBirim: hedefBirim,
      });
    }

    patch.onayDurumu = onayDurumu;
    patch.onayTarihi = FieldValue.serverTimestamp();
    patch.onaylayanUid = user.uid;
    if (decision === "onaya_sunuldu") {
      Object.assign(patch, onayaSunanKaydi(user.uid, callerData));
      Object.assign(patch, onayZinciriEkle(data, user.uid, callerData, "onaya_sundu"));
    }

    if (onayDurumu === "reddedildi") {
      Object.assign(patch, onayZinciriEkle(data, user.uid, callerData, "reddetti"));
      const profRol = normalizeProfileRole(callerData.role);
      if (profRol === "ara_onay" || profRol === "ikinci_ara_onay" || profRol === "nihai_onay") {
        patch.reddedenRol = profRol;
        patch.reddedenUid = user.uid;
      }
    }

    await ref.set(patch, { merge: true });

    return res.status(200).json({ success: true, docId, onayDurumu });
  } catch (e) {
    const status = e?.status && Number(e.status) >= 400 ? Number(e.status) : 500;
    return res.status(status).json({ error: String(e?.message || e) });
  }
});
