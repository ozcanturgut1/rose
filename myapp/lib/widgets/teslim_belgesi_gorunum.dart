import 'package:flutter/material.dart';

import '../formatting/display_date.dart';
import '../services/teslim_belgesi.dart';

String _teslimTarih(DateTime? t) => formatTurkishDate(t, empty: '—');

String _teslimOzetSatir(TeslimBelgesi b) {
  final parca = <String>[
    if ((b.invoiceBelgeNo ?? '').isNotEmpty) 'Fatura ${b.invoiceBelgeNo}',
    if (b.despatchBelgeNos.isNotEmpty) 'İrsaliye ${b.despatchBelgeNos.join(', ')}',
  ];
  if (parca.isEmpty) return 'Girilen no: ${b.girilenNo}';
  return parca.join(' · ');
}

/// Fatura ve irsaliye sekmelerinin yanındaki teslim belgesi görselleri.
class TeslimBelgesiGaleri extends StatelessWidget {
  const TeslimBelgesiGaleri({super.key, required this.belgeler});

  final List<TeslimBelgesi> belgeler;

  @override
  Widget build(BuildContext context) {
    if (belgeler.isEmpty) {
      return const Center(child: Text('Teslim belgesi yok'));
    }
    return ListView.separated(
      padding: const EdgeInsets.all(12),
      itemCount: belgeler.length,
      separatorBuilder: (_, __) => const SizedBox(height: 16),
      itemBuilder: (context, i) {
        final b = belgeler[i];
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(_teslimTarih(b.createdAt), style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 2),
            Text(_teslimOzetSatir(b), style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 8),
            InteractiveViewer(
              minScale: 1,
              maxScale: 4,
              child: Image.network(
                b.downloadUrl,
                fit: BoxFit.contain,
                errorBuilder: (_, __, ___) => const Text('Görsel açılamadı'),
              ),
            ),
          ],
        );
      },
    );
  }
}

/// Fatura özeti ekranındaki kısa teslim belgesi bilgisi.
class TeslimBelgesiOzet extends StatelessWidget {
  const TeslimBelgesiOzet({super.key, required this.anahtarlar});

  final Iterable<String> anahtarlar;

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<List<TeslimBelgesi>>(
      future: TeslimBelgesiServisi.listele(anahtarlar),
      builder: (context, snap) {
        if (snap.connectionState == ConnectionState.waiting) {
          return const Padding(
            padding: EdgeInsets.symmetric(vertical: 12),
            child: Center(child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2))),
          );
        }
        if (snap.hasError) {
          return Text(snap.error.toString());
        }
        final list = snap.data ?? const [];
        if (list.isEmpty) {
          return Text(
            'Teslim belgesi yok.',
            style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant),
          );
        }
        return Column(
          children: [
            for (final b in list)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: ClipRRect(
                  borderRadius: BorderRadius.circular(4),
                  child: Image.network(
                    b.downloadUrl,
                    width: 56,
                    height: 56,
                    fit: BoxFit.cover,
                    errorBuilder: (_, __, ___) => const Icon(Icons.broken_image_outlined),
                  ),
                ),
                title: Text(_teslimTarih(b.createdAt)),
                subtitle: Text(_teslimOzetSatir(b)),
                onTap: () {
                  showDialog<void>(
                    context: context,
                    builder: (ctx) => Dialog(
                      child: InteractiveViewer(
                        minScale: 1,
                        maxScale: 4,
                        child: Image.network(b.downloadUrl, fit: BoxFit.contain),
                      ),
                    ),
                  );
                },
              ),
          ],
        );
      },
    );
  }
}
