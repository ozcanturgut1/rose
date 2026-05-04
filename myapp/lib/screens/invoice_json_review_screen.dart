import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';

import '../services/qnb_api.dart';

String _safeDocKey(String s) => s.replaceAll(RegExp(r'[/\\]'), '_');

String? _ublXmlScalarText(dynamic node) {
  if (node == null) return null;
  if (node is String) {
    final t = node.trim();
    return t.isEmpty ? null : t;
  }
  if (node is num) return node.toString();
  if (node is Map) {
    final m = Map<String, dynamic>.from(node);
    final inner = m['#text'] ?? m['#TEXT'];
    if (inner != null) return _ublXmlScalarText(inner);
  }
  return null;
}

dynamic _ublFirst(dynamic x) {
  if (x is List && x.isNotEmpty) return x.first;
  return x;
}

bool _gecerliGonderenAdi(String? s) {
  if (s == null || s.trim().isEmpty) return false;
  final t = s.trim().toLowerCase();
  if (t.startsWith('urn:mail:')) return false;
  if (t.contains('@') && t.contains('.') && !t.contains(' ')) return false;
  return true;
}

String? _gondericiUnvanFromUblParsed(Map<String, dynamic> d) {
  final upRaw = d['ublParsed'];
  if (upRaw is! Map) return null;
  final up = Map<String, dynamic>.from(upRaw);
  final invRaw = up['Invoice'];
  if (invRaw is! Map) return null;
  final inv = Map<String, dynamic>.from(invRaw);
  final aspRaw = _ublFirst(inv['AccountingSupplierParty']);
  if (aspRaw is! Map) return null;
  final asp = Map<String, dynamic>.from(aspRaw);
  final partyRaw = _ublFirst(asp['Party']);
  if (partyRaw is! Map) return null;
  final party = Map<String, dynamic>.from(partyRaw);
  final pnRaw = _ublFirst(party['PartyName']);
  if (pnRaw is! Map) return null;
  final pn = Map<String, dynamic>.from(pnRaw);
  return _ublXmlScalarText(pn['Name']);
}

String _gonderenUnvani(Map<String, dynamic> d) {
  final fromUbl = _gondericiUnvanFromUblParsed(d);
  if (fromUbl != null && fromUbl.isNotEmpty && _gecerliGonderenAdi(fromUbl)) {
    return fromUbl;
  }
  final raw = d['qnbRaw'];
  final rm = raw is Map ? Map<String, dynamic>.from(raw) : <String, dynamic>{};
  final candidates = [
    d['supplierUnvan'],
    d['supplierEtiket'],
    rm['gondericiUnvan'],
    rm['gonderenUnvan'],
    rm['gonderenEtiket'],
    d['gonderenIsim'],
    d['gondericiIsim'],
    rm['gonderenIsim'],
    rm['gondericiIsim'],
  ];
  for (final c in candidates) {
    final s = c?.toString().trim();
    if (s != null && s.isNotEmpty && _gecerliGonderenAdi(s)) return s;
  }
  final vkn = d['supplierVkn']?.toString().trim();
  if (vkn != null && vkn.isNotEmpty) return 'VKN: $vkn';
  return '';
}

String? _faturaTarihi(Map<String, dynamic> data) {
  final q = data['qnbRaw'];
  if (q is Map) {
    final bt = Map<String, dynamic>.from(q)['belgeTarihi']?.toString().trim();
    if (bt != null && bt.isNotEmpty) return bt;
  }
  final upRaw = data['ublParsed'];
  if (upRaw is Map) {
    final up = Map<String, dynamic>.from(upRaw);
    final invRaw = _ublFirst(up['Invoice']);
    if (invRaw is Map) {
      final inv = Map<String, dynamic>.from(invRaw);
      final issue = _ublXmlScalarText(inv['IssueDate']);
      if (issue != null && issue.isNotEmpty) return issue;
    }
  }
  final bo = data['belgeOzet'];
  if (bo is Map) {
    final bb = Map<String, dynamic>.from(bo)['belgeBilgileri'];
    if (bb is Map) {
      final id = Map<String, dynamic>.from(bb)['IssueDate']?.toString().trim();
      if (id != null && id.isNotEmpty) return id;
    }
  }
  return null;
}

