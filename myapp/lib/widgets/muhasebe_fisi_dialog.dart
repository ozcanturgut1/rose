import 'package:flutter/material.dart';

import '../formatting/display_amount.dart';
import '../formatting/display_date.dart';

/// Muhasebe kullanıcısının arşive taşımadan önce gördüğü ETA mahsup fişi.
///
/// Veri `qnb_invoices.muhasebeFisi` alanından gelir; ETA SQL yerel ağda olduğu
/// için fiş, fatura kaydını yapan taraf (yerel worker / bulut trigger)
/// tarafından okunup Firestore'a yazılır. Bu widget ağ çağrısı yapmaz.
Future<void> showMuhasebeFisiDialog(
  BuildContext context, {
  required Map<String, dynamic>? fis,
  String? belgeNo,
}) {
  return showDialog<void>(
    context: context,
    builder: (ctx) => _MuhasebeFisiDialog(fis: fis, belgeNo: belgeNo),
  );
}

class _MuhasebeFisiDialog extends StatelessWidget {
  const _MuhasebeFisiDialog({required this.fis, this.belgeNo});

  final Map<String, dynamic>? fis;
  final String? belgeNo;

  static const double _borcAlacakColWidth = 110;

  String get _durum => fis?['durum']?.toString().trim().toLowerCase() ?? '';

  List<Map<String, dynamic>> get _satirlar {
    final raw = fis?['satirlar'];
    if (raw is! List) return const [];
    return raw
        .whereType<Object>()
        .map((e) => e is Map ? Map<String, dynamic>.from(e) : <String, dynamic>{})
        .where((m) => m.isNotEmpty)
        .toList();
  }

