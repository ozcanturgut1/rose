import test from "node:test";
import assert from "node:assert/strict";
import { binekFaturaSatirPlani } from "./etaInvoiceSync.js";

const kartlar = [
  { kod: "BİNEK ARAÇ YAKIT GİDERİ-K.K.E.G.", hesap: "689 1 07" },
  { kod: "İNDİRELEMEYEN KDV- (K.K.E.G.)", hesap: "689 1 03" },
  { kod: "BİNEK ARAÇ KİRA GİDERİ", hesap: "770 4 34" },
];

test("kira bölmesi üç satıra yazılır, ödenecek tutar aynı kalır", () => {
  const plan = binekFaturaSatirPlani({
    satirlar: [
      { hesap: "770 4 34", ba: 1, tutar: 46000 },
      { hesap: "689 1 11", ba: 1, tutar: 14760 },
      { hesap: "191 108 20", ba: 1, tutar: 9200 },
      { hesap: "689 1 03", ba: 1, tutar: 2952 },
      { hesap: "320 1 P0019", ba: 2, tutar: 72912 },
    ],
    kabulHesap: "770 4 34",
    kkegHesap: "689 1 11",
    indirilemeyenKdvHesap: "689 1 03",
    kaynakKod: "BİNEK ARAÇ KİRA GİDERİ",
    kaynakHesap: "770 4 34",
    kaynakCins: "34PAE998 kira",
    hizmetKartlari: kartlar,
  });
  assert.deepEqual(plan, [
    { kod: "BİNEK ARAÇ KİRA GİDERİ", muhKod: "", cins: "34PAE998 kira", tutar: 46000, kdv: 9200, kdvYuz: 20 },
    { kod: "", muhKod: "689 1 11", cins: "K.K.E.G.", tutar: 14760, kdv: 0, kdvYuz: 0 },
    { kod: "İNDİRELEMEYEN KDV- (K.K.E.G.)", muhKod: "", cins: "İNDİRELEMEYEN KDV- (K.K.E.G.)", tutar: 2952, kdv: 0, kdvYuz: 0 },
  ]);
  const toplam = plan.reduce((t, s) => t + s.tutar + s.kdv, 0);
  assert.equal(toplam, 72912);
});

test("yakıt bölmesi KKEG hizmet kartını kullanır", () => {
  const plan = binekFaturaSatirPlani({
    satirlar: [
      { hesap: "730 4 28", ba: 1, tutar: 74.85 },
      { hesap: "689 1 07", ba: 1, tutar: 32.08 },
      { hesap: "191 108 20", ba: 1, tutar: 14.97 },
      { hesap: "689 1 03", ba: 1, tutar: 6.42 },
      { hesap: "320 1 E0004", ba: 2, tutar: 128.32 },
    ],
    kabulHesap: "730 4 28",
    kkegHesap: "689 1 07",
    indirilemeyenKdvHesap: "689 1 03",
    kaynakKod: "BİNEK ARAÇ YAKIT GİDERİ-FABRİKA",
    kaynakHesap: "730 4 28",
    kaynakCins: "şarj",
    hizmetKartlari: kartlar,
  });
  assert.equal(plan[1].kod, "BİNEK ARAÇ YAKIT GİDERİ-K.K.E.G.");
  assert.equal(plan[1].muhKod, "");
  assert.equal(plan[2].kod, "İNDİRELEMEYEN KDV- (K.K.E.G.)");
  assert.equal(plan.reduce((t, s) => t + s.tutar + s.kdv, 0), 128.32);
});

test("bölme yoksa fatura satırı değişmez", () => {
  const plan = binekFaturaSatirPlani({
    satirlar: [
      { hesap: "770 4 34", ba: 1, tutar: 40000 },
      { hesap: "191 108 20", ba: 1, tutar: 8000 },
      { hesap: "320 1 P0019", ba: 2, tutar: 48000 },
    ],
    kabulHesap: "770 4 34",
    kkegHesap: "689 1 11",
    indirilemeyenKdvHesap: "689 1 03",
    kaynakKod: "BİNEK ARAÇ KİRA GİDERİ",
    kaynakHesap: "770 4 34",
    kaynakCins: "kira",
    hizmetKartlari: kartlar,
  });
  assert.equal(plan, null);
});