String? _gelisTarihi(Map<String, dynamic> data) {
  final q = data['qnbRaw'];
  if (q is Map) {
    final m = Map<String, dynamic>.from(q);
    final g = (m['faturaGelisTarihi'] ?? m['gelisTarihi'])?.toString().trim();
    if (g != null && g.isNotEmpty) return g;
  }
  return null;
}

Map<String, dynamic> _kalemFromBelgeOzetInvoiceLine(Map<String, dynamic> line) {
  final item = line['Item'];
  String ad = '';
  if (item is Map) {
    ad = item['Name']?.toString().trim() ?? '';
  }
  final cur = line['currencyID']?.toString().trim();
  return <String, dynamic>{
    if (ad.isNotEmpty) 'aciklama': ad,
    if (line['InvoicedQuantity'] != null) 'miktar': line['InvoicedQuantity'],
    if (line['LineExtensionAmount'] != null) 'satirTutari': line['LineExtensionAmount'],
    if (cur != null && cur.isNotEmpty) 'satirParaBirimi': cur,
  };
}

List<Map<String, dynamic>> _faturaKalemleri(Map<String, dynamic> data) {
  final bo = data['belgeOzet'];
  if (bo is Map) {
    final bom = Map<String, dynamic>.from(bo);
    final rows = <Map<String, dynamic>>[];
    final multi = bom['faturaSatirlari'];
    if (multi is List) {
      for (final raw in multi) {
        if (raw is Map) rows.add(_kalemFromBelgeOzetInvoiceLine(Map<String, dynamic>.from(raw)));
      }
    } else {
      final single = bom['faturaSatiri'];
      if (single is Map) {
        rows.add(_kalemFromBelgeOzetInvoiceLine(Map<String, dynamic>.from(single)));
      }
    }
    if (rows.isNotEmpty) {
      final docCur = _documentCurrencyFromInvoice(data);
      if (docCur != null && docCur.isNotEmpty) {
        for (final r in rows) {
          if (r['satirTutari'] != null &&
              (r['satirParaBirimi'] == null || (r['satirParaBirimi'] as Object).toString().trim().isEmpty)) {
            r['satirParaBirimi'] = docCur;
          }
        }
      }
      return rows;
    }
  }

  final upRaw = data['ublParsed'];
  if (upRaw is! Map) return [];
  final up = Map<String, dynamic>.from(upRaw);
  final invRaw = up['Invoice'];
  if (invRaw is! Map) return [];
  final inv = Map<String, dynamic>.from(invRaw);
  final linesRaw = inv['InvoiceLine'];
  if (linesRaw == null) return [];
  final lines = linesRaw is List
      ? linesRaw.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
      : [Map<String, dynamic>.from(linesRaw as Map)];
  final docCur = _documentCurrencyFromInvoice(data);
  final out = <Map<String, dynamic>>[];
  for (final line in lines) {
    final itemRaw = _ublFirst(line['Item']);
    var name = '';
    if (itemRaw is Map) {
      name = _ublXmlScalarText(Map<String, dynamic>.from(itemRaw)['Name'])?.trim() ?? '';
    }
    final qty = line['InvoicedQuantity'];
    num? miktar;
    String? birim;
    if (qty is Map) {
      final qm = Map<String, dynamic>.from(qty);
      final t = _ublXmlScalarText(qm);
      if (t != null) miktar = num.tryParse(t) ?? double.tryParse(t);
      birim = (qm['@_unitCode'] ?? qm['@_UnitCode'])?.toString();
    } else if (qty is num) {
      miktar = qty;
    }
    String? priceCur;
    final price = line['Price'];
    num? birimFiyat;
    if (price is Map) {
      final pm = Map<String, dynamic>.from(price);
      final pa = pm['PriceAmount'];
      if (pa != null) {
        if (pa is Map) {
          final pam = Map<String, dynamic>.from(pa);
          priceCur = (pam['@_currencyID'] ?? pam['@_CurrencyID'])?.toString();
        }
        final pv = pa is Map ? _ublXmlScalarText(pa) : pa.toString();
        birimFiyat = num.tryParse(pv ?? '') ?? double.tryParse(pv ?? '');
      }
    }
    String? lineCur;
    final le = line['LineExtensionAmount'];
    num? satir;
    if (le != null) {
      if (le is Map) {
        final lem = Map<String, dynamic>.from(le);
        lineCur = (lem['@_currencyID'] ?? lem['@_CurrencyID'])?.toString();
      }
      final lv = le is Map ? _ublXmlScalarText(Map<String, dynamic>.from(le)) : le.toString();
      satir = num.tryParse(lv ?? '') ?? double.tryParse(lv ?? '');
    }
    out.add(<String, dynamic>{
      if (name.isNotEmpty) 'aciklama': name,
      if (miktar != null) 'miktar': miktar,
      if (birim != null && birim.isNotEmpty) 'birim': birim,
      if (birimFiyat != null) 'birimFiyat': birimFiyat,
      if (birimFiyat != null) 'birimFiyatParaBirimi': priceCur ?? docCur,
      if (satir != null) 'satirTutari': satir,
      if (satir != null) 'satirParaBirimi': lineCur ?? docCur,
    });
  }
  return out;
}

