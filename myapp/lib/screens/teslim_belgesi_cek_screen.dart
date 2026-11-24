import 'dart:async';
import 'dart:typed_data';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../services/teslim_belgesi.dart';

/// İmzalı teslim belgesinin fotoğrafını çeker ve fatura veya irsaliye numarasıyla kaydeder.
class TeslimBelgesiCekScreen extends StatefulWidget {
  const TeslimBelgesiCekScreen({super.key});

  @override
  State<TeslimBelgesiCekScreen> createState() => _TeslimBelgesiCekScreenState();
}

class _TeslimBelgesiCekScreenState extends State<TeslimBelgesiCekScreen> {
  final _noCtrl = TextEditingController();
  final _picker = ImagePicker();
  Uint8List? _bytes;

  @override
  void dispose() {
    _noCtrl.dispose();
    super.dispose();
  }

  Future<void> _sec(ImageSource source) async {
    final file = await _picker.pickImage(
      source: source,
      imageQuality: 70,
      maxWidth: 1600,
    );
    if (file == null) return;
    final bytes = await file.readAsBytes();
    if (!mounted) return;
    setState(() => _bytes = bytes);
  }

  void _kaydet() {
    final no = teslimBelgeNoTamamla(_noCtrl.text);
    final bytes = _bytes;
    if (no.isEmpty) {
      _mesaj('Fatura veya irsaliye numarasını yazın.');
      return;
    }
    if (bytes == null || bytes.isEmpty) {
      _mesaj('Önce fotoğraf çekin.');
      return;
    }
    setState(() {
      _bytes = null;
      _noCtrl.clear();
    });
    unawaited(_kaydiBitir(no, bytes));
  }

  Future<void> _kaydiBitir(String no, Uint8List bytes) async {
    try {
      final bag = await TeslimBelgesiServisi.kaydet(girilenNo: no, bytes: bytes);
      if (!mounted) return;
      final irs = bag.despatchBelgeNos.join(', ');
      final metin = !bag.bulundu
          ? '$no kaydedildi. Bu numara henüz fatura veya irsaliye kaydında yok.'
          : bag.invoiceBelgeNo != null
              ? '$no kaydedildi. Fatura ${bag.invoiceBelgeNo}'
                  '${irs.isEmpty ? '' : ', irsaliye $irs'}.'
              : '$no kaydedildi. İrsaliye $irs.';
      _mesaj(metin);
    } catch (e) {
      if (mounted) _mesaj('$no kaydedilemedi: $e');
    }
  }

  void _mesaj(String text) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  @override
  Widget build(BuildContext context) {
    final bytes = _bytes;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Teslim belgesi'),
        automaticallyImplyLeading: false,
        actions: [
          IconButton(
            tooltip: 'Çıkış',
            onPressed: () => FirebaseAuth.instance.signOut(),
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const Text(
              'İmzalı teslim belgesinin fotoğrafını çekin. İlişkili fatura veya irsaliye numarasını yazın.',
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _noCtrl,
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(
                labelText: 'Fatura veya irsaliye no',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 16),
            AspectRatio(
              aspectRatio: 3 / 4,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: bytes == null
                    ? const Center(child: Text('Fotoğraf yok'))
                    : ClipRRect(
                        borderRadius: BorderRadius.circular(8),
                        child: Image.memory(bytes, fit: BoxFit.contain),
                      ),
              ),
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: FilledButton.icon(
                    onPressed: () => _sec(ImageSource.camera),
                    icon: const Icon(Icons.photo_camera_outlined),
                    label: const Text('Fotoğraf çek'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () => _sec(ImageSource.gallery),
                    icon: const Icon(Icons.photo_library_outlined),
                    label: const Text('Galeriden'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _kaydet,
              child: const Text('Kaydet'),
            ),
          ],
        ),
      ),
    );
  }
}
