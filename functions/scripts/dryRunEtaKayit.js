/**
 * Kayıt önizlemesi (dry run).
 *
 * Worker'ın kayıt kodunu (`syncApprovedInvoiceToEta`) yazma veritabanında bir transaction
 * içinde çalıştırır; oluşan fatura, stok, cari ve muhasebe satırlarını okur ve her
 * durumda geri alır. Firestore'a yazmaz, stok kartı kalıcı açılmaz.
 *
 *   node scripts/dryRunEtaKayit.js                    worker'ın şu an kaydedeceği faturalar
 *   node scripts/dryRunEtaKayit.js PRJ2026000011126   verilen belgeler (kayda uygun olmasa da)
 *   node scripts/dryRunEtaKayit.js --limit=5          en fazla 5 fatura (varsayılan 25)
 *
 * Rapor JSON olarak işletim sisteminin geçici klasörüne yazılır; yol çıktının sonundadır.
 *
 * Çıkış kodları: 0 önizleme tamam (faturadaki hatalar rapordadır), 2 ön koşul sağlanmadı,
 * 3 geri alma doğrulanamadı.
 *
 * Worker çalışırken başlamaz: kayıt kodu mevcut fişe NOLOCK ile bakar; aynı anda çalışan
 * worker geri alınacak deneme fişini görüp faturayı kaydedilmiş sayabilir.
 */
import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import sql from "mssql";
import { getFirestore } from "firebase-admin/firestore";
import { ensureAdmin } from "../adminInit.js";
import { resolveSqlTargets } from "../sqlDbTargets.js";
import { syncApprovedInvoiceToEta } from "../etaInvoiceSync.js";
import { formatEtaError } from "../etaError.js";
import { evaluateAracPlakaKapisi, recheckPlakaBlokaji } from "../plakaTespit.js";
import { hedefSubeFromBaglam, loadSubeBaglam } from "../subeAciklamaAtama.js";
import { faturaNihaiEkranda, kaydaUygun, onayDurumuBos } from "../nihaiEkranKriteri.js";
import { HEARTBEAT_DOC_PATH, collectPendingDocs, loadNihaiKisiler } from "./localEtaWorker.js";

// Worker kalp atışını yalnız parti bitince yazar; uzun bir parti bu süreyi doldurabilir.
const WORKER_TAZE_MS = 15 * 60 * 1000;
const KAPATMA_SURESI_MS = 15000;

function norm(v) {
  return String(v || "").trim().toLowerCase().replaceAll("ı", "i");
}

function temiz(v) {
  return typeof v === "string" ? v.trim() : v;
}

function sec(row, keys) {
  if (!row) return null;
  const out = {};
  for (const k of keys) {
    if (row[k] === undefined) continue;
    const v = row[k] instanceof Date ? row[k].toISOString().slice(0, 10) : temiz(row[k]);
    out[k] = v;
  }
  return out;
}

function sqlConfig(database, ekler = {}) {
  const t = resolveSqlTargets();
  return {
    user: t.user,
    password: t.password,
    server: t.host,
    port: t.port,
    database,
    requestTimeout: 120000,
    options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
    ...ekler,
  };
}

function argumanlar(argv) {
  const belgeler = [];
  let limit = 25;
  for (const a of argv) {
    if (a.startsWith("--limit=")) {
      const n = Number(a.slice("--limit=".length));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`Geçersiz limit: ${a}`);
      limit = n;
    } else if (a.startsWith("--")) {
      throw new Error(`Bilinmeyen seçenek: ${a}`);
    } else if (a.trim()) {
      belgeler.push(a.trim());
    }
  }
  return { belgeler, limit };
}

function docIdOf(arg) {
  return arg.startsWith("invoice_") ? arg : `invoice_${arg.replace(/[/\\]/g, "_")}`;
}

async function workerCalisiyor(db) {
  const s = await db.collection(HEARTBEAT_DOC_PATH[0]).doc(HEARTBEAT_DOC_PATH[1]).get();
  const v = s.data() || {};
  const son = typeof v.lastSeenAt?.toMillis === "function" ? v.lastSeenAt.toMillis() : 0;
  if (v.status !== "calisiyor" || !son || Date.now() - son >= WORKER_TAZE_MS) return null;
  return { workerId: v.workerId || "?", sonGorulme: new Date(son).toISOString() };
}

