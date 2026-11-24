import 'dart:typed_data';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_storage/firebase_storage.dart';

/// İmzalı teslim belgesi fotoğrafı. Fatura ve irsaliye numaraları `anahtarlar` içindedir.
class TeslimBelgesi {
  const TeslimBelgesi({
    required this.id,
    required this.girilenNo,
    required this.downloadUrl,
    required this.anahtarlar,
    this.invoiceBelgeNo,
    this.despatchBelgeNos = const [],
    this.createdAt,
  });

  final String id;
  final String girilenNo;
  final String downloadUrl;
  final List<String> anahtarlar;
  final String? invoiceBelgeNo;
  final List<String> despatchBelgeNos;
  final DateTime? createdAt;

  factory TeslimBelgesi.fromDoc(DocumentSnapshot<Map<String, dynamic>> doc) {
    final d = doc.data() ?? {};
    final ts = d['createdAt'];
    final despatch = d['despatchBelgeNos'];
    final anahtar = d['anahtarlar'];
    return TeslimBelgesi(
      id: doc.id,
      girilenNo: (d['girilenNo'] ?? '').toString(),
      downloadUrl: (d['downloadUrl'] ?? '').toString(),
      invoiceBelgeNo: (d['invoiceBelgeNo'] ?? '').toString().trim().isEmpty
          ? null
          : d['invoiceBelgeNo'].toString().trim(),
      despatchBelgeNos: despatch is List
          ? despatch.map((e) => e.toString().trim()).where((e) => e.isNotEmpty).toList()
          : const [],
      anahtarlar: anahtar is List
          ? anahtar.map((e) => e.toString().trim()).where((e) => e.isNotEmpty).toList()
          : const [],
      createdAt: ts is Timestamp ? ts.toDate() : null,
    );
  }
}

class TeslimBaglanti {
  const TeslimBaglanti({
    this.invoiceDocId,
    this.invoiceBelgeNo,
    this.despatchBelgeNos = const [],
    required this.bulundu,
  });

  final String? invoiceDocId;
  final String? invoiceBelgeNo;
  final List<String> despatchBelgeNos;
  final bool bulundu;
}

/// `SCA2026-1084` gibi yazımları `SCA2026000001084` biçimine çevirir.
/// Seri 9 haneye sıfırla tamamlanır. Biçim uymuyorsa metin olduğu gibi kalır.
String teslimBelgeNoTamamla(String girilen) {
  final ham = girilen.trim().toUpperCase();
  final eslesen = RegExp(r'^([A-Z]+)\s*(20\d{2})\D*(\d+)$').firstMatch(ham);
  if (eslesen == null) return ham;
  final seri = eslesen.group(3)!.padLeft(9, '0');
  return '${eslesen.group(1)}${eslesen.group(2)}$seri';
}

class TeslimBelgesiServisi {
  static final _db = FirebaseFirestore.instance;

  static String _safe(String s) => s.trim().replaceAll(RegExp(r'[/\\]'), '_');

  static List<String> _benzersiz(Iterable<String> values) {
    final out = <String>[];
    final seen = <String>{};
    for (final raw in values) {
      final s = raw.trim();
      if (s.isEmpty || !seen.add(s)) continue;
      out.add(s);
    }
    return out;
  }

  static Future<List<String>> _irsaliyeNolari(DocumentReference<Map<String, dynamic>> invRef) async {
    final inv = await invRef.get();
    final data = inv.data() ?? {};
    final related = data['relatedBelgeNos'];
    final fromRelated = related is List ? related.map((e) => e.toString()) : const <String>[];
    final sub = await invRef.collection('despatches').get();
    final fromSub = sub.docs.map((d) {
      final belge = (d.data()['belgeNo'] ?? '').toString().trim();
      return belge.isNotEmpty ? belge : d.id;
    });
    return _benzersiz([...fromRelated, ...fromSub]);
  }

  static String? _belgeNoFromInvoiceData(Map<String, dynamic> data, String docId) {
    final direct = (data['belgeNo'] ?? '').toString().trim();
    if (direct.isNotEmpty) return direct;
    final q = data['qnbRaw'];
    if (q is Map) {
      final raw = (q['belgeNo'] ?? '').toString().trim();
      if (raw.isNotEmpty) return raw;
    }
    if (docId.startsWith('invoice_')) return docId.substring('invoice_'.length);
    return null;
  }

