/**
 * `gelenBelgeTutarBilgileriSorgula` üst üste binen 2 günlük chunk'larla
 * sorgulandığında NAS2026000000246 dönüyor mu? autoSupplierInvoicePipeline.js'in
 * yeni 2-day-overlap stratejisinin NAS246'yı yakalayacağını doğrular.
 * Hiçbir veri yazmaz.
 *
 * Chunk algoritması (autoSupplierInvoicePipeline ile aynı):
 *   en güncelden geriye doğru,
 *   [to, to+1] → [to-1, to] → [to-2, to-1] → ... → [from, from+1]
 *
 * Çalıştırma: node scripts/probeQnbDailyChunkNas246.js
 */
import "dotenv/config";
import { callConnector } from "../qnbCall.js";

function normalizeListItems(resp) {
  const items = resp?.return ?? resp?.["return"] ?? resp?.["return[]"] ?? [];
  const arr = Array.isArray(items) ? items : [items];
  return arr.filter((x) => x != null && typeof x === "object");
}

function pad(n) {
  return String(n).padStart(2, "0");
}
function fmtYmd(dt) {
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function enumerateTwoDayChunks(fromYmd, toYmd) {
  const [fy, fm, fd] = fromYmd.split("-").map(Number);
  const [ty, tm, td] = toYmd.split("-").map(Number);
  const fromDt = new Date(Date.UTC(fy, fm - 1, fd));
  const toDt = new Date(Date.UTC(ty, tm - 1, td));
  const chunks = [];
  let curEnd = new Date(toDt);
  curEnd.setUTCDate(curEnd.getUTCDate() + 1);
  while (true) {
    const start = new Date(curEnd);
    start.setUTCDate(start.getUTCDate() - 1);
    chunks.push({ from: fmtYmd(start), to: fmtYmd(curEnd) });
    if (start.getTime() <= fromDt.getTime()) break;
    curEnd = start;
  }
  return chunks;
}

async function probeChunk(vknTckn, from, to) {
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
    return { ok: false, error: String(e?.message || e), count: 0, items: [] };
  }
}

async function main() {
  const vknTckn = process.env.QNB_VKN_TCKN;
  if (!vknTckn) throw new Error("QNB_VKN_TCKN missing in .env");

  const targetBelgeNo = "NAS2026000000246";

  const today = new Date();
  const todayYmd = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

  // autoPipeline ile aynı: rolling window son 10 gün (bugün dahil).
  const fromDt = new Date(today);
  fromDt.setDate(fromDt.getDate() - 9);
  const fromYmd = `${fromDt.getFullYear()}-${pad(fromDt.getMonth() + 1)}-${pad(fromDt.getDate())}`;

  const chunks = enumerateTwoDayChunks(fromYmd, todayYmd);

  console.log(`Hedef belgeNo = ${targetBelgeNo}`);
  console.log(`Rolling pencere = ${fromYmd}..${todayYmd}`);
  console.log(`Chunk sayisi = ${chunks.length} (her chunk 2 gun, ust uste 1 gun overlap)\n`);

  const seen = new Map();
  let foundChunk = null;

  for (const ch of chunks) {
    const r = await probeChunk(vknTckn, ch.from, ch.to);
    if (!r.ok) {
      console.log(`[${ch.from}..${ch.to}]  HATA: ${r.error.slice(0, 120)}`);
      continue;
    }
    const hit = r.items.find(
      (it) => String(it?.belgeNo || "").trim() === targetBelgeNo
    );
    let newCount = 0;
    for (const it of r.items) {
      const key = it?.belgeNo || it?.ettn || it?.ETTN;
      if (key && !seen.has(key)) {
        seen.set(key, it);
        newCount++;
      }
    }
    console.log(
      `[${ch.from}..${ch.to}]  total=${r.count.toString().padStart(3)}  yeni=${newCount
        .toString()
        .padStart(3)}  unique-so-far=${seen.size.toString().padStart(3)}  ${
        hit
          ? `>> NAS246 BURADA (belgeTarihi=${hit.belgeTarihi}, ettn=${hit.ettn})`
          : ""
      }`
    );
    if (hit && !foundChunk) foundChunk = `${ch.from}..${ch.to}`;
  }

  console.log("");
  console.log(`Toplam unique fatura (10 gun unionu): ${seen.size}`);
  console.log(
    foundChunk
      ? `>> NAS2026000000246 2-day chunk sorguda dondu: ${foundChunk}`
      : `>> NAS2026000000246 hicbir chunk'ta bulunamadi`
  );
}

main().catch((e) => {
  console.error("probeQnbDailyChunkNas246 failed:", e?.message || e);
  process.exitCode = 1;
});
