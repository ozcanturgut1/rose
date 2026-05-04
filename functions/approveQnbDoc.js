import { onRequest } from "firebase-functions/v2/https";
import { ensureAdmin } from "./adminInit.js";
ensureAdmin();

import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { requireAuth, requireRole, ROLES_QNB_MUTATE } from "./requireAuth.js";

const db = getFirestore();

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

export const approveQnbDoc = onRequest({ region: "europe-west1" }, async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    // Çok aşamalı onay akışı:
    // 1. ve 2. onay: admin/manager/accounting rollerinden, farklı kullanıcılar
    // 3. (son) onay: firma yetkilisi / süper admin (SUPER_ADMIN_UID)
    const user = await requireAuth(req);
    await requireRole(user.uid, ROLES_QNB_MUTATE);

    const isSuperAdmin = user.isSuperAdmin === true;

    // Kullanıcının birinci seviye onay için sorumlu olduğu gönderen ünvanları (routing).
    const routingSnap = await db.collection("qnb_approval_users").doc(user.uid).get();
    let senderNamesSet = null;
    if (routingSnap.exists) {
      const data = routingSnap.data() || {};
      const arr = Array.isArray(data.senderNames) ? data.senderNames : [];
      if (arr.length) {
        senderNamesSet = new Set(arr.map((x) => normalizeSenderName(x)));
      }
    }

    const body = typeof req.body === "object" && req.body ? req.body : {};

    const docId = (body.docId || req.query.docId) ? String(body.docId || req.query.docId) : null;
    const action = (body.action || req.query.action) ? String(body.action || req.query.action) : null;
    const note = body.note ? String(body.note) : null;

    if (!docId) return res.status(400).json({ error: "docId is required" });
    if (!["APPROVED", "REJECTED"].includes(action)) {
      return res.status(400).json({ error: "action must be APPROVED or REJECTED" });
    }

    const ref = db.collection("qnb_docs").doc(docId);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error("NOT_FOUND");

      const current = snap.data() || {};
      const nowServer = FieldValue.serverTimestamp();
      const nowClient = new Date();

      const status = current.status;

      // Eğer zaten sonuçlanmışsa tekrar onay verme
      if (status === "APPROVED" || status === "REJECTED") {
        throw new Error("ALREADY_DECIDED");
      }

      const approvals = Array.isArray(current.approvals) ? current.approvals : [];
      const currentStage =
        typeof current.approvalStage === "number" && Number.isFinite(current.approvalStage)
          ? current.approvalStage
          : 0;

      // İlk onay (approvalStage=0) için: gönderici ünvanı kullanıcının listesinde değilse reddet.
      if (!isSuperAdmin && (!currentStage || currentStage === 0) && senderNamesSet) {
        const sender = extractSenderName(current);
        const key = sender ? normalizeSenderName(sender) : null;
        if (key && !senderNamesSet.has(key)) {
          throw new Error("NOT_ASSIGNED_TO_USER");
        }
      }

      let nextStage = currentStage || 0;

      // RED: herhangi bir aşamada reddedilirse süreç biter, status = REJECTED
      if (action === "REJECTED") {
        nextStage = currentStage > 0 ? currentStage : 1;
      } else {
        // APPROVED: aşamayı belirle
        if (currentStage === 0) {
          // 1. onay
          nextStage = 1;
        } else if (currentStage === 1) {
          // 2. onay: 1. onaylayan ile aynı kullanıcı olamaz
          const firstApproval = approvals.find((a) => a && a.step === 1 && a.action === "APPROVED");
          if (firstApproval && firstApproval.uid && firstApproval.uid === user.uid) {
            throw new Error("SAME_USER_STAGE1_STAGE2");
          }
          nextStage = 2;
        } else if (currentStage === 2) {
          // 3. (son) onay: yalnızca süper admin / firma yetkilisi
          if (!isSuperAdmin) {
            throw new Error("NOT_FINAL_APPROVER");
          }
          nextStage = 3;
        } else {
          // 3'ten büyük bir aşama varsa zaten kapanmış kabul et
          throw new Error("ALREADY_DECIDED");
        }
      }

      const approval = {
        uid: user.uid,
        email: user.email || null,
        action,
        note: note || null,
        at: nowClient,
        step: nextStage,
      };

      const update = {
        lastActionAt: nowServer,
        updatedAt: nowServer,
        approvals: FieldValue.arrayUnion(approval),
        approvalStage: nextStage,
      };

      // Son durum:
      // - Herhangi bir aşamada RED => hemen REJECTED
      // - 3. aşamada APPROVED => APPROVED
      if (action === "REJECTED") {
        update.status = "REJECTED";
      } else if (action === "APPROVED" && nextStage === 3) {
        update.status = "APPROVED";
      } else {
        // Ara aşamalarda statü PENDING kalır; listQnbDocs zaten status=PENDING filtreliyor
        if (!status) {
          update.status = "PENDING";
        }
      }

      tx.set(ref, update, { merge: true });
    });

    return res.status(200).json({ success: true, docId, action });
  } catch (e) {
    const msg = String(e?.message || e);

    if (msg === "NOT_FOUND") return res.status(404).json({ error: "Not found" });
    if (msg === "ALREADY_DECIDED") return res.status(409).json({ error: "Already decided" });
    if (msg === "SAME_USER_STAGE1_STAGE2") {
      return res.status(400).json({ error: "İlk ve ikinci onay aynı kullanıcı olamaz" });
    }
    if (msg === "NOT_FINAL_APPROVER") {
      return res.status(403).json({ error: "Son onay yalnızca firma yetkilisi tarafından verilebilir" });
    }
    if (msg === "NOT_ASSIGNED_TO_USER") {
      return res.status(403).json({ error: "Bu belge sizin onay listenize ait değil" });
    }

    return res.status(500).json({ error: msg });
  }
});
