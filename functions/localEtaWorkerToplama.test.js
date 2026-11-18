import test from "node:test";
import assert from "node:assert/strict";
import { collectPendingDocs } from "./scripts/localEtaWorker.js";

/** Firestore koleksiyonunun `where` / `limit` / `startAfter` / `get` kadarı. */
function sahteKoleksiyon(belgeler) {
  const deger = (veri, alan) =>
    alan.split(".").reduce((o, k) => (o == null ? undefined : o[k]), veri);
  const uyar = (veri, f) =>
    f.op === "in" ? f.val.includes(deger(veri, f.alan)) : deger(veri, f.alan) === f.val;
  const sorgu = (filtreler, sinir, sonraId) => ({
    where: (alan, op, val) => sorgu([...filtreler, { alan, op, val }], sinir, sonraId),
    limit: (n) => sorgu(filtreler, n, sonraId),
    startAfter: (doc) => sorgu(filtreler, sinir, doc.id),
    get: async () => {
      let liste = Object.entries(belgeler)
        .filter(([, veri]) => filtreler.every((f) => uyar(veri, f)))
        .sort(([a], [b]) => a.localeCompare(b));
      if (sonraId) liste = liste.filter(([id]) => id > sonraId);
      if (sinir) liste = liste.slice(0, sinir);
      const docs = liste.map(([id, veri]) => ({ id, data: () => veri }));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  });
  return sorgu([], null, null);
}

const sinan = {
  uid: "u-sinan",
  birimNorm: "sinan",
  vkns: new Set(["7331158248"]),
  sorgular: new Set(["7331158248"]),
};
const baglam = { arac: new Map(), subeByBirim: new Map(), birimlerByVkn: new Map() };

test("VKN'si yalnız qnbRaw.gondericiVkn içinde olan boş onaylı fatura toplanır", async () => {
  const col = sahteKoleksiyon({
    invoice_PRJ1: { type: "invoice", qnbRaw: { gondericiVkn: "7331158248" } },
  });
  const { docs } = await collectPendingDocs(col, 25, 200, { kisiler: [sinan], baglam });
  assert.deepEqual([...docs.keys()], ["invoice_PRJ1"]);
});

test("supplierVkn dolu fatura iki aramada da bulunsa bir kez toplanır", async () => {
  const col = sahteKoleksiyon({
    invoice_A: {
      type: "invoice",
      supplierVkn: "7331158248",
      qnbRaw: { gondericiVkn: "7331158248" },
    },
  });
  const { docs } = await collectPendingDocs(col, 25, 200, { kisiler: [sinan], baglam });
  assert.deepEqual([...docs.keys()], ["invoice_A"]);
});

test("ETA kaydı tamamlanmış veya listede olmayan VKN'li fatura toplanmaz", async () => {
  const col = sahteKoleksiyon({
    invoice_KAYITLI: {
      type: "invoice",
      etaKayitDurumu: "tamamlandi",
      qnbRaw: { gondericiVkn: "7331158248" },
    },
    invoice_BASKA: { type: "invoice", qnbRaw: { gondericiVkn: "1111111111" } },
  });
  const { docs } = await collectPendingDocs(col, 25, 200, { kisiler: [sinan], baglam });
  assert.equal(docs.size, 0);
});
