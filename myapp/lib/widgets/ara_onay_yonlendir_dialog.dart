import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../services/qnb_api.dart';

String yonetimOnayMetni(String decision, String routed) {
  return switch (decision) {
    'onaya_sunuldu' when routed == 'erdem' => 'Fatura Erdem onayına gönderildi.',
    'onaya_sunuldu' when routed == 'sinan' => 'Fatura Sinan onayına gönderildi.',
    'onaya_sunuldu' => 'Fatura onaya sunuldu olarak kaydedildi.',
    'onaylandı' => 'Fatura onaylandı olarak kaydedildi.',
    _ => 'Fatura reddedildi olarak kaydedildi.',
  };
}

/// Onay isteği ekran kapandıktan sonra sürer. Sonuç [messenger] ile bildirilir.
Future<void> yonetimOnayiniBitir({
  required ScaffoldMessengerState messenger,
  required QnbApi api,
  required String docId,
  required String decision,
  required String note,
  String? aciklamaRole,
  String belgeNo = '',
  Future<bool>? kalemKaydi,
  void Function()? bitti,
}) async {
  final etiket = belgeNo.isEmpty ? 'Fatura' : belgeNo;
  try {
    if (kalemKaydi != null && !await kalemKaydi) {
      messenger.showSnackBar(
        SnackBar(content: Text('$etiket: kalem açıklamaları kaydedilemedi. İşlem iptal edildi.')),
      );
      return;
    }
    final res = await api.updateQnbInvoiceYonetimOnay(
      docId: docId,
      decision: decision,
      note: note,
      aciklamaRole: aciklamaRole,
    );
    final routed = (res['routedToBirim']?.toString() ?? '').trim();
    messenger.showSnackBar(SnackBar(content: Text('$etiket: ${yonetimOnayMetni(decision, routed)}')));
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text('$etiket işlemi tamamlanamadı: $e')));
  } finally {
    bitti?.call();
  }
}

Future<void> faturayiYonlendirBitir({
  required ScaffoldMessengerState messenger,
  required QnbApi api,
  required String docId,
  required String targetUid,
  String belgeNo = '',
  void Function()? bitti,
}) async {
  final etiket = belgeNo.isEmpty ? 'Fatura' : belgeNo;
  try {
    await api.assignQnbInvoiceAraOnay(docId: docId, targetUid: targetUid);
    messenger.showSnackBar(SnackBar(content: Text('$etiket yönlendirildi.')));
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text('$etiket yönlendirilemedi: $e')));
  } finally {
    bitti?.call();
  }
}

String _safeDocKey(String s) => s.replaceAll(RegExp(r'[/\\]'), '_');

/// Liste veya detay satırından `qnb_invoices` doküman kimliği.
String invoiceDocIdFromItem(Map<String, dynamic> item) {
  final id = (item['invoiceDocId']?.toString() ?? '').trim();
  if (id.isNotEmpty) return id;
  final belgeNo = (item['belgeNo']?.toString() ?? '').trim();
  if (belgeNo.isEmpty) return '';
  return 'invoice_${_safeDocKey(belgeNo)}';
}

/// Ara onay: bekleyen faturayı başka bir onay kullanıcısına yönlendir
/// (ara onay, Erdem, nihai onay veya muhasebe2). Nihai hedefte fatura
/// `onaya sunuldu` olur ve hedefin nihai kuyruğuna düşer. `muhasebe2` ara kuyrukta kalır.
/// Seçilen kullanıcının uid'si. İstek bu pencerede bekletilmez.
Future<String?> showAraOnayYonlendirDialog(
  BuildContext context, {
  required QnbApi api,
  required Map<String, dynamic> item,
}) async {
  final docId = invoiceDocIdFromItem(item);
  if (docId.isEmpty) {
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      const SnackBar(content: Text('BelgeNo / fatura kimliği bulunamadı.')),
    );
    return null;
  }

  final self = FirebaseAuth.instance.currentUser?.uid ?? '';
  return showDialog<String>(
    context: context,
    builder: (ctx) => _AraOnayYonlendirDialog(api: api, selfUid: self),
  );
}

class _AraOnayYonlendirDialog extends StatefulWidget {
  const _AraOnayYonlendirDialog({
    required this.api,
    required this.selfUid,
  });

  final QnbApi api;
  final String selfUid;

  @override
  State<_AraOnayYonlendirDialog> createState() => _AraOnayYonlendirDialogState();
}

class _AraOnayYonlendirDialogState extends State<_AraOnayYonlendirDialog> {
  late Future<List<Map<String, dynamic>>> _usersFuture;
  String? _selectedUid;

  /// Açılır listede uid göstermeyiz; birim + görünen ad.
  static String _dropdownDisplayLine(Map<String, dynamic> u) {
    final label = (u['label']?.toString() ?? '').trim();
    final birim = (u['birim']?.toString() ?? '').trim();
    if (birim.isNotEmpty && label.isNotEmpty) return '$birim · $label';
    if (birim.isNotEmpty) return birim;
    if (label.isNotEmpty) return label;
    return '—';
  }

  @override
  void initState() {
    super.initState();
    _usersFuture = widget.api.listAraOnayUsersCached();
  }

  void _submit() {
    final uid = _selectedUid?.trim() ?? '';
    if (uid.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Lütfen bir kullanıcı seçin.')),
      );
      return;
    }
    Navigator.of(context).pop(uid);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Faturayı yönlendir'),
      content: SizedBox(
        width: 360,
        child: FutureBuilder<List<Map<String, dynamic>>>(
          future: _usersFuture,
          builder: (context, snap) {
            if (snap.hasError) {
              return Text(snap.error.toString(), style: TextStyle(color: Theme.of(context).colorScheme.error));
            }
            if (!snap.hasData) {
              return const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Center(child: CircularProgressIndicator()),
              );
            }
            final allRows = snap.data;
            if (allRows == null) {
              return const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Center(child: CircularProgressIndicator()),
              );
            }
            final rows = allRows
                .where((u) {
                  final id = (u['uid']?.toString() ?? '').trim();
                  return id.isNotEmpty && id != widget.selfUid;
                })
                .toList();
            if (rows.isEmpty) {
              return const Text('Yönlendirilebilecek başka kullanıcı yok.');
            }
            return DropdownButtonFormField<String>(
              decoration: const InputDecoration(
                labelText: 'Hedef (birim)',
                border: OutlineInputBorder(),
                isDense: true,
              ),
              isExpanded: true,
              value: _selectedUid != null && rows.any((u) => u['uid']?.toString() == _selectedUid)
                  ? _selectedUid
                  : null,
              items: [
                for (final u in rows)
                  if ((u['uid']?.toString() ?? '').trim().isNotEmpty)
                    DropdownMenuItem<String>(
                      value: (u['uid']?.toString() ?? '').trim(),
                      child: Text(
                        _dropdownDisplayLine(u),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
              ],
              onChanged: (v) => setState(() => _selectedUid = v),
            );
          },
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('İptal'),
        ),
        FilledButton(
          onPressed: _submit,
          child: const Text('Yönlendir'),
        ),
      ],
    );
  }
}
