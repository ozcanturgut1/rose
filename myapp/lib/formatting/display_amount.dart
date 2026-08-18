/// Arayüzde tutar gösterimi (Türkiye): binlik ayraç `.`, ondalık `,`.
///
/// Sonda anlamsız sıfırlar atılır: `1234.5` → `1.234,5`, `1234.00` → `1.234`.
String formatTurkishAmount(num? value, {int fractionDigits = 2, String empty = '—'}) {
  if (value == null) return empty;
  final n = value.toDouble();
  final negative = n < 0;
  final x = negative ? -n : n;
  final parts = x.toStringAsFixed(fractionDigits).split('.');
  final intDigits = parts[0];
  final frac = parts.length > 1 ? parts[1].replaceAll(RegExp(r'0+$'), '') : '';
  final buf = StringBuffer();
  for (int i = 0; i < intDigits.length; i++) {
    if (i > 0 && (intDigits.length - i) % 3 == 0) buf.write('.');
    buf.write(intDigits[i]);
  }
  final intStr = negative ? '-$buf' : buf.toString();
  return frac.isEmpty ? intStr : '$intStr,$frac';
}

/// Firestore/JSON'dan gelen sayıyı gevşek ayrıştırır (`num`, `"12,50"`, `"12.50"`).
num? parseNumLoose(dynamic raw) {
  if (raw == null) return null;
  if (raw is num) return raw;
  var s = raw.toString().trim().replaceAll(' ', '');
  if (s.isEmpty) return null;
  if (s.contains(',') && s.contains('.')) {
    s = s.replaceAll('.', '').replaceAll(',', '.');
  } else if (s.contains(',')) {
    s = s.replaceAll(',', '.');
  }
  return num.tryParse(s);
}
