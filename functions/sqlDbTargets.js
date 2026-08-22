function pickEnv(key, fallback = "") {
  const v = process.env[key];
  return v == null ? fallback : String(v).trim();
}

export function resolveSqlTargets() {
  const host = pickEnv("DB_HOST");
  const portRaw = pickEnv("DB_PORT", "1433");
  const user = pickEnv("DB_USER");
  const password = pickEnv("DB_PASSWORD");
  const dbType = pickEnv("DB_TYPE", "MSSQL").toLowerCase();
  const readDb = pickEnv("DB_READ_NAME", "ETA_TEKNIKFILAMENT_2026");
  const writeDb = pickEnv("DB_WRITE_NAME", "ETA_DENEME_2026");

  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("Invalid DB_PORT. Expected positive number.");
  }
  if (!host || !user || !password) {
    throw new Error("Missing SQL connection env values (DB_HOST/DB_USER/DB_PASSWORD).");
  }
  if (!readDb || !writeDb) {
    throw new Error("Missing DB_READ_NAME or DB_WRITE_NAME.");
  }
  // Deneme kurulumunda okuma (canlı referans) ve yazma (deneme) DB'leri farklıdır ve
  // yanlışlıkla aynı verilmesi kazara canlıya yazmak demektir. Production'da ise tek
  // canlı DB doğru topoloji; bu yüzden eşitliğe yalnızca açık onayla izin verilir.
  const allowSameDb = pickEnv("ETA_ALLOW_SAME_DB") === "1";
  if (readDb.toLowerCase() === writeDb.toLowerCase() && !allowSameDb) {
    throw new Error(
      "DB_READ_NAME and DB_WRITE_NAME must be different. " +
        "Tek canlı DB kullanılacaksa ETA_ALLOW_SAME_DB=1 verin."
    );
  }

  return {
    dbType,
    host,
    port,
    user,
    password,
    readDb,
    writeDb,
  };
}