Map<String, dynamic> _kalemDespatchBelgeOzet(Map<String, dynamic> line) {
  final item = line['Item'];
  String ad = '';
  if (item is Map) {
    ad = item['Name']?.toString().trim() ?? '';
  }
  return <String, dynamic>{
    if (ad.isNotEmpty) 'aciklama': ad,
    if (line['DeliveredQuantity'] != null) 'miktar': line['DeliveredQuantity'],
  };
}

List<Map<String, dynamic>> _irsaliyeKalemleri(Map<String, dynamic> data) {
  final bo = data['belgeOzet'];
  if (bo is Map) {
    final bom = Map<String, dynamic>.from(bo);
    final rows = <Map<String, dynamic>>[];
    final multi = bom['irsaliyeSatirlari'];
    if (multi is List) {
      for (final raw in multi) {
        if (raw is Map) rows.add(_kalemDespatchBelgeOzet(Map<String, dynamic>.from(raw)));
      }
    } else {
      final single = bom['irsaliyeSatiri'];
      if (single is Map) {
        rows.add(_kalemDespatchBelgeOzet(Map<String, dynamic>.from(single)));
      }
    }
    if (rows.isNotEmpty) return rows;
  }

  final upRaw = data['ublParsed'];
  if (upRaw is! Map) return [];
  final up = Map<String, dynamic>.from(upRaw);
  final daRaw = up['DespatchAdvice'];
  if (daRaw is! Map) return [];
  final da = Map<String, dynamic>.from(daRaw);
  final linesRaw = da['DespatchLine'];
  if (linesRaw == null) return [];
  final lines = linesRaw is List
      ? linesRaw.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
      : [Map<String, dynamic>.from(linesRaw as Map)];
  final out = <Map<String, dynamic>>[];
  for (final line in lines) {
    final itemRaw = _ublFirst(line['Item']);
    var name = '';
    if (itemRaw is Map) {
      name = _ublXmlScalarText(Map<String, dynamic>.from(itemRaw)['Name'])?.trim() ?? '';
    }
    final qty = line['DeliveredQuantity'];
    num? miktar;
    String? birim;
    if (qty is Map) {
      final qm = Map<String, dynamic>.from(qty);
      final t = _ublXmlScalarText(qm);
      if (t != null) miktar = num.tryParse(t) ?? double.tryParse(t);
      birim = (qm['@_unitCode'] ?? qm['@_UnitCode'])?.toString();
    } else if (qty is num) {
      miktar = qty;
    }
    out.add(<String, dynamic>{
      if (name.isNotEmpty) 'aciklama': name,
      if (miktar != null) 'miktar': miktar,
      if (birim != null && birim.isNotEmpty) 'birim': birim,
    });
  }
  return out;
}

String? _irsaliyeTarihi(Map<String, dynamic> data) {
  final bo = data['belgeOzet'];
  if (bo is Map) {
    final bb = Map<String, dynamic>.from(bo)['belgeBilgileri'];
    if (bb is Map) {
      final id = Map<String, dynamic>.from(bb)['IssueDate']?.toString().trim();
      if (id != null && id.isNotEmpty) return id;
    }
  }
  final upRaw = data['ublParsed'];
  if (upRaw is Map) {
    final up = Map<String, dynamic>.from(upRaw);
    final daRaw = _ublFirst(up['DespatchAdvice']);
    if (daRaw is Map) {
      final issue = _ublXmlScalarText(Map<String, dynamic>.from(daRaw)['IssueDate']);
      if (issue != null && issue.isNotEmpty) return issue;
    }
  }
  return null;
}

