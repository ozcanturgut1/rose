CREATE PROCEDURE dbo.sp_Fatura_Muhasebe_Bagla_Deneme
  @FatFisRefNo INT,
  @MuhFisRefNo INT OUTPUT,
  @RefFatFisRefNo INT = NULL
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

  DECLARE
    @FatTip INT,
    @CariKod VARCHAR(40),
    @CariMuhKod VARCHAR(40),
    @EvrakNo VARCHAR(40),
    @FisTar DATETIME,
    @KdvOran DECIMAL(28, 9),
    @MalTop DECIMAL(28, 9),
    @KdvTop DECIMAL(28, 9),
    @GenTop DECIMAL(28, 9),
    @HazKod VARCHAR(40),
    @CurrentMuhRef INT,
    @LineAciklama VARCHAR(120),
    @StkKod VARCHAR(40),
    @AccMal VARCHAR(40),
    @AccKdv VARCHAR(40),
    @AccCari VARCHAR(40),
    @AccKdvInd VARCHAR(40),
    @AccTev360 VARCHAR(40),
    @isAlisLike BIT,
    @TevFlag BIT,
    @TevOran DECIMAL(28, 9),
    @TevTutar DECIMAL(28, 9),
    @KdvIndirilecek DECIMAL(28, 9),
    @hasTevkifat BIT,
    @DovKod VARCHAR(10),
    @DovKur DECIMAL(28, 9),
    @MuhFisNo VARCHAR(40),
    @MuhKayitOnc INT = 4,
    @MaxMuhRef INT,
    @NextHar INT;

  SELECT
    @FatTip = FATFISTIPI,
    @CariKod = FATFISCARKOD,
    @EvrakNo = FATFISEVRAKNO1,
    @FisTar = FATFISTAR,
    @KdvOran = ISNULL(FATFISKDVORANI, 0),
    @MalTop = ISNULL(FATFISMALTOP, 0),
    @KdvTop = ISNULL(FATFISKDVTUTARI, 0),
    @GenTop = ISNULL(FATFISGENTOPLAM, 0),
    @HazKod = ISNULL(FATFISHAZKOD, ''),
    @CurrentMuhRef = ISNULL(FATFISMUHREFNO, 0),
    @TevFlag = ISNULL(FATFISTEVKIFATFLAG, 0),
    @TevOran = ISNULL(FATFISTEVORAN, 0),
    @TevTutar = ISNULL(FATFISTEVTUTAR, 0),
    @DovKod = UPPER(LTRIM(RTRIM(ISNULL(FATFISDOVKOD, '')))),
    @DovKur = ISNULL(FATFISDOVKUR, 0)
  FROM dbo.FATFIS WITH (UPDLOCK, HOLDLOCK)
  WHERE FATFISREFNO = @FatFisRefNo;

  IF @FatTip IS NULL
    THROW 50001, 'FATFIS bulunamadi.', 1;

  IF @CurrentMuhRef > 0
  BEGIN
    SET @MuhFisRefNo = @CurrentMuhRef;
    RETURN;
  END;

  IF ISNULL(@EvrakNo, '') = ''
    SET @EvrakNo = 'FAT-' + CAST(@FatFisRefNo AS VARCHAR(20));

  SELECT TOP 1
    @LineAciklama = ISNULL(NULLIF(LTRIM(RTRIM(FATHARACIKLAMA)), ''), ISNULL(NULLIF(LTRIM(RTRIM(FATHARSTKCINS)), ''), @EvrakNo)),
    @StkKod = NULLIF(LTRIM(RTRIM(FATHARSTKKOD)), '')
  FROM dbo.FATHAR WITH (NOLOCK)
  WHERE FATHARREFNO = @FatFisRefNo
  ORDER BY FATHARSIRANO;

  IF @LineAciklama IS NULL
    SET @LineAciklama = @EvrakNo;

  SELECT TOP 1
    @CariMuhKod = COALESCE(NULLIF(LTRIM(RTRIM(CAREKCHAR1)), ''), NULLIF(LTRIM(RTRIM(CARMUHKODU)), ''))
  FROM dbo.CARKART WITH (NOLOCK)
  WHERE CARKOD = @CariKod;

  IF @CariMuhKod IS NULL
    THROW 50002, 'CARKART.CARMUHKODU bos. Cari muhasebe kodu zorunlu.', 1;

  IF ISNULL(LTRIM(RTRIM(@HazKod)), '') = ''
    SET @HazKod = 'YMM';

  SET @AccCari = @CariMuhKod;

  SET @hasTevkifat = CASE
    WHEN @TevFlag = 1 OR @TevTutar > 0 OR @TevOran > 0 THEN 1
    ELSE 0
  END;

  /* Matrahtan KDV; KDV × tevkifat oranı = 360 (sorumlu); kalan = 191 (indirilecek) */
  IF @hasTevkifat = 1
  BEGIN
    DECLARE @KdvFrac DECIMAL(28, 9) = CASE
      WHEN @KdvOran <= 0 THEN 0
      WHEN @KdvOran <= 1 THEN @KdvOran
      ELSE @KdvOran / 100.0
    END;
    DECLARE @TevFrac DECIMAL(28, 9) = CASE
      WHEN @TevOran <= 0 THEN 0
      WHEN @TevOran <= 1 THEN @TevOran
      ELSE @TevOran / 100.0
    END;

    IF @MalTop > 0 AND @KdvFrac > 0
      SET @KdvTop = ROUND(@MalTop * @KdvFrac, 2);

    IF @KdvTop > 0 AND @TevFrac > 0
      SET @TevTutar = ROUND(@KdvTop * @TevFrac, 2);
    ELSE
      SET @TevTutar = 0;

    SET @KdvIndirilecek = ROUND(@KdvTop - @TevTutar, 2);
    IF @KdvIndirilecek < 0
      SET @KdvIndirilecek = 0;

    SET @GenTop = ROUND(@MalTop + @KdvIndirilecek, 2);
  END;

  SET @isAlisLike = CASE WHEN @FatTip IN (1, 8, 9, 11) THEN 1 ELSE 0 END;

  /* --- Referans fatura: tevkifatlı ise hesap kodları korunur, tutarlar KDV bölünmesine göre yazılır --- */
  IF @RefFatFisRefNo IS NOT NULL AND @RefFatFisRefNo > 0
  BEGIN
    DECLARE @RefMuh INT = (
      SELECT TOP 1 ISNULL(FATFISMUHREFNO, 0)
      FROM ETA_TEKNIKFILAMENT_2026.dbo.FATFIS WITH (NOLOCK)
      WHERE FATFISREFNO = @RefFatFisRefNo
    );

    IF @RefMuh > 0
      AND EXISTS (
        SELECT 1
        FROM ETA_TEKNIKFILAMENT_2026.dbo.MUHHAR WITH (NOLOCK)
        WHERE MUHHARREFNO = @RefMuh
      )
    BEGIN
      BEGIN TRAN;

      UPDATE dbo.HARREFNO WITH (UPDLOCK)
      SET @NextHar = HARREFDEGER = ISNULL(HARREFDEGER, 0) + 1
      WHERE HARREFMODUL = 4 AND HARREFKONU = 1;

      IF @@ROWCOUNT = 0
      BEGIN
        INSERT INTO dbo.HARREFNO (HARREFMODUL, HARREFKONU, HARREFDEGER)
        VALUES (4, 1, 0);
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

      SET @MuhFisNo = 'MA-' + CAST(@MuhFisRefNo + 530287 AS VARCHAR(20));

      INSERT INTO dbo.MUHFIS (
        MUHFISTAR, MUHFISNO, MUHFISCINSI, MUHFISYEVNO, MUHFISREFNO, MUHFISKAYITONC,
        MUHFISBORCTOP, MUHFISALACAKTOP, MUHFISKAYNAK, MUHFISHAZKOD, MUHFISHAZTAR, MUHFISSEVNO, MUHFISBELTUR
      )
      VALUES (@FisTar, @MuhFisNo, 1, 0, @MuhFisRefNo, @MuhKayitOnc, 0, 0, 3, @HazKod, GETDATE(), 1, 'FAT');

      IF OBJECT_ID('tempdb..#ref') IS NOT NULL
        DROP TABLE #ref;

      SELECT
        ROW_NUMBER() OVER (ORDER BY MUHHARSIRANO) AS rn,
        MUHHARMUHKOD AS acc,
        MUHHARBATIPI AS bat,
        CAST(MUHHARTUTAR AS DECIMAL(28, 9)) AS amt,
        CAST(NULL AS VARCHAR(20)) AS role
      INTO #ref
      FROM ETA_TEKNIKFILAMENT_2026.dbo.MUHHAR WITH (NOLOCK)
      WHERE MUHHARREFNO = @RefMuh;

      IF @hasTevkifat = 1 AND @isAlisLike = 1
      BEGIN
        UPDATE #ref
        SET role = CASE
          WHEN acc LIKE '191 108%' THEN 'KDV_IND'
          WHEN acc LIKE '191 109%' THEN 'TEV191'
          WHEN acc LIKE '360%' THEN 'TEV360'
          WHEN bat = 2 AND (acc LIKE '320%' OR acc = @AccCari) THEN 'CARI'
          WHEN bat = 1 AND acc NOT LIKE '191%' AND acc NOT LIKE '360%' THEN 'MAL'
          ELSE 'OTHER'
        END;

        DECLARE @refMalSum DECIMAL(28, 9) = (
          SELECT ISNULL(SUM(amt), 0) FROM #ref WHERE role = 'MAL'
        );

        IF @refMalSum > 0 AND @MalTop > 0
        BEGIN
          UPDATE #ref
          SET amt = ROUND(amt * @MalTop / @refMalSum, 2)
          WHERE role = 'MAL';

          DECLARE @malFix DECIMAL(28, 9) = (
            SELECT ISNULL(SUM(amt), 0) FROM #ref WHERE role = 'MAL'
          );
          IF @malFix <> @MalTop
            UPDATE #ref
            SET amt = amt + (@MalTop - @malFix)
            WHERE rn = (SELECT MAX(rn) FROM #ref WHERE role = 'MAL');
        END;

        IF EXISTS (SELECT 1 FROM #ref WHERE role = 'KDV_IND')
          UPDATE #ref SET amt = @KdvIndirilecek, bat = 1 WHERE role = 'KDV_IND';

        IF EXISTS (SELECT 1 FROM #ref WHERE role = 'TEV191')
          UPDATE #ref SET amt = @TevTutar, bat = 1 WHERE role = 'TEV191';

        IF EXISTS (SELECT 1 FROM #ref WHERE role = 'TEV360')
          UPDATE #ref SET amt = @TevTutar, bat = 2 WHERE role = 'TEV360';

        IF EXISTS (SELECT 1 FROM #ref WHERE role = 'CARI')
          UPDATE #ref SET amt = @GenTop, bat = 2 WHERE role = 'CARI';

        SELECT TOP 1 @AccKdvInd = acc FROM #ref WHERE role = 'KDV_IND';
        SELECT TOP 1 @AccTev360 = acc FROM #ref WHERE role = 'TEV360';

        IF @AccKdvInd IS NULL
          SET @AccKdvInd = '191 108 10';
        IF @AccTev360 IS NULL
          SET @AccTev360 = '360 01 02';

        IF NOT EXISTS (SELECT 1 FROM #ref WHERE role = 'KDV_IND' AND @KdvIndirilecek > 0)
          INSERT INTO #ref (rn, acc, bat, amt, role)
          VALUES (
            (SELECT ISNULL(MAX(rn), 0) + 1 FROM #ref),
            @AccKdvInd, 1, @KdvIndirilecek, 'KDV_IND'
          );

        IF NOT EXISTS (SELECT 1 FROM #ref WHERE role = 'TEV191' AND @TevTutar > 0)
          INSERT INTO #ref (rn, acc, bat, amt, role)
          VALUES (
            (SELECT ISNULL(MAX(rn), 0) + 1 FROM #ref),
            '191 109 10', 1, @TevTutar, 'TEV191'
          );

        IF NOT EXISTS (SELECT 1 FROM #ref WHERE role = 'TEV360' AND @TevTutar > 0)
          INSERT INTO #ref (rn, acc, bat, amt, role)
          VALUES (
            (SELECT ISNULL(MAX(rn), 0) + 1 FROM #ref),
            @AccTev360, 2, @TevTutar, 'TEV360'
          );

        IF NOT EXISTS (SELECT 1 FROM #ref WHERE role = 'CARI')
          INSERT INTO #ref (rn, acc, bat, amt, role)
          VALUES (
            (SELECT ISNULL(MAX(rn), 0) + 1 FROM #ref),
            @AccCari, 2, @GenTop, 'CARI'
          );

        ;WITH ordered AS (
          SELECT rn, ROW_NUMBER() OVER (ORDER BY rn) AS newRn
          FROM #ref
          WHERE role <> 'OTHER' OR amt > 0
        )
        UPDATE r
        SET rn = o.newRn
        FROM #ref r
        INNER JOIN ordered o ON o.rn = r.rn;

        DELETE FROM #ref WHERE role = 'OTHER';

        IF OBJECT_ID('tempdb..#merged') IS NOT NULL
          DROP TABLE #merged;

        SELECT
          ROW_NUMBER() OVER (ORDER BY MIN(rn), acc, bat) AS rn,
          acc,
          bat,
          ROUND(SUM(amt), 2) AS amt
        INTO #merged
        FROM #ref
        WHERE amt <> 0
        GROUP BY acc, bat;

        INSERT INTO dbo.MUHHAR (
          MUHHARTAR, MUHHARREFNO, MUHHARSIRANO, MUHHARMUHKOD, MUHHARTUTAR, MUHHARBATIPI,
          MUHHAREVRAKNO, MUHHARACIKLAMA, MUHHARKAYITONC, MUHHARKAYNAK, MUHHARBELTUR, MUHHARCINSI, MUHHARYEVNO
        )
        SELECT
          @FisTar, @MuhFisRefNo, m.rn, m.acc, m.amt, m.bat,
          @EvrakNo, @LineAciklama, @MuhKayitOnc, 3, 'FAT', 1, 0
        FROM #merged m
        ORDER BY m.rn;
      END
      ELSE
      BEGIN
        /* Tevkifatsız: önceki orantılı kopyalama */
        DECLARE @refB DECIMAL(28, 9) = (SELECT ISNULL(SUM(CASE WHEN bat = 1 THEN amt END), 0) FROM #ref);
        DECLARE @refA DECIMAL(28, 9) = (SELECT ISNULL(SUM(CASE WHEN bat = 2 THEN amt END), 0) FROM #ref);
        DECLARE @targetSide DECIMAL(28, 9) = @MalTop + @KdvTop;

        IF @refB > 0 AND @refA > 0 AND @targetSide > 0
        BEGIN
          DECLARE @factorB DECIMAL(28, 12) = @targetSide / @refB;
          DECLARE @factorA DECIMAL(28, 12) = @targetSide / @refA;

          UPDATE #ref
          SET amt = ROUND(amt * (CASE WHEN bat = 1 THEN @factorB ELSE @factorA END), 2);

          DECLARE @sumB DECIMAL(28, 9) = (SELECT ISNULL(SUM(CASE WHEN bat = 1 THEN amt END), 0) FROM #ref);
          DECLARE @sumA DECIMAL(28, 9) = (SELECT ISNULL(SUM(CASE WHEN bat = 2 THEN amt END), 0) FROM #ref);

          IF @sumB <> @targetSide
            UPDATE #ref
            SET amt = amt + (@targetSide - @sumB)
            WHERE rn = (SELECT MAX(rn) FROM #ref WHERE bat = 1);

          IF @sumA <> @targetSide
            UPDATE #ref
            SET amt = amt + (@targetSide - @sumA)
            WHERE rn = (SELECT MAX(rn) FROM #ref WHERE bat = 2);

          IF OBJECT_ID('tempdb..#mergedNt') IS NOT NULL
            DROP TABLE #mergedNt;

          SELECT
            ROW_NUMBER() OVER (ORDER BY MIN(rn), acc, bat) AS rn,
            acc,
            bat,
            ROUND(SUM(amt), 2) AS amt
          INTO #mergedNt
          FROM #ref
          WHERE amt <> 0
          GROUP BY acc, bat;

          INSERT INTO dbo.MUHHAR (
            MUHHARTAR, MUHHARREFNO, MUHHARSIRANO, MUHHARMUHKOD, MUHHARTUTAR, MUHHARBATIPI,
            MUHHAREVRAKNO, MUHHARACIKLAMA, MUHHARKAYITONC, MUHHARKAYNAK, MUHHARBELTUR, MUHHARCINSI, MUHHARYEVNO
          )
          SELECT
            @FisTar, @MuhFisRefNo, m.rn, m.acc, m.amt, m.bat,
            @EvrakNo, @LineAciklama, @MuhKayitOnc, 3, 'FAT', 1, 0
          FROM #mergedNt m
          ORDER BY m.rn;
        END
        ELSE
        BEGIN
          ROLLBACK;
          THROW 50003, 'Referans muhasebe satirlari olceklendirilemedi.', 1;
        END;
      END;

      DECLARE @sumBf DECIMAL(28, 9) = (
        SELECT ISNULL(SUM(CASE WHEN MUHHARBATIPI = 1 THEN MUHHARTUTAR END), 0)
        FROM dbo.MUHHAR WITH (NOLOCK)
        WHERE MUHHARREFNO = @MuhFisRefNo
      );
      DECLARE @sumAf DECIMAL(28, 9) = (
        SELECT ISNULL(SUM(CASE WHEN MUHHARBATIPI = 2 THEN MUHHARTUTAR END), 0)
        FROM dbo.MUHHAR WITH (NOLOCK)
        WHERE MUHHARREFNO = @MuhFisRefNo
      );

      UPDATE dbo.MUHFIS
      SET MUHFISBORCTOP = @sumBf, MUHFISALACAKTOP = @sumAf
      WHERE MUHFISREFNO = @MuhFisRefNo;

      UPDATE dbo.FATFIS
      SET FATFISMUHREFNO = @MuhFisRefNo
      WHERE FATFISREFNO = @FatFisRefNo;

      INSERT INTO dbo.SIRKETLOG (
        SIRLOGMODUL, SIRLOGKONU, SIRLOGKYTTIPI, SIRLOGKYTREFNO,
        SIRLOGILKKULKOD, SIRLOGILKTAR, SIRLOGSONKULKOD, SIRLOGSONTAR
      )
      VALUES (4, 2, 3, @MuhFisRefNo, @HazKod, GETDATE(), @HazKod, GETDATE());

      COMMIT;
      RETURN;
    END;
  END;

  /* --- Hesap kodları (referanssız) --- */
  SELECT TOP 1 @AccMal = NULLIF(LTRIM(RTRIM(B.SMBMUHKOD1)), '')
  FROM dbo.STKMUHBAGLANTI B WITH (NOLOCK)
  WHERE B.SMBSTKKOD = @StkKod
    AND ISNULL(NULLIF(LTRIM(RTRIM(B.SMBMUHKOD1)), ''), '') <> ''
  ORDER BY CASE WHEN B.SMBITEMNO = 1 THEN 0 WHEN B.SMBITEMNO = 2 THEN 1 ELSE 9 END, B.SMBITEMNO;

  IF @AccMal IS NULL
    SELECT TOP 1 @AccMal = NULLIF(LTRIM(RTRIM(FMGMUHKOD1)), '')
    FROM dbo.FATMUHGRUP WITH (NOLOCK)
    WHERE FMGGRUPKOD = 'FATMUHGRP' AND FMGISLEMNO IN (61, 59)
    ORDER BY CASE WHEN FMGISLEMNO = 61 THEN 0 ELSE 1 END;

  SELECT TOP 1 @AccKdv = NULLIF(LTRIM(RTRIM(FMGMUHKOD1)), '')
  FROM dbo.FATMUHGRUP WITH (NOLOCK)
  WHERE FMGGRUPKOD = 'FATMUHGRP' AND FMGISLEMNO = 55
  ORDER BY ABS(ISNULL(FMGKDVORAN, 0) - ISNULL(@KdvOran, 0));

  SET @AccKdvInd = '191 108 10';
  SET @AccTev360 = '360 01 02';

  IF @AccMal IS NULL
    SET @AccMal = '153';
  IF @AccKdv IS NULL
    SET @AccKdv = '191';

  BEGIN TRAN;

  UPDATE dbo.HARREFNO WITH (UPDLOCK)
  SET @NextHar = HARREFDEGER = ISNULL(HARREFDEGER, 0) + 1
  WHERE HARREFMODUL = 4 AND HARREFKONU = 1;

  IF @@ROWCOUNT = 0
  BEGIN
    INSERT INTO dbo.HARREFNO (HARREFMODUL, HARREFKONU, HARREFDEGER)
    VALUES (4, 1, 0);
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

  SET @MuhFisNo = 'MA-' + CAST(@MuhFisRefNo + 530287 AS VARCHAR(20));

  INSERT INTO dbo.MUHFIS (
    MUHFISTAR, MUHFISNO, MUHFISCINSI, MUHFISYEVNO, MUHFISREFNO, MUHFISKAYITONC,
    MUHFISBORCTOP, MUHFISALACAKTOP, MUHFISKAYNAK, MUHFISHAZKOD, MUHFISHAZTAR, MUHFISSEVNO, MUHFISBELTUR
  )
  VALUES (
    @FisTar, @MuhFisNo, 1, 0, @MuhFisRefNo, @MuhKayitOnc,
    CASE
      WHEN @isAlisLike = 1 THEN @MalTop + CASE WHEN @hasTevkifat = 1 THEN @KdvIndirilecek ELSE @KdvTop END
      ELSE 0
    END,
    CASE
      WHEN @isAlisLike = 1 THEN @GenTop + CASE WHEN @hasTevkifat = 1 THEN @TevTutar ELSE 0 END
      ELSE @GenTop
    END,
    3, @HazKod, GETDATE(), 1, 'FAT'
  );

  IF @isAlisLike = 1
  BEGIN
    IF @hasTevkifat = 1
    BEGIN
      DECLARE @AccTev191 VARCHAR(40) = '191 109 10';
      INSERT INTO dbo.MUHHAR (
        MUHHARTAR, MUHHARREFNO, MUHHARSIRANO, MUHHARMUHKOD, MUHHARTUTAR, MUHHARBATIPI,
        MUHHAREVRAKNO, MUHHARACIKLAMA, MUHHARKAYITONC, MUHHARKAYNAK, MUHHARBELTUR, MUHHARCINSI, MUHHARYEVNO
      )
      VALUES
        (@FisTar, @MuhFisRefNo, 1, @AccMal, @MalTop, 1, @EvrakNo, @LineAciklama, @MuhKayitOnc, 3, 'FAT', 1, 0),
        (@FisTar, @MuhFisRefNo, 2, @AccKdvInd, @KdvIndirilecek, 1, @EvrakNo, @LineAciklama, @MuhKayitOnc, 3, 'FAT', 1, 0),
        (@FisTar, @MuhFisRefNo, 3, @AccTev191, @TevTutar, 1, @EvrakNo, @LineAciklama, @MuhKayitOnc, 3, 'FAT', 1, 0),
        (@FisTar, @MuhFisRefNo, 4, @AccCari, @GenTop, 2, @EvrakNo, @LineAciklama, @MuhKayitOnc, 3, 'FAT', 1, 0),
        (@FisTar, @MuhFisRefNo, 5, @AccTev360, @TevTutar, 2, @EvrakNo, @LineAciklama, @MuhKayitOnc, 3, 'FAT', 1, 0);
    END
    ELSE
    BEGIN
      INSERT INTO dbo.MUHHAR (
        MUHHARTAR, MUHHARREFNO, MUHHARSIRANO, MUHHARMUHKOD, MUHHARTUTAR, MUHHARBATIPI,
        MUHHAREVRAKNO, MUHHARACIKLAMA, MUHHARKAYITONC, MUHHARKAYNAK, MUHHARBELTUR, MUHHARCINSI, MUHHARYEVNO
      )
      VALUES
        (@FisTar, @MuhFisRefNo, 1, @AccMal, @MalTop, 1, @EvrakNo, @LineAciklama, @MuhKayitOnc, 3, 'FAT', 1, 0),
        (@FisTar, @MuhFisRefNo, 2, @AccKdv, @KdvTop, 1, @EvrakNo, @LineAciklama, @MuhKayitOnc, 3, 'FAT', 1, 0),
        (@FisTar, @MuhFisRefNo, 3, @AccCari, @GenTop, 2, @EvrakNo, @LineAciklama, @MuhKayitOnc, 3, 'FAT', 1, 0);
    END;
  END
  ELSE
  BEGIN
    INSERT INTO dbo.MUHHAR (
      MUHHARTAR, MUHHARREFNO, MUHHARSIRANO, MUHHARMUHKOD, MUHHARTUTAR, MUHHARBATIPI,
      MUHHAREVRAKNO, MUHHARACIKLAMA, MUHHARKAYITONC, MUHHARKAYNAK, MUHHARBELTUR, MUHHARCINSI, MUHHARYEVNO
    )
    VALUES
      (@FisTar, @MuhFisRefNo, 1, @AccCari, @GenTop, 1, @EvrakNo, @LineAciklama, @MuhKayitOnc, 3, 'FAT', 1, 0),
      (@FisTar, @MuhFisRefNo, 2, @AccMal, @MalTop, 2, @EvrakNo, @LineAciklama, @MuhKayitOnc, 3, 'FAT', 1, 0),
      (@FisTar, @MuhFisRefNo, 3, @AccKdv, @KdvTop, 2, @EvrakNo, @LineAciklama, @MuhKayitOnc, 3, 'FAT', 1, 0);
  END;

  DECLARE @sumBf2 DECIMAL(28, 9) = (
    SELECT ISNULL(SUM(CASE WHEN MUHHARBATIPI = 1 THEN MUHHARTUTAR END), 0)
    FROM dbo.MUHHAR WITH (NOLOCK)
    WHERE MUHHARREFNO = @MuhFisRefNo
  );
  DECLARE @sumAf2 DECIMAL(28, 9) = (
    SELECT ISNULL(SUM(CASE WHEN MUHHARBATIPI = 2 THEN MUHHARTUTAR END), 0)
    FROM dbo.MUHHAR WITH (NOLOCK)
    WHERE MUHHARREFNO = @MuhFisRefNo
  );

  UPDATE dbo.MUHFIS
  SET MUHFISBORCTOP = @sumBf2, MUHFISALACAKTOP = @sumAf2
  WHERE MUHFISREFNO = @MuhFisRefNo;

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
