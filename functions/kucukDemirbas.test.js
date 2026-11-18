import test from "node:test";
import assert from "node:assert/strict";
import { historyKartTuru, kucukDemirbasMetni } from "./etaInvoiceSync.js";

test("laminasyon makinesi küçük demirbaş sayılır", () => {
  assert.equal(
    kucukDemirbasMetni({ stokCinsi: "500139313- -KRAF LM-1000 A4 LAMİNASYON MAKİNESİ" }),
    true
  );
});

test("geçmiş satır türü hizmet veya stok kartını seçer", () => {
  assert.equal(historyKartTuru(2), "hizmet");
  assert.equal(historyKartTuru(1), "stok");
  assert.equal(historyKartTuru(0), "");
});

test("laminasyon geçmeyen satır küçük demirbaş sayılmaz", () => {
  assert.equal(kucukDemirbasMetni({ stokCinsi: "AVANSAS URANUS ÇALIŞMA KOLTUĞU FİLELİ" }), false);
});
