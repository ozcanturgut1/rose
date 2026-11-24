import test from "node:test";
import assert from "node:assert/strict";
import {
  faturaNihaiEkranda,
  kaydaUygun,
  vknKaynaklari,
  yasinVeyaSinanEkraninda,
} from "./nihaiEkranKriteri.js";

const yasin = { uid: "u-yasin", birimNorm: "yasin", vkns: new Set(["111", "6301027360"]) };
const sinan = { uid: "u-sinan", birimNorm: "sinan", vkns: new Set(["222"]) };
const kisiler = [yasin, sinan];

test("onaya sunuldu ve atanmamış fatura yalnız Yasin ekranındadır", () => {
  const data = { onayDurumu: "onaya sunuldu" };
  assert.equal(faturaNihaiEkranda(data, yasin, ""), true);
  assert.equal(faturaNihaiEkranda(data, sinan, ""), false);
  assert.equal(kaydaUygun(data, kisiler, ""), true);
});

test("Sinan'a atanmış nihai fatura Yasin ekranında değildir", () => {
  const data = { onayDurumu: "onaya sunuldu", nihaiOnayAtananUid: "u-sinan" };
  assert.equal(faturaNihaiEkranda(data, sinan, ""), true);
  assert.equal(faturaNihaiEkranda(data, yasin, ""), false);
});

test("Yasin'e atanmış nihai fatura Sinan ekranında değildir", () => {
  const data = { onayDurumu: "onaya sunuldu", nihaiOnayAtananUid: "u-yasin" };
  assert.equal(faturaNihaiEkranda(data, yasin, ""), true);
  assert.equal(faturaNihaiEkranda(data, sinan, ""), false);
});

test("başka nihai kullanıcıya atanmış fatura kayda girmez", () => {
  const data = { onayDurumu: "onaya sunuldu", nihaiOnayAtananUid: "u-baskasi" };
  assert.equal(yasinVeyaSinanEkraninda(data, kisiler, ""), false);
  assert.equal(kaydaUygun(data, kisiler, ""), false);
});

test("boş onay ve VKN eşleşmesi, şube yoksa Yasin ekranındadır", () => {
  const data = { onayDurumu: "", supplierVkn: "111" };
  assert.equal(faturaNihaiEkranda(data, yasin, ""), true);
  assert.equal(faturaNihaiEkranda(data, sinan, ""), false);
});

test("şube elif ise fatura Yasin ekranında değildir", () => {
  const data = { supplierVkn: "6301027360" };
  assert.equal(faturaNihaiEkranda(data, yasin, "elif"), false);
  assert.equal(kaydaUygun(data, kisiler, "elif"), false);
});

test("şube yasin ise atanmış olsa bile Yasin görür, Sinan görmez", () => {
  const data = { supplierVkn: "6301027360", araOnayAtananUid: "u-elif" };
  assert.equal(faturaNihaiEkranda(data, yasin, "yasin"), true);
  assert.equal(faturaNihaiEkranda(data, sinan, "yasin"), false);
});

test("elle Erdem'e yönlendirilmiş fatura onların ekranında değildir", () => {
  const data = {
    supplierVkn: "111",
    araOnayAtananUid: "u-erdem",
    araOnayYonlendirenUid: "u-olcay",
  };
  assert.equal(yasinVeyaSinanEkraninda(data, kisiler, "yasin"), false);
});

test("boş onaylı kur farkı faturası Yasin ekranında değildir", () => {
  const data = {
    onayDurumu: "",
    supplierVkn: "111",
    ublParsed: { Invoice: { Note: "Kur farkı faturası" } },
  };
  assert.equal(faturaNihaiEkranda(data, yasin, ""), false);
  assert.equal(kaydaUygun(data, kisiler, ""), false);
});

test("onaya sunulmuş kur farkı faturası Yasin ekranındadır", () => {
  const data = {
    onayDurumu: "onaya sunuldu",
    supplierVkn: "111",
    ublParsed: { Invoice: { Note: "Kur farkı faturası" } },
  };
  assert.equal(faturaNihaiEkranda(data, yasin, ""), true);
});

test("onaylanmış fatura ekranda olmasa da kayda uygundur", () => {
  const data = { onayDurumu: "onaylandı", supplierVkn: "999" };
  assert.equal(yasinVeyaSinanEkraninda(data, kisiler, ""), false);
  assert.equal(kaydaUygun(data, kisiler, ""), true);
});

test("reddedilmiş fatura kayda girmez", () => {
  const data = {
    onayDurumu: "reddedildi",
    nihaiOnayAtananUid: "u-yasin",
    supplierVkn: "111",
  };
  assert.equal(kaydaUygun(data, kisiler, ""), false);
});

test("tedarikçi belgesindeki VKN rakama indirgenir", () => {
  const { digits, sorgular } = vknKaynaklari({ vkns: ["111-222", "333"] });
  assert.deepEqual([...digits], ["111222", "333"]);
  assert.ok(sorgular.has("111222"));
  assert.ok(sorgular.has("333"));
});
