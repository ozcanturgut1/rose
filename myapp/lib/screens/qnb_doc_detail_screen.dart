import 'package:flutter/material.dart';
import 'package:printing/printing.dart';

import '../formatting/display_date.dart';
import '../services/qnb_api.dart';
import 'dart:typed_data';

class QnbDocDetailScreen extends StatefulWidget {
  const QnbDocDetailScreen({
    super.key,
    required this.api,
    required this.doc,
    required this.docId,
  });

  final QnbApi api;
  final Map<String, dynamic> doc;
  final String docId;

  @override
  State<QnbDocDetailScreen> createState() => _QnbDocDetailScreenState();
}

/// API'den dönen irsaliye görüntü öğesi: id, belgeNo, issueDate, belgeOzet
class RelatedDespatchView {
  RelatedDespatchView({
    required this.id,
    required this.belgeNo,
    this.issueDate,
    this.belgeOzet,
  });
  final String id;
  final String belgeNo;
  final String? issueDate;
  final Map<String, dynamic>? belgeOzet;
}

class _QnbDocDetailScreenState extends State<QnbDocDetailScreen> {
  bool loading = true;
  String? error;
  Uint8List? pdfBytes;

  bool relatedLoading = false;
  String? relatedError;
  List<Map<String, dynamic>> relatedDespatches = [];
  List<String> relatedMissing = [];

  /// Fatura için: yeni endpoint'ten gelen irsaliye listesi (görüntü özeti ile birlikte)
  List<RelatedDespatchView> relatedDespatchViews = [];