async function hedefleriTopla(db, ctx, belgeler, limit) {
  if (!belgeler.length) {
    const { docs } = await collectPendingDocs(db.collection("qnb_invoices"), limit, 200, ctx);
    return [...docs.values()].map((d) => ({ docId: d.id, data: d.data() || {}, kaynak: "worker_kuyrugu" }));
  }
  const out = [];
  for (const arg of belgeler.slice(0, limit)) {
    const docId = docIdOf(arg);
    let snap = await db.collection("qnb_invoices").doc(docId).get();
    let kaynak = "qnb_invoices";
    if (!snap.exists) {
      snap = await db.collection("qnb_invoices_archive").doc(docId).get();
      kaynak = "qnb_invoices_archive";
    }
    out.push(snap.exists ? { docId, data: snap.data() || {}, kaynak } : { docId, data: null, kaynak: "yok" });
  }
  return out;
}

async function evrakSayisi(pool, belgeNo) {
  const rs = await pool
    .request()
    .input("evrak", sql.NVarChar(80), belgeNo)
    .query("SET LOCK_TIMEOUT 10000; SELECT COUNT(*) AS n FROM dbo.FATFIS WHERE FATFISEVRAKNO1 = @evrak");
  return Number(rs.recordset[0]?.n || 0);
}

async function yazilanlariOku(tx, sonuc) {
  const tek = async (text, ref) =>
    ref ? (await tx.request().input("ref", sql.Int, ref).query(text)).recordset : [];

  const [fis] = await tek(
    `SELECT F.*, T.FATFTKOD AS FIS_TIPI_ADI, C.CARUNVAN AS CARI_UNVAN
       FROM dbo.FATFIS F
       LEFT JOIN dbo.FATFISTIP T ON T.FATFTNO = F.FATFISTIPI
       LEFT JOIN dbo.CARKART C ON C.CARKOD = F.FATFISCARKOD
      WHERE F.FATFISREFNO = @ref`,
    sonuc.fatFisRefNo
  );
  const faturaSatirlari = await tek(
    "SELECT * FROM dbo.FATHAR WHERE FATHARREFNO = @ref ORDER BY FATHARSIRANO",
    sonuc.fatFisRefNo
  );
  const stokFisRef = Number(fis?.FATFISSTKREFNO || sonuc.stokFisRefNo || 0);
  const [stokFis] = await tek("SELECT * FROM dbo.STKFIS WHERE STKFISREFNO = @ref", stokFisRef);
  const stokHareketleri = await tek("SELECT * FROM dbo.STKHAR WHERE STKHARREFNO = @ref", stokFisRef);
  const cariHareketleri = await tek(
    "SELECT * FROM dbo.CARHAR WHERE CARHARREFNO = @ref",
    Number(fis?.FATFISCARREFNO || 0)
  );

  const yeniKartKaynaklari = new Set(["new_stkkart_clone", "supplier_history_clone"]);
  const yeniKodlar = (sonuc.lineMatches || [])
    .filter((m) => yeniKartKaynaklari.has(m.source) && m.selectedStkKod)
    .map((m) => m.selectedStkKod);
  const yeniStokKartlari = [];
  for (const kod of yeniKodlar) {
    const rs = await tx
      .request()
      .input("kod", sql.NVarChar(40), kod)
      .query("SELECT STKKOD, STKCINSI FROM dbo.STKKART WHERE STKKOD = @kod");
    yeniStokKartlari.push(...rs.recordset.map((r) => sec(r, ["STKKOD", "STKCINSI"])));
  }

  return {
    fis: sec(fis, [
      "FATFISREFNO", "FATFISEVRAKNO1", "FATFISTAR", "FATFISTIPI", "FIS_TIPI_ADI",
      "FATFISCARKOD", "CARI_UNVAN", "FATFISMALTOP", "FATFISKDVTUTARI", "FATFISTEVTUTAR",
      "FATFISTEVNO", "FATFISGENTOPLAM", "FATFISDOVKOD", "FATFISDOVTUR", "FATFISDOVKUR",
      "FATFISGENDOVTOP", "FATFISSTKREFNO", "FATFISCARREFNO", "FATFISMUHREFNO",
    ]),
    faturaSatirlari: faturaSatirlari.map((r) =>
      sec(r, [
        "FATHARSIRANO", "FATHARKODTIP", "FATHARSTKKOD", "FATHARSTKCINS", "FATHARMIKTAR",
        "FATHARSTKBRM", "FATHARFIYAT", "FATHARTUTAR", "FATHARKDVYUZ", "FATHARKDVTUTAR",
        "FATHARDOVFIYAT", "FATHARDOVTUTAR", "FATHARDOVKUR", "FATHAREKCHAR1", "FATHAREKORAN1",
        "FATHARACIKLAMA", "FATHARACIKLAMA1",
      ])
    ),
    stokFis: sec(stokFis, ["STKFISREFNO", "STKFISTOPNTUT", "STKFISTOPKDV", "STKFISTOPKTUT"]),
    stokHareketleri: stokHareketleri.map((r) =>
      sec(r, [
        "STKHARSTKKOD", "STKHARSTKCINS", "STKHARANADEPO", "STKHARMIKTAR", "STKHARFIYAT",
        "STKHARTUTAR", "STKHARKDVTUTAR", "STKHARDOVFIYAT", "STKHARDOVTUTAR",
      ])
    ),
    cariHareketleri: cariHareketleri.map((r) =>
      sec(r, [
        "CARHARCARKOD", "CARHARTUTAR", "CARHARKDVTUTAR", "CARHARDOVKOD", "CARHARDOVTUR",
        "CARHARDOVTUTAR", "CARHARDOVKUR", "CARHARACIKLAMA",
      ])
    ),
    yeniStokKartlari,
  };
}

