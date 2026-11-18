import test from "node:test";
import assert from "node:assert/strict";
import { corluOsbKayitTanimi } from "./etaInvoiceSync.js";

const vkn = "8750360328";

test("ortak altyapı aidat hizmet kartına ve 320 Ç1027 cariye gider", () => {
  const tanim = corluOsbKayitTanimi(vkn, [
    { stokCinsi: "ORTAK ALTYAPI TESİSİ YATIRIMINA KATILIM" },
  ]);
  assert.deepEqual(tanim, {
    carkod: "320 Ç1027",
    stok: "AİDAT GİDERİ-FABRİKA",
    gider: true,
  });
});

test("atıksu ortak altyapıdan önce seçilir", () => {
  const tanim = corluOsbKayitTanimi(vkn, [
    { stokCinsi: "ATIKSU ARITMA", lineAciklama: "ORTAK ALTYAPI" },
  ]);
  assert.equal(tanim.carkod, "320 Ç1029");
  assert.equal(tanim.stok, "AİDAT GİDERİ-FABRİKA");
});
