import test from "node:test";
import assert from "node:assert/strict";
import { aliciTevkifatKodu } from "./etaInvoiceSync.js";

test("gönderenin 624 kodu alıcıda 224 olur", () => {
  assert.equal(aliciTevkifatKodu("624"), "224");
});

test("gönderenin 601 kodu alıcıda 201 olur", () => {
  assert.equal(aliciTevkifatKodu("601"), "201");
});

test("alıcı kodu yeniden çevrilmez", () => {
  assert.equal(aliciTevkifatKodu("224"), "224");
});