String _fmt(dynamic v) {
  if (v == null) return '—';
  if (v is num || v is bool) return v.toString();
  return v.toString().trim().isEmpty ? '—' : v.toString();
}

/// [Son10FaturaScreen] liste satırı — `belgeTarihi` kaynağı (`qnbRaw.belgeTarihi`).
dynamic _belgeTarihiListSource(Map<String, dynamic> data) {
  final q = data['qnbRaw'];
  if (q is Map) {
    final v = Map<String, dynamic>.from(q)['belgeTarihi'];
    if (v != null && v.toString().trim().isNotEmpty) return v;
  }
  return data['belgeTarihi'];
}

/// Liste ile aynı tarih gösterimi (`_formatBelgeTarih`).
String _formatBelgeTarihList(dynamic v) {
  final t = v?.toString().trim() ?? '';
  if (t.length == 8 && RegExp(r'^\d{8}$').hasMatch(t)) {
    return '${t.substring(0, 4)}-${t.substring(4, 6)}-${t.substring(6, 8)}';
  }
  return t.isEmpty ? '—' : t;
}

/// Binlik ayraç: `.`, ondalık: `,` (Türkiye).
String _formatTurkishAmount(num? value, {int fractionDigits = 2}) {
  if (value == null) return '—';
  final n = value.toDouble();
  final negative = n < 0;
  final x = negative ? -n : n;
  final parts = x.toStringAsFixed(fractionDigits).split('.');
  final intPartRaw = parts[0];
  final frac = parts.length > 1 ? parts[1].replaceAll(RegExp(r'0+$'), '') : '';
  final intDigits = intPartRaw;
  final buf = StringBuffer();
  for (int i = 0; i < intDigits.length; i++) {
    if (i > 0 && (intDigits.length - i) % 3 == 0) buf.write('.');
    buf.write(intDigits[i]);
  }
  final intStr = negative ? '-$buf' : buf.toString();
  final numStr = frac.isEmpty ? intStr : '$intStr,$frac';
  return numStr;
}

num? _parseNumLoose(dynamic raw) {
  if (raw == null) return null;
  if (raw is num) return raw;
  var s = raw.toString().trim().replaceAll(' ', '');
  if (s.isEmpty) return null;
  if (s.contains(',') && s.contains('.')) {
    s = s.replaceAll('.', '').replaceAll(',', '.');
  } else if (s.contains(',')) {
    s = s.replaceAll(',', '.');
  }
  return num.tryParse(s) ?? double.tryParse(s);
}

num? _asNum(dynamic v) {
  if (v == null) return null;
  if (v is num) return v;
  return _parseNumLoose(v);
}

String _formatMoney(num? amount, {String? currency, int fractionDigits = 2}) {
  final a = _formatTurkishAmount(amount, fractionDigits: fractionDigits);
  if (a == '—') return '—';
  final c = currency?.trim();
  if (c == null || c.isEmpty) return a;
  return '$a $c';
}

String? _documentCurrencyFromInvoice(Map<String, dynamic> data) {
  final bo = data['belgeOzet'];
  if (bo is Map) {
    final bb = Map<String, dynamic>.from(bo)['belgeBilgileri'];
    if (bb is Map) {
      final c = bb['DocumentCurrencyCode']?.toString().trim();
      if (c != null && c.isNotEmpty) return c;
    }
  }
  final upRaw = data['ublParsed'];
  if (upRaw is Map) {
    final invRaw = _ublFirst(Map<String, dynamic>.from(upRaw)['Invoice']);
    if (invRaw is Map) {
      final c = _ublXmlScalarText(Map<String, dynamic>.from(invRaw)['DocumentCurrencyCode']);
      if (c != null && c.isNotEmpty) return c;
    }
  }
  return null;
}

