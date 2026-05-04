import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;

class QnbApi {
  QnbApi({
    required this.baseListUrl,
    required this.baseApproveUrl,
    required this.baseViewUrl,
    required this.baseEnrichUrl,
    required this.baseRelatedDespatchesUrl,
    required this.baseSyncUrl,
    required this.baseDebugLastInvoiceIrsaliyeUrl,
    required this.baseFetchAndSaveDespatchUrl,
    required this.baseFetchAndSaveInvoiceUrl,
    required this.baseSyncAllDespatchesUrl,
    required this.baseSyncAllInvoicesUrl,
    required this.baseSyncAndEnrichInvoices2026Url,
    required this.baseListGelenBelgeleriExtUrl,
    required this.baseBackfillInvoicesFullByDateRangeUrl,
    required this.baseBackfillDespatchEttnFromQnbDocsUrl,
    required this.baseEnrichInvoiceDespatchesUblByEttnUrl,
    required this.baseUpdateQnbInvoiceYonetimOnayUrl,
  });

  final String baseListUrl;    // https://listqnbdocs-...a.run.app
  final String baseApproveUrl; // https://europe-west1-...cloudfunctions.net/approveQnbDoc
  final String baseViewUrl;    // https://europe-west1-...cloudfunctions.net/viewQnbDoc
  final String baseEnrichUrl; // https://europe-west1-...cloudfunctions.net/enrichInvoiceWithRelatedDespatches
  final String baseRelatedDespatchesUrl; // https://getinvoicerelateddespatches-...a.run.app
  final String baseSyncUrl;   // https://europe-west1-...cloudfunctions.net/syncQnbDocs
  final String baseDebugLastInvoiceIrsaliyeUrl; // https://...cloudfunctions.net/debugQnbLastInvoiceIrsaliye
  final String baseFetchAndSaveDespatchUrl; // https://...cloudfunctions.net/fetchAndSaveDespatchByBelgeNo
  final String baseFetchAndSaveInvoiceUrl; // https://...cloudfunctions.net/fetchAndSaveInvoiceByEttn
  final String baseSyncAllDespatchesUrl; // https://.../syncAllDespatches - tüm irsaliyeler sayfalı
  final String baseSyncAllInvoicesUrl; // https://.../syncAllInvoices - tüm faturalar sayfalı
  final String baseSyncAndEnrichInvoices2026Url; // https://.../syncAndEnrichInvoices2026 - 2026 faturalar sync+enrich
  final String baseListGelenBelgeleriExtUrl;
  /// Tarih aralığındaki faturaları indirip `qnb_invoices` koleksiyonuna yazar (UBL zenginleştirme dahil).
  final String baseBackfillInvoicesFullByDateRangeUrl;
  /// `qnb_docs` önbelleğindeki ETTN'leri `qnb_invoices/.../despatches` kayıtlarına yazar (portal yok).
  final String baseBackfillDespatchEttnFromQnbDocsUrl;
  /// `despatches` içine ETTN ile UBL (`contentUbl` / `ublParsed`) yazar; önce qnb_docs, yoksa portal.
  final String baseEnrichInvoiceDespatchesUblByEttnUrl;
  final String baseUpdateQnbInvoiceYonetimOnayUrl;

  Future<String> _idToken() async {
    final auth = FirebaseAuth.instance;
    final user = auth.currentUser;
    if (user == null) throw Exception('NOT_LOGGED_IN');

    final token = await user.getIdToken(true);

    if (token == null) {
      throw Exception('TOKEN_NULL');
    }
    return token;

  }

  Future<List<Map<String, dynamic>>> listDocs({
    String? type, // invoice|despatch|all
    String? status, // PENDING|APPROVED|REJECTED|ALL
    int limit = 50,
    bool includeRelatedDespatches = false,
  }) async {
    final token = await _idToken();

    final uri = Uri.parse(baseListUrl).replace(queryParameters: {
      if (type != null) 'type': type,
      if (status != null) 'status': status,
      'limit': limit.toString(),
      if (includeRelatedDespatches) 'includeRelatedDespatches': 'true',
    });

    final r = await http.get(
      uri,
      headers: {
        'Authorization': 'Bearer $token',
        'Accept': 'application/json',
      },
    );

    if (r.statusCode >= 400) {
      throw Exception('LIST_FAILED ${r.statusCode}: ${r.body}');
    }

    final decoded = jsonDecode(r.body);
    final list = (decoded as List).cast<dynamic>();
    return list.map((e) => (e as Map).cast<String, dynamic>()).toList();
  }

