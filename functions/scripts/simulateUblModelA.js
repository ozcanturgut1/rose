/**
 * Model A dry-run: ERD2026000001491 benzeri USD tek kalem (salt hesaplama, DB yok).
 * node scripts/simulateUblModelA.js
 */
import { computeUblAuthoritativeAmounts, docAmountToTl } from "../ublAuthoritativeAmounts.js";
import { roundMoney } from "../tevkifatMuhasebe.js";

const kur = 46.3293;
const docMal = 1521.826; // ~70505.30 TL
const docKdv = 152.183; // ~10% KDV
const docPay = docMal + docKdv;

const lineNetFromUbl = () => docMal;
const lineTaxFromUbl = () => docKdv;

const r = computeUblAuthoritativeAmounts({
  usableLines: [{ qty: 1, net: docMal, taxAmount: docKdv, taxPercent: 10 }],
  docTotals: { mal: docMal, kdv: docKdv, payable: docPay },
  isForeignCurrency: true,
  kur,
  lineNetFromUbl,
  lineTaxFromUbl,
});

console.log("Model A simülasyon (USD → TL, kur=" + kur + "):");
console.log("  UBL doc matrah     :", docMal);
console.log("  TL matrah (başlık) :", r.malHizmetToplamTutari);
console.log("  TL kalem net       :", r.perLine[0].netTl);
console.log("  TL ödenecek        :", r.odenecekTutar);
console.log("  Başlık-kalem fark  :", roundMoney(r.malHizmetToplamTutari - r.perLine[0].netTl));
console.log("  Read hedefi ~70505.30 TL:", docAmountToTl(docMal, true, kur));
