import test from "node:test";
import assert from "node:assert/strict";
import {
  eslestirIadeReferansSatirlari,
  iadeReferansBelgeNolari,
  satisIadeTipKodu,
} from "./etaInvoiceSync.js";

test("BillingReference fatura numarasını okur", () => {
  const nos = iadeReferansBelgeNolari({
    contentUbl: `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>FYS2026000010045</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>`,
  });
  assert.deepEqual(nos, ["FYS2026000010045"]);
});

test("satış fişi satış iadeye, alış fişi boş kalır", () => {
  assert.equal(satisIadeTipKodu("SATIŞ"), "SATIŞ İADE");
  assert.equal(satisIadeTipKodu("YURT DIŞI SATIŞ"), "YURT DIŞI SATIŞ İADE");
  assert.equal(satisIadeTipKodu("ALIM"), "");
});

test("iade satırları referans fişin stok cinsine bağlanır", () => {
  const satirlar = eslestirIadeReferansSatirlari(
    [
      { stokCinsi: "A/C 15+ 75 /36 Z PES RECYCLE EKRU 2.4" },
      { stokCinsi: "20/1 NT1068 SİYAH KESİK ELYAF REC + 70/1 N6 İMG SİYAH" },
    ],
    [
      { kod: "A1-001", cins: "A/C 15+ 75 /36 Z PES RECYCLE EKRU 2.4", kodtip: 1 },
      { kod: "A1-002", cins: "20/1 NT1068 SİYAH KESİK ELYAF REC + 70/1 N6 İMG SİYAH", kodtip: 1 },
    ]
  );
  assert.equal(satirlar[0].kod, "A1-001");
  assert.equal(satirlar[1].kod, "A1-002");
});
