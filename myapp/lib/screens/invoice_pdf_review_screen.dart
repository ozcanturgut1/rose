import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:pdf/pdf.dart';
import 'package:printing/printing.dart';

import '../services/qnb_api.dart';
import '../utils/open_bytes.dart';

String _safeDocKey(String s) => s.replaceAll(RegExp(r'[/\\]'), '_');

bool _looksLikePdf(Uint8List bytes) {
  if (bytes.length < 5) return false;
  return bytes[0] == 0x25 &&
      bytes[1] == 0x50 &&
      bytes[2] == 0x44 &&
      bytes[3] == 0x46;
}

class _PdfTab {
  const _PdfTab({
    required this.title,
    this.bytes,
    this.error,
  });

  final String title;
  final Uint8List? bytes;
  final String? error;
}

/// Fatura + ilgili irsaliye PDF/UBL önizlemesi ve yönetim onayı.
class InvoicePdfReviewScreen extends StatefulWidget {
  const InvoicePdfReviewScreen({
    super.key,
    required this.api,
    required this.item,
    this.userRole,
  });

  final QnbApi api;
  final Map<String, dynamic> item;

  /// [UserHomeRouter] / `user_profiles.role` (`ara_onay`, `nihai_onay`, `muhasebe`, `admin`, …).
  final String? userRole;

  @override
  State<InvoicePdfReviewScreen> createState() => _InvoicePdfReviewScreenState();
}

class _InvoicePdfReviewScreenState extends State<InvoicePdfReviewScreen> {
  late final Future<List<_PdfTab>> _tabsFuture;
  final TextEditingController _noteCtrl = TextEditingController();
  bool _saving = false;

  /// `ara_onay` / `nihai_onay` / `muhasebe`: sade görünüm (TabBarView); muhasebede alt çubukta not/onay/red yok.
  bool get _isMinimalApproverUi {
    final r =
        widget.userRole?.trim().toLowerCase().replaceAll(RegExp(r'\s+'), '_') ?? '';
    return r == 'ara_onay' || r == 'nihai_onay' || r == 'muhasebe';
  }

  /// Muhasebe: yalnızca önizleme; açıklama alanı ve Onayla/Reddet gösterilmez.
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

  /// Cloud Function notunu hangi Firestore açıklama alanına yazacağını belirtir.
  String? _aciklamaRoleForApi() {
    final r = _normalizedUserRole();
    if (r == 'ara_onay' || r == 'nihai_onay' || r == 'muhasebe' || r == 'admin') return r;
    return null;
  }

  @override
  void initState() {
    super.initState();
    _tabsFuture = _loadTabs();
  }

  @override
  void dispose() {
    _noteCtrl.dispose();
    super.dispose();
  }

  Future<List<_PdfTab>> _loadTabs() async {
    final belgeNo = (widget.item['belgeNo']?.toString() ?? '').trim();
    if (belgeNo.isEmpty) {
      return [const _PdfTab(title: 'Fatura', error: 'BelgeNo yok')];
    }
    final invoiceDocId = 'invoice_${_safeDocKey(belgeNo)}';
    final out = <_PdfTab>[];

    try {
      final b = await widget.api.fetchPdfBytes(invoiceDocId);
      out.add(_PdfTab(title: 'Fatura', bytes: b));
    } catch (e) {
      out.add(_PdfTab(title: 'Fatura', error: e.toString()));
    }

    try {
      final rel = await widget.api.getInvoiceRelatedDespatches(invoiceDocId);
      final list = rel['relatedDespatches'];
      final despatches = list is List
          ? list.map((e) => (e as Map).cast<String, dynamic>()).toList()
          : <Map<String, dynamic>>[];

      for (final d in despatches) {
        final dBelgeNo = (d['belgeNo']?.toString() ?? '').trim();
        if (dBelgeNo.isEmpty) continue;
        final despatchDocId = 'despatch_${_safeDocKey(dBelgeNo)}';
        try {
          final b = await widget.api.fetchPdfBytes(despatchDocId);
          out.add(_PdfTab(title: 'İrsaliye $dBelgeNo', bytes: b));
        } catch (e) {
          out.add(_PdfTab(title: 'İrsaliye $dBelgeNo', error: e.toString()));
        }
      }
    } catch (e) {
      out.add(_PdfTab(title: 'İrsaliyeler', error: e.toString()));
    }

    return out;
  }

