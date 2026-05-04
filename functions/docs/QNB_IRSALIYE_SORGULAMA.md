# QNB e-Solutions – İrsaliye sorgulama (teknik özet)

## Kaynaklar

- **API teknik sayfa:** https://www.qnbesolutions.com.tr/destek/api-teknik  
- **Teknik dokümantasyon linki (sayfada):** https://www.qnbesolutions.com.tr/api-docs-tr-final.html  
- **Konnektör ürün:** https://www.qnbesolutions.com.tr/urunler/e-donusum/konnektor  

Resmi web servis dokümantasyonu (operasyon isimleri, parametreler) **api-docs-tr-final.html** veya QNB’nin özel entegratör müşterilerine verdiği dokümanlarda yer alıyor. Açık sitede irsaliyeye özel detaylı metod listesi yok; “irsaliye numarası ve tarih ile sorgulama” için aşağıdaki mantık QNB tarafındaki yaygın kullanıma ve sizin kodunuza dayanıyor.

---

## İrsaliye sorgusunun nasıl yapılması gerektiği (özet)

1. **Tarih aralığı ile liste almak**  
   Konnektör tarafında belge listesi **tarih aralığı** ile alınıyor. Parametreler genelde:
   - `baslangicGelisTarihi` (başlangıç geliş tarihi)
   - `bitisGelisTarihi` (bitiş geliş tarihi)  
   Format: **YYYY-MM-DD** (veya portalın kabul ettiği tarih formatı).

2. **İrsaliye numarası ile eşleme**  
   Listeden ilgili irsaliyeyi **belge no** (veya eşdeğer alan) ile buluyorsunuz.  
   Farklı sistemlerde alan adları değişebilir: `belgeNo`, `belgeNoStr`, `irsaliyeNo`, `ID` vb. Karşılaştırmada boşluk/nokta farkları için normalize etmek (ör. boşluksuz, tek formatta) faydalı.

3. **UBL/XML indirme**  
   Listede bulunan kayıttan **ETTN (UUID)** alınıp, ayrı bir operasyonla (örn. gelen irsaliye indir) ilgili irsaliyenin UBL/XML içeriği indiriliyor.

Yani özet akış: **tarih aralığı ile listele → listede irsaliye numarasına göre bul → ETTN ile indir**.

---

## Bizim implementasyonla uyum

| Adım | QNB tarafı beklentisi | Projedeki kullanım |
|------|------------------------|---------------------|
| Liste (tarih aralığı) | Portal **sadece FATURA** kabul ediyor | İrsaliye için `gelenBelgeTutarBilgileriSorgula` kullanılmıyor (hata: "bilinmeyen belge Turu, sadece FATURA türü"). |
| Liste (tarihsiz) | Bazı operasyonlarda sadece belge türü | İrsaliye listesi **yalnızca** `gelenBelgeleriListeleNew` (belgeTuru: IRSALIYE) ile alınıyor; tarih aralığı yok. |
| İrsaliye no eşleme | Liste cevabında belge no/ID alanı | `belgeNo` / `belgeNoStr` / `irsaliyeNo` vb. alanlardan alınıp `belgeNoKey()` ile normalize edilerek karşılaştırılıyor. |
| İndirme | ETTN ile tek belge indir | `gelenIrsaliyeIndir(vkn, ettn)` kullanılıyor. |

**Sonuç:** İrsaliye sorgusunu “**irsaliye numarası + tarih**” ile yapma mantığı doğru: önce **tarih aralığı** ile liste alınıyor (`gelenBelgeTutarBilgileriSorgula`), bu listede **irsaliye numarası** ile eşleşen kayıt bulunuyor, sonra **ETTN** ile `gelenIrsaliyeIndir` çağrılıyor. Bu, QNB tarafında anlatılan “tarih aralığı ile listele, sonra indir” akışıyla uyumlu.

---

## Loglarda görülen hata hakkında

- `BelgeleriListeleNew`: Liste boş veya irsaliye bulunamıyor olabilir (sayfalama / kapsam farkı).
- `BelgeTutarBilgileriSorgula failed`: Servis geçici hata vermiş olabilir veya parametre isimleri/formatı (tarih, belge türü) o ortamda farklı olabilir.

**Öneriler:**

1. **Tarih (uygulandı):** İrsaliye tarihini biliyorsanız sorguyu dar aralıkla yapın. Projede tek `tarih` verildiğinde **3 günlük aralık** kullanılıyor: `from = tarih`, `to = tarih + 2 gün` (Flutter “İndir ve kaydet” → `fetchAndSaveDespatchByBelgeNo?belgeNo=...&tarih=...`).
2. **Parametre isimleri:** QNB’nin size verdiği Konnektör/API dokümanında `gelenBelgeTutarBilgileriSorgula` (ve varsa irsaliye listele) için **tam parametre listesi ve isimleri** (ör. `baslangicGelisTarihi` / `bitisGelisTarihi` veya farklı yazım) kontrol edin.
3. **Destek:** 0850 250 67 50 veya https://www.qnbesolutions.com.tr/iletisim üzerinden “irsaliye numarası ve geliş tarihi ile konnektörden liste alma” için hangi operasyon ve parametrelerin kullanılması gerektiğini teyit ettirin.

Bu dosya, QNB internet sitesi ve genel konnektör bilgisiyle mevcut kodu karşılaştırarak hazırlanmıştır; kesin operasyon adları ve parametreler QNB teknik dokümanına göre güncellenmelidir.
