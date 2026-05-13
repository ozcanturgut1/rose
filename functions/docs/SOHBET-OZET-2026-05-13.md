# Sohbet özeti — 13 Mayıs 2026 (ETA / QNB / Firestore)

Bu dosya, Cursor sohbetinde ele alınan konuların **kısa teknik özeti**dir (şifre, bağlantı dizesi, `.env` içeriği yok).

## 1) QNB → Firestore: eksik fatura (ör. NAS2026000000246)

- `gelenBelgeTutarBilgileriSorgula` geniş tarih aralığında **yaklaşık 100 satır** ile sınırlanıyor; tek günlük `start==end` sorgusu **0 satır** dönebiliyor.
- Çözüm: `autoSupplierInvoicePipeline` içinde **üst üste binen 2 günlük** pencereler (bir sonraki chunk’ın başlangıcı = öncekinin bitişi), sonuçların `belgeNo` / ETTN ile **dedupe** edilmesi.
- İADE faturası “özel filtre” değil; asıl risk **cap + sıralama** ile satırların dışarıda kalmasıydı.

## 2) Firestore → ETA (`etaInvoiceSync.js`)

- **Tarih:** `YYYYMMDD` için `Date.UTC` ile UTC gece yarısı (mssql `useUTC` ile 1 gün kayması önlenir).
- **İrsaliye:** `FATFIS` irsaliye alanları `qnbRaw` yerine **`despatches` alt koleksiyonundan** (ilk kayıt).
- **Fiş tipi (`ErpFaturaTipi`):** tedarikçi geçmiş eşleşmesinden **çoğunluk oyu** (`FATFISTIPI`); sınıf uyumsuzluğunda fallback; `FATFISTIP`’taki tüm `FATFTNO` ile uyum (JS tarafı).

## 3) ETA SQL: REFNO NULL (boş tablo sonrası)

- `MAX(REFNO)+1` boş tabloda `NULL+1` → NULL.
- Script: `patchEtaDenemeProceduresNullSafe.js` → `ISNULL(MAX(...),0)+1`.
- `copyEtaProcedures.js` kopyada aynı dönüşüm.

## 4) ETA SQL: “Tanımsız Fatura Tipi!”

### `sp_Fatura_Kayit` (cari)

- Eski: yalnızca `ALIM` / `GİDER` / `ALIM İADE`.
- Yeni: `FATFISTIP` kodunda **İADE/IADE** → cari tarafı “iade” yönü (1), aksi (0); `@FATFTKOD` NULL ise anlamlı hata.
- Script: `patchSpFaturaKayitCariBakiyeAllTypes.js`.

### `sp_Fatura_Detay_Kayit` (stok)

- Eski: stok bakiye için sınırlı kod listesi → `RAISERROR('Tanımsız Fatura Tipi!')`.
- Yeni: **İADE/IADE** → stok azalt (0), aksi → stok artır (1); `@FATFTKOD` NULL ise hata.
- Script: `patchSpFaturaDetayKayitStokAllTypes.js`.

## 5) Script import yan etkisi

- `patchEtaDenemeProceduresNullSafe.js` içinde `main()` yalnızca dosya **doğrudan** çalıştırıldığında çalışsın diye koruma eklendi (import edildiğinde yanlışlıkla çalışmasın).
- `patchSpFaturaKayitCariBakiyeAllTypes.js` için de aynı.

## 6) Local worker davranışı (log yorumu)

- İlk turda detay prosedürü hata verebilir; başlık (`sp_Fatura_Kayit`) oluşmuş olabilir → sonraki tur **`already_exists`**.
- Worker başarılı sayıp **archive** edebilir; bu durumda ETA tarafında satır/stok eksikliği kontrolü gerekir.

## 7) Firebase deploy ne zaman?

- **Sadece SQL yaması** uygulandıysa: **deploy gerekmez** (SQL sunucusunda zaten geçerli).
- **`etaInvoiceSync.js`** vb. değişti ve **bulutta** `onQnbInvoiceApproved` kullanılacaksa:

```bash
firebase deploy --only functions:onQnbInvoiceApproved
```

- `autoSupplierInvoicePipeline` değiştiyse:

```bash
firebase deploy --only functions:onQnbInvoiceApproved,functions:autoSupplierInvoicePipeline
```

## 8) npm kısayolları (örnek)

- `eta:patch-procs-null-safe`
- `eta:patch-fatura-tip-sp` (`patchSpFaturaKayitCariBakiyeAllTypes.js`)

Detay prosedür yaması için ayrıca:

```bash
node scripts/patchSpFaturaDetayKayitStokAllTypes.js --apply --confirm-write-db=ETA_DENEME_2026
```

---

*Cursor’ın kendi tam sohbet dışa aktarımı (varsa) IDE menüsünden alınabilir; bu dosya yalnızca proje içi özet kaydıdır.*
