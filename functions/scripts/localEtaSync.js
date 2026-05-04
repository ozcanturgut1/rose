import "dotenv/config";
import { getFirestore } from "firebase-admin/firestore";
import { ensureAdmin } from "../adminInit.js";
import { syncApprovedInvoiceToEta } from "../etaInvoiceSync.js";

async function main() {
  const docId = process.argv[2];
  if (!docId) {
    throw new Error("Usage: node scripts/localEtaSync.js <qnb_invoices_docId>");
  }

  ensureAdmin();
  const db = getFirestore();
  const ref = db.collection("qnb_invoices").doc(docId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new Error(`Document not found: qnb_invoices/${docId}`);
  }
  const after = snap.data() || {};
  const onay = String(after.onayDurumu || "")
    .trim()
    .toLowerCase()
    .replaceAll("ı", "i");
  if (onay !== "onaylandi") {
    throw new Error(`onayDurumu must be 'onaylandı'. Current: ${after.onayDurumu || "-"}`);
  }

  console.log(`Local ETA sync starting for ${docId} ...`);
  const result = await syncApprovedInvoiceToEta(after, docId);
  console.log("Local ETA sync result:", JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("localEtaSync failed:", err?.message || err);
  process.exitCode = 1;
});

