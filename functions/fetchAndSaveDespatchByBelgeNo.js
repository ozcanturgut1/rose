import { onRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { fetchDespatchUblByBelgeNo, fetchDespatchUblByEttn } from "./enrichInvoiceWithRelatedDespatches.js";

const db = getFirestore();

const setCors = (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

/** Query'den tarihi YYYY-MM-DD yap (tarih, from, to veya tek gün) */
function parseTarihToYyyyMmDd(val) {
  if (!val || typeof val !== "string") return null;
  const t = val.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const d = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (d) return `${d[3]}-${d[2].padStart(2, "0")}-${d[1].padStart(2, "0")}`;
  return null;
}

/** YYYY-MM-DD string'e gün ekle; QNB önerisi: dar aralık (birkaç gün) kullan */
function addDaysYyyyMmDd(str, days) {
  if (!str || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const d = new Date(str + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Verilen irsaliye numarası (ve isteğe bağlı tarih veya ETTN) ile portaldan bulur, UBL/XML indirir ve Firestore'a kaydeder.
 * GET ?belgeNo=BRS2026000000074&tarih=2026-01-28 veya &from=...&to=...
 * ETTN varsa liste atlanır, doğrudan gelenIrsaliyeIndir ile indirilir: ?belgeNo=...&ettn=...
 * Kayıt: qnb_docs docId = despatch_<belgeNo>
 */
export const fetchAndSaveDespatchByBelgeNo = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    try {
      setCors(req, res);
      if (req.method === "OPTIONS") return res.status(204).send("");
      if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

      const belgeNo = (req.query.belgeNo && String(req.query.belgeNo).trim()) || "BRS2026000000074";
      const vknTckn = process.env.QNB_VKN_TCKN;
      if (!vknTckn) {
        return res.status(500).json({ error: "QNB_VKN_TCKN missing in .env" });
      }

      let dateRange;
      const fromQ = parseTarihToYyyyMmDd(req.query.from);
      const toQ = parseTarihToYyyyMmDd(req.query.to);
      const tarihQ = parseTarihToYyyyMmDd(req.query.tarih);
      if (fromQ && toQ) {
        dateRange = { from: fromQ, to: toQ };
      } else if (tarihQ) {
        // QNB önerisi: irsaliye tarihi biliniyorsa dar aralık (3 gün) kullan
        dateRange = { from: tarihQ, to: addDaysYyyyMmDd(tarihQ, 2) };
      }

      const ettnQ = (req.query.ettn && String(req.query.ettn).trim()) || "";
      let fetched = null;

      if (ettnQ) {
        console.log("[fetchAndSaveDespatchByBelgeNo] ETTN ile doğrudan indiriliyor:", belgeNo, ettnQ.slice(0, 20) + "...");
        fetched = await fetchDespatchUblByEttn(vknTckn, ettnQ);
      }

      // ETTN verildiyse listeye düşmeyebilir; bu durumda belgeNo ile liste fallback'ı yapma.
      if (!fetched?.contentUbl && !ettnQ) {
        console.log("[fetchAndSaveDespatchByBelgeNo] Portaldan irsaliye aranıyor:", belgeNo, dateRange ? `tarih: ${dateRange.from} - ${dateRange.to}` : "");
        fetched = await fetchDespatchUblByBelgeNo(vknTckn, belgeNo, dateRange);
      }

      if (!fetched?.contentUbl) {
        const errCode = fetched?.errorCode;
        const errDetail = fetched?.errorDetail;
        console.log("[fetchAndSaveDespatchByBelgeNo] UBL indirilemedi:", belgeNo, errCode, errDetail);
        const message = errCode && errDetail
          ? (errCode === "LIST_QUERY_FAILED"
            ? `Portal liste sorgusu başarısız: ${errDetail}`
            : errCode === "ITEM_NOT_IN_LIST"
              ? errDetail
              : errCode === "INDIR_FAILED" || errCode === "INDIR_EMPTY"
                ? `Portal indirme hatası: ${errDetail}`
                : errDetail)
          : "Portaldan UBL/XML indirilemedi (liste veya indir hatası)";
        return res.status(502).json({
          ok: false,
          belgeNo,
          message,
          errorCode: errCode || undefined,
        });
      }

      const docId = `despatch_${String(belgeNo).replace(/[/\\]/g, "_")}`;
      const ref = db.collection("qnb_docs").doc(docId);

      const da = fetched.ublParsed?.DespatchAdvice;
      const rawUuid = da?.UUID ?? da?.Uuid ?? da?.uuid;
      const ettn =
        rawUuid != null
          ? String(typeof rawUuid === "object" && rawUuid["#text"] != null ? rawUuid["#text"] : rawUuid).trim()
          : null;

      await ref.set(
        {
          type: "despatch",
          belgeNo,
          externalId: ettn || belgeNo,
          ettn: ettn || null,
          status: "PENDING",
          qnbBelgeTuru: "IRSALIYE",
          contentUbl: fetched.contentUbl,
          ublParsed: fetched.ublParsed || null,
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      console.log("[fetchAndSaveDespatchByBelgeNo] Kaydedildi: docId=", docId);

      return res.status(200).json({
        ok: true,
        belgeNo,
        docId,
        message: "Portaldan UBL/XML indirildi ve Firestore'a kaydedildi (qnb_docs)",
        contentLength: fetched.contentUbl.length,
      });
    } catch (e) {
      console.error("[fetchAndSaveDespatchByBelgeNo] Hata:", e.message || e);
      return res.status(500).json({ error: e.message || "FAILED" });
    }
  }
);
