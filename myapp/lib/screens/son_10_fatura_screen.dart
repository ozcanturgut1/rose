import 'dart:convert';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../formatting/display_date.dart';
import '../services/qnb_api.dart';
import '../widgets/ara_onay_yonlendir_dialog.dart';
import 'invoice_json_review_screen.dart';
import 'invoice_pdf_review_screen.dart';

/// Fatura listesi ekranı.
///
/// **admin**: Portal `listGelenBelgeleriExt` + geliş tarihi + **Sorgula** + diğer araçlar.
///
/// **ara_onay** / **nihai_onay** / **muhasebe**: Yalnızca Firestore; tarih/sorgu yok (sayfalı okuma).
/// Ekranda yalnızca liste + AppBar **Çıkış**.
///
/// - `ara_onay` → `onayDurumu` boş
/// - `nihai_onay` → `onayDurumu == onaya sunuldu`
/// - `muhasebe` → açılır liste: onaylandı / reddedildi / onay bekliyor (Ara+Nihai kuyrukları)
///
/// İrsaliyeleri `qnb_docs` önbelleğine almak (yalnız admin UI): **kamyon** ikonu veya
/// ilgili butonlar → [QnbApi.syncAllDespatches].
///
/// **ara_onay** + dolu [profileBirim]: yalnızca `suppliers/{birim}` belgesindeki VKN listesiyle
/// eşleşen `supplierVkn` / `qnbRaw.gondericiVkn` faturaları gösterilir; yönlendirme `araOnayAtananUid` ile yapılır.
class Son10FaturaScreen extends StatefulWidget {
  const Son10FaturaScreen({super.key, required this.api, this.userRole, this.profileBirim});

  final QnbApi api;

  /// [UserHomeRouter] → `user_profiles.role` (ör. `nihai_onay`, `ara_onay`).
  final String? userRole;

  /// `user_profiles.birim` (ör. `iplik`). Yalnızca `ara_onay` ile `suppliers` süzmesi için.
  final String? profileBirim;

  @override
  State<Son10FaturaScreen> createState() => _Son10FaturaScreenState();
}

/// Muhasebe listesi: Firestore `onayDurumu` veya bekleyen kuyruk görünümü.
enum _MuhasebeFiltre { onaylandi, reddedildi, onayBekliyor }

class _Son10FaturaScreenState extends State<Son10FaturaScreen> {
  bool loading = true;
  String? error;
  List<Map<String, dynamic>> items = [];
  /// İşaretliyse liste satırına tıklanınca [InvoiceJsonReviewScreen] (özet), aksi halde PDF önizleme.
  bool _listTapShowsJson = false;
  /// Admin'de, yalnızca seçilen faturaları Firestore'a backfill etmek için `belgeNo` kümesi.
  final Set<String> _selectedBelgeNosForBackfill = <String>{};
  /// Admin listesinde sayfa indeksi (0 tabanlı); yalnızca görünüm — API tek seferde yüklenir.
  int _adminListPage = 0;

  _MuhasebeFiltre _muhasebeFiltre = _MuhasebeFiltre.onaylandi;
  /// Son başarılı `listGelenBelgeleriExt` yanıtı (debug).
  String? _lastResponseJson;

  bool _backfillLoading = false;
  bool _despatchSyncLoading = false;
  bool _ettFromQnbDocsLoading = false;
  bool _despatchUblLoading = false;
  int _despatchSyncedTotal = 0;

  late final TextEditingController _fromController;
  late final TextEditingController _toController;