  final noteCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _initRelatedFromDoc();
    _loadPdf();
    if (widget.doc['type'] == 'invoice') {
      _loadRelatedDespatchViews();
    } else {
      _loadRelatedDespatches();
    }
  }

  void _initRelatedFromDoc() {
    final raw = widget.doc['relatedDespatches'];
    if (raw is List && raw.isNotEmpty) {
      relatedDespatches = raw
          .where((e) => e is Map)
          .map((e) => (e as Map).cast<String, dynamic>())
          .toList();
    }
  }

  Future<void> _loadRelatedDespatchViews() async {
    setState(() {
      relatedLoading = true;
      relatedError = null;
    });
    try {
      final map = await widget.api.getInvoiceRelatedDespatches(widget.docId);
      final raw = map['relatedDespatches'];
      if (raw is List) {
        final list = <RelatedDespatchView>[];
        for (final e in raw) {
          if (e is! Map) continue;
          final m = (e as Map).cast<String, dynamic>();
          list.add(RelatedDespatchView(
            id: m['id']?.toString() ?? '',
            belgeNo: m['belgeNo']?.toString() ?? '',
            issueDate: m['issueDate']?.toString(),
            belgeOzet: m['belgeOzet'] is Map ? (m['belgeOzet'] as Map).cast<String, dynamic>() : null,
          ));
        }
        setState(() {
          relatedDespatchViews = list;
          relatedLoading = false;
        });
      } else {
        setState(() => relatedLoading = false);
      }
    } catch (e) {
      setState(() {
        relatedError = e.toString();
        relatedLoading = false;
      });
    }
  }

  Future<void> _loadPdf() async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final bytes = await widget.api.fetchPdfBytes(widget.docId);
      setState(() {
        pdfBytes = bytes as Uint8List?;
        loading = false;
      });
    } catch (e) {
      setState(() {
        error = e.toString();
        loading = false;
      });
    }
  }

  List<String> _relatedBelgeNos() {
    final raw = widget.doc['relatedBelgeNos'];
    if (raw is List) {
      return raw
          .where((e) => e != null)
          .map((e) => e.toString().trim())
          .where((e) => e.isNotEmpty)
          .toList();
    }
    return const [];
  }

  List<String> _relatedDespatchIds() {
    final raw = widget.doc['relatedDespatchIds'];
    if (raw is List) {
      return raw
          .where((e) => e != null)
          .map((e) => e.toString().trim())
          .where((e) => e.isNotEmpty)
          .toList();
    }
    return const [];
  }

  static bool _gecerliGonderenAdi(String? s) {
    if (s == null || s.trim().isEmpty) return false;
    final t = s.trim().toLowerCase();
    if (t.startsWith('urn:mail:')) return false;
    if (t.contains('@') && t.contains('.') && !t.contains(' ')) return false;
    return true;
  }

  String _gonderenAdi(Map<String, dynamic> d) {
    final raw = d['qnbRaw'] as Map?;
    final candidates = [
      d['supplierUnvan'],
      d['supplierEtiket'],
      raw?['gondericiUnvan'],
      raw?['gonderenUnvan'],
      raw?['gonderenEtiket'],
      d['gonderenIsim'],
      d['gondericiIsim'],
      raw?['gonderenIsim'],
      raw?['gondericiIsim'],
    ];
    for (final c in candidates) {
      final s = c?.toString().trim();
      if (s != null && s.isNotEmpty && _gecerliGonderenAdi(s)) return s;
    }
    final vkn = d['supplierVkn']?.toString().trim();
    if (vkn != null && vkn.isNotEmpty) return 'VKN: $vkn';
    return '';
  }

  String _formatDespatchSubtitle(Map<String, dynamic> despatch) {
    final parts = <String>[];
    final issueDate = despatch['issueDate'];
    if (issueDate != null && issueDate.toString().isNotEmpty) {
      parts.add('Tarih: ${formatTurkishDate(issueDate)}');
    }
    final supplierVkn = despatch['supplierVkn'];
    if (supplierVkn != null && supplierVkn.toString().isNotEmpty) {
      parts.add('VKN: $supplierVkn');
    }
    if (parts.isEmpty) return 'Detay yok';
    return parts.join(' • ');
  }

  Future<void> _loadRelatedDespatches() async {
    if (widget.doc['type'] != 'invoice') return;
    if (relatedDespatches.isNotEmpty) return;

    final ids = _relatedDespatchIds();
    final belgeNos = _relatedBelgeNos();
    if (ids.isEmpty && belgeNos.isEmpty) return;

    setState(() {
      relatedLoading = true;
      relatedError = null;
    });
    try {
      final docs = await widget.api.listDocs(
        type: 'despatch',
        status: 'ALL',
        limit: 200,
      );
      final byId = <String, Map<String, dynamic>>{};
      final byBelgeNo = <String, Map<String, dynamic>>{};
      for (final doc in docs) {
        final id = doc['id'];
        if (id != null) byId[id.toString()] = doc;
        final belgeNo = doc['belgeNo'] ?? (doc['qnbRaw'] is Map ? doc['qnbRaw']['belgeNo'] : null);
        if (belgeNo != null) byBelgeNo[belgeNo.toString().trim()] = doc;
      }

      final resolved = <Map<String, dynamic>>[];
      final missing = <String>[];

      for (final id in ids) {
        final found = byId[id];
        if (found != null && !resolved.any((d) => d['id'] == id)) {
          resolved.add(found);
        }
      }
      for (final no in belgeNos) {
        final found = byBelgeNo[no];
        if (found != null && !resolved.any((d) => d['id'] == found['id'])) {
          resolved.add(found);
        } else if (found == null && !missing.contains(no)) {
          missing.add(no);
        }
      }

      setState(() {
        relatedDespatches = resolved;
        relatedMissing = missing;
        relatedLoading = false;
      });
    } catch (e) {
      setState(() {
        relatedError = e.toString();
        relatedLoading = false;
      });
    }
  }

  void _openDespatchDetail(Map<String, dynamic> despatch) {
    final id = despatch['id'];
    if (id == null || id.toString().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('İrsaliye ID bulunamadı.')),
      );
      return;
    }
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => QnbDocDetailScreen(
          api: widget.api,
          doc: despatch,
          docId: id.toString(),
        ),
      ),
    );
  }

  Widget _buildBelgeOzetContent(Map<String, dynamic> belgeOzet) {
    final belgeBilgileri = belgeOzet['belgeBilgileri'] as Map<String, dynamic>?;
    final gonderici = belgeOzet['gonderici'] as Map<String, dynamic>?;
    final alici = belgeOzet['alici'] as Map<String, dynamic>?;
    final satir = belgeOzet['irsaliyeSatiri'] as Map<String, dynamic>?;
    final satirlar = belgeOzet['irsaliyeSatirlari'] as List?;

    final parts = <Widget>[];

    if (belgeBilgileri != null) {
      final issueRaw = belgeBilgileri['IssueDate'];
      final issueLabel = formatTurkishDate(issueRaw, empty: '');
      if (issueLabel.isNotEmpty) {
        parts.add(Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Text('Tarih: $issueLabel', style: const TextStyle(fontWeight: FontWeight.w500)),
        ));
      }
    }
    if (gonderici != null) {
      final unvan = gonderici['Unvan']?.toString();
      if (unvan != null && unvan.isNotEmpty) {
        parts.add(Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: Text('Gönderen: $unvan', style: const TextStyle(fontSize: 13)),
        ));
      }
    }
    if (alici != null) {
      final unvan = alici['Unvan']?.toString();
      if (unvan != null && unvan.isNotEmpty) {
        parts.add(Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: Text('Alıcı: $unvan', style: const TextStyle(fontSize: 13)),
        ));
      }
    }
    if (satir != null || (satirlar != null && satirlar.isNotEmpty)) {
      final list = satirlar ?? (satir != null ? [satir] : null);
      if (list != null && list.isNotEmpty) {
        parts.add(const Padding(
          padding: EdgeInsets.only(top: 6, bottom: 4),
          child: Text('Satırlar', style: TextStyle(fontWeight: FontWeight.w500, fontSize: 12)),
        ));
        for (final s in list.take(10)) {
          if (s is! Map) continue;
          final m = (s as Map).cast<String, dynamic>();
          final name = m['Item'] is Map ? (m['Item'] as Map)['Name']?.toString() : null;
          final qty = m['DeliveredQuantity']?.toString();
          final line = name != null ? (qty != null ? '$name — Miktar: $qty' : name) : (qty != null ? 'Miktar: $qty' : null);
          if (line != null) {
            parts.add(Padding(
              padding: const EdgeInsets.only(left: 8, bottom: 2),
              child: Text(line, style: const TextStyle(fontSize: 12)),
            ));
          }
        }
        if (list.length > 10) {
          parts.add(Padding(
            padding: const EdgeInsets.only(left: 8, top: 2),
            child: Text('+ ${list.length - 10} satır daha', style: const TextStyle(fontSize: 11, color: Colors.black54)),
          ));
        }
      }
    }

    if (parts.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: parts,
    );
  }

  Widget _buildRelatedSection() {
    if (widget.doc['type'] != 'invoice') return const SizedBox.shrink();
    final hasViews = relatedDespatchViews.isNotEmpty;
    final ids = _relatedDespatchIds();
    final belgeNos = _relatedBelgeNos();
    final hasLegacy = relatedDespatches.isNotEmpty || ids.isNotEmpty || belgeNos.isNotEmpty;
    if (!hasViews && !hasLegacy && !relatedLoading && relatedError == null) return const SizedBox.shrink();

    final count = hasViews ? relatedDespatchViews.length : (relatedDespatches.isNotEmpty ? relatedDespatches.length : (ids.isNotEmpty ? ids.length : belgeNos.length));
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
      child: Card(
        elevation: 2,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(Icons.local_shipping, size: 20),
                  const SizedBox(width: 8),
                  Text(
                    'İlgili irsaliyeler ($count)',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ],
              ),
              const SizedBox(height: 8),
              if (relatedLoading) const LinearProgressIndicator(),
              if (relatedError != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    relatedError!,
                    style: const TextStyle(color: Colors.red),
                  ),
                ),
              if (!relatedLoading && relatedError == null) ...[
                if (hasViews)
                  ...relatedDespatchViews.map(
                    (v) {
                      final hasOzet = v.belgeOzet != null && v.belgeOzet!.isNotEmpty;
                      return Card(
                        margin: const EdgeInsets.only(bottom: 8),
                        child: ExpansionTile(
                          leading: const Icon(Icons.description, size: 28),
                          title: Text('İrsaliye No: ${v.belgeNo.isEmpty ? v.id : v.belgeNo}'),
                          subtitle: v.issueDate != null && v.issueDate!.trim().isNotEmpty
                              ? Text(
                                  'Tarih: ${formatTurkishDate(v.issueDate)}',
                                  style: const TextStyle(fontSize: 12),
                                )
                              : null,
                          children: [
                            Padding(
                              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                              child: hasOzet
                                  ? _buildBelgeOzetContent(v.belgeOzet!)
                                  : const Text('Görüntü özeti yok.', style: TextStyle(color: Colors.black54)),
                            ),
                          ],
                        ),
                      );
                    },
                  ),
                if (!hasViews && relatedDespatches.isEmpty && relatedMissing.isEmpty)
                  const Text('İlişkili irsaliye bulunamadı.'),
                if (!hasViews)
                  ...relatedDespatches.map(
                    (despatch) {
                      final raw = despatch['qnbRaw'];
                      final belgeNo = raw is Map && raw['belgeNo'] != null
                          ? raw['belgeNo'].toString()
                          : despatch['belgeNo']?.toString() ?? '';
                      final gonderen = _gonderenAdi(despatch);
                      return ListTile(
                        dense: true,
                        contentPadding: EdgeInsets.zero,
                        leading: const Icon(Icons.description, size: 28),
                        title: Text('İrsaliye No: ${belgeNo.isEmpty ? despatch['externalId'] ?? '—' : belgeNo}'),
                        subtitle: Text(gonderen.isNotEmpty ? 'Gönderen: $gonderen' : _formatDespatchSubtitle(despatch)),
                        trailing: const Icon(Icons.chevron_right),
                        onTap: () => _openDespatchDetail(despatch),
                      );
                    },
                  ),
                if (relatedMissing.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(
                      'Bulunamadı: ${relatedMissing.join(', ')}',
                      style: const TextStyle(color: Colors.black54),
                    ),
                  ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _approve(String action) async {
    try {
      await widget.api.approve(
        docId: widget.docId,
        action: action,
        note: noteCtrl.text,
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(action == 'APPROVED' ? 'Onaylandı' : 'Reddedildi')),
        );
        Navigator.pop(context);
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.toString())),
      );
    }
  }

  @override
  void dispose() {
    noteCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final title = (widget.doc['type'] == 'despatch' ? 'İrsaliye' : 'Fatura') +
        ' ' +
        (widget.doc['belgeNo'] ?? '');

    return Scaffold(
      appBar: AppBar(
        title: Text(title),
        actions: [IconButton(onPressed: _loadPdf, icon: const Icon(Icons.refresh))],
      ),
      body: Column(
        children: [
          Expanded(
            child: loading
                ? const Center(child: CircularProgressIndicator())
                : error != null
                ? Center(child: Text(error!))
                : PdfPreview(
              build: (format) async => pdfBytes!,
              canChangePageFormat: false,
              canChangeOrientation: false,
            ),
          ),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 380),
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _buildRelatedSection(),
                  Padding(
                    padding: const EdgeInsets.all(12),
                    child: TextField(
                      controller: noteCtrl,
                      decoration: const InputDecoration(
                        labelText: 'Not (opsiyonel)',
                        border: OutlineInputBorder(),
                      ),
                      minLines: 1,
                      maxLines: 3,
                    ),
                  ),
                ],
              ),
            ),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: () => _approve('REJECTED'),
                      child: const Text('Reddet'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: ElevatedButton(
                      onPressed: () => _approve('APPROVED'),
                      child: const Text('Onayla'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}