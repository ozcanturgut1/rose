import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../services/qnb_api.dart';

String _safeDocKey(String s) => s.replaceAll(RegExp(r'[/\\]'), '_');

/// Liste veya detay satırından `qnb_invoices` doküman kimliği.
String invoiceDocIdFromItem(Map<String, dynamic> item) {
  final id = (item['invoiceDocId']?.toString() ?? '').trim();
  if (id.isNotEmpty) return id;
  final belgeNo = (item['belgeNo']?.toString() ?? '').trim();
  if (belgeNo.isEmpty) return '';
  return 'invoice_${_safeDocKey(belgeNo)}';
}

/// Ara onay: bekleyen faturayı başka bir ara onay kullanıcısına yönlendir.
/// Başarılıysa `true` döner (çağıran liste yenilemek için kullanabilir).
Future<bool> showAraOnayYonlendirDialog(
  BuildContext context, {
  required QnbApi api,
  required Map<String, dynamic> item,
}) async {
  final docId = invoiceDocIdFromItem(item);
  if (docId.isEmpty) {
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      const SnackBar(content: Text('BelgeNo / fatura kimliği bulunamadı.')),
    );
    return false;
  }

  final self = FirebaseAuth.instance.currentUser?.uid ?? '';
  final r = await showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (ctx) => _AraOnayYonlendirDialog(api: api, docId: docId, selfUid: self),
  );
  return r == true;
}

class _AraOnayYonlendirDialog extends StatefulWidget {
  const _AraOnayYonlendirDialog({
    required this.api,
    required this.docId,
    required this.selfUid,
  });

  final QnbApi api;
  final String docId;
  final String selfUid;

  @override
  State<_AraOnayYonlendirDialog> createState() => _AraOnayYonlendirDialogState();
}

class _AraOnayYonlendirDialogState extends State<_AraOnayYonlendirDialog> {
  late Future<List<Map<String, dynamic>>> _usersFuture;
  String? _selectedUid;
  bool _submitting = false;

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
    _usersFuture = widget.api.listAraOnayUsers();
  }

  Future<void> _submit() async {
    final uid = _selectedUid?.trim() ?? '';
    if (uid.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Lütfen bir kullanıcı seçin.')),
      );
      return;
    }
    setState(() => _submitting = true);
    try {
      await widget.api.assignQnbInvoiceAraOnay(docId: widget.docId, targetUid: uid);
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
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
              return const Text('Yönlendirilebilecek başka ara onay kullanıcısı yok.');
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
              onChanged: _submitting
                  ? null
                  : (v) {
                      setState(() => _selectedUid = v);
                    },
            );
          },
        ),
      ),
      actions: [
        TextButton(
          onPressed: _submitting ? null : () => Navigator.of(context).pop(false),
          child: const Text('İptal'),
        ),
        FilledButton(
          onPressed: _submitting ? null : _submit,
          child: _submitting
              ? const SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('Yönlendir'),
        ),
      ],
    );
  }
}