  String get _invoiceDocId {
    final belgeNo = (widget.item['belgeNo']?.toString() ?? '').trim();
    return 'invoice_${_safeDocKey(belgeNo)}';
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

  Widget _buildPreviewBody(BuildContext context, _PdfTab t) {
    if (t.error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Text(t.error!, textAlign: TextAlign.center),
        ),
      );
    }
    final bytes = t.bytes;
    if (bytes == null || bytes.isEmpty) {
      return const Center(child: Text('İçerik boş'));
    }
    if (!_looksLikePdf(bytes)) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Text(
                'Bu belge PDF değil (ör. UBL/XML). Önizleme için yeni sekmede açabilirsiniz.',
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 12),
              FilledButton.tonal(
                onPressed: () async {
                  await openBytesInNewTab(
                    bytes,
                    mimeType: 'application/octet-stream',
                    fileName: '${t.title}.bin',
                  );
                },
                child: const Text('Yeni sekmede aç'),
              ),
            ],
          ),
        ),
      );
    }
    final maxW = MediaQuery.sizeOf(context).width;
    return PdfPreview(
      build: (PdfPageFormat format) async => bytes,
      canChangePageFormat: false,
      canChangeOrientation: false,
      allowPrinting: false,
      allowSharing: false,
      useActions: false,
      canDebug: false,
      padding: EdgeInsets.zero,
      previewPageMargin: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
      maxPageWidth: maxW,
    );
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

  static const double _ettnTabsBarHeight = 44;

  /// E-posta ise yalnızca `@` öncesi (ör. `tolga@app.com` → `tolga`); değilse aynen.
  static String _kullaniciEtiketi(String? raw) {
    final s = raw?.trim() ?? '';
    if (s.isEmpty) return '';
    final i = s.indexOf('@');
    if (i <= 0) return s;
    final local = s.substring(0, i).trim();
    return local.isNotEmpty ? local : s;
  }

  /// Üst çubukta: tüm dolu açıklamalar; başlıkta `*YazanAd` varsa o, yoksa sabit etiket.
  String _allOnayAciklamalarDisplayText() {
    final parts = <String>[];
    void addPart(String fallbackLabel, String textKey, String authorKey) {
      final v = widget.item[textKey]?.toString().trim();
      if (v == null || v.isEmpty) return;
      final ad = widget.item[authorKey]?.toString().trim();
      final label = (ad != null && ad.isNotEmpty)
          ? _kullaniciEtiketi(ad)
          : fallbackLabel;
      parts.add('$label: $v');
    }

    addPart('Ara', 'onayAciklamaAraOnay', 'onayAciklamaAraOnayYazanAd');
    addPart('Nihai', 'onayAciklamaNihaiOnay', 'onayAciklamaNihaiOnayYazanAd');
    addPart('Muh.', 'onayAciklamaMuhasebe', 'onayAciklamaMuhasebeYazanAd');
    addPart('Genel', 'onayAciklama', 'onayAciklamaYazanAd');
    if (parts.isEmpty) return '—';
    return parts.join(' · ');
  }

  /// Ara / nihai / muhasebe: üstte onay açıklamaları + Fatura/İrsaliye sekmeleri.
  PreferredSizeWidget _minimalApproverAppBar(BuildContext context, List<_PdfTab> tabs) {
    final theme = Theme.of(context);
    final display = _allOnayAciklamalarDisplayText();
    final tabStyle = theme.textTheme.labelSmall?.copyWith(fontSize: 11);

    return AppBar(
      titleSpacing: 4,
      centerTitle: false,
      toolbarHeight: 52,
      title: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            flex: 2,
            child: Text(
              display,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(height: 1.2),
            ),
          ),
          Expanded(
            flex: 3,
            child: TabBar(
              isScrollable: true,
              tabAlignment: TabAlignment.start,
              labelPadding: const EdgeInsets.symmetric(horizontal: 4),
              labelStyle: tabStyle,
              unselectedLabelStyle: tabStyle,
              tabs: tabs.map((t) => Tab(text: t.title)).toList(),
            ),
          ),
        ],
      ),
    );
  }

  /// ETTN metni ile Fatura / İrsaliye sekmeleri aynı satırda (admin).
  Widget _ettnAndTabsRow(BuildContext context, List<_PdfTab> tabs) {
    final theme = Theme.of(context);
    final ettn = widget.item['ettn'];
    final ettnStyle = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurface.withValues(alpha: 0.72),
    );
    final tabStyle = theme.textTheme.labelLarge?.copyWith(fontSize: 12);

    return Material(
      elevation: 1,
      color: theme.colorScheme.surfaceContainerLow,
      child: SizedBox(
        height: _ettnTabsBarHeight,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (ettn != null) ...[
              Expanded(
                flex: 4,
                child: Padding(
                  padding: const EdgeInsets.only(left: 12, right: 4),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      'ETTN: $ettn',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ettnStyle,
                    ),
                  ),
                ),
              ),
              VerticalDivider(
                width: 1,
                thickness: 1,
                indent: 6,
                endIndent: 6,
                color: theme.colorScheme.outlineVariant,
              ),
            ],
            Expanded(
              flex: ettn != null ? 5 : 1,
              child: TabBar(
                isScrollable: true,
                tabAlignment: TabAlignment.start,
                labelPadding: const EdgeInsets.symmetric(horizontal: 8),
                labelStyle: tabStyle,
                unselectedLabelStyle: tabStyle,
                tabs: tabs.map((t) => Tab(text: t.title)).toList(),
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final belgeNo = (widget.item['belgeNo']?.toString() ?? '').trim();
    final titleText = belgeNo.isNotEmpty ? belgeNo : 'Fatura';

    return FutureBuilder<List<_PdfTab>>(
      future: _tabsFuture,
      builder: (context, snapshot) {
        if (snapshot.connectionState == ConnectionState.waiting) {
          return Scaffold(
            appBar: _isMinimalApproverUi
                ? AppBar(
                    titleSpacing: 8,
                    toolbarHeight: 52,
                    title: Text(
                      _allOnayAciklamalarDisplayText(),
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(height: 1.2),
                    ),
                  )
                : AppBar(title: Text(titleText)),
            body: const Center(child: CircularProgressIndicator()),
            bottomNavigationBar: _isMuhasebe ? null : _bottomActions(context),
          );
        }
        if (snapshot.hasError) {
          return Scaffold(
            appBar: _isMinimalApproverUi
                ? AppBar(
                    titleSpacing: 8,
                    toolbarHeight: 52,
                    title: Text(
                      _allOnayAciklamalarDisplayText(),
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(height: 1.2),
                    ),
                  )
                : AppBar(title: Text(titleText)),
            body: Center(child: Text('${snapshot.error}')),
            bottomNavigationBar: _isMuhasebe ? null : _bottomActions(context),
          );
        }
        final tabs = snapshot.data ?? [];
        if (tabs.isEmpty) {
          return Scaffold(
            appBar: _isMinimalApproverUi
                ? AppBar(
                    titleSpacing: 8,
                    toolbarHeight: 52,
                    title: Text(
                      _allOnayAciklamalarDisplayText(),
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(height: 1.2),
                    ),
                  )
                : AppBar(title: Text(titleText)),
            body: const Center(child: Text('Gösterilecek belge yok')),
            bottomNavigationBar: _isMuhasebe ? null : _bottomActions(context),
          );
        }

        return DefaultTabController(
          length: tabs.length,
          child: Scaffold(
            appBar: _isMinimalApproverUi
                ? _minimalApproverAppBar(context, tabs)
                : AppBar(title: Text(titleText)),
            body: _isMinimalApproverUi
                ? TabBarView(
                    children: tabs.map((t) => _buildPreviewBody(context, t)).toList(),
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _ettnAndTabsRow(context, tabs),
                      Expanded(
                        child: TabBarView(
                          children: tabs.map((t) => _buildPreviewBody(context, t)).toList(),
                        ),
                      ),
                    ],
                  ),
            bottomNavigationBar: _isMuhasebe ? null : _bottomActions(context),
          ),
        );
      },
    );
  }
}
