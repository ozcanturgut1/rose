---
name: eta-kayit-onizleme
description: Gelen faturaların ETA'ya nasıl kaydedileceğini kaydetmeden önce gösterir. Worker'ın gerçek kayıt kodunu canlı veritabanında geri alınan bir transaction içinde çalıştırır; fiş tipi, cari, satır stok/hizmet kodları, TL ve döviz tutarları, KDV, tevkifat, stok hareketi, cari hareketi, muhasebe fişi ve açılacak stok kartını raporlar. Kullanıcı kayıt önizlemesi, dry run, "nasıl kaydedilecek" ya da "kaydetmeden önce göster" dediğinde kullanılır.
---

# ETA kayıt önizlemesi (dry run)

`functions/scripts/dryRunEtaKayit.js`, worker'ın kayıt fonksiyonunu (`syncApprovedInvoiceToEta`) yazma veritabanında bir transaction içinde çalıştırır. Oluşan satırları okur, her durumda geri alır ve geri almayı ayrı bir bağlantıyla doğrular. Firestore'a yazmaz; stok kartı kalıcı açılmaz.

Bu skill yalnız agent tarafındadır. Uygulamaya (Flutter, fonksiyonlar) önizleme kodu ekleme; "kayıt önizlemesi kodunu geri getirme" kuralı o koda aittir.

## Kurallar

- Yalnız v20 deposunun `functions` klasöründen, Node 22 ile çalıştır. Masaüstündeki ofis kopyasını kullanma.
- Worker çalışıyorsa betik başlamaz. Worker'ı durdurma ya da başlatma; durumu kullanıcıya bildir.
- Önizleme kayıt değildir. Commit, push, deploy ve worker başlatma ayrıca söylenmeden yapılmaz.
- Betik diskteki güncel kodu çalıştırır. Worker yeniden başlatılmadıysa eski kodla kaydeder; bu durumda sonucun worker yeniden başlatıldıktan sonraki kaydı gösterdiğini belirt.
- Betiği değiştirmen gerekirse transaction, örtük transaction modu, geri alma ve doğrulama adımlarını koru.

## Çalıştırma

```powershell
cd functions
node -v                                            # v22.x olmalı
node scripts/dryRunEtaKayit.js                     # worker'ın şu an kaydedeceği faturalar
node scripts/dryRunEtaKayit.js PRJ2026000011126    # belge no ya da invoice_ docId, birden çok olabilir
node scripts/dryRunEtaKayit.js --limit=5           # en fazla 5 fatura (varsayılan 25)
```

Belge verildiğinde fatura kayda uygun olmasa da önizlenir; `worker` alanı worker'ın şu an kaydedip kaydetmeyeceğini söyler. Fatura başına birkaç saniye sürer; uzun listelerde Shell bekleme süresini artır.

Çıkış kodları:

- `0`: önizleme tamam. Faturaya özgü hatalar rapordadır.
- `2`: ön koşul yok (Node 22 değil ya da worker çalışıyor). Mesajı kullanıcıya ilet.
- `3`: KRİTİK, geri alma doğrulanamadı. Başka işlem yapmadan kullanıcıya bildir; rapordaki `geriAlma` alanını ve o evrakın `FATFIS` kaydını göster.
- `1`: beklenmeyen hata.

## Raporu okuma

Çıktının son satırı (`Rapor: ...`) JSON raporunun yoludur; dosya işletim sisteminin geçici klasöründedir. Konsol özeti kısadır, ayrıntıyı JSON'dan al. Alanlar ve satır eşleşme kaynakları için [reference.md](reference.md).

## Kullanıcıya sunma

Önce kısa sonuç: kaç fatura önizlendi, kaçını worker kaydeder, kaçında dikkat gereken durum var. Sonra her fatura için:

1. Belge no, gönderen, tutar ve para birimi; `worker` ve `sonuc.durum`.
2. Fiş: fiş tipi adı, cari kodu ve unvanı, matrah, KDV, tevkifat, genel toplam. Dövizliyse döviz kodu, kur türü, kur ve döviz toplamı.
3. Satır tablosu: sıra, stok/hizmet, kod, stok cinsi, miktar, birim fiyat, TL tutar, KDV oranı ve tutarı, döviz fiyatı ve tutarı, eşleşme kaynağı.
4. Muhasebe fişi tablosu: borç/alacak, hesap kodu, hesap adı, tutar; fiş dengede mi.
5. Stok ve cari hareketinde fatura satırından farklı bir tutar varsa onu.

Şunlardan biri varsa ayrıca ve açıkça yaz:

- `default_fallback` ya da `supplier_history_dominant` kaynaklı satır
- `yeniStokKartlari` dolu: stok kartı kullanıcı onayı olmadan açılmaz; açılacak kartı kullanıcıya sor
- muhasebe fişi yok ya da dengede değil
- dövizli faturada kur ya da kur türü boş
- `plaka_blokaji`, `blocked_kurfarki`, `hata`, `bulunamadi`

Üçten fazla faturada tabloları bir canvas'ta göstermeyi öner.