/**
 * Kayıt kodunu transaction içinde çalıştırır ve her durumda geri alır.
 * Örtük transaction modu, bir yordamın kendi ROLLBACK'inden sonra gelen ifadelerin
 * de kalıcı olmamasını sağlar.
 */
async function geriAlinanKayit(veri, docId, belgeNo, syncOpts) {
  const out = { durum: null };
  const dogrulamaHavuzu = await new sql.ConnectionPool(sqlConfig(resolveSqlTargets().writeDb)).connect();
  try {
    let once;
    try {
      once = await evrakSayisi(dogrulamaHavuzu, belgeNo);
    } catch (err) {
      out.durum = "hata";
      out.hata = `ön kontrol okunamadı, önizleme yapılmadı: ${err?.message || err}`;
      return out;
    }
    const pool = await new sql.ConnectionPool(
      sqlConfig(resolveSqlTargets().writeDb, { pool: { max: 1, min: 0 } })
    ).connect();
    const tx = new sql.Transaction(pool);
    try {
      await tx.begin();
      await tx.request().batch("SET IMPLICIT_TRANSACTIONS ON; SET LOCK_TIMEOUT 10000;");
      const sonuc = await syncApprovedInvoiceToEta(veri, docId, { ...syncOpts, sqlBaglanti: tx });
      out.durum = sonuc?.status || "bilinmiyor";
      out.kayit = {
        fatFisRefNo: sonuc?.fatFisRefNo || null,
        erpCariKodu: sonuc?.erpCariKodu || null,
        cariSecimNedeni: sonuc?.cariResolveReason || null,
        muhasebeRefFatFisRefNo: sonuc?.muhasebeRefFatFisRefNo || 0,
        binekAracMuhasebe: sonuc?.binekAracMuhasebe || null,
        satirEslesmeleri: sonuc?.lineMatches || [],
        muhasebeFisi: sonuc?.muhasebeFisi || null,
        engel: sonuc?.blocked
          ? { neden: sonuc.blockReason || null, mesaj: sonuc.blockMessage || null }
          : null,
      };
      if (sonuc?.fatFisRefNo && sonuc.status !== "already_exists" && !sonuc.blocked) {
        out.yazilacaklar = await yazilanlariOku(tx, sonuc);
      }
    } catch (err) {
      out.durum = "hata";
      out.hata = formatEtaError(err);
    } finally {
      try {
        await tx.rollback();
      } catch (err) {
        if (!["EABORT", "ENOTBEGUN"].includes(err?.code)) {
          out.geriAlmaUyarisi = err?.message || String(err);
        }
      }
      const kapandi = await Promise.race([
        pool.close().then(() => true),
        new Promise((r) => setTimeout(() => r(false), KAPATMA_SURESI_MS)),
      ]);
      if (!kapandi) {
        console.error(
          `[KRITIK] ${belgeNo}: önizleme bağlantısı kapanmadı. Süreç sonlandırılıyor; ` +
            "SQL Server bağlantı kopunca transaction'ı geri alır. Fiş varlığını elle doğrulayın."
        );
        process.exit(3);
      }
    }
    try {
      const sonra = await evrakSayisi(dogrulamaHavuzu, belgeNo);
      out.geriAlma = { onceFisSayisi: once, sonraFisSayisi: sonra, dogrulandi: once === sonra };
    } catch (err) {
      out.geriAlma = { onceFisSayisi: once, dogrulandi: false, hata: err?.message || String(err) };
    }
  } finally {
    await dogrulamaHavuzu.close();
  }
  return out;
}