  /// Girilen numarayı fatura veya irsaliye kaydında arar. Bulunamazsa kayıt yine de bu numarayla yazılır.
  static Future<TeslimBaglanti> coz(String girilen) async {
    final no = girilen.trim();
    if (no.isEmpty) {
      return const TeslimBaglanti(bulundu: false);
    }
    final invRef = _db.collection('qnb_invoices').doc('invoice_${_safe(no)}');
    final inv = await invRef.get();
    if (inv.exists) {
      return TeslimBaglanti(
        bulundu: true,
        invoiceDocId: inv.id,
        invoiceBelgeNo: _belgeNoFromInvoiceData(inv.data() ?? {}, inv.id) ?? no,
        despatchBelgeNos: await _irsaliyeNolari(invRef),
      );
    }

    try {
      final grup = await _db.collectionGroup('despatches').where('belgeNo', isEqualTo: no).limit(1).get();
      if (grup.docs.isNotEmpty) {
        final parent = grup.docs.first.reference.parent.parent;
        if (parent != null) {
          final parentSnap = await parent.get();
          final pdata = parentSnap.data() ?? {};
          return TeslimBaglanti(
            bulundu: true,
            invoiceDocId: parent.id,
            invoiceBelgeNo: _belgeNoFromInvoiceData(pdata, parent.id),
            despatchBelgeNos: await _irsaliyeNolari(parent),
          );
        }
      }
    } catch (_) {
      // İrsaliye alt koleksiyonu sorgusu indeks ister. Numara yine de kayda yazılır.
    }

    final qnbDespatch = await _db.collection('qnb_docs').doc('despatch_${_safe(no)}').get();
    if (qnbDespatch.exists) {
      final belge = (qnbDespatch.data()?['belgeNo'] ?? no).toString().trim();
      return TeslimBaglanti(bulundu: true, despatchBelgeNos: _benzersiz([belge.isEmpty ? no : belge]));
    }

    return const TeslimBaglanti(bulundu: false);
  }

  static Future<TeslimBaglanti> kaydet({
    required String girilenNo,
    required Uint8List bytes,
  }) async {
    final ham = girilenNo.trim();
    final no = teslimBelgeNoTamamla(ham);
    if (no.isEmpty) {
      throw StateError('Fatura veya irsaliye numarası gerekli.');
    }
    if (bytes.isEmpty) {
      throw StateError('Fotoğraf boş.');
    }
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) {
      throw StateError('Oturum açık değil.');
    }

    final bag = await coz(no);
    final doc = _db.collection('teslim_belgeleri').doc();
    final path = 'teslim_belgeleri/${doc.id}.jpg';
    final storageRef = FirebaseStorage.instance.ref(path);
    await storageRef.putData(bytes, SettableMetadata(contentType: 'image/jpeg'));
    final url = await storageRef.getDownloadURL();
    final anahtarlar = _benzersiz([
      ham,
      no,
      if (bag.invoiceBelgeNo != null) bag.invoiceBelgeNo!,
      ...bag.despatchBelgeNos,
    ]);

    await doc.set({
      'girilenNo': no,
      'invoiceDocId': bag.invoiceDocId,
      'invoiceBelgeNo': bag.invoiceBelgeNo,
      'despatchBelgeNos': bag.despatchBelgeNos,
      'anahtarlar': anahtarlar,
      'storagePath': path,
      'downloadUrl': url,
      'contentType': 'image/jpeg',
      'createdAt': FieldValue.serverTimestamp(),
      'createdByUid': user.uid,
    });
    return bag;
  }

  static Future<List<TeslimBelgesi>> listele(Iterable<String> anahtarlar) async {
    final keys = _benzersiz(anahtarlar);
    if (keys.isEmpty) return const [];
    final snaps = await Future.wait(
      keys.map(
        (k) => _db.collection('teslim_belgeleri').where('anahtarlar', arrayContains: k).get(),
      ),
    );
    final byId = <String, TeslimBelgesi>{};
    for (final snap in snaps) {
      for (final doc in snap.docs) {
        final belge = TeslimBelgesi.fromDoc(doc);
        if (belge.downloadUrl.isEmpty) continue;
        byId[doc.id] = belge;
      }
    }
    final list = byId.values.toList();
    list.sort((a, b) {
      final ta = a.createdAt ?? DateTime.fromMillisecondsSinceEpoch(0);
      final tb = b.createdAt ?? DateTime.fromMillisecondsSinceEpoch(0);
      return tb.compareTo(ta);
    });
    return list;
  }
}
