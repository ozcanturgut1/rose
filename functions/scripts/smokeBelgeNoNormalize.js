/**
 * İrsaliye no kısaltma / eşdeğerlik smoke assert'leri.
 * Çalıştırma: node scripts/smokeBelgeNoNormalize.js
 */
import {
  belgeNoKey,
  parseEBelgeParts,
  expandEBelgeCandidates,
  belgeNosEquivalent,
  pickBelgeNoMatch,
} from "../qnbDespatchPortalLookup.js";

let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL:", msg);
  } else {
    console.log("ok:", msg);
  }
}

assert(belgeNosEquivalent("MYF26-1614", "MYF2026000001614"), "MYF26-1614 ≡ MYF2026000001614");
assert(belgeNosEquivalent("MYF261614", "MYF2026000001614"), "MYF261614 ≡ MYF2026000001614");
assert(belgeNosEquivalent("BRS 2026 000000074", "BRS2026000000074"), "BRS boşluklu ≡ compact");
assert(!belgeNosEquivalent("MYF26-1614", "MYF2026000001615"), "farklı serial eşleşmez");

const parts = parseEBelgeParts("MYF26-1614");
assert(parts?.prefix === "MYF" && parts?.year === "2026" && parts?.serial === "1614", "parseEBelgeParts kısa form");

const cands = expandEBelgeCandidates("MYF26-1614");
assert(cands.includes("MYF261614") && cands.includes("MYF2026000001614"), "expand adayları");

const items = [
  { belgeNo: "MYF2026000001613" },
  { belgeNo: "MYF2026000001614" },
  { belgeNo: "OTHER2026000000001" },
];
assert(pickBelgeNoMatch(items, "MYF26-1614")?.belgeNo === "MYF2026000001614", "pickBelgeNoMatch expand");
assert(pickBelgeNoMatch(items, "MYF2026000001614")?.belgeNo === "MYF2026000001614", "pickBelgeNoMatch exact");

assert(pickBelgeNoMatch([{ belgeNo: "ZZZ2026000000001" }], "MYF26-1614") === null, "eşleşmeyen → null");

// Expand anahtarı listede yok; iki farklı key aynı prefix/year/serial → belirsiz → null
const multiLoose = [{ belgeNo: "ABC20265" }, { belgeNo: "ABC2026005" }];
assert(pickBelgeNoMatch(multiLoose, "ABC26-5") === null, "birden fazla loose aday → null");

assert(
  pickBelgeNoMatch([{ belgeNoStr: "ABC2026000000099" }], "ABC26-99")?.belgeNoStr === "ABC2026000000099",
  "belgeNoStr alanı ile eşleşir"
);

assert(belgeNoKey("BRS 2026 000000074") === "BRS2026000000074", "belgeNoKey ayırıcı temizler");

if (failed) {
  console.error(`\n${failed} assert başarısız`);
  process.exit(1);
}
console.log("\nTüm smoke assert'ler geçti.");
