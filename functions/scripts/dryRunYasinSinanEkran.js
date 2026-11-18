/**
 * Yasin / Sinan ekranındaki faturaların ETA kayıt planı.
 * Fiş yazmaz, stok kartı açmaz, Firestore güncellemez.
 *
 *   node scripts/dryRunYasinSinanEkran.js
 */
import "dotenv/config";
import sql from "mssql";
import { getFirestore } from "firebase-admin/firestore";
import { ensureAdmin } from "../adminInit.js";
import { resolveSqlTargets } from "../sqlDbTargets.js";
import { previewStockLineMatches, corluOsbKayitTanimi } from "../etaInvoiceSync.js";
import { evaluateAracPlakaKapisi } from "../plakaTespit.js";
import { ublToFullJson } from "../ublToStructuredJson.js";
import { hedefSubeFromBaglam, loadSubeBaglam } from "../subeAciklamaAtama.js";
import {
  faturaNihaiEkranda,
  normBirim,
  onayDurumuBos,
  vknKaynaklari,
  vknRakam,
} from "../nihaiEkranKriteri.js";

process.env.ETA_AUTO_CREATE_STKKART = "0";

function rolNorm(raw) {
  return String(raw || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function onayNorm(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("ı", "i");
}

function pb(data) {
  const q = data?.qnbRaw && typeof data.qnbRaw === "object" ? data.qnbRaw : {};
  return String(q.odenecekTutarDovizCinsi || q.paraBirimi || data?.currency || "").trim().toUpperCase();
}

function yurtici(code) {
  const c = String(code || "").trim().toUpperCase();
  return c === "" || c === "TRY" || c === "TL";
}

function unvan(data) {
  const q = data?.qnbRaw && typeof data.qnbRaw === "object" ? data.qnbRaw : {};
  return String(data?.supplierUnvan || q.gondericiUnvan || q.gondericiIsim || "").trim();
}

function tutar(data) {
  const q = data?.qnbRaw && typeof data.qnbRaw === "object" ? data.qnbRaw : {};
  return q.odenecekTutar ?? data?.total ?? data?.odenecekTutar ?? "";
}

function belgeNoOf(data) {
  const q = data?.qnbRaw && typeof data.qnbRaw === "object" ? data.qnbRaw : {};
  return String(data?.belgeNo || q.belgeNo || "").trim();
}

async function loadKisiler(db) {
  const prof = await db.collection("user_profiles").get();
  const kisiler = [];
  for (const d of prof.docs) {
    const x = d.data() || {};
    const birimNorm = normBirim(x.birim);
    if (rolNorm(x.role) !== "nihai_onay") continue;
    if (birimNorm !== "yasin" && birimNorm !== "sinan") continue;
    const birim = String(x.birim || "").trim();
    let vkns = new Set();
    let sorgular = new Set();
    if (birim) {
      const s = await db.collection("suppliers").doc(birim).get();
      if (s.exists) {
        const parsed = vknKaynaklari(s.data() || {});
        vkns = parsed.digits;
        sorgular = parsed.sorgular;
      }
    }
    kisiler.push({ uid: d.id, birimNorm, vkns, sorgular });
  }
  return kisiler;
}

async function sayfala(qBase, kabul, out) {
  let cursor = null;
  let n = 0;
  const max = 4000;
  while (n < max) {
    let q = qBase.limit(250);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    n += snap.size;
    for (const d of snap.docs) {
      const veri = d.data() || {};
      if (String(veri.type || "").toLowerCase() !== "invoice") continue;
      if (!(await kabul(veri))) continue;
      out.set(d.id, veri);
    }
    if (snap.size < 250) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
  return n;
}

function ekranAdlari(data, kisiler, sube) {
  return kisiler.filter((k) => faturaNihaiEkranda(data, k, sube)).map((k) => k.birimNorm);
}

async function mevcutFis(pool, evrak) {
  if (!evrak) return null;
  const rs = await pool
    .request()
    .input("evrak", sql.NVarChar(80), evrak)
    .query(
      "SELECT TOP 1 FATFISREFNO, FATFISCARKOD, FATFISTIPI, FATFISDOVKOD FROM dbo.FATFIS WITH (NOLOCK) WHERE FATFISEVRAKNO1=@evrak ORDER BY FATFISREFNO DESC"
    );
  const row = rs.recordset[0];
  if (!row) return null;
  const cnt = await pool
    .request()
    .input("ref", sql.Int, row.FATFISREFNO)
    .query("SELECT COUNT(*) AS cnt FROM dbo.FATHAR WITH (NOLOCK) WHERE FATHARREFNO=@ref");
  return {
    ref: row.FATFISREFNO,
    cari: String(row.FATFISCARKOD || "").trim(),
    tip: row.FATFISTIPI,
    doviz: String(row.FATFISDOVKOD || "").trim(),
    satir: Number(cnt.recordset[0]?.cnt || 0),
  };
}

async function cariAdaylari(pool, vkn) {
  const digits = String(vkn || "").replace(/\D/g, "");
  if (!digits) return [];
  const rs = await pool
    .request()
    .input("vkn", sql.NVarChar(20), digits)
    .query(
      `SELECT CARKOD FROM (
         SELECT CARKOD FROM dbo.CARKART WITH (NOLOCK)
          WHERE REPLACE(REPLACE(ISNULL(CARVERHESNO,''),' ',''),'-','') = @vkn
         UNION
         SELECT k.KIMKOD AS CARKOD
           FROM dbo.KIMLIKLER k WITH (NOLOCK)
           INNER JOIN dbo.CARKART c WITH (NOLOCK) ON c.CARKOD = k.KIMKOD
          WHERE k.KIMMODUL = 2
            AND REPLACE(REPLACE(ISNULL(k.KIMMERNISNO,''),' ',''),'-','') = @vkn
       ) x ORDER BY CARKOD`
    );
  return (rs.recordset || []).map((r) => String(r.CARKOD || "").trim()).filter(Boolean);
}

function satirOzet(match) {
  const kaynak = match.source || "";
  const hizmet = kaynak === "corlu_osb_hizmet" || kaynak === "hizmet_karti";
  return {
    no: match.lineNo,
    kod: match.selectedStkKod,
    kaynak,
    faturaTuru: hizmet ? 2 : 1,
    kart: hizmet ? "hizmet" : "stok",
    aciklama: match.primaryKalemAciklama || match.linePreview?.stokCinsi || "",
    varsayilan: kaynak === "default_fallback",
  };
}

async function main() {
  ensureAdmin();
  const db = getFirestore();
  const kisiler = await loadKisiler(db);
  if (!kisiler.length) {
    console.log("Yasin veya Sinan nihai profili bulunamadı.");
    return;
  }
  const baglam = await loadSubeBaglam(db);
  const col = db.collection("qnb_invoices");
  const bulunan = new Map();
  const ekranda = async (veri) => {
    const sube = onayDurumuBos(veri) ? hedefSubeFromBaglam(veri, baglam) : "";
    return ekranAdlari(veri, kisiler, sube).length > 0;
  };

  let taranan = 0;
  taranan += await sayfala(
    col.where("type", "==", "invoice").where("onayDurumu", "==", "onaya sunuldu"),
    ekranda,
    bulunan
  );
  for (const kisi of kisiler) {
    taranan += await sayfala(col.where("araOnayAtananUid", "==", kisi.uid), ekranda, bulunan);
  }
  const sorgular = new Set();
  for (const kisi of kisiler) {
    for (const v of kisi.sorgular || []) sorgular.add(v);
  }
  const liste = [...sorgular];
  for (const alan of ["supplierVkn", "qnbRaw.gondericiVkn"]) {
    for (let i = 0; i < liste.length; i += 30) {
      const parca = liste.slice(i, i + 30);
      if (!parca.length) continue;
      taranan += await sayfala(col.where(alan, "in", parca), ekranda, bulunan);
    }
  }

  const t = resolveSqlTargets();
  const pool = await new sql.ConnectionPool({
    user: t.user,
    password: t.password,
    server: t.host,
    port: t.port,
    database: t.writeDb,
    options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
  }).connect();

  const satirlar = [];
  for (const [id, data] of bulunan) {
    const sube = onayDurumuBos(data) ? hedefSubeFromBaglam(data, baglam) : "";
    const ekran = ekranAdlari(data, kisiler, sube);
    const belge = belgeNoOf(data);
    const para = pb(data);
    const eta = onayNorm(data.etaKayitDurumu);
    const fis = await mevcutFis(pool, belge);
    const temel = {
      id,
      ekran,
      belge,
      unvan: unvan(data),
      vkn: vknRakam(data),
      tutar: tutar(data),
      para: para || "TRY",
      onay: String(data.onayDurumu || "").trim() || "(boş)",
      eta: eta || "(yok)",
      sube: sube || "",
    };

    if (eta === "tamamlandi" || (fis && fis.satir > 0)) {
      satirlar.push({
        ...temel,
        karar: fis && fis.satir > 0 ? "yazilmaz_eta_var" : "yazilmaz_tamamlandi",
        fis,
      });
      continue;
    }

    const plaka = await evaluateAracPlakaKapisi({ db, data });
    if (plaka.blocked) {
      satirlar.push({ ...temel, karar: "yazilmaz_plaka", plaka: plaka.mesaj || plaka.durum });
      continue;
    }

    let planData = data;
    if ((!data.ublParsed || !Object.keys(data.ublParsed || {}).length) && data.contentUbl) {
      planData = { ...data, ublParsed: ublToFullJson(data.contentUbl) ?? {} };
    }
    const corlu = corluOsbKayitTanimi(temel.vkn, planData.ublParsed ? undefined : []);
    let onizleme = null;
    let hata = null;
    try {
      onizleme = await previewStockLineMatches(planData);
    } catch (err) {
      hata = err?.message || String(err);
    }
    const cariler = await cariAdaylari(pool, temel.vkn);
    const corluTanim = corluOsbKayitTanimi(
      temel.vkn,
      onizleme?.lines || []
    );
    const satirPlan = (onizleme?.lineMatches || []).map(satirOzet);
    satirlar.push({
      ...temel,
      karar: fis && fis.satir === 0 ? "satir_tamamlanir" : "kaydedilir",
      fis,
      cariAday: cariler,
      corlu: corluTanim
        ? { cari: corluTanim.carkod, kart: corluTanim.stok, fis: "GIDER" }
        : null,
      dovizKolon: yurtici(para) ? "bos" : "dolar",
      satirlar: satirPlan,
      varsayilanSatir: satirPlan.filter((s) => s.varsayilan).length,
      hata,
      plakaNot: plaka.tespitHatasi || null,
    });
    if (corlu) {
      /* tanım satırdan gelir; boş diziyle erken çağrı yalnızca yan etki yaratmasın */
    }
  }

  await pool.close();

  satirlar.sort((a, b) => String(a.belge).localeCompare(String(b.belge), "tr"));
  const ozet = {
    db: t.writeDb,
    taranan,
    ekranda: satirlar.length,
    kaydedilir: satirlar.filter((s) => s.karar === "kaydedilir" || s.karar === "satir_tamamlanir").length,
    yazilmaz: satirlar.filter((s) => String(s.karar).startsWith("yazilmaz")).length,
  };
  console.log(JSON.stringify({ ozet, faturalar: satirlar }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
