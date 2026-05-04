import 'package:flutter/material.dart';
import '../services/qnb_api.dart';
import 'qnb_doc_detail_screen.dart';
import 'son_10_fatura_screen.dart';

class QnbDocsScreen extends StatefulWidget {
  const QnbDocsScreen({super.key, required this.api});
  final QnbApi api;

  @override
  State<QnbDocsScreen> createState() => _QnbDocsScreenState();
}

class _QnbDocsScreenState extends State<QnbDocsScreen> {
  bool loading = true;
  String? error;
  List<Map<String, dynamic>> docs = [];
  bool syncing = false;
  String? syncMessage;
  bool enriching = true;
  bool fetchingDespatch = false;
  bool syncingAllInvoices = false;
  int totalInvoicesFetched = 0;
  bool syncingAllDespatches = false;
  int totalDespatchesFetched = 0;
  bool savingInvoiceUbl = false;
  final irsaliyeNoController = TextEditingController(text: 'BRS2026000000074');
  final irsaliyeTarihController = TextEditingController(text: '2026-01-28');
  final irsaliyeEttnController = TextEditingController();

  String type = 'invoice'; // Ekranda fatura listesi göster
  String status = 'ALL';

  @override
  void initState() {
    super.initState();
    _load();
    _runSyncAndEnrich2026(); // Uygulama açılışında yalnızca syncAndEnrichInvoices2026 çalışır
  }

