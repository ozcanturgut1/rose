import test from "node:test";
import assert from "node:assert/strict";
import { gelenFaturaFisAilesi } from "./etaInvoiceSync.js";

test("gelen SATIS faturası alış fişidir", () => {
  assert.equal(gelenFaturaFisAilesi({ invType: "SATIS", isIade: false, hasTevkifat: false }), "alim");
});

test("gelen tevkifat faturası tevkifatlı alış fişidir", () => {
  assert.equal(
    gelenFaturaFisAilesi({ invType: "TEVKIFAT", isIade: false, hasTevkifat: true }),
    "tevkifatli_alis"
  );
});

test("gelen iade faturası iade ailesindedir", () => {
  assert.equal(gelenFaturaFisAilesi({ invType: "IADE", isIade: true, hasTevkifat: false }), "iade");
});
