import test from "node:test";
import assert from "node:assert/strict";
import { fisNotu, iplikKalemNotu, stokCinsiNotuyla } from "./etaInvoiceSync.js";

test("not stok cinsinin devamına parantez içinde yazılır", () => {
  assert.equal(
    stokCinsiNotuyla("75/36/40 ELASTAN İPLİK", "a3 a/c 70/40 pes 36 flm ecru"),
    "75/36/40 ELASTAN İPLİK (a3 a/c 70/40 pes 36 flm ecru)"
  );
});

test("sığmazsa stok cinsi kısalır, not bütün kalır", () => {
  const cins = "Spandex,Z2173-,H350,SD,__20/1__,AA,72EA,";
  const not = "a3 20 denye elastan siyah, 72 koli, lot E11SS83/2563 ayrı";
  const sonuc = stokCinsiNotuyla(cins, not);
  assert.ok(sonuc.length <= 80);
  assert.ok(sonuc.endsWith(`(${not})`));
  assert.ok(sonuc.startsWith("Spandex,Z2173-"));
});

test("not 78 karakterden uzunsa yalnız not kalır, kısalır", () => {
  const not = "x".repeat(90);
  const sonuc = stokCinsiNotuyla("152.0039", not);
  assert.equal(sonuc, `(${"x".repeat(78)})`);
});

test("nottaki boşluk ve satır sonları tek boşluk olur", () => {
  assert.equal(stokCinsiNotuyla("152.0039", "a3   a/c 70/20\nna6 24 flm"), "152.0039 (a3 a/c 70/20 na6 24 flm)");
});

test("not yoksa stok cinsi değişmez", () => {
  assert.equal(stokCinsiNotuyla("75 DENYE POLYESTER İPLİK", ""), "75 DENYE POLYESTER İPLİK");
});

test("red açıklaması fiş notuna yazılmaz", () => {
  assert.equal(fisNotu("ben bu tarihte araç şarj etmedim", true), "");
  assert.equal(fisNotu("şarj bedeli fabrika", false), "şarj bedeli fabrika");
  assert.equal(fisNotu("şarj bedeli fabrika", undefined), "şarj bedeli fabrika");
});

test("yalnız birimi iplik olan yazarın notu alınır", () => {
  const iplik = new Set(["u-iplik"]);
  const satir = (uid) => ({ kullaniciKalemAciklama: "a3 30 denye elastan", kullaniciKalemAciklamaYazanUid: uid });
  assert.equal(iplikKalemNotu(satir("u-iplik"), iplik), "a3 30 denye elastan");
  assert.equal(iplikKalemNotu(satir("u-eda"), iplik), "");
  assert.equal(iplikKalemNotu(satir(""), iplik), "");
});