String _tutarListStr(Map<String, dynamic> data) {
  final q = data['qnbRaw'];
  final qm = q is Map ? Map<String, dynamic>.from(q) : <String, dynamic>{};
  final raw = qm['odenecekTutar'] ?? data['odenecekTutar'];
  final pb = qm['odenecekTutarDovizCinsi']?.toString() ?? data['odenecekTutarDovizCinsi']?.toString() ?? '';
  final n = _parseNumLoose(raw);
  if (n == null) return '—';
  return _formatMoney(n, currency: pb.isEmpty ? null : pb);
}

/// [InvoicePdfReviewScreen._kullaniciEtiketi] ile aynı.
String _kullaniciEtiketiOnay(String? raw) {
  final s = raw?.trim() ?? '';
  if (s.isEmpty) return '';
  final i = s.indexOf('@');
  if (i <= 0) return s;
  final local = s.substring(0, i).trim();
  return local.isNotEmpty ? local : s;
}

/// [InvoicePdfReviewScreen._allOnayAciklamalarDisplayText] ile aynı mantık.
String _onayAciklamalarDisplayFromMap(Map<String, dynamic> m) {
  final parts = <String>[];
  void addPart(String fallbackLabel, String textKey, String authorKey) {
    final v = m[textKey]?.toString().trim();
    if (v == null || v.isEmpty) return;
    final ad = m[authorKey]?.toString().trim();
    final label =
        (ad != null && ad.isNotEmpty) ? _kullaniciEtiketiOnay(ad) : fallbackLabel;
    parts.add('$label: $v');
  }

  addPart('Ara', 'onayAciklamaAraOnay', 'onayAciklamaAraOnayYazanAd');
  addPart('Nihai', 'onayAciklamaNihaiOnay', 'onayAciklamaNihaiOnayYazanAd');
  addPart('Muh.', 'onayAciklamaMuhasebe', 'onayAciklamaMuhasebeYazanAd');
  addPart('Genel', 'onayAciklama', 'onayAciklamaYazanAd');
  if (parts.isEmpty) return '—';
  return parts.join(' · ');
}

/// Fatura / irsaliye özeti (tarih, gönderen, kalemler, onay notları) — [InvoicePdfReviewScreen] ile uyumlu.
class InvoiceJsonReviewScreen extends StatefulWidget {
  const InvoiceJsonReviewScreen({
    super.key,
    required this.api,
    required this.item,
    this.userRole,
  });

  final QnbApi api;
  final Map<String, dynamic> item;

  /// [UserHomeRouter] / `user_profiles.role` — muhasebede onay çubuğu gösterilmez.
  final String? userRole;

  @override
  State<InvoiceJsonReviewScreen> createState() => _InvoiceJsonReviewScreenState();
}

class _InvoiceJsonReviewScreenState extends State<InvoiceJsonReviewScreen> {
  late final Future<Map<String, dynamic>> _summaryFuture;
  final TextEditingController _noteCtrl = TextEditingController();
  bool _saving = false;

  /// Muhasebe: yalnızca önizleme; açıklama ve Onayla/Reddet yok ([InvoicePdfReviewScreen] ile aynı).
  bool get _isMuhasebe {
    final r =
        widget.userRole?.trim().toLowerCase().replaceAll(RegExp(r'\s+'), '_') ?? '';
    return r == 'muhasebe';
  }

  /// Ara onay: birincil düğme "Onaya Sun" ve `onaya_sunuldu`.
  bool get _isAraOnay {
    final r =
        widget.userRole?.trim().toLowerCase().replaceAll(RegExp(r'\s+'), '_') ?? '';
    return r == 'ara_onay';
  }

  String _normalizedUserRole() =>
      widget.userRole?.trim().toLowerCase().replaceAll(RegExp(r'\s+'), '_') ?? '';

  String? _aciklamaRoleForApi() {
    final r = _normalizedUserRole();
    if (r == 'ara_onay' || r == 'nihai_onay' || r == 'muhasebe' || r == 'admin') return r;
    return null;
  }

  String get _invoiceDocId {
    final belgeNo = (widget.item['belgeNo']?.toString() ?? '').trim();
    return 'invoice_${_safeDocKey(belgeNo)}';
  }

  @override
  void initState() {
    super.initState();
    _summaryFuture = _loadSummaryPayload();
  }

