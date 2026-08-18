CREATE PROCEDURE dbo.sp_Fatura_YanEtki_Kayit
  @FatFisRefNo INT,
  @ApplyMuhMizan BIT = 1,
  @ApplyStkMizan BIT = 1,
  @ApplyHarrefno BIT = 1
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

  IF @FatFisRefNo IS NULL OR @FatFisRefNo <= 0
    THROW 52001, 'sp_Fatura_YanEtki_Kayit: FatFisRefNo gecersiz.', 1;

  DECLARE
    @FisTar DATETIME,
    @MuhRef INT,
    @StkRef INT,
    @Yil INT,
    @Ay INT,
    @StkIade BIT = 0,
    @Bos VARCHAR(40) = ' ';

  SELECT
    @FisTar = F.FATFISTAR,
    @MuhRef = ISNULL(F.FATFISMUHREFNO, 0),
    @StkRef = ISNULL(F.FATFISSTKREFNO, 0)
  FROM dbo.FATFIS F WITH (UPDLOCK, HOLDLOCK)
  WHERE F.FATFISREFNO = @FatFisRefNo;

  IF @FisTar IS NULL
    THROW 52002, 'sp_Fatura_YanEtki_Kayit: FATFIS bulunamadi.', 1;

  SET @Yil = YEAR(@FisTar);
  SET @Ay = MONTH(@FisTar);

  IF @StkRef > 0
    SELECT @StkIade = CASE WHEN ISNULL(STKFISIADE, 0) = 1 THEN 1 ELSE 0 END
    FROM dbo.STKFIS WITH (NOLOCK)
    WHERE STKFISREFNO = @StkRef;

  BEGIN TRAN;

  IF @ApplyMuhMizan = 1 AND @MuhRef > 0
  BEGIN
    DECLARE
      @MuhKod VARCHAR(40),
      @MuhWalk VARCHAR(40),
      @MuhBorc DECIMAL(28, 9),
      @MuhAlacak DECIMAL(28, 9),
      @Sp INT;

    DECLARE curMuh CURSOR LOCAL FAST_FORWARD FOR
      SELECT
        NULLIF(LTRIM(RTRIM(MUHHARMUHKOD)), ''),
        CASE WHEN MUHHARBATIPI = 1 THEN ISNULL(MUHHARTUTAR, 0) ELSE 0 END,
        CASE WHEN MUHHARBATIPI = 2 THEN ISNULL(MUHHARTUTAR, 0) ELSE 0 END
      FROM dbo.MUHHAR WITH (NOLOCK)
      WHERE MUHHARREFNO = @MuhRef
        AND ISNULL(MUHHARTUTAR, 0) <> 0
        AND NULLIF(LTRIM(RTRIM(MUHHARMUHKOD)), '') IS NOT NULL;

    OPEN curMuh;
    FETCH NEXT FROM curMuh INTO @MuhKod, @MuhBorc, @MuhAlacak;
    WHILE @@FETCH_STATUS = 0
    BEGIN
      SET @MuhWalk = @MuhKod;
      WHILE @MuhWalk IS NOT NULL AND LEN(@MuhWalk) > 0
      BEGIN
        UPDATE dbo.MUHMIZDEGER
        SET
          MUHBORC = ISNULL(MUHBORC, 0) + @MuhBorc,
          MUHALACAK = ISNULL(MUHALACAK, 0) + @MuhAlacak
        WHERE MUHKOD = @MuhWalk
          AND MUHYIL = @Yil
          AND MUHAY = @Ay
          AND MUHRAKTIP = 1
          AND MUHDOVKOD = @Bos;

        IF @@ROWCOUNT = 0
          INSERT INTO dbo.MUHMIZDEGER (
            MUHKOD, MUHYIL, MUHAY, MUHRAKTIP, MUHDOVKOD, MUHBORC, MUHALACAK
          )
          VALUES (
            @MuhWalk, @Yil, @Ay, 1, @Bos, @MuhBorc, @MuhAlacak
          );

        IF CHARINDEX(' ', @MuhWalk) = 0
          BREAK;
        SET @Sp = LEN(@MuhWalk) - CHARINDEX(' ', REVERSE(@MuhWalk));
        IF @Sp <= 0
          BREAK;
        SET @MuhWalk = RTRIM(LEFT(@MuhWalk, @Sp));
      END;

      FETCH NEXT FROM curMuh INTO @MuhKod, @MuhBorc, @MuhAlacak;
    END;
    CLOSE curMuh;
    DEALLOCATE curMuh;
  END;

  IF @ApplyStkMizan = 1 AND @StkRef > 0
  BEGIN
    DECLARE
      @StkKod VARCHAR(40),
      @StkMiktar DECIMAL(28, 9),
      @StkTutar DECIMAL(28, 9),
      @StkBorc1 DECIMAL(28, 9),
      @StkAlacak1 DECIMAL(28, 9),
      @StkBorc6 DECIMAL(28, 9),
      @StkAlacak6 DECIMAL(28, 9),
      @StkBorc8 DECIMAL(28, 9),
      @StkAlacak8 DECIMAL(28, 9);

    DECLARE curStk CURSOR LOCAL FAST_FORWARD FOR
      SELECT
        NULLIF(LTRIM(RTRIM(STKHARSTKKOD)), ''),
        ISNULL(STKHARMIKTAR, 0),
        ISNULL(STKHARTUTAR, ISNULL(STKHARNETTUTAR, 0))
      FROM dbo.STKHAR WITH (NOLOCK)
      WHERE STKHARREFNO = @StkRef
        AND NULLIF(LTRIM(RTRIM(STKHARSTKKOD)), '') IS NOT NULL;

    OPEN curStk;
    FETCH NEXT FROM curStk INTO @StkKod, @StkMiktar, @StkTutar;
    WHILE @@FETCH_STATUS = 0
    BEGIN
      IF @StkIade = 1
      BEGIN
        SET @StkBorc1 = 0; SET @StkAlacak1 = @StkMiktar;
        SET @StkBorc6 = 0; SET @StkAlacak6 = @StkTutar;
        SET @StkBorc8 = 0; SET @StkAlacak8 = 1;
      END
      ELSE
      BEGIN
        SET @StkBorc1 = @StkMiktar; SET @StkAlacak1 = 0;
        SET @StkBorc6 = @StkTutar; SET @StkAlacak6 = 0;
        SET @StkBorc8 = 1; SET @StkAlacak8 = 0;
      END;

      -- STKRAKTIP 1 = miktar, 6 = tutar, 8 = belge adedi (ETA arayüz izi)
      UPDATE dbo.STKMIZDEGER
      SET STKBORC = ISNULL(STKBORC, 0) + @StkBorc1, STKALACAK = ISNULL(STKALACAK, 0) + @StkAlacak1
      WHERE STKKOD = @StkKod AND STKYIL = @Yil AND STKAY = @Ay AND STKRAKTIP = 1
        AND STKDOVKOD = @Bos AND STKDEPO = @Bos;
      IF @@ROWCOUNT = 0
        INSERT INTO dbo.STKMIZDEGER (STKKOD, STKYIL, STKAY, STKRAKTIP, STKDOVKOD, STKBORC, STKALACAK, STKDEPO)
        VALUES (@StkKod, @Yil, @Ay, 1, @Bos, @StkBorc1, @StkAlacak1, @Bos);

      UPDATE dbo.STKMIZDEGER
      SET STKBORC = ISNULL(STKBORC, 0) + @StkBorc6, STKALACAK = ISNULL(STKALACAK, 0) + @StkAlacak6
      WHERE STKKOD = @StkKod AND STKYIL = @Yil AND STKAY = @Ay AND STKRAKTIP = 6
        AND STKDOVKOD = @Bos AND STKDEPO = @Bos;
      IF @@ROWCOUNT = 0
        INSERT INTO dbo.STKMIZDEGER (STKKOD, STKYIL, STKAY, STKRAKTIP, STKDOVKOD, STKBORC, STKALACAK, STKDEPO)
        VALUES (@StkKod, @Yil, @Ay, 6, @Bos, @StkBorc6, @StkAlacak6, @Bos);

      UPDATE dbo.STKMIZDEGER
      SET STKBORC = ISNULL(STKBORC, 0) + @StkBorc8, STKALACAK = ISNULL(STKALACAK, 0) + @StkAlacak8
      WHERE STKKOD = @StkKod AND STKYIL = @Yil AND STKAY = @Ay AND STKRAKTIP = 8
        AND STKDOVKOD = @Bos AND STKDEPO = @Bos;
      IF @@ROWCOUNT = 0
        INSERT INTO dbo.STKMIZDEGER (STKKOD, STKYIL, STKAY, STKRAKTIP, STKDOVKOD, STKBORC, STKALACAK, STKDEPO)
        VALUES (@StkKod, @Yil, @Ay, 8, @Bos, @StkBorc8, @StkAlacak8, @Bos);

      FETCH NEXT FROM curStk INTO @StkKod, @StkMiktar, @StkTutar;
    END;
    CLOSE curStk;
    DEALLOCATE curStk;
  END;

  IF @ApplyHarrefno = 1
  BEGIN
    DECLARE @Modul INT, @NextDeger INT;

    DECLARE curHar CURSOR LOCAL FAST_FORWARD FOR
      SELECT 3, ISNULL((SELECT MAX(FATFISREFNO) FROM dbo.FATFIS WITH (UPDLOCK, HOLDLOCK)), 0) + 1
      UNION ALL
      SELECT 1, ISNULL((SELECT MAX(STKFISREFNO) FROM dbo.STKFIS WITH (UPDLOCK, HOLDLOCK)), 0) + 1
      UNION ALL
      SELECT 2, ISNULL((SELECT MAX(CARFISREFNO) FROM dbo.CARFIS WITH (UPDLOCK, HOLDLOCK)), 0) + 1
      UNION ALL
      SELECT 4, ISNULL((SELECT MAX(MUHFISREFNO) FROM dbo.MUHFIS WITH (UPDLOCK, HOLDLOCK)), 0) + 1;

    OPEN curHar;
    FETCH NEXT FROM curHar INTO @Modul, @NextDeger;
    WHILE @@FETCH_STATUS = 0
    BEGIN
      UPDATE dbo.HARREFNO WITH (UPDLOCK)
      SET HARREFDEGER = CASE
        WHEN ISNULL(HARREFDEGER, 0) < @NextDeger THEN @NextDeger
        ELSE HARREFDEGER
      END
      WHERE HARREFMODUL = @Modul AND HARREFKONU = 1;

      IF @@ROWCOUNT = 0
        INSERT INTO dbo.HARREFNO (HARREFMODUL, HARREFKONU, HARREFDEGER)
        VALUES (@Modul, 1, @NextDeger);

      FETCH NEXT FROM curHar INTO @Modul, @NextDeger;
    END;
    CLOSE curHar;
    DEALLOCATE curHar;
  END;

  COMMIT;
END;
