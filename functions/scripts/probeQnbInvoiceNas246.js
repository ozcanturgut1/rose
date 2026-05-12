/**
 * NAS2026000000246'nın QNB portal SOAP cevabında 7 Mayıs civarı dönüp dönmediğini test eder.
 * Hiçbir veri değiştirmez. Sadece QNB SOAP'a read-only sorgu.
 *
 * Çalıştırma: node scripts/probeQnbInvoiceNas246.js
 */
import "dotenv/config";
import { callConnector } from "../qnbCall.js";

function normalizeListItems(resp) {
  const items = resp?.return || resp?.["return"] || resp?.["return[]"] || [];
  const arr = Array.isArray(items) ? items : [items];
  return arr.filter((x) => x != null && typeof x === "object");
}

function pad(n) {
  return String(n).padStart(2, "0");
}
function shiftYmd(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

async function tryRangeTutar(vknTckn, from, to) {
  try {
    const resp = await callConnector("gelenBelgeTutarBilgileriSorgula", {
      vergiTcKimlikNo: String(vknTckn),
      belgeTuru: "FATURA",
      baslangicGelisTarihi: from,
      bitisGelisTarihi: to,
    });
    const items = normalizeListItems(resp);
    return { ok: true, count: items.length, items };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function tryRangeExt(vknTckn, fromCompact, toCompact) {
  try {
    const resp = await callConnector("gelenBelgeleriListeleExt", {
      parametreler: {
        vergiTcKimlikNo: String(vknTckn),
        belgeTuru: "FATURA",
        sonAlinanBelgeSiraNumarasi: "0",
        donusTipiVersiyon: "6.0",
        gelisTarihiBaslangic: fromCompact,
        gelisTarihiBitis: toCompact,
        onayDurum: "HEPSI",
      },
    });
    const items = normalizeListItems(resp);
    return { ok: true, count: items.length, items };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function findIn(items, belgeNo) {
  return items.filter((it) => String(it?.belgeNo || "").trim() === belgeNo);
}

async function main() {
  const vknTckn = process.env.QNB_VKN_TCKN;
  if (!vknTckn) throw new Error("QNB_VKN_TCKN missing in .env");

  const targetBelgeNo = "NAS2026000000246";
  const dayCenter = "2026-05-07"; // user said gelisTarihi 07/05/2026

  console.log(`QNB probe: hedef belgeNo=${targetBelgeNo}, merkez tarih=${dayCenter}\n`);

  const ranges = [
    { from: dayCenter, to: dayCenter, label: "tek gün (07/05)" },
    { from: dayCenter, to: shiftYmd(dayCenter, 1), label: "07/05–08/05" },
    { from: shiftYmd(dayCenter, -2), to: shiftYmd(dayCenter, 2), label: "05/05–09/05" },
    { from: "2026-05-01", to: "2026-05-12", label: "01/05–12/05 (geniş)" },
  ];

  for (const r of ranges) {
    console.log(`--- gelenBelgeTutarBilgileriSorgula  ${r.label}  (${r.from}..${r.to}) ---`);
    const tut = await tryRangeTutar(vknTckn, r.from, r.to);
    if (!tut.ok) {
      console.log(`  HATA: ${tut.error.slice(0, 200)}`);
    } else {
      console.log(`  toplam item = ${tut.count}`);
      const hits = findIn(tut.items, targetBelgeNo);
      console.log(`  ${targetBelgeNo} bulundu = ${hits.length}`);
      if (hits.length) {
        const h = hits[0];
        const keys = Object.keys(h).sort();
        console.log(`    item keys (${keys.length}) = ${keys.join(", ")}`);
        console.log(`    belgeTarihi=${h.belgeTarihi ?? "-"}  gelisTarihi=${h.gelisTarihi ?? "-"}  ettn=${h.ettn ?? h.ETTN ?? "-"}`);
      }
    }

    const fromC = r.from.replace(/-/g, "");
    const toC = r.to.replace(/-/g, "");
    console.log(`--- gelenBelgeleriListeleExt  ${r.label}  (${fromC}..${toC}) ---`);
    const ext = await tryRangeExt(vknTckn, fromC, toC);
    if (!ext.ok) {
      console.log(`  HATA: ${ext.error.slice(0, 200)}`);
    } else {
      console.log(`  toplam item = ${ext.count}`);
      const hits = findIn(ext.items, targetBelgeNo);
      console.log(`  ${targetBelgeNo} bulundu = ${hits.length}`);
      if (hits.length) {
        const h = hits[0];
        const keys = Object.keys(h).sort();
        console.log(`    item keys (${keys.length}) = ${keys.join(", ")}`);
        console.log(`    belgeTarihi=${h.belgeTarihi ?? "-"}  gelisTarihi=${h.gelisTarihi ?? h.faturaGelisTarihi ?? "-"}  ettn=${h.ettn ?? h.ETTN ?? "-"}`);
      }
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error("probeQnbInvoiceNas246 failed:", e?.message || e);
  process.exitCode = 1;
});
