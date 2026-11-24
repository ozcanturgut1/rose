import test from "node:test";
import assert from "node:assert/strict";
import {
  baslikEkleriniSatiraYaz,
  tutarKapisi,
  tutarKapisiMesaji,
} from "./faturaBaslikEkleri.js";

const urun = (net, tax) => ({
  itemCode: "STK",
  stokCinsi: "Makine",
  qty: 1,
  unitPrice: net,
  net,
  taxAmount: tax,
  taxPercent: 20,
  taxPercentExplicit: true,
});

const avansas = {
  ublParsed: {
    Invoice: {
      AllowanceCharge: {
        ChargeIndicator: true,
        AllowanceChargeReason: "Kargo Ücreti",
        Amount: "166.58",
      },
      TaxTotal: { TaxAmount: "231.49" },
      LegalMonetaryTotal: {
        LineExtensionAmount: "990.83",
        TaxExclusiveAmount: "1157.41",
        TaxInclusiveAmount: "1388.90",
        PayableAmount: "1388.90",
      },
    },
  },
};

test("kargo kendi satırı olur, ürün KDV'si belgenin tüm KDV'si olmaz", () => {
  const lines = [urun(990.83, 198.17)];
  const r = baslikEkleriniSatiraYaz(lines, avansas);
  assert.equal(r.uygulandi, true);
  assert.equal(r.mal, 1157.41);
  assert.equal(r.kdv, 231.49);
  assert.equal(lines[0].net, 990.83);
  assert.equal(lines[0].taxAmount, 198.17);
  assert.equal(lines[1].ekUcret, true);
  assert.equal(lines[1].stokCinsi, "Kargo Ücreti");
  assert.equal(lines[1].net, 166.58);
  assert.equal(lines[1].taxAmount, 33.32);
  assert.equal(lines[1].taxPercent, 20);
  const kapi = tutarKapisi(
    lines.map((l) => ({ netTl: l.net, taxTl: l.taxAmount })),
    1388.9,
    0
  );
  assert.equal(kapi.uyar, true);
});

test("gösterge boşsa matrah farkı kargoyu ek ücret sayar", () => {
  const data = structuredClone(avansas);
  data.ublParsed.Invoice.AllowanceCharge = {
    AllowanceChargeReason: "Kargo Ücreti",
    Amount: { "#text": "166.58" },
  };
  const lines = [urun(990.83, 198.17)];
  const r = baslikEkleriniSatiraYaz(lines, data);
  assert.equal(r.uygulandi, true);
  assert.equal(lines[1].net, 166.58);
  assert.equal(lines[1].taxAmount, 33.32);
});

test("iskonto en büyük satırın matrahından ve KDV'sinden düşülür", () => {
  const lines = [urun(1000, 200), urun(100, 20)];
  const data = {
    ublParsed: {
      Invoice: {
        AllowanceCharge: {
          ChargeIndicator: "false",
          AllowanceChargeReason: "İskonto",
          Amount: "100.00",
        },
        TaxTotal: { TaxAmount: "200.00" },
        LegalMonetaryTotal: {
          LineExtensionAmount: "1100.00",
          TaxExclusiveAmount: "1000.00",
          PayableAmount: "1200.00",
        },
      },
    },
  };
  const r = baslikEkleriniSatiraYaz(lines, data);
  assert.equal(r.uygulandi, true);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].net, 900);
  assert.equal(lines[0].taxAmount, 180);
  assert.equal(r.mal, 1000);
  assert.equal(r.kdv, 200);
});

test("başlık eki yoksa satırlar değişmez", () => {
  const lines = [urun(100, 20)];
  const r = baslikEkleriniSatiraYaz(lines, { ublParsed: { Invoice: {} } });
  assert.equal(r.uygulandi, false);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].net, 100);
});

test("iki belirsiz tutar satıra yazılmaz", () => {
  const lines = [urun(1000, 200)];
  const data = {
    ublParsed: {
      Invoice: {
        AllowanceCharge: [
          { Amount: "50" },
          { Amount: "30" },
        ],
        TaxTotal: { TaxAmount: "200" },
        LegalMonetaryTotal: {
          LineExtensionAmount: "1000",
          TaxExclusiveAmount: "1020",
          PayableAmount: "1220",
        },
      },
    },
  };
  const r = baslikEkleriniSatiraYaz(lines, data);
  assert.equal(r.belirsiz, true);
  assert.equal(r.uygulandi, false);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].net, 1000);
});

test("satır toplamı ödenecek tutardan sapınca kapı kapanır", () => {
  const kapi = tutarKapisi([{ netTl: 990.83, taxTl: 231.49 }], 1388.9, 0);
  assert.equal(kapi.uyar, false);
  assert.equal(kapi.satirToplam, 1222.32);
  assert.equal(kapi.fark, -166.58);
  assert.match(tutarKapisiMesaji(kapi), /1\.388,90/);
  assert.match(tutarKapisiMesaji(kapi), /1\.222,32/);
  assert.match(tutarKapisiMesaji(kapi), /166,58/);
  assert.match(tutarKapisiMesaji(kapi), /Fiş yazılmadı/);
});

test("tevkifat düşülünce ödenecek tutar tutar", () => {
  const kapi = tutarKapisi([{ netTl: 1000, taxTl: 200 }], 1100, 100);
  assert.equal(kapi.uyar, true);
  assert.equal(kapi.satirToplam, 1100);
});