  static String _fmtYmd(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  static bool _validYmd(String s) => RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(s.trim());
  static String? _normalizeYmd(String raw) {
    final s = raw.trim();
    if (s.isEmpty) return null;
    if (_validYmd(s)) return s;
    final d = DateTime.tryParse(s);
    if (d == null) return null;
    return _fmtYmd(d);
  }

  /// Admin portal listesi: [listGelenBelgeleriExt] tek istekte en fazla 2000 kayıt döner ([QnbApi] ile uyumlu).
  static const int _adminPortalListLimit = 2000;

  /// Admin liste sayfalama: tek seferde bellekteki [items] dilimlenir.
  static const int _adminPageSize = 50;

  /// admin | ara_onay | nihai_onay | muhasebe ([UserHomeRouter]).
  String get _listFilterMode {
    final r =
        widget.userRole?.trim().toLowerCase().replaceAll(RegExp(r'\s+'), '_') ?? '';
    if (r == 'ara_onay') return 'ara_onay';
    if (r == 'nihai_onay') return 'nihai_onay';
    if (r == 'muhasebe') return 'muhasebe';
    if (r == 'admin') return 'admin';
    return 'admin';
  }

  /// Ara / nihai / muhasebe: sadeleştirilmiş arayüz, portala bağlanmadan Firestore listesi.
  bool get _isMinimalApproverUi {
    final m = _listFilterMode;
    return m == 'ara_onay' || m == 'nihai_onay' || m == 'muhasebe';
  }

  /// Gösterim için geçerli ünvan (e-posta tek başına gönderen adı sayılmaz); [qnb_docs_screen] ile uyumlu.
  static bool _gecerliGonderenAdi(String? s) {
    if (s == null || s.trim().isEmpty) return false;
    final t = s.trim().toLowerCase();
    if (t.startsWith('urn:mail:')) return false;
    if (t.contains('@') && t.contains('.') && !t.contains(' ')) return false;
    return true;
  }

  /// UBL XML yaprak düğümü: düz metin veya `{ "#text": "..." }` ([ublToStructuredJson] `val` ile uyumlu).
  static String? _ublXmlScalarText(dynamic node) {
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

  static dynamic _ublFirst(dynamic x) {
    if (x is List && x.isNotEmpty) return x.first;
    return x;
  }

  /// Firestore `ublParsed.Invoice.AccountingSupplierParty.Party.PartyName.Name` (gönderen ünvanı).
  static String? _gondericiUnvanFromUblParsed(Map<String, dynamic> d) {
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

  /// Gönderici ünvanı: önce Firestore UBL `PartyName.Name`, sonra üst alanlar, yoksa VKN etiketi.
  static String _gondericiUnvanFromDoc(Map<String, dynamic> d) {
    final fromUbl = _gondericiUnvanFromUblParsed(d);
    if (fromUbl != null && fromUbl.isNotEmpty && _gecerliGonderenAdi(fromUbl)) {
      return fromUbl;
    }

    final raw = d['qnbRaw'];
    final rm = raw is Map ? Map<String, dynamic>.from(raw) : <String, dynamic>{};
    final unvanCandidates = [
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
    for (final c in unvanCandidates) {
      final s = c?.toString().trim();
      if (s != null && s.isNotEmpty && _gecerliGonderenAdi(s)) return s;
    }
    final vkn = d['supplierVkn']?.toString().trim();
    if (vkn != null && vkn.isNotEmpty) return 'VKN: $vkn';
    return '';
  }

  /// `qnb_invoices` verisinden liste satırı (portal `items` ile uyumlu alanlar).
  static Map<String, dynamic> _invoiceDocToListItem(Map<String, dynamic> data) {
    final q = data['qnbRaw'];
    final qm = q is Map ? Map<String, dynamic>.from(q) : <String, dynamic>{};
    return {
      'belgeNo': data['belgeNo'] ?? qm['belgeNo'],
      'onayAciklamaAraOnay': data['onayAciklamaAraOnay'],
      'onayAciklamaAraOnayYazanAd': data['onayAciklamaAraOnayYazanAd'],
      'onayAciklamaNihaiOnay': data['onayAciklamaNihaiOnay'],
      'onayAciklamaNihaiOnayYazanAd': data['onayAciklamaNihaiOnayYazanAd'],
      'onayAciklamaMuhasebe': data['onayAciklamaMuhasebe'],
      'onayAciklamaMuhasebeYazanAd': data['onayAciklamaMuhasebeYazanAd'],
      'onayAciklama': data['onayAciklama'],
      'onayAciklamaYazanAd': data['onayAciklamaYazanAd'],
      'ettn': data['ettn'] ?? qm['ettn'] ?? qm['ETTN'],
      'belgeTarihi': qm['belgeTarihi'],
      'faturaGelisTarihi': qm['faturaGelisTarihi'] ?? qm['gelisTarihi'],
      'gelisTarihi': qm['gelisTarihi'],
      'belgeSiraNo': qm['belgeSiraNo'],
      'odenecekTutar': qm['odenecekTutar'],
      'odenecekTutarDovizCinsi': qm['odenecekTutarDovizCinsi'],
      'gondericiUnvanDisplay': _gondericiUnvanFromDoc(data),
    };
  }

  static const String _nihaiOnayDurumuValue = 'onaya sunuldu';
  static const String _muhasebeOnayDurumuValue = 'onaylandı';
  static const String _reddedildiDurumuValue = 'reddedildi';

  static bool _onayDurumuIsNihaiPool(dynamic raw) {
    final s = raw?.toString().trim().replaceAll(RegExp(r'\s+'), ' ') ?? '';
    return s == _nihaiOnayDurumuValue;
  }

  static bool _onayDurumuIsOnaylandi(dynamic raw) {
    final s = raw?.toString().trim().replaceAll(RegExp(r'\s+'), ' ') ?? '';
    return s == _muhasebeOnayDurumuValue;
  }

  static bool _onayDurumuIsReddedildi(dynamic raw) {
    final s = raw?.toString().trim().replaceAll(RegExp(r'\s+'), ' ') ?? '';
    return s == _reddedildiDurumuValue;
  }

  /// E-posta ise `@` öncesi; ad soyad gibi kısa metin olduğu gibi.
  static String _kisaYazarEtiketi(String? raw) {
    final v = raw?.trim() ?? '';
    if (v.isEmpty) return '';
    if (v.contains('@')) {
      final i = v.indexOf('@');
      if (i > 0) {
        final local = v.substring(0, i).trim();
        if (local.isNotEmpty) return local;
      }
    }
    return v;
  }

  /// Onay bekliyor: kuyruk + varsa son açıklama yazarı (e-postada `@` öncesi).
  static String _beklemeParantezMetni({
    required bool nihaiKuyruk,
    required Map<String, dynamic> data,
  }) {
    final kuyruk = nihaiKuyruk ? 'Nihai onay' : 'Ara onay';
    final y = nihaiKuyruk
        ? data['onayAciklamaNihaiOnayYazanAd']?.toString()
        : data['onayAciklamaAraOnayYazanAd']?.toString();
    final short = _kisaYazarEtiketi(y);
    if (short.isNotEmpty) return '($kuyruk · $short)';
    return '($kuyruk)';
  }

  static String _sortKeyFromListItem(Map<String, dynamic> it) {
    final g = it['faturaGelisTarihi'] ?? it['gelisTarihi'];
    final t = g?.toString().trim() ?? '';
    if (t.length >= 14 && RegExp(r'^\d+$').hasMatch(t)) return t;
    if (RegExp(r'^\d{8}$').hasMatch(t)) return '${t.substring(0, 4)}${t.substring(4, 6)}${t.substring(6, 8)}00000000';
    return t.padLeft(8, '0');
  }

  /// Sadece rakamlar; VKN karşılaştırması için.
  static String _digitsOnlyVkn(String? raw) {
    final s = raw?.toString().trim() ?? '';
    if (s.isEmpty) return '';
    return s.replaceAll(RegExp(r'\D'), '');
  }

  /// Fatura belgesi: önce `supplierVkn`, yoksa `qnbRaw.gondericiVkn`.
  static String? _invoiceSupplierVknDigits(Map<String, dynamic> data) {
    final top = _digitsOnlyVkn(data['supplierVkn']?.toString());
    if (top.isNotEmpty) return top;
    final q = data['qnbRaw'];
    if (q is Map) {
      final g = _digitsOnlyVkn(Map<String, dynamic>.from(q)['gondericiVkn']?.toString());
      if (g.isNotEmpty) return g;
    }
    return null;
  }

  /// `suppliers/{docId}` → `vkns` | `vkn` | `vknList` (dizi veya virgülle ayrılmış metin).
  static Set<String> _vknsFromSupplierDocData(Map<String, dynamic> d) {
    final out = <String>{};
    void consume(dynamic raw) {
      if (raw == null) return;
      if (raw is List) {
        for (final e in raw) {
          final v = _digitsOnlyVkn(e?.toString());
          if (v.isNotEmpty) out.add(v);
        }
        return;
      }
      final s = raw.toString().trim();
      if (s.isEmpty) return;
      if (s.contains(',') || s.contains(';')) {
        for (final part in s.split(RegExp(r'[,;]\s*'))) {
          final v = _digitsOnlyVkn(part);
          if (v.isNotEmpty) out.add(v);
        }
        return;
      }
      final v = _digitsOnlyVkn(s);
      if (v.isNotEmpty) out.add(v);
    }

    if (d.containsKey('vkns')) consume(d['vkns']);
    if (d.containsKey('vkn')) consume(d['vkn']);
    if (d.containsKey('vknList')) consume(d['vknList']);
    return out;
  }

  Future<Set<String>> _fetchSupplierVknsForBirim(String birim) async {
    final docId = birim.trim();
    if (docId.isEmpty) return {};
    final snap = await FirebaseFirestore.instance.collection('suppliers').doc(docId).get();
    if (!snap.exists) return {};
    final d = snap.data();
    if (d == null) return {};
    return _vknsFromSupplierDocData(d);
  }

  /// Tüm `qnb_invoices` belgelerini [FieldPath.documentId] sırasıyla sayfalar.
  Future<List<QueryDocumentSnapshot<Map<String, dynamic>>>> _paginateByDocId(
    Query<Map<String, dynamic>> Function() base,
  ) async {
    final out = <QueryDocumentSnapshot<Map<String, dynamic>>>[];
    QueryDocumentSnapshot<Map<String, dynamic>>? cursor;
    const batch = 250;
    while (true) {
      Query<Map<String, dynamic>> q = base().limit(batch);
      if (cursor != null) {
        q = q.startAfterDocument(cursor);
      }
      final snap = await q.get();
      if (snap.docs.isEmpty) break;
      out.addAll(snap.docs);
      cursor = snap.docs.last;
      if (snap.docs.length < batch) break;
    }
    return out;
  }

  /// Firestore — tarih süzmesi yok; şarta uyan tüm `invoice_*` faturalar.
  ///
  /// **nihai / muhasebe (onaylandı|reddedildi):** `onayDurumu` eşitliği + `orderBy(__name__)` (bileşik indeks gerekebilir).
  /// **muhasebe · onay bekliyor:** Ara (boş `onayDurumu`) + Nihai (`onaya sunuldu`) birleşik liste.
  /// **ara:** Koleksiyonun tamamı taranır.
  Future<List<Map<String, dynamic>>> _fetchInvoicesFromFirestoreOnly() async {
    final col = FirebaseFirestore.instance.collection('qnb_invoices');
    final mode = _listFilterMode;
    final profileBirim = widget.profileBirim?.trim() ?? '';
    final myUid = FirebaseAuth.instance.currentUser?.uid ?? '';
    final araOnaySupplierVkns = (mode == 'ara_onay' && profileBirim.isNotEmpty)
        ? await _fetchSupplierVknsForBirim(profileBirim)
        : null;

    if (mode == 'muhasebe' && _muhasebeFiltre == _MuhasebeFiltre.onayBekliyor) {
      final araDocs = await _paginateByDocId(
        () => col.orderBy(FieldPath.documentId),
      );
      final nihaiDocs = await _paginateByDocId(
        () => col
            .where('onayDurumu', isEqualTo: _nihaiOnayDurumuValue)
            .orderBy(FieldPath.documentId),
      );
      final out = <Map<String, dynamic>>[];
      final seen = <String>{};
      for (final d in araDocs) {
        if (!d.id.startsWith('invoice_')) continue;
        final data = d.data();
        final onay = data['onayDurumu']?.toString().trim() ?? '';
        if (onay.isNotEmpty) continue;
        seen.add(d.id);
        final item = _invoiceDocToListItem(data);
        item['invoiceDocId'] = d.id;
        item['araOnayAtananUid'] = data['araOnayAtananUid']?.toString();
        item['muhasebeBeklemeParantez'] =
            _beklemeParantezMetni(nihaiKuyruk: false, data: data);
        out.add(item);
      }
      for (final d in nihaiDocs) {
        if (!d.id.startsWith('invoice_')) continue;
        if (seen.contains(d.id)) continue;
        final data = d.data();
        final item = _invoiceDocToListItem(data);
        item['invoiceDocId'] = d.id;
        item['araOnayAtananUid'] = data['araOnayAtananUid']?.toString();
        item['muhasebeBeklemeParantez'] =
            _beklemeParantezMetni(nihaiKuyruk: true, data: data);
        out.add(item);
      }
      out.sort((x, y) => _sortKeyFromListItem(y).compareTo(_sortKeyFromListItem(x)));
      return out;
    }

    final out = <Map<String, dynamic>>[];

    final List<QueryDocumentSnapshot<Map<String, dynamic>>> docs;
    if (mode == 'nihai_onay') {
      docs = await _paginateByDocId(
        () => col
            .where('onayDurumu', isEqualTo: _nihaiOnayDurumuValue)
            .orderBy(FieldPath.documentId),
      );
    } else if (mode == 'muhasebe') {
      final durum = _muhasebeFiltre == _MuhasebeFiltre.reddedildi
          ? _reddedildiDurumuValue
          : _muhasebeOnayDurumuValue;
      docs = await _paginateByDocId(
        () => col
            .where('onayDurumu', isEqualTo: durum)
            .orderBy(FieldPath.documentId),
      );
    } else {
      docs = await _paginateByDocId(
        () => col.orderBy(FieldPath.documentId),
      );
    }

    for (final d in docs) {
      if (!d.id.startsWith('invoice_')) continue;
      final data = d.data();
      final onay = data['onayDurumu']?.toString().trim() ?? '';
      if (mode == 'ara_onay') {
        if (onay.isNotEmpty) continue;
        final assigned = (data['araOnayAtananUid']?.toString() ?? '').trim();
        if (assigned.isNotEmpty && assigned != myUid) continue;
        if (assigned.isEmpty) {
          if (profileBirim.isNotEmpty) {
            final allowed = araOnaySupplierVkns ?? <String>{};
            if (allowed.isEmpty) continue;
            final vkn = _invoiceSupplierVknDigits(data);
            if (vkn == null || !allowed.contains(vkn)) continue;
          }
        }
      } else if (mode == 'nihai_onay') {
        if (!_onayDurumuIsNihaiPool(data['onayDurumu'])) continue;
      } else if (mode == 'muhasebe') {
        if (_muhasebeFiltre == _MuhasebeFiltre.reddedildi) {
          if (!_onayDurumuIsReddedildi(data['onayDurumu'])) continue;
        } else {
          if (!_onayDurumuIsOnaylandi(data['onayDurumu'])) continue;
        }
      }
      final item = _invoiceDocToListItem(data);
      item['invoiceDocId'] = d.id;
      item['araOnayAtananUid'] = data['araOnayAtananUid']?.toString();
      out.add(item);
    }

    out.sort((x, y) => _sortKeyFromListItem(y).compareTo(_sortKeyFromListItem(x)));
    return out;
  }

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    final from = now.subtract(const Duration(days: 7));
    _fromController = TextEditingController(text: _fmtYmd(from));
    _toController = TextEditingController(text: _fmtYmd(now));
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _fromController.dispose();
    _toController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    if (_isMinimalApproverUi) {
      setState(() {
        loading = true;
        error = null;
        _selectedBelgeNosForBackfill.clear();
      });
      try {
        final list = await _fetchInvoicesFromFirestoreOnly();
        if (!mounted) return;
        setState(() {
          items = list;
          loading = false;
          _lastResponseJson = null;
          _selectedBelgeNosForBackfill.clear();
        });
      } catch (e) {
        setState(() {
          error = e.toString();
          loading = false;
          _lastResponseJson = null;
          _selectedBelgeNosForBackfill.clear();
        });
      }
      return;
    }

    final a = _fromController.text.trim();
    final b = _toController.text.trim();
    if (!_validYmd(a) || !_validYmd(b)) {
      setState(() => error = 'Tarihler YYYY-MM-DD olmalı.');
      return;
    }
    if (a.compareTo(b) > 0) {
      setState(() => error = 'Başlangıç, bitişten büyük olamaz.');
      return;
    }

    setState(() {
      loading = true;
      error = null;
      _selectedBelgeNosForBackfill.clear();
      _adminListPage = 0;
    });
    try {
      final data = await widget.api.listGelenBelgeleriExt(
        limit: _adminPortalListLimit,
        onayDurum: 'HEPSI',
        gelisBaslangic: a,
        gelisBitis: b,
      );
      final raw = data['items'];
      final list = raw is List
          ? raw.map((e) => (e as Map).cast<String, dynamic>()).toList()
          : <Map<String, dynamic>>[];
      String? jsonText;
      try {
        jsonText = const JsonEncoder.withIndent('  ').convert(data);
      } catch (_) {
        jsonText = data.toString();
      }
      if (!mounted) return;
      setState(() {
        items = list;
        loading = false;
        _lastResponseJson = jsonText;
        _selectedBelgeNosForBackfill.clear();
        _adminListPage = 0;
      });
    } catch (e) {
      setState(() {
        error = e.toString();
        loading = false;
        _lastResponseJson = null;
      });
    }
  }

  /// Aynı geliş tarih aralığı için portaldan indirip `qnb_invoices` koleksiyonuna yazar (UBL dahil).
  Future<void> _backfillToFirestore() async {
    final a = _normalizeYmd(_fromController.text);
    final b = _normalizeYmd(_toController.text);
    if (a == null || b == null) {
      setState(() => error = 'Tarihler YYYY-MM-DD olmalı.');
      return;
    }
    if (DateTime.parse(a).isAfter(DateTime.parse(b))) {
      setState(() => error = 'Başlangıç, bitişten büyük olamaz.');
      return;
    }

    // Admin için: kullanıcı belirli belge numaralarını işaretlediyse,
    // bunları sunucuya ipucu olarak gönder (sunucu henüz desteklemiyorsa parametreyi yok sayar).
    final List<String> selectedBelgeNos =
        _listFilterMode == 'admin' ? _selectedBelgeNosForBackfill.toList() : const <String>[];

    setState(() {
      _backfillLoading = true;
      error = null;
    });
    try {
      final r = await widget.api.backfillInvoicesFullByDateRange(
        from: a,
        to: b,
        docIds: selectedBelgeNos.isEmpty ? null : selectedBelgeNos,
      );
      final upserted = r['upsertedDocs'];
      final enriched = r['enriched'];
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'qnb_invoices: kaydedilen $upserted · UBL ile zenginleştirilen $enriched',
          ),
        ),
      );
    } catch (e) {
      if (mounted) {
        setState(() => error = e.toString());
      }
    } finally {
      if (mounted) {
        setState(() => _backfillLoading = false);
      }
    }
  }

