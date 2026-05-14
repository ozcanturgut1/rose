// QNB dışı fonksiyonlar deploy edilmiyor (CPU kotası / sadece QNB kullanımı için)
// Geri eklemek için: import + export listesine ekleyin.
// import { askAssistant } from "./askAssistant.js";
// import { query } from "./query.js";
// import { flat_query } from "./flat_query.js";
// import { onOrderChange } from "./triggers/updateVectorStoreOnOrderChange.js";
// import { chatAssistant } from "./chatAssistant.js";
// import { sendImageToAssistantOt } from "./sendImageToAssistantOt.js";

import { listQnbDocs } from "./listQnbDocs.js";
import { approveQnbDoc } from "./approveQnbDoc.js";
import { syncQnbDocs } from "./syncQnbDocs.js";
import { viewQnbDoc } from "./viewQnbDoc.js";
import { normalizeQnbInvoices } from "./normalizeQnbInvoices.js";
import { enrichInvoiceWithRelatedDespatches } from "./enrichInvoiceWithRelatedDespatches.js";
import { getInvoiceRelatedDespatches } from "./getInvoiceRelatedDespatches.js";
import { onQnbDocCreated } from "./triggers/onQnbDocCreated.js";
import { debugQnbLastInvoiceIrsaliye } from "./debugQnbLastInvoiceIrsaliye.js";
import { fetchAndSaveDespatchByBelgeNo } from "./fetchAndSaveDespatchByBelgeNo.js";
import { syncAllDespatches } from "./syncAllDespatches.js";
import { syncAllInvoices } from "./syncAllInvoices.js";
import { backfillInvoicesFullByDateRange } from "./backfillInvoicesFullByDateRange.js";
import { syncAndEnrichInvoices2026 } from "./syncAndEnrichInvoices2026.js";
import { listGelenBelgeleriExt } from "./listGelenBelgeleriExt.js";
import { backfillDespatchEttnFromQnbDocs } from "./backfillDespatchEttnFromQnbDocs.js";
import { enrichInvoiceDespatchesUblByEttn } from "./enrichInvoiceDespatchesUblByEttn.js";
import { updateQnbInvoiceYonetimOnay } from "./updateQnbInvoiceYonetimOnay.js";
import { listAraOnayUsers } from "./listAraOnayUsers.js";
import { assignQnbInvoiceAraOnay } from "./assignQnbInvoiceAraOnay.js";
import { onQnbInvoiceApproved } from "./triggers/onQnbInvoiceApproved.js";
import { autoSupplierInvoicePipeline } from "./autoSupplierInvoicePipeline.js";

// Probe/debug (uygulama kullanmıyor; CPU kotası için deploy edilmiyor):
// probeQnbTutar, probeQnbIrsaliyeList, qnbDescribe, qnbOpInfo, qnbUserDescribe, qnbUserOpInfo

export {
  listQnbDocs,
  approveQnbDoc,
  syncQnbDocs,
  viewQnbDoc,
  normalizeQnbInvoices,
  enrichInvoiceWithRelatedDespatches,
  getInvoiceRelatedDespatches,
  onQnbDocCreated,
  debugQnbLastInvoiceIrsaliye,
  fetchAndSaveDespatchByBelgeNo,
  syncAllDespatches,
  syncAllInvoices,
  backfillInvoicesFullByDateRange,
  syncAndEnrichInvoices2026,
  listGelenBelgeleriExt,
  backfillDespatchEttnFromQnbDocs,
  enrichInvoiceDespatchesUblByEttn,
  updateQnbInvoiceYonetimOnay,
  listAraOnayUsers,
  assignQnbInvoiceAraOnay,
  onQnbInvoiceApproved,
  autoSupplierInvoicePipeline,
};