  /// 2026 faturalarını sync + enrich eder (syncAndEnrichInvoices2026); hasMore false olana kadar tekrar çağrılır.
  Future<void> _runSyncAndEnrich2026() async {
    if (syncing) return;
    if (!mounted) return;
    setState(() {
      syncing = true;
      syncingAllInvoices = true;
      totalInvoicesFetched = 0;
      syncMessage = null;
    });
    int total = 0;
    int? start;
    const pageSize = 1000;
    const windowDays = 7;
    bool hasMore = true;
    int rounds = 0;
    try {
      while (mounted && hasMore && rounds < 500) {
        rounds++;
        try {
          final result = await widget.api.syncAndEnrichInvoices2026(
            start: start,
            pageSize: pageSize,
            windowDays: windowDays,
          );
          final fetched = (result['fetchedInThisCall'] as num?)?.toInt() ?? 0;
          total += fetched;
          if (mounted) setState(() => totalInvoicesFetched = total);
          hasMore = result['hasMore'] == true;
          if (!hasMore) break;
          final next = (result['nextStart'] as num?)?.toInt();
          if (next == null) break;
          if (start != null && next <= start) break;
          start = next;
        } catch (e) {
          if (mounted) {
            setState(() {
              syncing = false;
              syncingAllInvoices = false;
              syncMessage = e.toString();
            });
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('syncAndEnrich2026 hatası: $e')),
            );
          }
          return;
        }
      }
      if (mounted) {
        setState(() {
          syncing = false;
          syncingAllInvoices = false;
          syncMessage = total > 0 ? '2026 faturaları güncellendi: $total adet' : 'Yeni fatura yok';
        });
        _load();
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          syncing = false;
          syncingAllInvoices = false;
          syncMessage = e.toString();
        });
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('syncAndEnrich2026 hatası: $e')),
        );
      }
    }
  }

  /// Portaldaki tüm irsaliyeleri sayfalı çeker; hasMore false olana kadar tekrar çağrılır.
  Future<void> _syncAllDespatchesRecursive() async {
    if (syncingAllDespatches) return;
    if (!mounted) return;
    setState(() {
      syncingAllDespatches = true;
      totalDespatchesFetched = 0;
    });
    int? start; // null ise sunucu en son kaldığı yerden devam eder
    const pageSize = 1000;
    int total = 0;
    try {
      while (mounted) {
        final r = await widget.api.syncAllDespatches(start: start, pageSize: pageSize);
        final success = r['success'] == true;
        if (!success) break;
        final fetched = (r['fetchedInThisCall'] as num?)?.toInt() ?? 0;
        total += fetched;
        if (mounted) setState(() => totalDespatchesFetched = total);
        final hasMore = r['hasMore'] == true;
        if (!hasMore) break;
        final next = (r['nextStart'] as num?)?.toInt();
        if (next == null) break;
        if (start != null && next <= start) break;
        start = next;
      }
      if (mounted) {
        setState(() => syncingAllDespatches = false);
        _load();
        if (total > 0) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('İrsaliyeler güncellendi: $total adet')),
          );
        }
      }
    } catch (e) {
      if (mounted) {
        setState(() => syncingAllDespatches = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('İrsaliye sync hatası: $e')),
        );
      }
    }
  }

  @override
  void dispose() {
    irsaliyeNoController.dispose();
    irsaliyeTarihController.dispose();
    irsaliyeEttnController.dispose();
    super.dispose();
  }

  Future<void> _runSync() async {
    if (syncing) return;
    setState(() {
      syncing = true;
      syncingAllInvoices = true;
      totalInvoicesFetched = 0;
      syncMessage = null;
    });
    int total = 0;
    int? start; // null => backend state'ten devam
    const pageSize = 50;
    bool hasMoreInvoices = true;
    int rounds = 0;
    try {
      // İrsaliye akışıyla birebir: hasMore/nextStart ile recursive sayfalama.
      while (mounted && hasMoreInvoices && rounds < 500) {
        rounds++;
        try {
          final y = DateTime.now().year;
          final result = await widget.api.syncAllInvoices(
            start: start,
            pageSize: pageSize,
            windowDays: 7,
            enrich: true,
            year: y,
          );
          final fetched = (result['fetchedInThisCall'] as num?)?.toInt() ?? 0;
          total += fetched;
          if (mounted) setState(() => totalInvoicesFetched = total);
          hasMoreInvoices = result['hasMore'] == true;
          if (!hasMoreInvoices) break;
          final next = (result['nextStart'] as num?)?.toInt();
          if (next == null) break;
          if (start != null && next <= start) break;
          start = next;
        } catch (_) {
          // syncAllInvoices endpointine erişilemezse (anlık ağ/CORS) eski endpoint ile devam et.
          final fallback = await widget.api.syncDocs(type: 'invoice');
          final invoice = fallback['invoice'];
          final fetched = invoice is Map ? (invoice['fetchedCount'] as num?)?.toInt() ?? 0 : 0;
          total += fetched;
          if (mounted) setState(() => totalInvoicesFetched = total);
          hasMoreInvoices = fallback['hasMoreInvoices'] == true;
          if (!hasMoreInvoices) break;
        }
      }
      if (mounted) {
        setState(() {
          syncing = false;
          syncingAllInvoices = false;
          syncMessage = total > 0 ? 'Faturalar güncellendi: $total adet' : 'Yeni fatura yok';
        });
        _load();

        // Emniyet kemeri: Senkron sonrası (seçilen yıl/current year) eksik faturaları toplu zenginleştir.
        // Not: Backend tarafında enrichInvoiceWithRelatedDespatches?batch=1&year=YYYY desteklemelidir.
        try {
          final y = DateTime.now().year;
          await widget.api.enrichInvoicesBatch(limit: 20, year: y);
        } catch (_) {
          // UI akışını bozmasın
        }
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          syncing = false;
          syncingAllInvoices = false;
          syncMessage = e.toString();
        });
      }
    }
  }

  Future<void> _fetchAndSaveDespatch() async {
    if (fetchingDespatch) return;
    final belgeNo = irsaliyeNoController.text.trim();
    if (belgeNo.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('İrsaliye numarası girin')),
      );
      return;
    }
    setState(() {
      fetchingDespatch = true;
      syncMessage = null;
    });
    final tarih = irsaliyeTarihController.text.trim();
    final ettn = irsaliyeEttnController.text.trim();
    try {
      final result = await widget.api.fetchAndSaveDespatchByBelgeNo(
        belgeNo,
        tarih: tarih.isEmpty ? null : tarih,
        ettn: ettn.isEmpty ? null : ettn,
      );
      final ok = result['ok'] == true;
      final message = result['message'] as String? ?? (ok ? 'Kaydedildi' : 'Hata');
      if (mounted) {
        setState(() {
          fetchingDespatch = false;
          syncMessage = ok ? 'İrsaliye indirildi ve kaydedildi: $belgeNo' : message;
        });
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(ok ? 'İrsaliye $belgeNo kaydedildi' : message),
            backgroundColor: ok ? Colors.green : null,
          ),
        );
        if (ok) _load();
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          fetchingDespatch = false;
          syncMessage = e.toString();
        });
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Hata: $e'), backgroundColor: Colors.red),
        );
      }
    }
  }

  Future<void> _runEnrichBatch() async {
    if (enriching) return;
    setState(() { enriching = true; syncMessage = null; });
    try {
      final result = await widget.api.enrichInvoicesBatch(limit: 10);
      final n = result['enriched'] as int? ?? 0;
      if (mounted) {
        setState(() {
          enriching = false;
          syncMessage = n > 0 ? '$n faturaya irsaliye eşlendi' : 'Eşlenecek yeni fatura yok';
        });
        _load();
      }
    } catch (e) {
      if (mounted) {
        setState(() { enriching = false; syncMessage = e.toString(); });
      }
    }
  }

  String _invoiceEttn(Map<String, dynamic> d) {
    final candidates = [
      d['ettn'],
      d['uuid'],
      d['externalId'],
      d['documentUuid'],
      (d['qnbRaw'] is Map ? (d['qnbRaw'] as Map)['ettn'] : null),
      (d['qnbRaw'] is Map ? (d['qnbRaw'] as Map)['uuid'] : null),
      (d['qnbRaw'] is Map ? (d['qnbRaw'] as Map)['externalId'] : null),
    ];
    for (final c in candidates) {
      final s = c?.toString().trim();
      if (s != null && s.isNotEmpty) return s;
    }
    return '';
  }

  Future<void> _saveListedInvoicesUblByEttn() async {
    if (savingInvoiceUbl) return;
    final invoices = docs.where((d) => d['type'] == 'invoice').toList();
    if (invoices.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Listede fatura bulunamadı')),
      );
      return;
    }

    setState(() {
      savingInvoiceUbl = true;
      syncMessage = null;
    });

    int updated = 0;
    int skipped = 0;
    int failed = 0;
    try {
      for (final invoice in invoices) {
        final docId = invoice['id']?.toString() ?? '';
        final ettn = _invoiceEttn(invoice);
        if (docId.isEmpty || ettn.isEmpty) {
          skipped++;
          continue;
        }
        try {
          final result = await widget.api.fetchAndSaveInvoiceByEttn(
            docId: docId,
            ettn: ettn,
          );
          final ok = result['ok'] == true || result['success'] == true;
          if (ok) {
            updated++;
          } else {
            failed++;
          }
        } catch (_) {
          failed++;
        }
      }

      if (mounted) {
        setState(() {
          savingInvoiceUbl = false;
          syncMessage =
              'UBL kaydı tamamlandı: $updated güncellendi, $skipped atlandı, $failed hata';
        });
        _load();
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          savingInvoiceUbl = false;
          syncMessage = 'UBL kaydı hatası: $e';
        });
      }
    }
  }

  Future<void> _load() async {
    setState(() {
      loading = true;
      error = null;
    });
    // Debug: Son faturanın irsaliye numarasını Flutter konsoluna yazdır
    widget.api.debugLastInvoiceIrsaliye().catchError((e) {
      debugPrint('[debugLastInvoiceIrsaliye] Hata: $e');
    });

    try {
      final data = await widget.api.listDocs(
        type: type,
        status: status,
        limit: 20,
        includeRelatedDespatches: true,
      );
      final sorted = List<Map<String, dynamic>>.from(data)
        ..sort((a, b) => _docDateOrMin(b).compareTo(_docDateOrMin(a)));
      setState(() {
        docs = sorted.take(20).toList();
        loading = false;
      });
    } catch (e) {
      setState(() {
        error = e.toString();
        loading = false;
      });
    }
  }

  DateTime _docDateOrMin(Map<String, dynamic> d) {
    final candidates = [
      d['issueDate'],
      d['createdAt'],
      d['updatedAt'],
      (d['qnbRaw'] is Map ? (d['qnbRaw'] as Map)['issueDate'] : null),
      (d['qnbRaw'] is Map ? (d['qnbRaw'] as Map)['createdAt'] : null),
    ];
    for (final c in candidates) {
      final parsed = _parseAnyDate(c);
      if (parsed != null) return parsed;
    }
    return DateTime.fromMillisecondsSinceEpoch(0);
  }

  DateTime? _parseAnyDate(dynamic raw) {
    if (raw == null) return null;
    if (raw is DateTime) return raw;
    if (raw is int) return DateTime.fromMillisecondsSinceEpoch(raw);
    if (raw is String) {
      final t = DateTime.tryParse(raw);
      if (t != null) return t;
      final match = RegExp(r'^(\d{2})\.(\d{2})\.(\d{4})$').firstMatch(raw.trim());
      if (match != null) {
        final day = int.tryParse(match.group(1)!);
        final month = int.tryParse(match.group(2)!);
        final year = int.tryParse(match.group(3)!);
        if (day != null && month != null && year != null) {
          return DateTime(year, month, day);
        }
      }
      return null;
    }
    if (raw is Map) {
      final ms = raw['_milliseconds'] ?? raw['milliseconds'];
      if (ms is int) return DateTime.fromMillisecondsSinceEpoch(ms);
      final seconds = raw['_seconds'] ?? raw['seconds'];
      if (seconds is int) {
        return DateTime.fromMillisecondsSinceEpoch(seconds * 1000);
      }
    }
    return null;
  }

  /// UBL'den gelen belgeNo öncelikli (enrich sonrası); yoksa qnbRaw.belgeNo veya externalId
  String _belgeNo(Map<String, dynamic> d) {
    final topBelgeNo = d['belgeNo']?.toString().trim();
    if (topBelgeNo != null && topBelgeNo.isNotEmpty) return topBelgeNo;
    final raw = d['qnbRaw'];
    if (raw is Map && raw['belgeNo'] != null) {
      final s = raw['belgeNo'].toString().trim();
      if (s.isNotEmpty) return s;
    }
    return d['externalId']?.toString() ?? '';
  }

  String _title(Map<String, dynamic> d) {
    final t = d['type'] == 'despatch' ? 'İrsaliye' : 'Fatura';
    final no = _belgeNo(d);
    if (no.isEmpty) return t;
    return '$t No: $no';
  }

  /// Gösterim için geçerli ünvan/isim: mail adresi veya urn:mail: ise gönderen adı olarak gösterme
  static bool _gecerliGonderenAdi(String? s) {
    if (s == null || s.trim().isEmpty) return false;
    final t = s.trim().toLowerCase();
    if (t.startsWith('urn:mail:')) return false;
    if (t.contains('@') && t.contains('.') && !t.contains(' ')) return false;
    return true;
  }

  /// Gönderen: önce ünvan/ad, mail adresi veya urn:mail: hiç gösterilmez; yoksa VKN
  String _gonderen(Map<String, dynamic> d) {
    final raw = d['qnbRaw'] as Map?;

    final unvanCandidates = [
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
    for (final c in unvanCandidates) {
      final s = c?.toString().trim();
      if (s != null && s.isNotEmpty && _gecerliGonderenAdi(s)) return s;
    }

    final vkn = d['supplierVkn']?.toString().trim();
    if (vkn != null && vkn.isNotEmpty) return 'VKN: $vkn';
    return '—';
  }

  String _tutarVeDurum(Map<String, dynamic> d) {
    final total = d['total'];
    final cur = d['currency'] ?? '';
    final st = d['status'] ?? '';
    final totalStr = total == null ? '' : '$total $cur'.trim();
    if (totalStr.isEmpty && st.isEmpty) return '';
    if (totalStr.isEmpty) return st;
    return '$totalStr  •  $st';
  }

  String? _asNonEmptyString(dynamic v) {
    final s = v?.toString().trim();
    if (s == null || s.isEmpty) return null;
    return s;
  }

  /// Faturaya bağlı irsaliye numaralarını tüm olası kaynaklardan toplar.
  List<String> _collectRelatedDespatchNos(
    Map<String, dynamic> d,
    List<Map<String, dynamic>> relatedDespatches,
  ) {
    final nos = <String>{};

    final relatedBelgeNos = d['relatedBelgeNos'];
    if (relatedBelgeNos is List) {
      for (final n in relatedBelgeNos) {
        final s = _asNonEmptyString(n);
        if (s != null) nos.add(s);
      }
    }

    for (final rel in relatedDespatches) {
      final s1 = _asNonEmptyString(rel['belgeNo']);
      if (s1 != null) nos.add(s1);
      final s2 = _asNonEmptyString(rel['docNo']);
      if (s2 != null) nos.add(s2);
      final ozet = rel['belgeOzet'];
      if (ozet is Map) {
        final s3 = _asNonEmptyString(ozet['belgeNo']);
        if (s3 != null) nos.add(s3);
      }
    }

    final ubl = d['ublParsed'];
    if (ubl is Map) {
      final refs = (ubl['Invoice'] is Map
              ? (ubl['Invoice'] as Map)['DespatchDocumentReference']
              : null) ??
          ubl['DespatchDocumentReference'];
      final refList = refs is List ? refs : (refs != null ? [refs] : <dynamic>[]);
      for (final r in refList) {
        if (r is Map) {
          final s = _asNonEmptyString(r['ID']);
          if (s != null) nos.add(s);
        } else {
          final s = _asNonEmptyString(r);
          if (s != null) nos.add(s);
        }
      }
    }

    return nos.toList();
  }

  @override
  Widget build(BuildContext context) {
    final despatchByBelgeNo = <String, Map<String, dynamic>>{};
    for (final d in docs) {
      if (d['type'] == 'despatch' && d['belgeNo'] != null) {
        despatchByBelgeNo[d['belgeNo'].toString()] = d;
      }
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('QNB Belgeler'),
        actions: [
          IconButton(
            onPressed: () {
              Navigator.push(
                context,
                MaterialPageRoute<void>(
                  builder: (_) => Son10FaturaScreen(api: widget.api),
                ),
              );
            },
            icon: const Icon(Icons.cloud_download_outlined),
            tooltip: 'Portal: son 10 gelen fatura',
          ),
          IconButton(
            onPressed: savingInvoiceUbl ? null : _saveListedInvoicesUblByEttn,
            icon: savingInvoiceUbl
                ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.description),
            tooltip: 'Listedeki faturaların UBL\'lerini kaydet',
          ),
          IconButton(
            onPressed: enriching ? null : _runEnrichBatch,
            icon: enriching
                ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.link),
            tooltip: 'Faturalara irsaliye eşle',
          ),
          IconButton(
            onPressed: syncing ? null : _runSyncAndEnrich2026,
            icon: syncing
                ? const SizedBox(
                    width: 24,
                    height: 24,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.sync),
            tooltip: 'QNB\'den senkronize et',
          ),
          IconButton(onPressed: _load, icon: const Icon(Icons.refresh), tooltip: 'Listeyi yenile'),
        ],
      ),
      body: Column(
        children: [
          if (syncingAllInvoices)
            Material(
              color: Colors.green.shade100,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                child: Row(
                  children: [
                    const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)),
                    const SizedBox(width: 12),
                    Text('Faturalar çekiliyor... $totalInvoicesFetched adet', style: const TextStyle(fontSize: 13)),
                  ],
                ),
              ),
            ),
          if (syncingAllDespatches)
            Material(
              color: Colors.blue.shade100,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                child: Row(
                  children: [
                    const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)),
                    const SizedBox(width: 12),
                    Text('İrsaliyeler çekiliyor... $totalDespatchesFetched adet', style: const TextStyle(fontSize: 13)),
                  ],
                ),
              ),
            ),
          if (syncMessage != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
              child: Text(
                syncMessage!,
                style: TextStyle(
                  color: syncMessage!.startsWith('Sync tamamlandı') || syncMessage!.contains('kaydedildi') ? Colors.green : Colors.red,
                  fontSize: 12,
                ),
              ),
            ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          flex: 2,
                          child: TextField(
                            controller: irsaliyeNoController,
                            decoration: const InputDecoration(
                              labelText: 'İrsaliye no',
                              hintText: 'BRS2026000000074',
                              border: OutlineInputBorder(),
                              isDense: true,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: TextField(
                            controller: irsaliyeTarihController,
                            decoration: const InputDecoration(
                              labelText: 'Tarih',
                              hintText: '2026-01-28',
                              border: OutlineInputBorder(),
                              isDense: true,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    TextField(
                      controller: irsaliyeEttnController,
                      decoration: const InputDecoration(
                        labelText: 'ETTN (opsiyonel)',
                        hintText: 'Listede yoksa fatura detayından veya portaldan yapıştırın',
                        border: OutlineInputBorder(),
                        isDense: true,
                      ),
                    ),
                    const SizedBox(height: 8),
                    ElevatedButton.icon(
                      onPressed: fetchingDespatch ? null : _fetchAndSaveDespatch,
                      icon: fetchingDespatch
                          ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                          : const Icon(Icons.download),
                      label: const Text('İndir ve kaydet (numara + tarih ile portala sorgula)'),
                    ),
                  ],
                ),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              children: [
                Expanded(
                  child: DropdownButtonFormField<String>(
                    value: status,
                    items: const [
                      DropdownMenuItem(value: 'PENDING', child: Text('Bekleyen')),
                      DropdownMenuItem(value: 'APPROVED', child: Text('Onaylı')),
                      DropdownMenuItem(value: 'REJECTED', child: Text('Reddedilmiş')),
                      DropdownMenuItem(value: 'ALL', child: Text('Tümü')),
                    ],
                    onChanged: (v) {
                      if (v == null) return;
                      setState(() => status = v);
                      _load();
                    },
                    decoration: const InputDecoration(labelText: 'Durum'),
                  ),
                ),
              ],
            ),
          ),
          Expanded(
            child: loading
                ? const Center(child: CircularProgressIndicator())
                : error != null
                ? Center(child: Text(error!))
                : ListView.separated(
              itemCount: docs.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (context, i) {
                final d = docs[i];

                // Öncelikle backend'in doğrudan döndürdüğü relatedDespatches alanını kullan
                List<Map<String, dynamic>> relatedDespatches = [];
                final rawRelated = d['relatedDespatches'];
                if (rawRelated is List) {
                  for (final x in rawRelated) {
                    if (x is Map) {
                      relatedDespatches.add((x as Map).cast<String, dynamic>());
                    }
                  }
                }

                // Eğer backend tarafında henüz relatedDespatches yoksa
                // eski davranışa geri dön: relatedBelgeNos + belgeNo eşleşmesi
                if (relatedDespatches.isEmpty) {
                  final relatedNos = (d['relatedBelgeNos'] as List?)
                          ?.map((e) => e.toString())
                          .toList() ??
                      [];
                  relatedDespatches = relatedNos
                      .map((no) => despatchByBelgeNo[no])
                      .where((x) => x != null)
                      .cast<Map<String, dynamic>>()
                      .toList();
                }

                // Fatura için irsaliye numaraları: relatedBelgeNos + relatedDespatches + UBL refs
                String irsaliyeNosStr = '';
                if (d['type'] == 'invoice') {
                  final nos = _collectRelatedDespatchNos(d, relatedDespatches);
                  if (nos.isNotEmpty) {
                    irsaliyeNosStr = nos.join(', ');
                  }
                }

                final subtitle = Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${d['type'] == 'despatch' ? 'İrsaliye' : 'Fatura'} No: ${_belgeNo(d).isEmpty ? '—' : _belgeNo(d)}'),
                    if (d['type'] == 'invoice')
                      Text('İrsaliye No: ${irsaliyeNosStr.isEmpty ? '—' : irsaliyeNosStr}'),
                    Text('Gönderen: ${_gonderen(d)}'),
                    if (_tutarVeDurum(d).isNotEmpty)
                      Text(_tutarVeDurum(d), style: const TextStyle(fontSize: 12)),
                    if (d['type'] == 'invoice' && relatedDespatches.isNotEmpty) ...[
                      const SizedBox(height: 6),
                      Text(
                        'İrsaliyeler (${relatedDespatches.length})',
                        style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 12),
                      ),
                      ...relatedDespatches.map((rel) {
                        final belgeNo = rel['belgeNo']?.toString() ?? '';
                        final issueDate = rel['issueDate']?.toString() ?? '';
                        final supplierVkn = rel['supplierVkn']?.toString() ?? '';
                        final meta = [issueDate, supplierVkn]
                            .where((x) => x.isNotEmpty)
                            .join('  ');
                        return Text(
                          meta.isEmpty ? belgeNo : '$belgeNo  $meta',
                          style: const TextStyle(fontSize: 12),
                        );
                      }),
                    ],
                  ],
                );

                return ListTile(
                  title: Text(_title(d)),
                  subtitle: subtitle,
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () async {
                    final id = d['id'] as String;
                    Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (_) => QnbDocDetailScreen(api: widget.api, doc: d, docId: id),
                      ),
                    );
                  },
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}