  Future<void> approve({
    required String docId,
    required String action, // APPROVED|REJECTED
    String? note,
  }) async {
    final token = await _idToken();

    final uri = Uri.parse(baseApproveUrl);

    final r = await http.post(
      uri,
      headers: {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: jsonEncode({
        'docId': docId,
        'action': action,
        if (note != null && note.trim().isNotEmpty) 'note': note.trim(),
      }),
    );

    if (r.statusCode >= 400) {
      throw Exception('APPROVE_FAILED ${r.statusCode}: ${r.body}');
    }
  }

  /// [aciklamaRole] `ara_onay` / `nihai_onay` / `muhasebe` → ilgili `onayAciklama*`; `admin`/null → `onayAciklama`.
  Future<void> updateQnbInvoiceYonetimOnay({
    required String docId,
    required String decision,
    String? note,
    String? aciklamaRole,
  }) async {
    final token = await _idToken();
    final uri = Uri.parse(baseUpdateQnbInvoiceYonetimOnayUrl);
    final r = await http.post(
      uri,
      headers: {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: jsonEncode({
        'docId': docId.trim(),
        'decision': decision.trim(),
        if (note != null && note.trim().isNotEmpty) 'note': note.trim(),
        if (aciklamaRole != null && aciklamaRole.trim().isNotEmpty)
          'aciklamaRole': aciklamaRole.trim(),
      }),
    );
    if (r.statusCode >= 400) {
      throw Exception('UPDATE_INVOICE_ONAY_FAILED ${r.statusCode}: ${r.body}');
    }
  }

  /// Faturanın irsaliyelerini ve her birinin görüntü özetini (belgeOzet) döndürür.
  Future<Map<String, dynamic>> getInvoiceRelatedDespatches(String docId) async {
    final token = await _idToken();
    final uri = Uri.parse(baseRelatedDespatchesUrl).replace(queryParameters: {'docId': docId});
    final r = await http.get(
      uri,
      headers: {
        'Authorization': 'Bearer $token',
        'Accept': 'application/json',
      },
    );
    if (r.statusCode >= 400) {
      throw Exception('RELATED_DESPATCHES_FAILED ${r.statusCode}: ${r.body}');
    }
    final decoded = jsonDecode(r.body);
    return (decoded as Map).cast<String, dynamic>();
  }

  Future<Uint8List> fetchPdfBytes(String docId) async {
    final token = await _idToken();

    final uri = Uri.parse(baseViewUrl).replace(queryParameters: {'docId': docId});

    final r = await http.get(
      uri,
      headers: {
        'Authorization': 'Bearer $token',
      },
    );

    if (r.statusCode >= 400) {
      throw Exception('VIEW_FAILED ${r.statusCode}: ${r.body}');
    }

    return Uint8List.fromList(r.bodyBytes);
  }

  /// Fatura için irsaliye ilişkisini UBL'den çıkarıp Firestore'a yazar.
  Future<void> enrichInvoiceWithRelatedDespatches(String docId) async {
    final token = await _idToken();
    final uri = Uri.parse(baseEnrichUrl).replace(queryParameters: {'docId': docId});
    final r = await http.get(uri, headers: {'Authorization': 'Bearer $token', 'Accept': 'application/json'});
    if (r.statusCode >= 400) throw Exception('ENRICH_FAILED ${r.statusCode}: ${r.body}');
  }

  /// İrsaliye bilgisi olmayan faturaları toplu zenginleştirir (en fazla [limit] adet). Firestore'da relatedDespatches dolar.
  Future<Map<String, dynamic>> enrichInvoicesBatch({int limit = 10, int? year}) async {
    final token = await _idToken();

    final qp = <String, String>{
      'batch': '1',
      'limit': limit.toString(),
      if (year != null) 'year': year.toString(),
    };

    final uri = Uri.parse(baseEnrichUrl).replace(queryParameters: qp);
    final r = await http.get(uri, headers: {'Authorization': 'Bearer $token', 'Accept': 'application/json'});
    if (r.statusCode >= 400) throw Exception('ENRICH_BATCH_FAILED ${r.statusCode}: ${r.body}');
    final decoded = jsonDecode(r.body);
    return (decoded as Map).cast<String, dynamic>();
  }

  /// Debug: Son faturanın docId, belgeNo ve bu faturaya ait irsaliye numaralarını döndürür (ve Flutter konsoluna yazar).
  Future<Map<String, dynamic>> debugLastInvoiceIrsaliye() async {
    final token = await _idToken();
    final uri = Uri.parse(baseDebugLastInvoiceIrsaliyeUrl);
    final r = await http.get(
      uri,
      headers: {
        'Authorization': 'Bearer $token',
        'Accept': 'application/json',
      },
    );
    if (r.statusCode >= 400) {
      throw Exception('DEBUG_LAST_INVOICE_IRSALIYE_FAILED ${r.statusCode}: ${r.body}');
    }
    final decoded = jsonDecode(r.body);
    final map = (decoded as Map).cast<String, dynamic>();
    // Flutter konsoluna print
    final ok = map['ok'] == true;
    final lastInvoice = map['lastInvoice'] as Map<String, dynamic>?;
    final irsaliyeNumbers = map['irsaliyeNumbers'] as List<dynamic>? ?? [];
    print('[debugLastInvoiceIrsaliye] ok=$ok');
    if (lastInvoice != null) {
      print('[debugLastInvoiceIrsaliye] Son fatura docId=${lastInvoice['docId']}, belgeNo=${lastInvoice['belgeNo']}');
    }
    print('[debugLastInvoiceIrsaliye] Bu faturaya ait irsaliye numarası(ları): $irsaliyeNumbers');
    return map;
  }

  /// İrsaliye numarası ve isteğe bağlı tarih veya ETTN ile portaldan UBL/XML indirir ve Firestore'a kaydeder.
  /// [ettn] Verilirse liste atlanır, doğrudan ETTN ile indirilir (listede yoksa fatura detayından veya portaldan alın).
  /// [tarih] YYYY-MM-DD veya DD.MM.YYYY (tek gün). [from]/[to] ile aralık da verilebilir.
  Future<Map<String, dynamic>> fetchAndSaveDespatchByBelgeNo(
    String belgeNo, {
    String? tarih,
    String? from,
    String? to,
    String? ettn,
  }) async {
    final token = await _idToken();
    final params = <String, String>{
      'belgeNo': belgeNo.trim().isEmpty ? 'BRS2026000000074' : belgeNo.trim(),
    };
    if (tarih != null && tarih.trim().isNotEmpty) params['tarih'] = tarih.trim();
    if (from != null && from.trim().isNotEmpty) params['from'] = from.trim();
    if (to != null && to.trim().isNotEmpty) params['to'] = to.trim();
    if (ettn != null && ettn.trim().isNotEmpty) params['ettn'] = ettn.trim();
    final uri = Uri.parse(baseFetchAndSaveDespatchUrl).replace(queryParameters: params);
    final r = await http.get(
      uri,
      headers: {
        'Authorization': 'Bearer $token',
        'Accept': 'application/json',
      },
    );
    if (r.statusCode >= 400) {
      throw Exception('FETCH_SAVE_DESPATCH_FAILED ${r.statusCode}: ${r.body}');
    }
    final decoded = jsonDecode(r.body);
    return (decoded as Map).cast<String, dynamic>();
  }

  /// ETTN ile faturanın UBL/XML verisini çekip Firestore'da ilgili fatura kaydına yazar.
  Future<Map<String, dynamic>> fetchAndSaveInvoiceByEttn({
    required String docId,
    required String ettn,
  }) async {
    final token = await _idToken();
    final headers = {
      'Authorization': 'Bearer $token',
      'Accept': 'application/json',
    };

    // Öncelik: "fatura indir" webservisi (ETTN ile)
    final primaryUri = Uri.parse(baseFetchAndSaveInvoiceUrl).replace(queryParameters: {
      'ettn': ettn.trim(),
    });
    final primary = await http.get(primaryUri, headers: headers);
    if (primary.statusCode < 400) {
      final decoded = jsonDecode(primary.body);
      return (decoded as Map).cast<String, dynamic>();
    }

    // Geriye uyumluluk: bazı eski servisler docId+ettn bekleyebilir.
    final fallbackUri = Uri.parse(baseFetchAndSaveInvoiceUrl).replace(queryParameters: {
      'docId': docId,
      'ettn': ettn.trim(),
    });
    final fallback = await http.get(fallbackUri, headers: headers);
    if (fallback.statusCode >= 400) {
      throw Exception('FETCH_SAVE_INVOICE_FAILED ${fallback.statusCode}: ${fallback.body}');
    }
    final decoded = jsonDecode(fallback.body);
    return (decoded as Map).cast<String, dynamic>();
  }

  /// QNB'den fatura veya irsaliye listesini çekip Firestore'a yazar. type: invoice | despatch
  Future<Map<String, dynamic>> syncDocs({required String type, bool resetInvoiceCursor = false}) async {
    final token = await _idToken();
    final qp = <String, String>{'type': type};
    if (resetInvoiceCursor) qp['resetInvoiceCursor'] = '1';
    final uri = Uri.parse(baseSyncUrl).replace(queryParameters: qp);
    final r = await http.post(
      uri,
      headers: {
        'Authorization': 'Bearer $token',
        'Accept': 'application/json',
      },
    );
    if (r.statusCode >= 400) {
      throw Exception('SYNC_FAILED ${r.statusCode}: ${r.body}');
    }
    final decoded = jsonDecode(r.body);
    return (decoded as Map).cast<String, dynamic>();
  }

  /// 2026 faturalarını indirir ve her birini enrich eder (sync + UBL). hasMore ile recursive çağrılır.
  Future<Map<String, dynamic>> syncAndEnrichInvoices2026({
    int? start,
    int pageSize = 1000,
    int windowDays = 7,
    bool resetYearCursor = false,
  }) async {
    final token = await _idToken();
    final qp = <String, String>{
      'pageSize': pageSize.toString(),
      'windowDays': windowDays.toString(),
      if (resetYearCursor) 'resetYearCursor': '1',
    };
    if (start != null) qp['start'] = start.toString();
    final uri = Uri.parse(baseSyncAndEnrichInvoices2026Url).replace(queryParameters: qp);
    final r = await http.get(
      uri,
      headers: {
        'Authorization': 'Bearer $token',
        'Accept': 'application/json',
      },
    );
    if (r.statusCode >= 400) {
      throw Exception('SYNC_AND_ENRICH_2026_FAILED ${r.statusCode}: ${r.body}');
    }
    final decoded = jsonDecode(r.body);
    return (decoded as Map).cast<String, dynamic>();
  }

  /// Portaldaki irsaliyeleri sayfalı çeker.
  /// [start] verilmezse sunucu en son kaldığı yerden (qnb_sync_state.despatchNextStart) devam eder.
  Future<Map<String, dynamic>> syncAllDespatches({
    int? start,
    int pageSize = 50,
    String? from,
    String? to,
  }) async {
    final token = await _idToken();
    final qp = <String, String>{
      'pageSize': pageSize.toString(),
      if (from != null && from.trim().isNotEmpty) 'from': from.trim(),
      if (to != null && to.trim().isNotEmpty) 'to': to.trim(),
    };
    if (start != null) qp['start'] = start.toString();
    final uri = Uri.parse(baseSyncAllDespatchesUrl).replace(queryParameters: qp);
    final r = await http.get(
      uri,
      headers: {
        'Authorization': 'Bearer $token',
        'Accept': 'application/json',
      },
    );
    if (r.statusCode >= 400) {
      throw Exception('SYNC_ALL_DESPATCHES_FAILED ${r.statusCode}: ${r.body}');
    }
    final decoded = jsonDecode(r.body);
    return (decoded as Map).cast<String, dynamic>();
  }

  /// Portaldaki faturaları sayfalı çeker.
  /// [start] verilmezse sunucu en son kaldığı yerden (qnb_sync_state.invoicePageStart) devam eder.
  Future<Map<String, dynamic>> syncAllInvoices({
    int? start,
    int pageSize = 1000,
    int windowDays = 7,
    bool enrich = false,
    int? year,
    bool resetYearCursor = false,
  }) async {
    final token = await _idToken();
    final qp = <String, String>{
      'pageSize': pageSize.toString(),
      'windowDays': windowDays.toString(),
      'enrich': enrich ? '1' : '0',
      if (year != null) 'year': year.toString(),
      if (resetYearCursor) 'resetYearCursor': '1',
    };
    if (start != null) qp['start'] = start.toString();
    final uri = Uri.parse(baseSyncAllInvoicesUrl).replace(queryParameters: qp);
    try {
      final r = await http.get(
        uri,
        headers: {
          'Authorization': 'Bearer $token',
          'Accept': 'application/json',
        },
      );
      if (r.statusCode >= 400) {
        throw Exception('SYNC_ALL_INVOICES_FAILED ${r.statusCode}: ${r.body}');
      }
      final decoded = jsonDecode(r.body);
      return (decoded as Map).cast<String, dynamic>();
    } catch (_) {
      // Web'de anlık CORS/network "Failed to fetch" durumlarında fallback:
      // klasik syncDocs çağrısı ile devam et.
      final fallback = await syncDocs(type: 'invoice');
      final invoice = fallback['invoice'];
      final fetched = invoice is Map ? (invoice['fetchedCount'] as num?)?.toInt() ?? 0 : 0;
      final hasMore = fallback['hasMoreInvoices'] == true;
      return {
        'success': true,
        'hasMore': hasMore,
        'nextStart': hasMore ? ((start ?? 0) + 1) : null,
        'start': start ?? 0,
        'pageSize': pageSize,
        'fetchedInThisCall': fetched,
        'withUbl': invoice is Map ? (invoice['withUbl'] ?? 0) : 0,
        'fallback': 'syncDocs',
      };
    }
  }

  /// [gelisBaslangic] / [gelisBitis]: portala geliş tarihi (YYYY-MM-DD). İkisi birlikte verilmeli.
  Future<Map<String, dynamic>> listGelenBelgeleriExt({
    int limit = 10,
    String onayDurum = 'HEPSI',
    String? gelisBaslangic,
    String? gelisBitis,
  }) async {
    final token = await _idToken();
    final lim = gelisBaslangic != null && gelisBitis != null
        ? limit.clamp(1, 2000)
        : limit.clamp(1, 50);
    final uri = Uri.parse(baseListGelenBelgeleriExtUrl).replace(queryParameters: {
      'limit': lim.toString(),
      'onayDurum': onayDurum,
      if (gelisBaslangic != null && gelisBaslangic.trim().isNotEmpty)
        'gelisBaslangic': gelisBaslangic.trim(),
      if (gelisBitis != null && gelisBitis.trim().isNotEmpty) 'gelisBitis': gelisBitis.trim(),
    });
    final r = await http.get(
      uri,
      headers: {
        'Authorization': 'Bearer $token',
        'Accept': 'application/json',
      },
    );
    if (r.statusCode >= 400) {
      throw Exception('LIST_GELEN_EXT_FAILED ${r.statusCode}: ${r.body}');
    }
    final decoded = jsonDecode(r.body);
    return (decoded as Map).cast<String, dynamic>();
  }

  /// [from] / [to]: portala geliş tarihi (YYYY-MM-DD). `qnb_invoices` upsert + UBL indirme.
  ///
  /// [docIds]: (opsiyonel) yalnızca belirli `invoice_...` belgeleri için ipucu.
  /// Sunucu bu parametreyi henüz desteklemiyorsa yok sayılır; geriye dönük uyumlu kalır.
  Future<Map<String, dynamic>> backfillInvoicesFullByDateRange({
    required String from,
    required String to,
    int limit = 2000,
    List<String>? docIds,
  }) async {
    final token = await _idToken();
    final qp = <String, String>{
      'from': from.trim(),
      'to': to.trim(),
      'limit': limit.clamp(1, 2000).toString(),
    };
    if (docIds != null && docIds.isNotEmpty) {
      qp['docIds'] = docIds.map((e) => e.trim()).where((e) => e.isNotEmpty).join(',');
    }
    final uri =
        Uri.parse(baseBackfillInvoicesFullByDateRangeUrl).replace(queryParameters: qp);
    final r = await http.get(
      uri,
      headers: {
        'Authorization': 'Bearer $token',
        'Accept': 'application/json',
      },
    );
    if (r.statusCode >= 400) {
      throw Exception('BACKFILL_INVOICES_FAILED ${r.statusCode}: ${r.body}');
    }
    final decoded = jsonDecode(r.body);
    return (decoded as Map).cast<String, dynamic>();
  }

  /// `despatches` alt koleksiyonunda ETTN eksik/yanlışsa `qnb_docs/despatch_*` ile doldurur.
  /// [allInvoices]: `qnb_invoices` içindeki tüm `type == invoice` kayıtları (sayfalı tarama).
  /// [docId]: yalnızca `invoice_...` tek fatura ([allInvoices] ile birlikte kullanılmaz).
  Future<Map<String, dynamic>> backfillDespatchEttnFromQnbDocs({
    String? docId,
    int limit = 100,
    bool allInvoices = false,
  }) async {
    final token = await _idToken();
    final qp = <String, String>{
      if (!allInvoices) 'limit': limit.clamp(1, 300).toString(),
      if (allInvoices) 'all': '1',
      if (docId != null && docId.trim().isNotEmpty) 'docId': docId.trim(),
    };
    final uri = Uri.parse(baseBackfillDespatchEttnFromQnbDocsUrl).replace(queryParameters: qp);
    final timeout = allInvoices ? const Duration(minutes: 9) : const Duration(minutes: 2);
    final r = await http
        .get(
          uri,
          headers: {
            'Authorization': 'Bearer $token',
            'Accept': 'application/json',
          },
        )
        .timeout(timeout);
    if (r.statusCode >= 400) {
      throw Exception('BACKFILL_DESPATCH_ETTN_FAILED ${r.statusCode}: ${r.body}');
    }
    final decoded = jsonDecode(r.body);
    return (decoded as Map).cast<String, dynamic>();
  }

  /// Her faturanın `despatches` altında geçerli `ettn` varsa UBL doldurur (`allInvoices`: tüm koleksiyon).
  /// [force]: Mevcut DespatchAdvice XML'i olsa bile yeniden indirir / qnb_docs'tan yazar.
  Future<Map<String, dynamic>> enrichInvoiceDespatchesUblByEttn({
    String? docId,
    int limit = 100,
    bool allInvoices = false,
    bool force = false,
  }) async {
    final token = await _idToken();
    final qp = <String, String>{
      if (!allInvoices) 'limit': limit.clamp(1, 300).toString(),
      if (allInvoices) 'all': '1',
      if (force) 'force': '1',
      if (docId != null && docId.trim().isNotEmpty) 'docId': docId.trim(),
    };
    final uri = Uri.parse(baseEnrichInvoiceDespatchesUblByEttnUrl).replace(queryParameters: qp);
    final timeout = allInvoices ? const Duration(minutes: 9) : const Duration(minutes: 2);
    final r = await http
        .get(
          uri,
          headers: {
            'Authorization': 'Bearer $token',
            'Accept': 'application/json',
          },
        )
        .timeout(timeout);
    if (r.statusCode >= 400) {
      throw Exception('ENRICH_DESPATCHES_UBL_FAILED ${r.statusCode}: ${r.body}');
    }
    final decoded = jsonDecode(r.body);
    return (decoded as Map).cast<String, dynamic>();
  }
}