# Önizleme raporu alanları

## Üst düzey

- `yazmaVeritabani`: önizlemenin çalıştığı veritabanı.
- `hedef`: `worker_kuyrugu` (argümansız) ya da `verilen_belgeler`.
- `faturalar[]`: fatura başına sonuç.

## Fatura

- `worker`: `kaydeder` ya da `kaydetmez: ...`. Worker'ın kayıt kapısıyla aynı kural (onaylı ya da Yasin/Sinan ekranında, reddedilmemiş, ETA kaydı tamamlanmamış).
- `yasinSinanEkrani`: faturayı gören nihai ekranlar (`yasin`, `sinan`).
- `yeniStokKartiAcilabilir`: onaylı faturada `true`. Onaydan önceki kayıtta stok kartı açılmaz.
- `arac`: plaka ve araç tipi. `binek` ise binek araç muhasebesi kullanılır.
- `sonuc.durum`:
  - `inserted`: yeni kayıt yapılır.
  - `repaired`: satırsız kalmış mevcut fiş tamamlanır.
  - `already_exists`: ETA'da bu evrak var; yazılmaz.
  - `blocked_kurfarki`: kur farkı faturasında cari belirlenemedi.
  - `plaka_blokaji`: araç plakası eşleşmedi; kayıt yapılmaz.
  - `hata`: kayıt kodu hata verdi (`sonuc.hata`); her şey geri alındı.
  - `bulunamadi`: Firestore'da belge yok.
- `sonuc.geriAlma`: `onceFisSayisi`, `sonraFisSayisi`, `dogrulandi`. Önce ve sonra aynı olmalı.
- `sonuc.kayit`:
  - `erpCariKodu`, `cariSecimNedeni`
  - `satirEslesmeleri[]`: satır başına `source`, `selectedStkKod`, puanlar, `linePreview` (UBL stok cinsi, açıklama, kullanıcı notu)
  - `muhasebeFisi`: `satirlar[]` (`baTipi` 1 borç, 2 alacak; `hesapKodu`, `hesapAdi`, `tutar`), `borcToplam`, `alacakToplam`, `dengede`. `durum: yok` ise fatura muhasebeye bağlanmadı.
  - `binekAracMuhasebe`, `muhasebeRefFatFisRefNo`, `engel`
- `sonuc.yazilacaklar`: transaction içinde okunan satırlar.
  - `fis`: `FATFIS` alanları, `FIS_TIPI_ADI`, `CARI_UNVAN`
  - `faturaSatirlari`: `FATHAR`; `FATHARKODTIP` 1 stok, 2 hizmet; `FATHAREKCHAR1` tevkifat kodu, `FATHAREKORAN1` tevkifat oranı
  - `stokFis`, `stokHareketleri`: `STKFIS`, `STKHAR`
  - `cariHareketleri`: `CARHAR`
  - `yeniStokKartlari`: kayıtta açılacak `STKKART` satırları

## Satır eşleşme kaynakları (`source`)

| Kaynak | Anlamı |
|---|---|
| `supplier_history_match` | Tedarikçinin geçmiş faturasındaki stok kodu |
| `supplier_history_dominant` | Geçmişte en çok kullanılan koda düştü; eşleşme zayıf, kontrol et |
| `supplier_history_clone` | Geçmişteki koddan yeni stok kartı açılır |
| `hizmet_karti` | Hizmet kartı |
| `corlu_osb_hizmet`, `ergul_nakliye`, `kucuk_demirbas` | Sabit kurallar |
| `iade_referans`, `iade_referans_hizmet` | İade referans fişinin satırından |
| `stkkart_cinsi_exact`, `stkkart_cinsi_fuzzy` | Stok kartı cinsi adıyla eşleşme |
| `direct_item_code` | UBL kalem kodu doğrudan stok kodu |
| `new_stkkart_clone` | UBL kodundan yeni stok kartı açılır |
| `default_fallback` | Varsayılan stoka düştü; kontrol et |