  @override
  Widget build(BuildContext context) {
    final belge = (belgeNo ?? '').trim();
    return AlertDialog(
      title: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text('Mahsup Fişi'),
          if (belge.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                belge,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
        ],
      ),
      content: SizedBox(
        width: _dialogGenisligi(context),
        child: _durum == 'ok' ? _buildFis(context) : _buildBosDurum(context),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Kapat'),
        ),
      ],
    );
  }

  /// Fiş oluşmamış veya ETA'da bulunamamış durumları açıklar.
  Widget _buildBosDurum(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final String mesaj;
    if (fis == null) {
      mesaj =
          'Bu fatura için mahsup fişi bilgisi kaydedilmemiş. Fatura, fiş kaydı '
          'bu özellik eklenmeden önce işlenmiş olabilir.';
    } else if (_durum == 'yok') {
      mesaj =
          'Fatura ETA\'ya kaydedilmiş ancak bir muhasebe fişine bağlanmamış. '
          'Arşive taşımadan önce ETA üzerinden kontrol edin.';
    } else if (_durum == 'bulunamadi') {
      final ref = parseNumLoose(fis?['muhFisRefNo'])?.toInt() ?? 0;
      mesaj =
          'Fiş referansı var (${ref > 0 ? ref : '—'}) ancak fiş ETA\'da bulunamadı; '
          'silinmiş olabilir. Arşive taşımadan önce ETA üzerinden kontrol edin.';
    } else {
      mesaj = 'Mahsup fişi bilgisi okunamadı.';
    }

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(Icons.info_outline, color: cs.error),
        const SizedBox(width: 10),
        Expanded(child: Text(mesaj)),
      ],
    );
  }

  static const double _genisEkranGenisligi = 720;

  /// Geniş ekranda sabit; dar ekranda ekranın %90'ı (taşmayı önler).
  static double _dialogGenisligi(BuildContext context) {
    final w = MediaQuery.of(context).size.width;
    return w < _genisEkranGenisligi + 40 ? w * 0.9 : _genisEkranGenisligi;
  }

  Widget _buildFis(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        _buildBaslik(context),
        const SizedBox(height: 12),
        ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.of(context).size.height * 0.45,
          ),
          child: SingleChildScrollView(
            child: _buildSatirTablosu(context),
          ),
        ),
        const Divider(height: 20),
        _buildToplamlar(context),
      ],
    );
  }

  Widget _buildBaslik(BuildContext context) {
    final fisNo = (fis?['fisNo']?.toString() ?? '').trim();
    final yevmiyeNo = parseNumLoose(fis?['yevmiyeNo'])?.toInt() ?? 0;
    final okunma = fis?['okunmaTarihi'];

    return Wrap(
      spacing: 20,
      runSpacing: 6,
      children: [
        _alan(context, 'Fiş No', fisNo.isEmpty ? '—' : fisNo),
        _alan(context, 'Fiş Tarihi', formatTurkishDate(fis?['fisTarih'])),
        // Yevmiye numarası ETA'da yevmiye numaralandırması yapılana kadar 0 kalır.
        _alan(
          context,
          'Yevmiye No',
          yevmiyeNo > 0 ? yevmiyeNo.toString() : 'Numaralandırılmamış',
        ),
        if (okunma != null)
          _alan(context, 'Fiş Okunma', formatTurkishDate(okunma)),
      ],
    );
  }

  Widget _alan(BuildContext context, String etiket, String deger) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          etiket,
          style: Theme.of(context).textTheme.labelSmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
        ),
        Text(deger, style: const TextStyle(fontWeight: FontWeight.w600)),
      ],
    );
  }

  Widget _buildSatirTablosu(BuildContext context) {
    final satirlar = _satirlar;
    if (satirlar.isEmpty) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 8),
        child: Text('Fişte satır bulunmuyor.'),
      );
    }

    return Table(
      columnWidths: const {
        0: FlexColumnWidth(),
        1: FixedColumnWidth(_borcAlacakColWidth),
        2: FixedColumnWidth(_borcAlacakColWidth),
      },
      defaultVerticalAlignment: TableCellVerticalAlignment.middle,
      children: [
        _baslikSatiri(context),
        for (final s in satirlar) _tabloSatiri(context, s),
      ],
    );
  }

  TableRow _baslikSatiri(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final style = TextStyle(fontWeight: FontWeight.w600, color: cs.onSurfaceVariant, fontSize: 12);
    return TableRow(
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: cs.outlineVariant)),
      ),
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Text('Hesap', style: style),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Text('Borç', style: style, textAlign: TextAlign.right),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Text('Alacak', style: style, textAlign: TextAlign.right),
        ),
      ],
    );
  }

  TableRow _tabloSatiri(BuildContext context, Map<String, dynamic> s) {
    final cs = Theme.of(context).colorScheme;
    final kod = (s['hesapKodu']?.toString() ?? '').trim();
    final ad = (s['hesapAdi']?.toString() ?? '').trim();
    final aciklama = (s['aciklama']?.toString() ?? '').trim();
    final baTipi = parseNumLoose(s['baTipi'])?.toInt() ?? 0;
    final tutar = parseNumLoose(s['tutar']);
    final tutarStr = formatTurkishAmount(tutar);

    return TableRow(
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: cs.outlineVariant.withValues(alpha: 0.5))),
      ),
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                kod.isEmpty ? '—' : kod,
                style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.w600),
              ),
              if (ad.isNotEmpty)
                Text(ad, style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant)),
              if (aciklama.isNotEmpty && aciklama != ad)
                Text(
                  aciklama,
                  style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
            ],
          ),
        ),
        _tutarHucresi(baTipi == 1 ? tutarStr : ''),
        _tutarHucresi(baTipi == 2 ? tutarStr : ''),
      ],
    );
  }

  Widget _tutarHucresi(String metin) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Text(metin, textAlign: TextAlign.right),
    );
  }

  Widget _buildToplamlar(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final borc = parseNumLoose(fis?['satirToplamBorc']);
    final alacak = parseNumLoose(fis?['satirToplamAlacak']);
    final dengede = fis?['dengede'] == true;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          children: [
            const Expanded(
              child: Text('Toplam', style: TextStyle(fontWeight: FontWeight.w600)),
            ),
            SizedBox(
              width: _borcAlacakColWidth,
              child: Text(
                formatTurkishAmount(borc),
                textAlign: TextAlign.right,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
            ),
            SizedBox(
              width: _borcAlacakColWidth,
              child: Text(
                formatTurkishAmount(alacak),
                textAlign: TextAlign.right,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
            ),
          ],
        ),
        if (!dengede)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.warning_amber_rounded, size: 18, color: cs.error),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    'Borç ve alacak toplamları eşit değil; fişi ETA üzerinden kontrol edin.',
                    style: TextStyle(fontSize: 12, color: cs.error, fontWeight: FontWeight.w500),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}
