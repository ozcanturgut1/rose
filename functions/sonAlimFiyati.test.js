import test from "node:test";
import assert from "node:assert/strict";
import {
  birimFiyatAyikla,
  gecmisKartSonAlimaUygun,
  sonAlimBirimFiyati,
} from "./sonAlimFiyati.js";

test("birim fiyat miktarla çarpınca tutara uyuyorsa aynen kalır", () => {
  assert.equal(birimFiyatAyikla(10, 50, 5), 10);
});

test("fiyat satır tutarıyla aynıysa birim fiyat tutar/miktardır", () => {
  assert.equal(birimFiyatAyikla(40, 40, 4), 10);
});

test("döviz faturasında son alım döviz birim fiyatıdır", () => {
  const fiyat = sonAlimBirimFiyati(
    { DOVFIYAT: 12.5, DOVTUTAR: 125, FIYAT: 420, TUTAR: 4200, MIKTAR: 10, DOVKOD: "USD" },
    "USD"
  );
  assert.deepEqual(fiyat, { fiyat: 12.5, paraBirimi: "USD" });
});

test("TL faturasında dövizli geçmişin TL birim fiyatı kullanılır", () => {
  const fiyat = sonAlimBirimFiyati(
    { DOVFIYAT: 12.5, DOVTUTAR: 125, FIYAT: 420, NETTUTAR: 4200, MIKTAR: 10, DOVKOD: "USD" },
    "TRY"
  );
  assert.deepEqual(fiyat, { fiyat: 420, paraBirimi: "TRY" });
});

test("TL geçmiş TL birim fiyatıdır", () => {
  const fiyat = sonAlimBirimFiyati(
    { FIYAT: 15.25, TUTAR: 30.5, MIKTAR: 2, DOVKOD: "TL" },
    "TRY"
  );
  assert.deepEqual(fiyat, { fiyat: 15.25, paraBirimi: "TRY" });
});

test("fiyat yoksa sonuç yoktur", () => {
  assert.equal(sonAlimBirimFiyati({ FIYAT: 0, TUTAR: 0, MIKTAR: 1, DOVKOD: "TRY" }, "TRY"), null);
});

test("baskın stok yedeği ve düşük skor son alım kartı değildir", () => {
  assert.equal(gecmisKartSonAlimaUygun({ stkkod: "A", score: 0.9, dominantFallback: true }), false);
  assert.equal(gecmisKartSonAlimaUygun({ stkkod: "A", score: 0.1 }), false);
  assert.equal(gecmisKartSonAlimaUygun({ stkkod: "A", score: 0.28 }), true);
  assert.equal(gecmisKartSonAlimaUygun(null), false);
});
