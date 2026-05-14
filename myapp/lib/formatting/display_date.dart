/// Arayüzde tarih gösterimi: `dd.MM.yyyy` (Türkiye); ayrıştırılamazsa kısaltılmış metin veya [empty].
String formatTurkishDate(dynamic raw, {String empty = '—'}) {
  final parsed = tryParseFlexibleDate(raw);
  if (parsed != null) {
    return _formatDmyMaybeTime(parsed);
  }
  final s = raw?.toString().trim() ?? '';
  return s.isEmpty ? empty : s;
}

DateTime? tryParseFlexibleDate(dynamic raw) {
  if (raw == null) return null;
  if (raw is DateTime) return raw;
  if (raw is int) {
    final v = raw.abs();
    if (v > 1000000000000) return DateTime.fromMillisecondsSinceEpoch(raw);
    if (v > 1000000000 && v < 100000000000) {
      return DateTime.fromMillisecondsSinceEpoch(raw * 1000);
    }
    return null;
  }
  if (raw is String) {
    final t = raw.trim();
    if (t.isEmpty) return null;
    if (t.length == 8 && RegExp(r'^\d{8}$').hasMatch(t)) {
      final y = int.tryParse(t.substring(0, 4));
      final m = int.tryParse(t.substring(4, 6));
      final d = int.tryParse(t.substring(6, 8));
      if (y != null && m != null && d != null) return DateTime(y, m, d);
    }
    final ymd = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(t);
    if (ymd != null) {
      final y = int.tryParse(ymd.group(1)!);
      final mo = int.tryParse(ymd.group(2)!);
      final d = int.tryParse(ymd.group(3)!);
      if (y != null && mo != null && d != null) return DateTime(y, mo, d);
    }
    final dmy = RegExp(r'^(\d{2})\.(\d{2})\.(\d{4})$').firstMatch(t);
    if (dmy != null) {
      final day = int.tryParse(dmy.group(1)!);
      final mo = int.tryParse(dmy.group(2)!);
      final y = int.tryParse(dmy.group(3)!);
      if (day != null && mo != null && y != null) return DateTime(y, mo, day);
    }
    return DateTime.tryParse(t);
  }
  if (raw is Map) {
    final inner = raw['#text'] ?? raw['#TEXT'];
    if (inner != null) return tryParseFlexibleDate(inner);
    final ms = raw['_milliseconds'] ?? raw['milliseconds'];
    if (ms is int) return DateTime.fromMillisecondsSinceEpoch(ms);
    final seconds = raw['_seconds'] ?? raw['seconds'];
    if (seconds is int) return DateTime.fromMillisecondsSinceEpoch(seconds * 1000);
  }
  try {
    final toDate = (raw as dynamic).toDate;
    if (toDate is Function) {
      final dt = toDate() as DateTime?;
      if (dt != null) return dt;
    }
  } catch (_) {}
  return null;
}

String _formatDmyMaybeTime(DateTime d) {
  final date =
      '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')}.${d.year}';
  if (d.hour != 0 || d.minute != 0 || d.second != 0 || d.millisecond != 0 || d.microsecond != 0) {
    final h = d.hour.toString().padLeft(2, '0');
    final m = d.minute.toString().padLeft(2, '0');
    return '$date $h:$m';
  }
  return date;
}
