CREATE PROCEDURE dbo.sp_Fatura_Muhasebe_Bagla_BinekArac
  @FatFisRefNo INT,
  @MuhFisRefNo INT OUTPUT,
  @GiderTuru NVARCHAR(10),                 -- 'KIRA' => aylık limit; diğerleri (YAKIT/BAKIM/
                                           --   SIGORTA/HGS_OGS/MUAYENE/UTTS/DIGER) => @KabulOrani
  @KabulHesap VARCHAR(40),                 -- kabul edilen gider hesabı (türüne göre JS'de seçilir)
  @KkegHesap VARCHAR(40),                  -- KKEG hesabı (türüne göre JS'de seçilir)
  @IndirilemeyenKdvHesap VARCHAR(40),      -- indirilemeyen KDV KKEG hesabı (ör. 689 1 03)
  @KabulOrani DECIMAL(9, 4) = 0.70,        -- binek cari gider kabul oranı (%70)
  @KiraLimiti DECIMAL(28, 2) = 46000       -- binek aylık kira gider tavanı (KDV hariç)
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

  DECLARE
    @CariKod VARCHAR(40),
    @EvrakNo VARCHAR(40),
    @FisTar DATETIME,
    @CurrentMuhRef INT,
    @HazKod VARCHAR(40),
    @CariMuhKod VARCHAR(40),
    @LineAciklama VARCHAR(120),
    @KdvOran DECIMAL(28, 9),
    @MuhKayitOnc INT = 4,
    @MaxMuhRef INT,
    @NextHar INT,
    @MuhFisNo VARCHAR(40),
    @NextFisNoInt INT,
    @Sira INT = 0,
    @FatTip INT,
    @FisTuruEtiket VARCHAR(80);

  SELECT
    @FatTip = FATFISTIPI,
    @CariKod = FATFISCARKOD,
    @EvrakNo = FATFISEVRAKNO1,
    @FisTar = FATFISTAR,
    @CurrentMuhRef = ISNULL(FATFISMUHREFNO, 0),
    @HazKod = ISNULL(FATFISHAZKOD, ''),
    @KdvOran = ISNULL(FATFISKDVORANI, 0)
  FROM dbo.FATFIS WITH (UPDLOCK, HOLDLOCK)
  WHERE FATFISREFNO = @FatFisRefNo;

  IF @CariKod IS NULL
    THROW 51001, 'FATFIS bulunamadi (BinekArac).', 1;

  -- Zaten muhasebeleştirilmişse tekrar oluşturma.
  IF @CurrentMuhRef > 0
  BEGIN
    SET @MuhFisRefNo = @CurrentMuhRef;
    RETURN;
  END;

  IF ISNULL(@EvrakNo, '') = ''
    SET @EvrakNo = 'FAT-' + CAST(@FatFisRefNo AS VARCHAR(20));

  /* Belge türü etiketi (MUHFISEKCHAR2). Değerler ETA'nın kendi kayıtlarından;
     sp_Fatura_Muhasebe_Bagla_Deneme ile aynı sözlük kullanılıyor. Binek araç
     faturaları pratikte GİDER (9) tipinden gelir, yine de tam liste tutuluyor. */
  SET @FisTuruEtiket = CASE @FatTip
    WHEN 1 THEN 'ALIM FATURASI'
    WHEN 2 THEN 'ALIM İADE FATURASI'
    WHEN 3 THEN 'YURT İÇİ SATIŞ FATURASI'
    WHEN 4 THEN 'YURT İÇİ SATIŞ İADE FATURASI'
    WHEN 5 THEN 'YURT DIŞI SATIŞ FATURASI'
    WHEN 7 THEN 'TEVKİFATLI SATIŞ FATURASI'
    WHEN 8 THEN 'TEVKİFATLI ALIŞ FATURASI'
    WHEN 9 THEN 'GİDER FATURASI'
    WHEN 11 THEN 'YURT DIŞI ALIM FATURASI'
    WHEN 12 THEN 'İHRAÇ KAYITLI SATIŞ FATURASI'
    WHEN 13 THEN 'YANSITMA SATIŞ FATURASI'
    ELSE NULL
  END;

  IF @FisTuruEtiket IS NULL
    SELECT TOP 1 @FisTuruEtiket = LTRIM(RTRIM(FATFTKOD)) + ' FATURASI'
    FROM dbo.FATFISTIP WITH (NOLOCK)
    WHERE FATFTNO = @FatTip;

  SET @FisTuruEtiket = ISNULL(NULLIF(LTRIM(RTRIM(@FisTuruEtiket)), ''), 'FATURA');

  -- Mal (matrah) ve KDV: FATHAR toplamlarından (otorite).
  DECLARE @Mal DECIMAL(28, 2) = (
    SELECT ISNULL(SUM(ROUND(ISNULL(H.FATHARNETTUTAR, ISNULL(H.FATHARKDVMATRAH, H.FATHARTUTAR)), 2)), 0)
    FROM dbo.FATHAR H WITH (NOLOCK) WHERE H.FATHARREFNO = @FatFisRefNo
  );
  DECLARE @Kdv DECIMAL(28, 2) = (
    SELECT ISNULL(SUM(ISNULL(H.FATHARKDVTUTAR, 0)), 0)
    FROM dbo.FATHAR H WITH (NOLOCK) WHERE H.FATHARREFNO = @FatFisRefNo
  );

  IF @Mal IS NULL OR @Mal <= 0
    THROW 51002, 'BinekArac: mal/matrah 0; muhasebe olusturulmadi.', 1;

  DECLARE @GenTop DECIMAL(28, 2) = ROUND(@Mal + @Kdv, 2);

  -- Satır açıklaması (ilk kalem) ve cari muhasebe kodu.
  SELECT TOP 1
    @LineAciklama = ISNULL(NULLIF(LTRIM(RTRIM(FATHARACIKLAMA)), ''), ISNULL(NULLIF(LTRIM(RTRIM(FATHARSTKCINS)), ''), @EvrakNo))
  FROM dbo.FATHAR WITH (NOLOCK)
  WHERE FATHARREFNO = @FatFisRefNo
  ORDER BY FATHARSIRANO;
  IF @LineAciklama IS NULL SET @LineAciklama = @EvrakNo;

  SELECT TOP 1
    @CariMuhKod = COALESCE(NULLIF(LTRIM(RTRIM(CAREKCHAR1)), ''), NULLIF(LTRIM(RTRIM(CARMUHKODU)), ''))
  FROM dbo.CARKART WITH (NOLOCK)
  WHERE CARKOD = @CariKod;

  IF @CariMuhKod IS NULL
    THROW 51003, 'BinekArac: CARKART cari muhasebe kodu bos.', 1;

  IF ISNULL(LTRIM(RTRIM(@HazKod)), '') = ''
    SET @HazKod = 'YMM';

  -- İndirilecek KDV hesabı: FATMUHGRUP'tan KDV oranına en yakın (alış) hesap.
  DECLARE @KdvOranPct DECIMAL(28, 4) = CASE
    WHEN @KdvOran <= 0 AND @Mal > 0 THEN ROUND(@Kdv / @Mal * 100.0, 0)
    WHEN @KdvOran <= 1 THEN @KdvOran * 100.0
    ELSE @KdvOran
  END;
  DECLARE @AccKdvInd VARCHAR(40);
  SELECT TOP 1 @AccKdvInd = NULLIF(LTRIM(RTRIM(FMGMUHKOD1)), '')
  FROM dbo.FATMUHGRUP WITH (NOLOCK)
  WHERE FMGGRUPKOD = 'FATMUHGRP'
    AND ISNULL(FMGKDVORAN, 0) > 0
    AND ISNULL(NULLIF(LTRIM(RTRIM(FMGMUHKOD1)), ''), '') <> ''
  ORDER BY ABS(ISNULL(FMGKDVORAN, 0) - @KdvOranPct);
  IF @AccKdvInd IS NULL
    SET @AccKdvInd = CASE
      WHEN @KdvOranPct <= 1 THEN '191 108 01'
      WHEN @KdvOranPct <= 10 THEN '191 108 10'
      ELSE '191 108 20'
    END;

  -- Kabul / KKEG bölmesi.
  DECLARE @KabulMal DECIMAL(28, 2), @KkegMal DECIMAL(28, 2);
  IF UPPER(@GiderTuru) = 'KIRA'
    SET @KabulMal = CASE WHEN @Mal <= @KiraLimiti THEN @Mal ELSE @KiraLimiti END;
  ELSE
    SET @KabulMal = ROUND(@Mal * ISNULL(NULLIF(@KabulOrani, 0), 0.70), 2);

  IF @KabulMal > @Mal SET @KabulMal = @Mal;
  IF @KabulMal < 0 SET @KabulMal = 0;
  SET @KkegMal = ROUND(@Mal - @KabulMal, 2);

  DECLARE @OranKabul DECIMAL(28, 9) = CASE WHEN @Mal > 0 THEN @KabulMal / @Mal ELSE 1 END;
  DECLARE @KdvKabul DECIMAL(28, 2) = ROUND(@Kdv * @OranKabul, 2);   -- indirilebilir KDV
  DECLARE @KdvKkeg DECIMAL(28, 2) = ROUND(@Kdv - @KdvKabul, 2);     -- indirilemeyen KDV (KKEG)
  IF @KdvKabul < 0 SET @KdvKabul = 0;
  IF @KdvKkeg < 0 SET @KdvKkeg = 0;

  BEGIN TRAN;

  -- Muhasebe fiş referans numarası (HARREFNO modul 4, konu 1).
  UPDATE dbo.HARREFNO WITH (UPDLOCK)
  SET @NextHar = HARREFDEGER = ISNULL(HARREFDEGER, 0) + 1
  WHERE HARREFMODUL = 4 AND HARREFKONU = 1;

  IF @@ROWCOUNT = 0
  BEGIN
    INSERT INTO dbo.HARREFNO (HARREFMODUL, HARREFKONU, HARREFDEGER) VALUES (4, 1, 0);
    SET @NextHar = 1;
    UPDATE dbo.HARREFNO SET HARREFDEGER = 1 WHERE HARREFMODUL = 4 AND HARREFKONU = 1;
  END;

  SET @MuhFisRefNo = @NextHar;
  SET @MaxMuhRef = ISNULL((SELECT MAX(MUHFISREFNO) FROM dbo.MUHFIS WITH (UPDLOCK, HOLDLOCK)), 0);
  IF @MuhFisRefNo <= @MaxMuhRef
  BEGIN
    SET @MuhFisRefNo = @MaxMuhRef + 1;
    UPDATE dbo.HARREFNO SET HARREFDEGER = @MuhFisRefNo WHERE HARREFMODUL = 4 AND HARREFKONU = 1;
  END;

  -- Fiş no, sabit ofsetle değil mevcut MA- dizisinin devamı olarak üretilir:
  -- ofset veritabanına göre değişiyor (canlıda 530292, denemede 530287) ve
  -- sabit kullanıldığında mevcut fiş numaralarıyla çakışıyor.
  SET @NextFisNoInt = ISNULL((
    SELECT MAX(TRY_CAST(SUBSTRING(MUHFISNO, 4, 20) AS INT))
    FROM dbo.MUHFIS WITH (UPDLOCK, HOLDLOCK)
    WHERE MUHFISNO LIKE 'MA-%'
  ), @MuhFisRefNo + 530286) + 1;
  SET @MuhFisNo = 'MA-' + CAST(@NextFisNoInt AS VARCHAR(20));

  INSERT INTO dbo.MUHFIS (
    MUHFISTAR, MUHFISNO, MUHFISCINSI, MUHFISYEVNO, MUHFISREFNO, MUHFISKAYITONC,
    MUHFISBORCTOP, MUHFISALACAKTOP, MUHFISKAYNAK, MUHFISHAZKOD, MUHFISHAZTAR, MUHFISSEVNO, MUHFISBELTUR,
    MUHFISMATATEFLAG
  )
  VALUES (
    @FisTar, @MuhFisNo, 1, 0, @MuhFisRefNo, @MuhKayitOnc,
    @GenTop, @GenTop, 3, @HazKod, GETDATE(), 1, 'FAT', 1
  );

  -- Borç: kabul edilen gider
  IF @KabulMal > 0
  BEGIN
    SET @Sira = @Sira + 1;
    INSERT INTO dbo.MUHHAR (MUHHARTAR, MUHHARREFNO, MUHHARSIRANO, MUHHARMUHKOD, MUHHARTUTAR, MUHHARBATIPI,
      MUHHAREVRAKNO, MUHHARACIKLAMA, MUHHARKAYITONC, MUHHARKAYNAK, MUHHARBELTUR, MUHHARCINSI, MUHHARYEVNO)
    VALUES (@FisTar, @MuhFisRefNo, @Sira, @KabulHesap, @KabulMal, 1,
      @EvrakNo, @LineAciklama, @MuhKayitOnc, 3, 'FAT', 1, 0);
  END;

  -- Borç: KKEG (kabul edilmeyen gider)
  IF @KkegMal > 0
  BEGIN
    SET @Sira = @Sira + 1;
    INSERT INTO dbo.MUHHAR (MUHHARTAR, MUHHARREFNO, MUHHARSIRANO, MUHHARMUHKOD, MUHHARTUTAR, MUHHARBATIPI,
      MUHHAREVRAKNO, MUHHARACIKLAMA, MUHHARKAYITONC, MUHHARKAYNAK, MUHHARBELTUR, MUHHARCINSI, MUHHARYEVNO)
    VALUES (@FisTar, @MuhFisRefNo, @Sira, @KkegHesap, @KkegMal, 1,
      @EvrakNo, @LineAciklama, @MuhKayitOnc, 3, 'FAT', 1, 0);
  END;

  -- Borç: indirilecek KDV
  IF @KdvKabul > 0
  BEGIN
    SET @Sira = @Sira + 1;
    INSERT INTO dbo.MUHHAR (MUHHARTAR, MUHHARREFNO, MUHHARSIRANO, MUHHARMUHKOD, MUHHARTUTAR, MUHHARBATIPI,
      MUHHAREVRAKNO, MUHHARACIKLAMA, MUHHARKAYITONC, MUHHARKAYNAK, MUHHARBELTUR, MUHHARCINSI, MUHHARYEVNO)
    VALUES (@FisTar, @MuhFisRefNo, @Sira, @AccKdvInd, @KdvKabul, 1,
      @EvrakNo, @LineAciklama, @MuhKayitOnc, 3, 'FAT', 1, 0);
  END;

  -- Borç: indirilemeyen KDV (KKEG)
  IF @KdvKkeg > 0
  BEGIN
    SET @Sira = @Sira + 1;
    INSERT INTO dbo.MUHHAR (MUHHARTAR, MUHHARREFNO, MUHHARSIRANO, MUHHARMUHKOD, MUHHARTUTAR, MUHHARBATIPI,
      MUHHAREVRAKNO, MUHHARACIKLAMA, MUHHARKAYITONC, MUHHARKAYNAK, MUHHARBELTUR, MUHHARCINSI, MUHHARYEVNO)
    VALUES (@FisTar, @MuhFisRefNo, @Sira, @IndirilemeyenKdvHesap, @KdvKkeg, 1,
      @EvrakNo, @LineAciklama, @MuhKayitOnc, 3, 'FAT', 1, 0);
  END;

  -- Alacak: cari (mal + toplam KDV = ödenecek)
  SET @Sira = @Sira + 1;
  INSERT INTO dbo.MUHHAR (MUHHARTAR, MUHHARREFNO, MUHHARSIRANO, MUHHARMUHKOD, MUHHARTUTAR, MUHHARBATIPI,
    MUHHAREVRAKNO, MUHHARACIKLAMA, MUHHARKAYITONC, MUHHARKAYNAK, MUHHARBELTUR, MUHHARCINSI, MUHHARYEVNO)
  VALUES (@FisTar, @MuhFisRefNo, @Sira, @CariMuhKod, @GenTop, 2,
    @EvrakNo, @LineAciklama, @MuhKayitOnc, 3, 'FAT', 1, 0);

  -- Fiş toplamlarını gerçek satırlardan güncelle (denge güvencesi).
  DECLARE @SumB DECIMAL(28, 2) = (SELECT ISNULL(SUM(CASE WHEN MUHHARBATIPI = 1 THEN MUHHARTUTAR END), 0)
    FROM dbo.MUHHAR WITH (NOLOCK) WHERE MUHHARREFNO = @MuhFisRefNo);
  DECLARE @SumA DECIMAL(28, 2) = (SELECT ISNULL(SUM(CASE WHEN MUHHARBATIPI = 2 THEN MUHHARTUTAR END), 0)
    FROM dbo.MUHHAR WITH (NOLOCK) WHERE MUHHARREFNO = @MuhFisRefNo);

  UPDATE dbo.MUHFIS
  SET MUHFISBORCTOP = @SumB, MUHFISALACAKTOP = @SumA, MUHFISMATATEFLAG = 1,
      MUHFISEKCHAR2 = @FisTuruEtiket
  WHERE MUHFISREFNO = @MuhFisRefNo;

  -- Evrak tarihi fişin tüm satırlarına tek seferde yazılır (beş ayrı MUHHAR
  -- insert'i var; her birine ayrı eklemek satır atlamaya açık olurdu).
  UPDATE dbo.MUHHAR
  SET MUHHAREVRAKTAR = @FisTar
  WHERE MUHHARREFNO = @MuhFisRefNo;

  UPDATE dbo.FATFIS
  SET FATFISMUHREFNO = @MuhFisRefNo
  WHERE FATFISREFNO = @FatFisRefNo;

  INSERT INTO dbo.SIRKETLOG (
    SIRLOGMODUL, SIRLOGKONU, SIRLOGKYTTIPI, SIRLOGKYTREFNO,
    SIRLOGILKKULKOD, SIRLOGILKTAR, SIRLOGSONKULKOD, SIRLOGSONTAR
  )
  VALUES (4, 2, 3, @MuhFisRefNo, @HazKod, GETDATE(), @HazKod, GETDATE());

  COMMIT;
END;
