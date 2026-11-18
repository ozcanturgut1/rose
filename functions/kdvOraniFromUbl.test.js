import test from "node:test";
import assert from "node:assert/strict";
import { kdvOraniFromUbl } from "./etaInvoiceSync.js";

test("belge KDV oranı 0015 yüzdesidir, tevkifat 624 sayılmaz", () => {
  const data = {
    ublParsed: {
      Invoice: {
        TaxTotal: {
          TaxSubtotal: [
            {
              Percent: "20",
              TaxCategory: { TaxScheme: { TaxTypeCode: "0015", Name: "KDV" } },
            },
            {
              Percent: "20",
              TaxCategory: { TaxScheme: { TaxTypeCode: "624", Name: "YÜK TAŞIMACILIĞI" } },
            },
          ],
        },
      },
    },
  };
  assert.equal(kdvOraniFromUbl(data), 20);
});

test("tek KDV alt toplamında kod boşsa yüzde alınır", () => {
  const data = {
    ublParsed: {
      Invoice: {
        TaxTotal: { TaxSubtotal: { Percent: 10 } },
      },
    },
  };
  assert.equal(kdvOraniFromUbl(data), 10);
});