  /// Portaldan irsaliyeleri sayfalı çeker; `qnb_docs` + UBL yazar (`qnb_sync_state.despatchNextStart` ile devam).
  Future<void> _syncDespatchesToQnbDocs() async {
    final a = _fromController.text.trim();
    final b = _toController.text.trim();
    if (!_validYmd(a) || !_validYmd(b)) {
      setState(() => error = 'Tarihler YYYY-MM-DD olmalı.');
      return;
    }
    if (a.compareTo(b) > 0) {
      setState(() => error = 'Başlangıç, bitişten büyük olamaz.');
      return;
    }
    if (_despatchSyncLoading) return;
    setState(() {
      _despatchSyncLoading = true;
      error = null;
      _despatchSyncedTotal = 0;
    });
    int? start;
    const pageSize = 100;
    var total = 0;
    var pages = 0;
    const maxPages = 400;
    try {
      while (mounted && pages < maxPages) {
        pages++;
        final r = await widget.api.syncAllDespatches(
          start: start,
          pageSize: pageSize,
          from: a,
          to: b,
        );
        final success = r['success'] == true;
        if (!success) break;
        final fetched = (r['fetchedInThisCall'] as num?)?.toInt() ?? 0;
        total += fetched;
        if (mounted) setState(() => _despatchSyncedTotal = total);
        final hasMore = r['hasMore'] == true;
        if (!hasMore) break;
        final next = (r['nextStart'] as num?)?.toInt();
        if (next == null) break;
        if (start != null && next <= start) break;
        start = next;
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            total > 0
                ? 'qnb_docs: $total irsaliye işlendi ($pages sunucu çağrısı)'
                : 'Yeni irsaliye yok veya liste boş ($pages çağrı)',
          ),
        ),
      );
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) {
        setState(() => _despatchSyncLoading = false);
      }
    }
  }

  /// qnb_docs önbelleğindeki ETTN'leri tüm faturaların `despatches` altına yazar (`all=1`).
  Future<void> _backfillDespatchEttnFromQnbDocs() async {
    if (_ettFromQnbDocsLoading) return;
    setState(() {
      _ettFromQnbDocsLoading = true;
      error = null;
    });
    try {
      final r = await widget.api.backfillDespatchEttnFromQnbDocs(allInvoices: true);
      if (!mounted) return;
      final updated = r['updated'];
      final scanned = r['despatchesScanned'];
      final inv = r['invoicesProcessed'];
      final pages = r['invoiceDocPages'];
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            pages != null
                ? 'ETTN (tüm koleksiyon): $inv fatura · $pages sayfa · $scanned irsaliye · güncellenen $updated'
                : 'ETTN eşleştirme: $inv fatura · $scanned irsaliye tarandı · güncellenen $updated',
          ),
        ),
      );
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => _ettFromQnbDocsLoading = false);
    }
  }

  /// despatches kayıtlarında ettn ile UBL (önce qnb_docs, yoksa portal) — tüm faturalar.
  Future<void> _enrichDespatchesUblByEttn() async {
    if (_despatchUblLoading) return;
    setState(() {
      _despatchUblLoading = true;
      error = null;
    });
    try {
      final r = await widget.api.enrichInvoiceDespatchesUblByEttn(allInvoices: true);
      if (!mounted) return;
      final written = r['ublWritten'];
      final fromDoc = r['fromQnbDocs'];
      final fromPortal = r['fromPortal'];
      final failed = r['fetchFailed'];
      final pages = r['invoiceDocPages'];
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            pages != null
                ? 'İrsaliye UBL: $written yazıldı (qnb_docs: $fromDoc · portal: $fromPortal · başarısız: $failed) · $pages sayfa'
                : 'İrsaliye UBL: $written yazıldı (qnb_docs: $fromDoc · portal: $fromPortal · başarısız: $failed)',
          ),
        ),
      );
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => _despatchUblLoading = false);
    }
  }

  void _showLastResponseJson() {
    final text = _lastResponseJson;
    if (text == null || text.isEmpty) return;
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('listGelenBelgeleriExt — ham JSON'),
        content: SizedBox(
          width: double.maxFinite,
          height: MediaQuery.of(context).size.height * 0.55,
          child: SelectionArea(
            child: SingleChildScrollView(
              child: SelectableText(
                text,
                style: const TextStyle(fontFamily: 'monospace', fontSize: 11, height: 1.35),
              ),
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: text));
              if (!mounted) return;
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('JSON panoya kopyalandı')),
              );
            },
            child: const Text('Kopyala'),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Kapat'),
          ),
        ],
      ),
    );
  }

  static String _formatBelgeTarih(dynamic v) => formatTurkishDate(v);

  int _effectiveAdminPage() {
    if (items.isEmpty) return 0;
    final maxPage = (items.length - 1) ~/ _adminPageSize;
    var p = _adminListPage;
    if (p < 0) p = 0;
    if (p > maxPage) p = maxPage;
    return p;
  }

  void _adjustAdminPage(int delta) {
    if (_listFilterMode != 'admin' || items.isEmpty) return;
    final maxPage = (items.length - 1) ~/ _adminPageSize;
    final p = _effectiveAdminPage();
    final next = p + delta;
    if (next < 0 || next > maxPage) return;
    setState(() => _adminListPage = next);
  }

  /// Admin modunda yalnızca mevcut sayfanın satırları; diğer modlarda tüm [items].
  List<Map<String, dynamic>> _listRowsForDisplay() {
    if (_listFilterMode != 'admin' || items.isEmpty) return items;
    final page = _effectiveAdminPage();
    final start = page * _adminPageSize;
    if (start >= items.length) return [];
    final end = (start + _adminPageSize) > items.length ? items.length : start + _adminPageSize;
    return items.sublist(start, end);
  }

  Widget _buildAdminPaginationBar(BuildContext context) {
    final total = items.length;
    if (total <= _adminPageSize) return const SizedBox.shrink();
    final totalPages = (total + _adminPageSize - 1) ~/ _adminPageSize;
    final page = _effectiveAdminPage();
    final startIdx = page * _adminPageSize;
    final endIdx = (startIdx + _adminPageSize) > total ? total : startIdx + _adminPageSize;
    final cs = Theme.of(context).colorScheme;
    return Material(
      elevation: 1,
      color: cs.surfaceContainerLow,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
        child: Row(
          children: [
            IconButton(
              tooltip: 'Önceki sayfa',
              onPressed: page > 0 ? () => _adjustAdminPage(-1) : null,
              icon: const Icon(Icons.chevron_left),
            ),
            Expanded(
              child: Text(
                '${startIdx + 1}–$endIdx / $total · Sayfa ${page + 1}/$totalPages',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
            IconButton(
              tooltip: 'Sonraki sayfa',
              onPressed: page < totalPages - 1 ? () => _adjustAdminPage(1) : null,
              icon: const Icon(Icons.chevron_right),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _yonlendirFatura(BuildContext context, Map<String, dynamic> it) async {
    final ok = await showAraOnayYonlendirDialog(context, api: widget.api, item: it);
    if (!context.mounted) return;
    if (ok) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Fatura yönlendirildi.')));
      await _load();
    }
  }

  Future<void> _openInvoicePdfReview(Map<String, dynamic> it) async {
    final belgeNo = (it['belgeNo']?.toString() ?? '').trim();
    if (belgeNo.isEmpty) {
      setState(() => error = 'BelgeNo bulunamadı.');
      return;
    }
    final listChanged = await Navigator.of(context).push<bool>(
      MaterialPageRoute<bool>(
        builder: (_) => _listTapShowsJson
            ? InvoiceJsonReviewScreen(
                api: widget.api,
                item: it,
                userRole: widget.userRole,
              )
            : InvoicePdfReviewScreen(
                api: widget.api,
                item: it,
                userRole: widget.userRole,
              ),
      ),
    );
    if (!mounted) return;
    if (listChanged == true) {
      await _load();
    }
  }

  Widget _buildDateRangeFields() {
    return Row(
      children: [
        Expanded(
          child: TextField(
            controller: _fromController,
            decoration: const InputDecoration(
              labelText: 'Başlangıç',
              border: OutlineInputBorder(),
              isDense: true,
            ),
            keyboardType: TextInputType.datetime,
            inputFormatters: [
              FilteringTextInputFormatter.allow(RegExp(r'[\d-]')),
            ],
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: TextField(
            controller: _toController,
            decoration: const InputDecoration(
              labelText: 'Bitiş',
              border: OutlineInputBorder(),
              isDense: true,
            ),
            keyboardType: TextInputType.datetime,
            inputFormatters: [
              FilteringTextInputFormatter.allow(RegExp(r'[\d-]')),
            ],
          ),
        ),
      ],
    );
  }

  /// Admin: portal + Firestore araçları.
  Widget _buildAdminFilterSection(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Portala geliş tarihi (YYYY-MM-DD)',
          style: TextStyle(fontSize: 12),
        ),
        const SizedBox(height: 8),
        _buildDateRangeFields(),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: FilledButton.tonal(
                onPressed: (loading || _backfillLoading || _despatchSyncLoading || _ettFromQnbDocsLoading || _despatchUblLoading)
                    ? null
                    : _load,
                child: loading
                    ? const SizedBox(
                        width: 22,
                        height: 22,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('Sorgula'),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: OutlinedButton(
                onPressed: (loading || _backfillLoading || _despatchSyncLoading || _ettFromQnbDocsLoading || _despatchUblLoading)
                    ? null
                    : _backfillToFirestore,
                child: _backfillLoading
                    ? const SizedBox(
                        width: 22,
                        height: 22,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('Firestore\'a kaydet'),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        SizedBox(
          width: double.infinity,
          child: FilledButton.icon(
            onPressed: (loading || _backfillLoading || _despatchSyncLoading || _ettFromQnbDocsLoading || _despatchUblLoading)
                ? null
                : _syncDespatchesToQnbDocs,
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(context).colorScheme.secondaryContainer,
              foregroundColor: Theme.of(context).colorScheme.onSecondaryContainer,
            ),
            icon: _despatchSyncLoading
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.local_shipping_outlined, size: 22),
            label: Text(
              _despatchSyncLoading
                  ? 'İrsaliyeler qnb_docs\'a alınıyor... ($_despatchSyncedTotal)'
                  : 'İrsaliyeleri qnb_docs\'a çek (portal önbellek)',
            ),
          ),
        ),
        if (_despatchSyncLoading)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              'Sunucu sırasına göre sayfa sayfa çekilir; fatura zenginleştirme bu önbelleği kullanır.',
              style: TextStyle(fontSize: 11, color: Theme.of(context).colorScheme.outline),
            ),
          ),
        const SizedBox(height: 10),
        SizedBox(
          width: double.infinity,
          child: OutlinedButton.icon(
            onPressed: (loading || _backfillLoading || _despatchSyncLoading || _ettFromQnbDocsLoading || _despatchUblLoading)
                ? null
                : _backfillDespatchEttnFromQnbDocs,
            icon: _ettFromQnbDocsLoading
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.link, size: 22),
            label: Text(
              _ettFromQnbDocsLoading
                  ? 'Tüm faturalar: qnb_docs → despatches ETTN...'
                  : 'Tüm faturalarda ETTN\'leri qnb_docs\'tan despatches\'e yaz',
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text(
            'qnb_invoices içindeki bütün fatura dokümanlarını tarar; portal çağırmaz. Çok kayıtta işlem dakikalar sürebilir.',
            style: TextStyle(fontSize: 11, color: Theme.of(context).colorScheme.outline),
          ),
        ),
        const SizedBox(height: 10),
        SizedBox(
          width: double.infinity,
          child: FilledButton.icon(
            onPressed: (loading ||
                    _backfillLoading ||
                    _despatchSyncLoading ||
                    _ettFromQnbDocsLoading ||
                    _despatchUblLoading)
                ? null
                : _enrichDespatchesUblByEttn,
            icon: _despatchUblLoading
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.description_outlined, size: 22),
            label: Text(
              _despatchUblLoading
                  ? 'İrsaliye UBL despatches\'e yazılıyor...'
                  : 'ETTN ile irsaliye UBL\'i despatches\'e kaydet (tüm faturalar)',
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text(
            'Önce ETTN alanları dolu olmalı. Önce qnb_docs\'taki UBL kopyalanır; yoksa portaldan gelenIrsaliyeIndir. Zaten geçerli UBL varsa atlanır.',
            style: TextStyle(fontSize: 11, color: Theme.of(context).colorScheme.outline),
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(
          _isMinimalApproverUi ? 'Faturalar' : 'Geliş tarihine göre faturalar',
        ),
        automaticallyImplyLeading: false,
        actions: [
          IconButton(
            tooltip: 'Çıkış',
            onPressed: () => FirebaseAuth.instance.signOut(),
            icon: const Icon(Icons.logout),
          ),
          if (!_isMinimalApproverUi) ...[
            IconButton(
              tooltip: 'İrsaliyeleri qnb_docs\'a çek (portal → önbellek)',
              onPressed: (loading || _backfillLoading || _despatchSyncLoading || _ettFromQnbDocsLoading || _despatchUblLoading)
                  ? null
                  : _syncDespatchesToQnbDocs,
              icon: _despatchSyncLoading
                  ? const SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.local_shipping_outlined),
            ),
            IconButton(
              tooltip: 'Ham JSON',
              onPressed: _lastResponseJson == null ? null : _showLastResponseJson,
              icon: const Icon(Icons.code),
            ),
          ],
        ],
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (!_isMinimalApproverUi)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
              child: _buildAdminFilterSection(context),
            ),
          if (error != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Text(error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 4, 4, 0),
            child: CheckboxListTile(
              value: _listTapShowsJson,
              onChanged: loading
                  ? null
                  : (v) {
                      setState(() => _listTapShowsJson = v ?? false);
                    },
              title: const Text('Fatura Özeti'),
              controlAffinity: ListTileControlAffinity.leading,
              dense: true,
            ),
          ),
          if (_listFilterMode == 'muhasebe')
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
              child: DropdownButtonFormField<_MuhasebeFiltre>(
                value: _muhasebeFiltre,
                decoration: const InputDecoration(
                  labelText: 'Liste',
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
                items: const [
                  DropdownMenuItem(
                    value: _MuhasebeFiltre.onaylandi,
                    child: Text('Onaylandı'),
                  ),
                  DropdownMenuItem(
                    value: _MuhasebeFiltre.reddedildi,
                    child: Text('Reddedildi'),
                  ),
                  DropdownMenuItem(
                    value: _MuhasebeFiltre.onayBekliyor,
                    child: Text('Onay bekliyor'),
                  ),
                ],
                onChanged: (v) {
                  if (v == null) return;
                  setState(() => _muhasebeFiltre = v);
                  _load();
                },
              ),
            ),
          Expanded(
            child: loading && items.isEmpty
                ? const Center(child: CircularProgressIndicator())
                : items.isEmpty
                    ? Center(
                        child: Text(
                          _isMinimalApproverUi ? 'Kayıt yok' : 'Kayıt yok veya sorgu yapın',
                        ),
                      )
                    : Builder(
                        builder: (context) {
                          final listRows = _listRowsForDisplay();
                          return Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              if (_listFilterMode == 'admin') _buildAdminPaginationBar(context),
                              Expanded(
                                child: ListView.separated(
                                  itemCount: listRows.length,
                                  separatorBuilder: (_, __) => const Divider(height: 1),
                                  itemBuilder: (context, i) {
                                    final it = listRows[i];
                                    final tutar = it['odenecekTutar']?.toString() ?? '—';
                                    final pb = it['odenecekTutarDovizCinsi']?.toString() ?? '';
                                    final tutarStr = pb.isEmpty ? tutar : '$tutar $pb';
                                    final belgeNo = (it['belgeNo']?.toString() ?? '').trim();
                                    final bek = (it['muhasebeBeklemeParantez']?.toString() ?? '').trim();
                                    final gUnvan = (it['gondericiUnvanDisplay']?.toString() ?? '').trim();
                                    final gonderenStr =
                                        gUnvan.isNotEmpty ? gUnvan : _gondericiUnvanFromDoc(it);
                                    final baseTitle = belgeNo.isNotEmpty
                                        ? belgeNo
                                        : (gonderenStr.isNotEmpty ? gonderenStr : '—');
                                    final titleText =
                                        bek.isNotEmpty ? '$baseTitle  $bek' : baseTitle;

                                    final isAdmin = _listFilterMode == 'admin';
                                    final isAraOnay = _listFilterMode == 'ara_onay';
                                    final myUid = FirebaseAuth.instance.currentUser?.uid ?? '';
                                    final atanan =
                                        (it['araOnayAtananUid']?.toString() ?? '').trim();
                                    final atananBana = atanan.isNotEmpty && atanan == myUid;

                                    final isSelected = isAdmin &&
                                        belgeNo.isNotEmpty &&
                                        _selectedBelgeNosForBackfill.contains(belgeNo);

                                    return ListTile(
                                      leading: isAdmin
                                          ? Checkbox(
                                              value: isSelected,
                                              onChanged: (v) {
                                                setState(() {
                                                  if (!isAdmin || belgeNo.isEmpty) return;
                                                  if (v == true) {
                                                    _selectedBelgeNosForBackfill.add(belgeNo);
                                                  } else {
                                                    _selectedBelgeNosForBackfill.remove(belgeNo);
                                                  }
                                                });
                                              },
                                            )
                                          : null,
                                      title: Text(
                                        titleText,
                                        style: const TextStyle(fontWeight: FontWeight.w600),
                                      ),
                                      subtitle: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            'Fatura tarihi: ${_formatBelgeTarih(it['belgeTarihi'])}',
                                          ),
                                          Text('Tutar: $tutarStr'),
                                          if (gonderenStr.isNotEmpty)
                                            Text(
                                              'Gönderen: $gonderenStr',
                                              style: const TextStyle(fontSize: 12),
                                            ),
                                          if (isAraOnay && atananBana)
                                            Text(
                                              'Bu fatura size yönlendirildi.',
                                              style: TextStyle(
                                                fontSize: 12,
                                                color: Theme.of(context).colorScheme.primary,
                                              ),
                                            ),
                                        ],
                                      ),
                                      isThreeLine: false,
                                      onTap: () => _openInvoicePdfReview(it),
                                      trailing: isAraOnay
                                          ? Row(
                                              mainAxisSize: MainAxisSize.min,
                                              children: [
                                                IconButton(
                                                  tooltip: 'Yönlendir',
                                                  icon: const Icon(Icons.person_search_outlined),
                                                  onPressed: loading
                                                      ? null
                                                      : () => _yonlendirFatura(context, it),
                                                ),
                                                const Icon(Icons.chevron_right, size: 22),
                                              ],
                                            )
                                          : const Icon(Icons.chevron_right, size: 22),
                                    );
                                  },
                                ),
                              ),
                            ],
                          );
                        },
                      ),
          ),
        ],
      ),
    );
  }
}
