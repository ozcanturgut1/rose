import { aciklamadaCekYerineSenet, analyzeCekSenetKurFarki, belgeMetnindeKurFarki } from "../cekSenetKurFarki.js";

function belge(note, lines = []) {
  return {
    ublParsed: { Invoice: { Note: note } },
  };
}

const ornekSatir = [{ stokCinsi: "Kur farkı", description: "", lineAciklama: "" }];

const cases = [
  {
    ad: "ornek genel not",
    after: belge("18.09.2026 vadeli çek için düzenlenmiştir"),
    lines: ornekSatir,
    tip: "cek",
    vade: "2026-09-18",
    numara: null,
  },
  {
    ad: "cek ile odeme kur farki degil",
    after: belge("Çek ile ödeme yapılacaktır"),
    lines: ornekSatir,
    tip: null,
  },
  {
    ad: "vadeli senet",
    after: belge("Vadeli senet için düzenlenmiştir"),
    lines: ornekSatir,
    tip: "senet",
  },
  {
    ad: "hem cek hem senet",
    after: belge("vadeli çek ve vadeli senet"),
    lines: ornekSatir,
    tip: null,
  },
  {
    ad: "cekim stok cinsi",
    after: belge(""),
    lines: [{ stokCinsi: "NA6 ÇEKİM kur farkı", description: "", lineAciklama: "" }],
    tip: null,
  },
  {
    ad: "cek no",
    after: belge("Çek no: 0045821 kur farkı"),
    lines: [],
    tip: "cek",
    numara: "45821",
  },
  {
    ad: "senet numarasi",
    after: belge("Senet numarası 9981 için kur farkı"),
    lines: [],
    tip: "senet",
    numara: "9981",
  },
  {
    ad: "cek notu kalibi degil",
    after: belge("Çek notu kur farkı"),
    lines: [],
    tip: null,
  },
  {
    ad: "yalniz kur farki",
    after: belge("Kur farkı faturası"),
    lines: [],
    tip: null,
    kurFarki: true,
  },
  {
    ad: "vade farki degil",
    after: belge("vade farkı"),
    lines: [],
    tip: null,
    kurFarki: false,
  },
  {
    ad: "gecersiz tarih",
    after: belge("32.13.2026 vadeli çek kur farkı"),
    lines: [],
    tip: "cek",
    vadeYok: true,
  },
  {
    ad: "iso tarih",
    after: belge("2026-09-18 vadeli çek kur farkı"),
    lines: [],
    tip: "cek",
    vade: "2026-09-18",
  },
];

let failed = 0;
for (const c of cases) {
  const ipucu = analyzeCekSenetKurFarki(c.after, c.lines);
  const tip = ipucu?.tip || null;
  const kur = belgeMetnindeKurFarki(c.after, c.lines);
  const sorun = [];
  if (tip !== c.tip) sorun.push(`tip ${tip} != ${c.tip}`);
  if (c.vade && !ipucu?.vadeler?.includes(c.vade)) sorun.push(`vade yok ${c.vade}`);
  if (c.vadeYok && ipucu?.vadeler?.length) sorun.push(`vade beklenmiyordu ${ipucu.vadeler}`);
  if (c.numara && !ipucu?.numaralar?.includes(c.numara)) sorun.push(`numara yok ${c.numara}`);
  if (c.kurFarki != null && kur !== c.kurFarki) sorun.push(`kurFarki ${kur}`);
  if (c.tip && kur !== true) sorun.push("kur farki kapisi kapali");
  if (sorun.length) {
    failed += 1;
    console.error("FAIL", c.ad, sorun.join("; "), ipucu);
  } else {
    console.log("ok", c.ad);
  }
}

if (failed) {
  console.error(`${failed} basarisiz`);
  process.exit(1);
}

const aciklamaCases = [
  ["ÇEK KUR FARKI", "SENET KUR FARKI"],
  ["12 NOLU ÇEK KUR FARKI", "12 NOLU SENET KUR FARKI"],
  ["vadeli çek", "vadeli senet"],
  ["NA6 ÇEKİM kur farkı", "NA6 ÇEKİM kur farkı"],
  ["CEKET", "CEKET"],
];
for (const [girdi, beklenen] of aciklamaCases) {
  const cikti = aciklamadaCekYerineSenet(girdi);
  if (cikti !== beklenen) {
    console.error("FAIL aciklama", JSON.stringify(girdi), "->", JSON.stringify(cikti));
    process.exit(1);
  }
  console.log("ok aciklama", girdi);
}

console.log("tum assertler gecti");
