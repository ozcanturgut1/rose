import test from "node:test";
import assert from "node:assert/strict";
import { giderFisiHesaplari, stokFisiAcilsin } from "./etaInvoiceSync.js";

test("bütün satırlar 760, 770 ya da 780'e gidiyorsa gider fişidir", () => {
  assert.equal(giderFisiHesaplari(["760 3 12", "770 4 28", "780 1 01"]), true);
});

test("bir satır başka hesaba gidiyorsa alım fişi kalır", () => {
  assert.equal(giderFisiHesaplari(["760 3 15", "730 3 17"]), false);
  assert.equal(giderFisiHesaplari(["770 4 21", "153"]), false);
  assert.equal(giderFisiHesaplari(["760 3 12", "689 1 01"]), false);
});

test("hesabı bulunamayan satır gider sayılmaz", () => {
  assert.equal(giderFisiHesaplari(["760 3 12", ""]), false);
  assert.equal(giderFisiHesaplari([]), false);
  assert.equal(giderFisiHesaplari(undefined), false);
});

test("boşluksuz yazılmış hesap kodu da okunur", () => {
  assert.equal(giderFisiHesaplari(["7603 12", "770412"]), true);
});

test("bütün satırlar hizmetse stok fişi açılmaz", () => {
  assert.equal(stokFisiAcilsin([true, true]), false);
});

test("stok kartı satırı varsa stok fişi açılır", () => {
  assert.equal(stokFisiAcilsin([true, false]), true);
  assert.equal(stokFisiAcilsin([]), true);
});