async function onizle(db, ctx, hedef) {
  const { docId, data, kaynak } = hedef;
  if (!data) return { docId, kaynak, sonuc: { durum: "bulunamadi" } };

  const q = data.qnbRaw && typeof data.qnbRaw === "object" ? data.qnbRaw : {};
  const belgeNo = String(data.belgeNo || q.belgeNo || "").trim();
  const rapor = {
    docId,
    kaynak,
    belgeNo,
    gonderen: String(data.supplierUnvan || q.gondericiUnvan || q.gondericiIsim || "").trim(),
    vkn: String(data.supplierVkn || q.gondericiVkn || "").trim(),
    belgeTarihi: q.belgeTarihi || null,
    odenecek: q.odenecekTutar ?? null,
    paraBirimi: q.odenecekTutarDovizCinsi || null,
    onayDurumu: String(data.onayDurumu || "").trim() || "(boş)",
    etaKayitDurumu: data.etaKayitDurumu || null,
  };

  const sube = onayDurumuBos(data) ? hedefSubeFromBaglam(data, ctx.baglam) : "";
  rapor.yasinSinanEkrani = ctx.kisiler.filter((k) => faturaNihaiEkranda(data, k, sube)).map((k) => k.birimNorm);
  const eta = norm(data.etaKayitDurumu);
  if (!kaydaUygun(data, ctx.kisiler, sube)) {
    rapor.worker = "kaydetmez: onaylanmadı, Yasin/Sinan ekranında değil ya da reddedildi";
  } else if (eta === "tamamlandi") {
    rapor.worker = "kaydetmez: ETA kaydı tamamlanmış";
  } else {
    rapor.worker = "kaydeder";
  }

  const veri = { ...data };
  if (eta === "beklemede_plaka") {
    const y = await recheckPlakaBlokaji({ db, data: veri });
    if (!y.cozuldu) {
      rapor.sonuc = { durum: "plaka_blokaji", mesaj: data.etaKayitHata || y.durum };
      return rapor;
    }
    Object.assign(veri, y.guncellenenAlanlar);
    delete veri.etaKayitDurumu;
  }
  const plaka = await evaluateAracPlakaKapisi({ db, data: veri });
  if (plaka.guncellenenAlanlar) Object.assign(veri, plaka.guncellenenAlanlar);
  if (plaka.blocked) {
    rapor.sonuc = { durum: "plaka_blokaji", mesaj: plaka.mesaj };
    return rapor;
  }
  rapor.arac = veri.aracTespit
    ? { plaka: veri.aracTespit.plaka || null, aracTipi: veri.aracTespit.aracTipi || null }
    : null;

  const syncOpts = norm(data.onayDurumu) === "onaylandi" ? {} : { allowAutoStk: false };
  rapor.yeniStokKartiAcilabilir =
    syncOpts.allowAutoStk !== false &&
    String(process.env.ETA_AUTO_CREATE_STKKART ?? "1").trim() !== "0";
  rapor.sonuc = await geriAlinanKayit(veri, docId, belgeNo, syncOpts);
  return rapor;
}

function para(v) {
  const n = Number(v);
  return Number.isFinite(n)
    ? n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 6 })
    : "-";
}

