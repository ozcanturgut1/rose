import { onRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { requireAuth, requireRole } from "./requireAuth.js";

const db = getFirestore();

const setCors = (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

const normalizeSenderName = (s) => {
  if (!s) return "";
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
};

const isValidSenderName = (s) => {
  if (!s) return false;
  const t = String(s).trim().toLowerCase();
  if (!t) return false;
  if (t.startsWith("urn:mail:")) return false;
  if (t.includes("@") && t.includes(".") && !t.includes(" ")) return false;
  return true;
};

const extractSenderName = (d) => {
  const raw = d.qnbRaw || {};
  const candidates = [
    d.supplierUnvan,
    d.supplierEtiket,
    raw.gondericiUnvan,
    raw.gonderenUnvan,
    raw.gonderenEtiket,
    d.gonderenIsim,
    d.gondericiIsim,
    raw.gonderenIsim,
    raw.gondericiIsim,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const s = String(c).trim();
    if (s && isValidSenderName(s)) return s;
  }
  const vkn = d.supplierVkn;
  if (vkn != null && String(vkn).trim() !== "") return `vkn:${String(vkn).trim()}`;
  return null;
};

export const listQnbDocs = onRequest({ region: "europe-west1" }, async (req, res) => {
  try {
    setCors(req, res);
    if (req.method === "OPTIONS") return res.status(204).send("");

    if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

    const user = await requireAuth(req);
    await requireRole(user.uid, ["admin", "manager", "accounting"]);

    const isSuperAdmin = user.isSuperAdmin === true;

    // Kullanıcının 1. seviye onay için sorumlu olduğu gönderen ünvanları listesi.
    const routingSnap = await db.collection("qnb_approval_users").doc(user.uid).get();
    let senderNamesSet = null;
    if (routingSnap.exists) {
      const data = routingSnap.data() || {};
      const arr = Array.isArray(data.senderNames) ? data.senderNames : [];
      if (arr.length) {
        senderNamesSet = new Set(arr.map((x) => normalizeSenderName(x)));
      }
    }

    const { type, status, limit } = req.query;

    const typeVal = type ? String(type) : null;
    const statusVal = status ? String(status) : null;
    // Varsayılan: son 10 kayıt. ?limit=20 ile artırılabilir.
    let lim = 10;
    if (limit !== undefined) {
      const n = Number(limit);
      if (Number.isFinite(n) && n > 0) lim = Math.min(n, 200);
    }

    let docs = [];

    // Not: where(type)+orderBy(updatedAt) bazı projelerde ek index ister ve 500 üretebilir.
    // Bu yüzden qnb_docs tarafında sadece orderBy ile çekip type filtrelemesi uygulamada yapılıyor.
    // type = despatch -> sadece irsaliyeler (qnb_docs, type=despatch)
    if (typeVal && typeVal.toLowerCase() === "despatch") {
      const fetchLimit = Math.max(lim * 5, 300);
      const snapshot = await db
        .collection("qnb_docs")
        .orderBy("updatedAt", "desc")
        .limit(fetchLimit)
        .get();
      docs = snapshot.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((x) => String(x.type) === "despatch")
        .slice(0, lim);
    } else if (typeVal && typeVal.toLowerCase() === "invoice") {
      // type = invoice -> sadece faturalar (qnb_invoices)
      const snapshot = await db
        .collection("qnb_invoices")
        .orderBy("updatedAt", "desc")
        .limit(lim)
        .get();
      docs = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    } else {
      // type yok veya ALL -> son faturalar (qnb_invoices) + son irsaliyeler (qnb_docs), birlikte sıralanır
      const invoiceSnap = await db
        .collection("qnb_invoices")
        .orderBy("updatedAt", "desc")
        .limit(lim)
        .get();
      const fetchLimit = Math.max(lim * 5, 300);
      const despatchSnap = await db
        .collection("qnb_docs")
        .orderBy("updatedAt", "desc")
        .limit(fetchLimit)
        .get();
      docs = [
        ...invoiceSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
        ...despatchSnap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((x) => String(x.type) === "despatch"),
      ];
      docs.sort((a, b) => {
        const ta = a.updatedAt?.toMillis?.() ?? 0;
        const tb = b.updatedAt?.toMillis?.() ?? 0;
        return tb - ta;
      });
      docs = docs.slice(0, lim);
    }

    if (!statusVal) {
      docs = docs.filter((x) => String(x.status) === "PENDING");
    } else if (statusVal !== "ALL" && statusVal !== "all") {
      docs = docs.filter((x) => String(x.status) === statusVal);
    }

    // Firma yetkilisi (SUPER_ADMIN_UID): bekleyen belgeler içinde sadece son onay aşamasına (>=2) gelmiş olanları görsün.
    if (isSuperAdmin) {
      docs = docs.filter((x) => {
        const statusStr = String(x.status || "PENDING");
        if (statusStr !== "PENDING") return true;
        const stage = typeof x.approvalStage === "number" ? x.approvalStage : 0;
        return stage >= 2;
      });
    } else if (senderNamesSet) {
      // 1. ve 2. kullanıcılar: kendi gönderen ünvanı listelerine göre ilk onay aşamasındaki (approvalStage=0) faturaları görsün.
      docs = docs.filter((x) => {
        const statusStr = String(x.status || "PENDING");
        if (statusStr !== "PENDING") return true;

        const stage = typeof x.approvalStage === "number" ? x.approvalStage : 0;

        // İlk onay aşaması (henüz kimse onaylamamış): gönderen ünvanına göre yönlendir.
        if (!stage || stage === 0) {
          const sender = extractSenderName(x);
          if (!sender) return false;
          return senderNamesSet.has(normalizeSenderName(sender));
        }

        // İkinci onay aşaması (approvalStage=1): her iki kullanıcı da görebilsin.
        if (stage === 1) {
          return true;
        }

        // Sonraki aşamalar (>=2): artık firma yetkilisi onayı bekleniyor; burada listelemeye gerek yok.
        return false;
      });
    }

    return res.status(200).json(docs);
  } catch (error) {
    console.error("Error listing QNB docs:", error);
    return res.status(500).send("Internal Server Error");
  }
});