import 'display_amount.dart';

/// Yeni birim fiyatın yanında parantez içinde gösterilecek son alım metni.
/// Aynı para biriminde yalnız sayı, farklı birimde sayı ve kod döner.
/// Fiyat yoksa boş döner.
String sonAlimFiyatParantezi({
  required num fiyat,
  required String paraBirimi,
  required String yeniFiyatMetni,
}) {
  if (!(fiyat > 0)) return '';
  final sayi = formatTurkishAmount(fiyat, fractionDigits: 4, empty: '');
  if (sayi.isEmpty) return '';
  final pb = paraBirimi.trim().toUpperCase();
  if (pb.isEmpty || _ayniParaBirimi(yeniFiyatMetni, pb)) return sayi;
  return '$sayi $pb';
}

bool _ayniParaBirimi(String yeniFiyatMetni, String paraBirimi) {
  final u = yeniFiyatMetni.toUpperCase();
  if (paraBirimi == 'TRY' || paraBirimi == 'TL') {
    return u.contains('TRY') || u.contains('TL');
  }
  return u.contains(paraBirimi);
}