function ozetYaz(r) {
  const s = r.sonuc || {};
  const satirlar = [
    `== ${r.belgeNo || r.docId} · ${r.gonderen || "-"} · ${para(r.odenecek)} ${r.paraBirimi || ""}`,
    `   worker: ${r.worker || "-"} · ekran: ${(r.yasinSinanEkrani || []).join(", ") || "-"} · onay: ${r.onayDurumu || "-"}`,
    `   sonuç: ${s.durum || "-"}${s.hata ? ` · ${s.hata}` : ""}${s.mesaj ? ` · ${s.mesaj}` : ""}`,
  ];
  if (s.geriAlma) {
    satirlar.push(`   geri alma: ${s.geriAlma.dogrulandi ? "doğrulandı" : "DOĞRULANAMADI"}`);
  }
  const y = s.yazilacaklar;
  if (y?.fis) {
    const f = y.fis;
    satirlar.push(
      `   fiş: ${f.FIS_TIPI_ADI || f.FATFISTIPI} · cari ${f.FATFISCARKOD} ${f.CARI_UNVAN || ""} · ` +
        `mal ${para(f.FATFISMALTOP)} · KDV ${para(f.FATFISKDVTUTARI)} · genel ${para(f.FATFISGENTOPLAM)}` +
        (f.FATFISDOVKOD ? ` · ${f.FATFISDOVKOD} ${para(f.FATFISGENDOVTOP)} kur ${f.FATFISDOVKUR}` : "")
    );
    for (const h of y.faturaSatirlari) {
      satirlar.push(
        `   ${h.FATHARSIRANO}. ${Number(h.FATHARKODTIP) === 2 ? "hizmet" : "stok"} ${h.FATHARSTKKOD} · ` +
          `${h.FATHARSTKCINS || ""} · ${para(h.FATHARMIKTAR)} × ${para(h.FATHARFIYAT)} = ${para(h.FATHARTUTAR)} · ` +
          `KDV %${h.FATHARKDVYUZ} ${para(h.FATHARKDVTUTAR)}`
      );
    }
    const muh = s.kayit?.muhasebeFisi;
    if (muh?.satirlar?.length) {
      for (const m of muh.satirlar) {
        satirlar.push(`   muhasebe ${m.baTipi === 1 ? "B" : "A"} ${m.hesapKodu} ${m.hesapAdi} ${para(m.tutar)}`);
      }
    }
    for (const k of y.yeniStokKartlari || []) {
      satirlar.push(`   YENİ STOK KARTI: ${k.STKKOD} ${k.STKCINSI || ""}`);
    }
  }
  return satirlar.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major !== 22) {
    console.error(`Node 22 gerekli; şu an ${process.versions.node}.`);
    return 2;
  }
  const { belgeler, limit } = argumanlar(argv);

  ensureAdmin();
  const db = getFirestore();
  const worker = await workerCalisiyor(db);
  if (worker) {
    console.error(
      `Worker çalışıyor görünüyor (${worker.workerId}, son kalp atışı ${worker.sonGorulme}). ` +
        "Önizleme worker dururken yapılır."
    );
    return 2;
  }

  const ctx = { kisiler: await loadNihaiKisiler(db), baglam: await loadSubeBaglam(db) };
  const hedefler = await hedefleriTopla(db, ctx, belgeler, limit);
  const t = resolveSqlTargets();
  const rapor = {
    olusturma: new Date().toISOString(),
    yazmaVeritabani: t.writeDb,
    hedef: belgeler.length ? "verilen_belgeler" : "worker_kuyrugu",
    faturalar: [],
  };
  if (!hedefler.length) console.log("Önizlenecek fatura yok.");

  let geriAlmaSorunu = false;
  for (const h of hedefler) {
    let r;
    try {
      r = await onizle(db, ctx, h);
    } catch (err) {
      r = { docId: h.docId, kaynak: h.kaynak, sonuc: { durum: "hata", hata: err?.message || String(err) } };
    }
    rapor.faturalar.push(r);
    if (r.sonuc?.geriAlma && !r.sonuc.geriAlma.dogrulandi) geriAlmaSorunu = true;
    console.log(ozetYaz(r));
  }

  const klasor = path.join(os.tmpdir(), "eta-kayit-onizleme");
  mkdirSync(klasor, { recursive: true });
  const dosya = path.join(klasor, `onizleme-${rapor.olusturma.replace(/[:.]/g, "-")}.json`);
  writeFileSync(dosya, JSON.stringify(rapor, null, 2), "utf8");
  console.log(`\nRapor: ${dosya}`);
  if (geriAlmaSorunu) {
    console.error("[KRITIK] En az bir faturada geri alma doğrulanamadı. Rapordaki geriAlma alanına bakın.");
    return 3;
  }
  return 0;
}

const isRunDirectly = (() => {
  const a1 = process.argv[1];
  if (!a1) return false;
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(a1);
  } catch {
    return false;
  }
})();

if (isRunDirectly) {
  main()
    .then((kod) => process.exit(kod))
    .catch((err) => {
      console.error("dryRunEtaKayit failed:", err?.message || err);
      process.exit(1);
    });
}
