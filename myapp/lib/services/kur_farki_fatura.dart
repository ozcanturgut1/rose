/// Fatura metninde kur farkı var mı? Vade farkı ve fiyat farkı sayılmaz.
/// Not ve fatura satırı metnine bakar; liste süzmesi ile aynı kaynak.
bool kurFarkiFaturasi(Map<String, dynamic> data) {
  return kurFarkiMetni('${_notMetni(data)} ${_kalemMetni(data)}');
}

bool kurFarkiMetni(String raw) {
  return RegExp(r'kur\s*fark').hasMatch(_norm(raw));
}

String _norm(String raw) {
  var s = raw.replaceAll('İ', 'i').replaceAll('I', 'ı');
  s = s.toLowerCase();
  s = s
      .replaceAll('ı', 'i')
      .replaceAll('ğ', 'g')
      .replaceAll('ü', 'u')
      .replaceAll('ş', 's')
      .replaceAll('ö', 'o')
      .replaceAll('ç', 'c');
  s = s.replaceAll(RegExp(r'[^a-z0-9\s]'), ' ');
  return s.replaceAll(RegExp(r'\s+'), ' ').trim();
}

String _notMetni(Map<String, dynamic> data) {
  final parts = <String>[];
  void add(dynamic raw) {
    if (raw == null) return;
    if (raw is String || raw is num) {
      final t = raw.toString().trim();
      if (t.isNotEmpty) parts.add(t);
      return;
    }
    if (raw is List) {
      for (final e in raw) {
        add(e);
      }
      return;
    }
    if (raw is Map) add(raw['#text'] ?? raw['#TEXT']);
  }

  final up = data['ublParsed'];
  if (up is Map) {
    final inv = up['Invoice'];
    if (inv is Map) add(inv['Note']);
    if (inv is List && inv.isNotEmpty && inv.first is Map) {
      add(Map<String, dynamic>.from(inv.first as Map)['Note']);
    }
  }
  final bo = data['belgeOzet'];
  if (bo is Map) {
    final bilgi = bo['belgeBilgileri'];
    if (bilgi is Map) add(bilgi['Note']);
  }
  final ubl = data['contentUbl']?.toString() ?? '';
  if (ubl.isNotEmpty) {
    final re = RegExp(r'<cbc:Note[^>]*>([\s\S]*?)</cbc:Note>', caseSensitive: false);
    for (final m in re.allMatches(ubl)) {
      final t = (m.group(1) ?? '').replaceAll(RegExp(r'<[^>]+>'), '').trim();
      if (t.isNotEmpty) parts.add(t);
    }
  }
  return parts.join(' ');
}

String _kalemMetni(Map<String, dynamic> data) {
  final ubl = data['contentUbl']?.toString() ?? '';
  if (ubl.isNotEmpty) {
    final re = RegExp(r'<cac:InvoiceLine\b[\s\S]*?</cac:InvoiceLine>', caseSensitive: false);
    final parts = re.allMatches(ubl).map((m) => m.group(0) ?? '').where((s) => s.isNotEmpty);
    if (parts.isNotEmpty) return parts.join(' ');
  }
  final up = data['ublParsed'];
  if (up is Map) {
    final inv = up['Invoice'];
    if (inv is Map) return inv['InvoiceLine']?.toString() ?? '';
    if (inv is List && inv.isNotEmpty && inv.first is Map) {
      return Map<String, dynamic>.from(inv.first as Map)['InvoiceLine']?.toString() ?? '';
    }
  }
  return '';
}
