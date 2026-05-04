export function formatEtaError(err) {
  const msg = String(err?.message || err || "ETA_SYNC_FAILED");
  const pe = Array.isArray(err?.precedingErrors) ? err.precedingErrors : [];
  const peMsg = pe
    .map((e) => e?.message || e?.originalError?.info?.message || "")
    .filter(Boolean)
    .join(" || ");
  const info = err?.originalError?.info;

  const parts = [
    msg,
    err?.code ? `code=${err.code}` : "",
    err?.number != null ? `number=${err.number}` : "",
    err?.lineNumber != null ? `line=${err.lineNumber}` : "",
    err?.procName ? `proc=${err.procName}` : "",
    err?.serverName ? `server=${err.serverName}` : "",
    err?.originalError?.message ? `orig=${err.originalError.message}` : "",
    info?.message ? `sql=${info.message}` : "",
    info?.number != null ? `sqlNo=${info.number}` : "",
    info?.procName ? `sqlProc=${info.procName}` : "",
    peMsg ? `prev=${peMsg}` : "",
  ].filter(Boolean);
  return parts.join(" | ").slice(0, 4000);
}