  @override
  void dispose() {
    _noteCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit(String decision) async {
    if (_saving) return;
    setState(() => _saving = true);
    try {
      await widget.api.updateQnbInvoiceYonetimOnay(
        docId: _invoiceDocId,
        decision: decision,
        note: _noteCtrl.text,
        aciklamaRole: _aciklamaRoleForApi(),
      );
      if (!mounted) return;
      final msg = switch (decision) {
        'onaya_sunuldu' => 'Fatura onaya sunuldu olarak kaydedildi.',
        'onaylandı' => 'Fatura onaylandı olarak kaydedildi.',
        _ => 'Fatura reddedildi olarak kaydedildi.',
      };
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
      Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Widget _bottomActions(BuildContext context) {
    return Material(
      elevation: 3,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: EdgeInsets.only(
            left: 12,
            right: 12,
            top: 8,
            bottom: 8 + MediaQuery.viewInsetsOf(context).bottom,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: _noteCtrl,
                decoration: const InputDecoration(
                  labelText: 'Açıklama (isteğe bağlı)',
                  border: OutlineInputBorder(),
                  isDense: true,
                  contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                ),
                maxLines: 2,
                minLines: 1,
                textInputAction: TextInputAction.newline,
                enabled: !_saving,
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: FilledButton(
                      style: FilledButton.styleFrom(
                        padding: const EdgeInsets.symmetric(vertical: 10),
                        visualDensity: VisualDensity.compact,
                      ),
                      onPressed: _saving
                          ? null
                          : () => _submit(_isAraOnay ? 'onaya_sunuldu' : 'onaylandı'),
                      child: _saving
                          ? const SizedBox(
                              height: 20,
                              width: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : Text(_isAraOnay ? 'Onaya Sun' : 'Onayla'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: OutlinedButton(
                      style: OutlinedButton.styleFrom(
                        padding: const EdgeInsets.symmetric(vertical: 10),
                        visualDensity: VisualDensity.compact,
                      ),
                      onPressed: _saving ? null : () => _submit('reddedildi'),
                      child: const Text('Reddet'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<Map<String, dynamic>> _loadSummaryPayload() async {
    final belgeNo = (widget.item['belgeNo']?.toString() ?? '').trim();
    if (belgeNo.isEmpty) {
      return {'_error': 'BelgeNo bulunamadı.'};
    }
    final invoiceDocId = 'invoice_${_safeDocKey(belgeNo)}';

    final invSnap =
        await FirebaseFirestore.instance.collection('qnb_invoices').doc(invoiceDocId).get();
    if (!invSnap.exists || invSnap.data() == null) {
      return {'_error': 'Fatura bulunamadı (Firestore: $invoiceDocId).'};
    }

    final invData = Map<String, dynamic>.from(invSnap.data()!);
    final mergedOnay = <String, dynamic>{...widget.item, ...invData};
    final onayAcikText = _onayAciklamalarDisplayFromMap(mergedOnay);
    final ettnStr = mergedOnay['ettn']?.toString().trim();
    final onayDurumuStr = mergedOnay['onayDurumu']?.toString().trim();

    final faturaOzeti = <String, dynamic>{
      'belgeNo': belgeNo,
      'faturaTarihi': _faturaTarihi(invData),
      'faturaGelisTarihi': _gelisTarihi(invData),
      'gonderenUnvan': _gonderenUnvani(invData),
      'faturaTarihiListe': _formatBelgeTarihList(_belgeTarihiListSource(invData)),
      'tutarListe': _tutarListStr(invData),
      'kalemler': _faturaKalemleri(invData),
      'onayAciklamalarText': onayAcikText,
      if (ettnStr != null && ettnStr.isNotEmpty) 'ettn': ettnStr,
      if (onayDurumuStr != null && onayDurumuStr.isNotEmpty) 'onayDurumu': onayDurumuStr,
    };

    final irsaliyeler = <Map<String, dynamic>>[];
    final sub = await FirebaseFirestore.instance
        .collection('qnb_invoices')
        .doc(invoiceDocId)
        .collection('despatches')
        .get();

    for (final d in sub.docs) {
      final dd = Map<String, dynamic>.from(d.data());
      final ib = (dd['belgeNo'] ?? dd['belgeNoStr'] ?? d.id).toString().trim();
      irsaliyeler.add({
        'belgeNo': ib.isNotEmpty ? ib : d.id,
        'tarih': _irsaliyeTarihi(dd),
        'kalemler': _irsaliyeKalemleri(dd),
      });
    }

    return <String, dynamic>{
      'fatura': faturaOzeti,
      'irsaliyeler': irsaliyeler,
    };
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Fatura özeti'),
      ),
      bottomNavigationBar: _isMuhasebe ? null : _bottomActions(context),
      body: FutureBuilder<Map<String, dynamic>>(
        future: _summaryFuture,
        builder: (context, snap) {
          if (snap.hasError) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(snap.error.toString(), textAlign: TextAlign.center),
              ),
            );
          }
          if (!snap.hasData) {
            return const Center(child: CircularProgressIndicator());
          }
          final data = snap.data!;
          final err = data['_error']?.toString();
          if (err != null) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(err, textAlign: TextAlign.center),
              ),
            );
          }

          final f = Map<String, dynamic>.from(data['fatura'] as Map);
          final irs = (data['irsaliyeler'] as List<dynamic>? ?? [])
              .map((e) => Map<String, dynamic>.from(e as Map))
              .toList();

          return ListView(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
            children: [
              Text(
                'Fatura bilgileri',
                style: Theme.of(context).textTheme.titleMedium?.copyWith(color: cs.primary),
              ),
              const SizedBox(height: 8),
              Card(
                elevation: 0,
                color: cs.surfaceContainerHighest.withValues(alpha: 0.5),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  child: _faturaListStyleBlock(context, f),
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Kalemler',
                style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 8),
              ..._buildKalemTiles(context, f['kalemler'] as List<dynamic>? ?? []),
              if (irs.isNotEmpty) ...[
                const SizedBox(height: 20),
                Text(
                  'İrsaliyeler',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(color: cs.primary),
                ),
                const SizedBox(height: 8),
                ...irs.map((d) => _despatchCard(context, d)),
              ],
              const SizedBox(height: 20),
              Text(
                'Onay bilgileri',
                style: Theme.of(context).textTheme.titleMedium?.copyWith(color: cs.primary),
              ),
              const SizedBox(height: 8),
              Card(
                elevation: 0,
                color: cs.surfaceContainerHighest.withValues(alpha: 0.5),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  child: _onayBilgiBlock(context, f),
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  /// [Son10FaturaScreen] liste satırı ile aynı başlık ve alt satırlar.
  Widget _faturaListStyleBlock(BuildContext context, Map<String, dynamic> f) {
    final belgeNoRaw = (f['belgeNo'] ?? widget.item['belgeNo'])?.toString().trim() ?? '';
    final gUnvan = _fmt(f['gonderenUnvan']);
    final gonderenStr = gUnvan == '—' ? '' : gUnvan;
    final baseTitle = belgeNoRaw.isNotEmpty
        ? belgeNoRaw
        : (gonderenStr.isNotEmpty ? gonderenStr : '—');
    final bek = (widget.item['muhasebeBeklemeParantez']?.toString() ?? '').trim();
    final titleText = bek.isNotEmpty ? '$baseTitle  $bek' : baseTitle;
    final tarihStr = _fmt(f['faturaTarihiListe']);
    final tutarStr = _fmt(f['tutarListe']);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          titleText,
          style: const TextStyle(fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 6),
        Text('Fatura tarihi: $tarihStr'),
        Text('Tutar: $tutarStr'),
        if (gonderenStr.isNotEmpty)
          Text(
            'Gönderen: $gonderenStr',
            style: const TextStyle(fontSize: 12),
          ),
      ],
    );
  }

  /// [InvoicePdfReviewScreen] üst çubuğu / ETTN satırı ile aynı veri kaynağı (onay açıklamaları + durum + ETTN).
  Widget _onayBilgiBlock(BuildContext context, Map<String, dynamic> f) {
    final cs = Theme.of(context).colorScheme;
    final acik = _fmt(f['onayAciklamalarText']);
    final durum = f['onayDurumu']?.toString().trim();
    final ettn = f['ettn']?.toString().trim();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Onay notları: $acik',
          style: TextStyle(
            fontSize: 13,
            height: 1.25,
            color: cs.onSurface,
          ),
        ),
        if (durum != null && durum.isNotEmpty) ...[
          const SizedBox(height: 6),
          Text(
            'Onay durumu: $durum',
            style: const TextStyle(fontSize: 13),
          ),
        ],
        if (ettn != null && ettn.isNotEmpty) ...[
          const SizedBox(height: 6),
          Text(
            'ETTN: $ettn',
            style: TextStyle(
              fontSize: 13,
              color: cs.onSurface.withValues(alpha: 0.72),
            ),
          ),
        ],
      ],
    );
  }

  List<Widget> _buildKalemTiles(BuildContext context, List<dynamic> kalemler) {
    if (kalemler.isEmpty) {
      return [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Text(
            'Kalem bulunamadı.',
            style: TextStyle(color: Theme.of(context).colorScheme.outline),
          ),
        ),
      ];
    }
    return List<Widget>.generate(kalemler.length, (i) {
      final k = Map<String, dynamic>.from(kalemler[i] as Map);
      final sub = _kalemSubtitle(k);
      return Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Card(
          elevation: 0,
          margin: EdgeInsets.zero,
          child: ListTile(
            leading: CircleAvatar(
              radius: 16,
              child: Text('${i + 1}', style: const TextStyle(fontSize: 12)),
            ),
            title: Text(
              _kalemBaslik(k, i),
              style: const TextStyle(fontWeight: FontWeight.w500),
            ),
            subtitle: Text(
              sub,
              style: TextStyle(fontSize: 13, color: Theme.of(context).colorScheme.onSurfaceVariant),
            ),
            isThreeLine: sub.length > 60,
          ),
        ),
      );
    });
  }

  String _kalemBaslik(Map<String, dynamic> k, int i) {
    final a = k['aciklama']?.toString().trim();
    if (a != null && a.isNotEmpty) return a;
    return 'Kalem ${i + 1}';
  }

  String _irsaliyeSatirBaslik(Map<String, dynamic> k, int i) {
    final a = k['aciklama']?.toString().trim();
    if (a != null && a.isNotEmpty) return a;
    return 'Satır ${i + 1}';
  }

  String _kalemSubtitle(Map<String, dynamic> k) {
    final parts = <String>[];
    if (k['miktar'] != null) {
      final b = k['birim'] != null ? ' ${k['birim']}' : '';
      parts.add('Miktar: ${k['miktar']}$b');
    }
    if (k['birimFiyat'] != null) {
      parts.add(
        'Birim fiyat: ${_formatMoney(_asNum(k['birimFiyat']), currency: k['birimFiyatParaBirimi']?.toString())}',
      );
    }
    if (k['satirTutari'] != null) {
      parts.add(
        'Satır tutarı: ${_formatMoney(_asNum(k['satirTutari']), currency: k['satirParaBirimi']?.toString())}',
      );
    }
    return parts.isEmpty ? '—' : parts.join(' · ');
  }

  Widget _despatchCard(BuildContext context, Map<String, dynamic> d) {
    final cs = Theme.of(context).colorScheme;
    final kalemler = d['kalemler'] as List<dynamic>? ?? [];
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Card(
        elevation: 0,
        color: cs.surfaceContainerHighest.withValues(alpha: 0.35),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(Icons.local_shipping_outlined, size: 18, color: cs.primary),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _fmt(d['belgeNo']),
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                'Tarih: ${_fmt(d['tarih'])}',
                style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant),
              ),
              if (kalemler.isEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    'İrsaliye kalemi yok.',
                    style: TextStyle(fontSize: 13, color: cs.outline),
                  ),
                )
              else
                ...List<Widget>.generate(kalemler.length, (i) {
                  final k = Map<String, dynamic>.from(kalemler[i] as Map);
                  return Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('${i + 1}. ', style: TextStyle(color: cs.primary, fontWeight: FontWeight.w600)),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(_irsaliyeSatirBaslik(k, i)),
                              if (k['miktar'] != null || k['birim'] != null)
                                Text(
                                  'Miktar: ${_fmt(k['miktar'])}${k['birim'] != null ? ' ${k['birim']}' : ''}',
                                  style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
                                ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  );
                }),
            ],
          ),
        ),
      ),
    );
  }

}
