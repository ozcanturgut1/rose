import test from "node:test";
import assert from "node:assert/strict";
import { computeUblExactAmounts } from "./ublExactAmounts.js";

const satir = (qty, unitPrice, net, taxAmount) => ({ qty, unitPrice, net, taxAmount, taxPercent: 10 });
const hesapla = ({ lines, mal, kdv, payable, kur, afterData = {}, doviz = true }) =>
  computeUblExactAmounts({
    usableLines: lines,
    docTotals: { mal, kdv, payable },
    afterData,
    isForeignCurrency: doviz,
    kur,
    parseQty: (l) => l.qty || 1,
  });

test("UBL'de TL yoksa ödenecek matrah + KDV olur (MYF2026000002092)", () => {
  const r = hesapla({
    lines: [satir(1126.23, 3, 3378.69, 337.87), satir(1840.81, 3.2, 5890.59, 589.06)],
    mal: 9269.28,
    kdv: 926.93,
    payable: 10196.21,
    kur: 50.1981,
  });
  assert.equal(r.malHizmetToplamTutari, 465300.24);
  assert.equal(r.vergiTutari, 46530.12);
  assert.equal(r.odenecekTutar, 511830.36);
  assert.deepEqual(r.perLine.map((p) => p.netTl), [169603.82, 295696.42]);
  assert.deepEqual(r.perLine.map((p) => p.taxTl), [16960.43, 29569.69]);
});

test("kalem toplamı başlığı tutmazsa fark yalnız en büyük kaleme yazılır (SCA2026000000973)", () => {
  const r = hesapla({
    lines: [satir(146.96, 4.6, 676.02, 67.6), satir(36.06, 7.6, 274.06, 27.41)],
    mal: 950.07,
    kdv: 95.01,
    payable: 1045.08,
    kur: 49.6015,
  });
  assert.equal(r.malHizmetToplamTutari, 47124.9);
  assert.deepEqual(r.perLine.map((p) => p.netTl), [33531.11, 13593.79]);
  assert.deepEqual(r.perLine.map((p) => p.taxTl), [3353.06, 1359.58]);
  assert.equal(r.odenecekTutar, 51837.54);
});

test("satıcının TL toplamı esas, kalemler döviz × kur (ERD2026000002480)", () => {
  const afterData = {
    ublParsed: {
      Invoice: {
        AdditionalDocumentReference: [
          { ID: "1742476.37", DocumentType: "LINEEXTENSIONAMOUNT" },
          { ID: "1916724.01", DocumentType: "PAYABLEAMOUNT" },
          { ID: "174247.64", DocumentType: "VERGI", DocumentDescription: "KDV" },
        ],
      },
    },
  };
  const r = hesapla({
    lines: [
      satir(5361.29, 2.8, 15011.61, 1501.16),
      satir(3209.08, 3.1, 9948.15, 994.82),
      satir(2654.2, 3.95, 10484.09, 1048.41),
    ],
    mal: 35443.85,
    kdv: 3544.39,
    payable: 38988.24,
    kur: 49.1616,
    afterData,
  });
  assert.equal(r.issuerTlUsed, true);
  assert.equal(r.malHizmetToplamTutari, 1742476.37);
  assert.equal(r.vergiTutari, 174247.64);
  assert.equal(r.odenecekTutar, 1916724.01);
  assert.deepEqual(r.perLine.map((p) => p.netTl), [737994.76, 489066.97, 515414.64]);
  assert.deepEqual(r.perLine.map((p) => p.taxTl), [73799.19, 48906.94, 51541.51]);
});

test("döviz ödenecek matrah + KDV değilse ödenecek kurla çevrilir", () => {
  const r = hesapla({
    lines: [satir(1, 1000, 1000, 200)],
    mal: 1000,
    kdv: 200,
    payable: 1040,
    kur: 40.1234,
  });
  assert.equal(r.odenecekTutar, 41728.34);
});

test("TL faturada kalemler eskisi gibi oranla dağıtılır, ödenecek UBL'den gelir", () => {
  const r = hesapla({
    lines: [satir(1, 100, 100, 20), satir(1, 50.01, 50.01, 10)],
    mal: 150,
    kdv: 30,
    payable: 180.01,
    kur: 1,
    doviz: false,
  });
  assert.equal(r.odenecekTutar, 180.01);
  assert.deepEqual(r.perLine.map((p) => p.netTl), [99.99, 50.01]);
});
