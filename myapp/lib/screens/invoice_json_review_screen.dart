import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';

import '../formatting/display_date.dart';
import '../services/qnb_api.dart';
import '../widgets/ara_onay_yonlendir_dialog.dart';

String _safeDocKey(String s) => s.replaceAll(RegExp(r'[/\\]'), '_');

String? _ublXmlScalarText(dynamic node) {
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

dynamic _ublFirst(dynamic x) {
  if (x is List && x.isNotEmpty) return x.first;
  return x;
}

String? _ublItemIdentificationId(dynamic ident) {
  if (ident == null) return null;
  if (ident is String) {
    final t = ident.trim();
    return t.isEmpty ? null : t;
  }
  if (ident is Map) {
    final m = Map<String, dynamic>.from(ident);
    final idNode = _ublFirst(m['ID']);
    if (idNode is Map) {
      return _ublXmlScalarText(Map<String, dynamic>.from(idNode))?.trim();
    }
    return idNode?.toString().trim();
  }
  return null;
}

void _ublCollectNoteNodes(dynamic raw, List<String> out) {
  if (raw == null) return;
  if (raw is String) {
    final t = raw.trim();
    if (t.isNotEmpty) out.add(t);
    return;
  }
  if (raw is List) {
    for (final e in raw) {
      _ublCollectNoteNodes(e, out);
    }
    return;
  }
  if (raw is Map) {
    final t = _ublXmlScalarText(raw)?.trim();
    if (t != null && t.isNotEmpty) out.add(t);
  }
}

List<String> _ublInvoiceLineNotes(dynamic noteNode) {
  final out = <String>[];
  _ublCollectNoteNodes(noteNode, out);
  final seen = <String>{};
  return out.where((s) => seen.add(s)).toList();
}

/// UBL `Item/Description` (tek veya çoklu metin düğümü).
String? _ublItemDescriptionText(dynamic raw) {
  final parts = <String>[];
  _ublCollectNoteNodes(raw, parts);
  if (parts.isEmpty) return null;
  return parts.join(' ');
}

String _kalemUblSutunBasligiTr(String anahtar) {
  const tr = <String, String>{
    'Note': 'Satır notu',
    'OrderLineReference/ID': 'Sipariş satır referansı',
    'Item/Description': 'Açıklama',
    'Item/BuyersItemIdentification/ID': 'Alıcı ürün tanımı',
    'Item/Name': 'Ürün / hizmet adı',
    'InvoicedQuantity': 'Miktar',
    'Price/PriceAmount': 'Birim fiyat',
    'LineExtensionAmount': 'Satır tutarı',
    'AllowanceCharge': 'İndirim / ek ücret',
    'TaxTotal/TaxAmount': 'Satır KDV tutarı',
    'TaxTotal/TaxSubtotal/Percent': 'KDV oranı',
    'TaxTotal/TaxSubtotal/TaxCategory/TaxScheme/TaxTypeCode': 'Vergi kodu',
  };
  return tr[anahtar] ?? anahtar;
}

String? _ublAllowanceChargeOzeti(dynamic raw) {
  if (raw == null) return null;
  final parts = <String>[];
  final arr = raw is List ? raw : [raw];
  for (final e in arr) {
    if (e is! Map) continue;
    final m = Map<String, dynamic>.from(e);
    final ind = m['ChargeIndicator'];
    final isCharge = ind == true ||
        ind == 1 ||
        '$ind'.toLowerCase() == 'true' ||
        '$ind'.toLowerCase() == '1';
    final amt = m['Amount'];
    num? n;
    String? cur;
    if (amt is Map) {
      final am = Map<String, dynamic>.from(amt);
      cur = (am['@_currencyID'] ?? am['@_CurrencyID'])?.toString();
      n = _asNum(_ublXmlScalarText(am) ?? am);
    } else {
      n = _asNum(amt);
    }
    if (n == null) continue;
    final label = isCharge ? 'Ek ücret' : 'İndirim';
    parts.add('$label: ${_formatMoney(n, currency: cur)}');
  }
  if (parts.isEmpty) return null;
  return parts.join(' · ');
}

/// UBL fatura satırı [TaxTotal] → tutar / oran / kod özeti.
Map<String, dynamic> _ublInvoiceLineVergiOzet(Map<String, dynamic> line, String? docCur) {
  final out = <String, dynamic>{};
  final tt = line['TaxTotal'];
  if (tt is! Map) return out;
  final ttm = Map<String, dynamic>.from(tt);
  final ta = ttm['TaxAmount'];
  if (ta != null) {
    num? taxAmt;
    String? taxCur;
    if (ta is Map) {
      final tam = Map<String, dynamic>.from(ta);
      taxCur = (tam['@_currencyID'] ?? tam['@_CurrencyID'])?.toString();
      taxAmt = _asNum(_ublXmlScalarText(tam) ?? tam);
    } else {
      taxAmt = _asNum(ta);
    }
    if (taxAmt != null) {
      out['satirKdvTutari'] = taxAmt;
      final c = taxCur?.trim();
      if (c != null && c.isNotEmpty) {
        out['satirKdvParaBirimi'] = c;
      } else if (docCur != null && docCur.isNotEmpty) {
        out['satirKdvParaBirimi'] = docCur;
      }
    }
  }

  final subRaw = ttm['TaxSubtotal'];
  final subs = subRaw is List ? subRaw : (subRaw != null ? [subRaw] : <dynamic>[]);
  final oranParcalari = <String>[];
  final kodParcalari = <String>[];
  for (final s in subs) {
    if (s is! Map) continue;
    final sm = Map<String, dynamic>.from(s);
    final pRaw = sm['Percent'];
    final pn = _asNum(pRaw is Map ? _ublXmlScalarText(Map<String, dynamic>.from(pRaw)) : pRaw);
    if (pn != null) {
      oranParcalari.add('${_formatTurkishAmount(pn, fractionDigits: 2)}%');
    }
    final tc = sm['TaxCategory'];
    if (tc is Map) {
      final ts = Map<String, dynamic>.from(tc)['TaxScheme'];
      if (ts is Map) {
        final code = _ublXmlScalarText(Map<String, dynamic>.from(ts)['TaxTypeCode'])?.trim();
        if (code != null && code.isNotEmpty) kodParcalari.add(code);
      }
    }
  }
  if (oranParcalari.isNotEmpty) {
    out['kdvOranMetni'] = oranParcalari.join(', ');
  }
  if (kodParcalari.isNotEmpty) {
    out['vergiKodlariMetni'] = kodParcalari.join(' · ');
  }
  return out;
}

String? _ublOrderLineReferenceId(dynamic olr) {
  final first = _ublFirst(olr);
  if (first is! Map) return null;
  return _ublXmlScalarText(Map<String, dynamic>.from(first)['ID'])?.trim();
}

bool _gecerliGonderenAdi(String? s) {
  if (s == null || s.trim().isEmpty) return false;
  final t = s.trim().toLowerCase();
  if (t.startsWith('urn:mail:')) return false;
  if (t.contains('@') && t.contains('.') && !t.contains(' ')) return false;
  return true;
}

String? _gondericiUnvanFromUblParsed(Map<String, dynamic> d) {
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

String _gonderenUnvani(Map<String, dynamic> d) {
  final fromUbl = _gondericiUnvanFromUblParsed(d);
  if (fromUbl != null && fromUbl.isNotEmpty && _gecerliGonderenAdi(fromUbl)) {
    return fromUbl;
  }
  final raw = d['qnbRaw'];
  final rm = raw is Map ? Map<String, dynamic>.from(raw) : <String, dynamic>{};
  final candidates = [
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
  for (final c in candidates) {
    final s = c?.toString().trim();
    if (s != null && s.isNotEmpty && _gecerliGonderenAdi(s)) return s;
  }
  final vkn = d['supplierVkn']?.toString().trim();
  if (vkn != null && vkn.isNotEmpty) return 'VKN: $vkn';
  return '';
}

String? _faturaTarihi(Map<String, dynamic> data) {
  final q = data['qnbRaw'];
  if (q is Map) {
    final bt = Map<String, dynamic>.from(q)['belgeTarihi']?.toString().trim();
    if (bt != null && bt.isNotEmpty) return bt;
  }
  final upRaw = data['ublParsed'];
  if (upRaw is Map) {
    final up = Map<String, dynamic>.from(upRaw);
    final invRaw = _ublFirst(up['Invoice']);
    if (invRaw is Map) {
      final inv = Map<String, dynamic>.from(invRaw);
      final issue = _ublXmlScalarText(inv['IssueDate']);
      if (issue != null && issue.isNotEmpty) return issue;
    }
  }
  final bo = data['belgeOzet'];
  if (bo is Map) {
    final bb = Map<String, dynamic>.from(bo)['belgeBilgileri'];
    if (bb is Map) {
      final id = Map<String, dynamic>.from(bb)['IssueDate']?.toString().trim();
      if (id != null && id.isNotEmpty) return id;
    }
  }
  return null;
}

String? _gelisTarihi(Map<String, dynamic> data) {
  final q = data['qnbRaw'];
  if (q is Map) {
    final m = Map<String, dynamic>.from(q);
    final g = (m['faturaGelisTarihi'] ?? m['gelisTarihi'])?.toString().trim();
    if (g != null && g.isNotEmpty) return g;
  }
  return null;
}

Map<String, dynamic> _kalemFromBelgeOzetInvoiceLine(Map<String, dynamic> line) {
  final item = line['Item'];
  String ad = '';
  String? sellerSku;
  String? buyerSku;
  if (item is Map) {
    final im = Map<String, dynamic>.from(item);
    ad = im['Name']?.toString().trim() ?? '';
    final s = im['SellersItemIdentification'];
    final b = im['BuyersItemIdentification'];
    sellerSku = s?.toString().trim();
    buyerSku = b?.toString().trim();
    if (sellerSku != null && sellerSku.isEmpty) sellerSku = null;
    if (buyerSku != null && buyerSku.isEmpty) buyerSku = null;
  }
  final cur = line['currencyID']?.toString().trim();
  final lineId = line['ID']?.toString().trim();
  final unitCode = line['unitCode']?.toString().trim();
  final satirVergi = _asNum(line['TaxAmount']);
  num? kdvOran;
  String? vergiKodu;
  String? kdvOranMetni;
  final kdv = line['KDV'];
  if (kdv is Map) {
    final km = Map<String, dynamic>.from(kdv);
    kdvOran = _asNum(km['Percent']);
    vergiKodu = km['TaxTypeCode']?.toString().trim();
    if (vergiKodu != null && vergiKodu.isEmpty) vergiKodu = null;
    if (kdvOran != null) {
      kdvOranMetni = '${_formatTurkishAmount(kdvOran, fractionDigits: 2)}%';
    }
  }

  return <String, dynamic>{
    if (lineId != null && lineId.isNotEmpty) 'satirNo': lineId,
    if (ad.isNotEmpty) 'aciklama': ad,
    if (sellerSku != null && sellerSku.isNotEmpty) 'saticiKalemKodu': sellerSku,
    if (buyerSku != null && buyerSku.isNotEmpty) 'aliciKalemKodu': buyerSku,
    if (line['InvoicedQuantity'] != null) 'miktar': line['InvoicedQuantity'],
    if (unitCode != null && unitCode.isNotEmpty) 'birim': unitCode,
    if (line['LineExtensionAmount'] != null) 'satirTutari': line['LineExtensionAmount'],
    if (cur != null && cur.isNotEmpty) 'satirParaBirimi': cur,
    if (satirVergi != null) 'satirKdvTutari': satirVergi,
    if (kdvOran != null) 'kdvOrani': kdvOran,
    if (kdvOranMetni != null && kdvOranMetni.isNotEmpty) 'kdvOranMetni': kdvOranMetni,
    if (vergiKodu != null && vergiKodu.isNotEmpty) 'vergiKodlariMetni': vergiKodu,
  };
}

void _kalemTabloHucreEkle(Map<String, String> out, String anahtar, String? deger) {
  if (deger == null) return;
  final t = deger.trim();
  if (t.isEmpty) return;
  out[anahtar] = t;
}

/// `belgeOzet` fatura satırı (InvoiceLine özeti) → tablo başlığı = UBL-benzeri yol adları.
Map<String, String> _flattenBelgeOzetInvoiceLineForTablo(Map<String, dynamic> line, String? docCur) {
  final out = <String, String>{};

  final qty = line['InvoicedQuantity'];
  final uc = line['unitCode']?.toString().trim();
  if (qty != null) {
    final qs = qty.toString().trim();
    if (qs.isNotEmpty) {
      _kalemTabloHucreEkle(out, 'InvoicedQuantity', uc != null && uc.isNotEmpty ? '$qs $uc' : qs);
    }
  }

  final cur = line['currencyID']?.toString().trim();
  final le = line['LineExtensionAmount'];
  if (le != null) {
    final n = _asNum(le);
    if (n != null) {
      _kalemTabloHucreEkle(out, 'LineExtensionAmount', _formatMoney(n, currency: cur ?? docCur));
    }
  }

  final item = line['Item'];
  if (item is Map) {
    final im = Map<String, dynamic>.from(item);
    _kalemTabloHucreEkle(out, 'Item/Name', im['Name']?.toString().trim());
    _kalemTabloHucreEkle(out, 'Item/Description', _ublItemDescriptionText(im['Description']));
    final b = im['BuyersItemIdentification']?.toString().trim();
    if (b != null && b.isNotEmpty) {
      _kalemTabloHucreEkle(out, 'Item/BuyersItemIdentification/ID', b);
    }
  }

  final ta = line['TaxAmount'];
  if (ta != null) {
    final n = _asNum(ta);
    if (n != null) {
      _kalemTabloHucreEkle(out, 'TaxTotal/TaxAmount', _formatMoney(n, currency: cur ?? docCur));
    }
  }

  final kdv = line['KDV'];
  if (kdv is Map) {
    final km = Map<String, dynamic>.from(kdv);
    final p = _asNum(km['Percent']);
    if (p != null) {
      _kalemTabloHucreEkle(out, 'TaxTotal/TaxSubtotal/Percent', _formatTurkishAmount(p, fractionDigits: 2));
    }
    _kalemTabloHucreEkle(out, 'TaxTotal/TaxSubtotal/TaxCategory/TaxScheme/TaxTypeCode', km['TaxTypeCode']?.toString().trim());
  }

  const bilinen = <String>{
    'ID',
    'InvoicedQuantity',
    'unitCode',
    'LineExtensionAmount',
    'currencyID',
    'Item',
    'TaxAmount',
    'KDV',
  };
  for (final e in line.entries) {
    if (bilinen.contains(e.key)) continue;
    final v = e.value;
    if (v == null || v is Map || v is List) continue;
    final t = v.toString().trim();
    if (t.isNotEmpty) {
      _kalemTabloHucreEkle(out, e.key, t);
    }
  }
  return out;
}

/// UBL `InvoiceLine` → tablo hücreleri (başlık olarak yerel öğe / alt öğe yolu).
Map<String, String> _flattenUblInvoiceLineForTablo(Map<String, dynamic> line, String? docCur) {
  final out = <String, String>{};

  final notes = _ublInvoiceLineNotes(line['Note']);
  if (notes.isNotEmpty) {
    _kalemTabloHucreEkle(out, 'Note', notes.join(' | '));
  }

  _kalemTabloHucreEkle(out, 'OrderLineReference/ID', _ublOrderLineReferenceId(line['OrderLineReference']));

  final itemRaw = _ublFirst(line['Item']);
  if (itemRaw is Map) {
    final im = Map<String, dynamic>.from(itemRaw);
    _kalemTabloHucreEkle(out, 'Item/Name', _ublXmlScalarText(im['Name']));
    _kalemTabloHucreEkle(out, 'Item/Description', _ublItemDescriptionText(im['Description']));
    _kalemTabloHucreEkle(
      out,
      'Item/BuyersItemIdentification/ID',
      _ublItemIdentificationId(im['BuyersItemIdentification']),
    );
  }

  final qty = line['InvoicedQuantity'];
  String qtyStr = '';
  String? uCode;
  if (qty is Map) {
    final qm = Map<String, dynamic>.from(qty);
    qtyStr = _ublXmlScalarText(qm)?.trim() ?? '';
    uCode = (qm['@_unitCode'] ?? qm['@_UnitCode'])?.toString();
  } else if (qty != null) {
    qtyStr = qty.toString().trim();
  }
  if (qtyStr.isNotEmpty) {
    final birim = uCode;
    if (birim != null && birim.isNotEmpty) {
      _kalemTabloHucreEkle(out, 'InvoicedQuantity', '$qtyStr $birim');
    } else {
      _kalemTabloHucreEkle(out, 'InvoicedQuantity', qtyStr);
    }
  }

  final price = line['Price'];
  if (price is Map) {
    final pm = Map<String, dynamic>.from(price);
    final pa = pm['PriceAmount'];
    if (pa != null) {
      String? pCur;
      if (pa is Map) {
        final pam = Map<String, dynamic>.from(pa);
        pCur = (pam['@_currencyID'] ?? pam['@_CurrencyID'])?.toString();
      }
      final pv = pa is Map ? _ublXmlScalarText(pa) : pa.toString();
      final n = _asNum(pv);
      if (n != null) {
        _kalemTabloHucreEkle(out, 'Price/PriceAmount', _formatMoney(n, currency: pCur ?? docCur, fractionDigits: 4));
      }
    }
  }

  final le = line['LineExtensionAmount'];
  if (le != null) {
    String? lCur;
    if (le is Map) {
      final lem = Map<String, dynamic>.from(le);
      lCur = (lem['@_currencyID'] ?? lem['@_CurrencyID'])?.toString();
    }
    final lv = le is Map ? _ublXmlScalarText(Map<String, dynamic>.from(le)) : le.toString();
    final n = _asNum(lv);
    if (n != null) {
      _kalemTabloHucreEkle(out, 'LineExtensionAmount', _formatMoney(n, currency: lCur ?? docCur));
    }
  }

  final isk = _ublAllowanceChargeOzeti(line['AllowanceCharge']);
  if (isk != null && isk.isNotEmpty) {
    _kalemTabloHucreEkle(out, 'AllowanceCharge', isk);
  }

  final vm = _ublInvoiceLineVergiOzet(line, docCur);
  final taxN = _asNum(vm['satirKdvTutari']);
  if (taxN != null) {
    _kalemTabloHucreEkle(
      out,
      'TaxTotal/TaxAmount',
      _formatMoney(taxN, currency: vm['satirKdvParaBirimi']?.toString()),
    );
  }
  final oranMetni = vm['kdvOranMetni']?.toString().trim();
  if (oranMetni != null && oranMetni.isNotEmpty) {
    _kalemTabloHucreEkle(out, 'TaxTotal/TaxSubtotal/Percent', oranMetni);
  }
  final kodMetni = vm['vergiKodlariMetni']?.toString().trim();
  if (kodMetni != null && kodMetni.isNotEmpty) {
    _kalemTabloHucreEkle(out, 'TaxTotal/TaxSubtotal/TaxCategory/TaxScheme/TaxTypeCode', kodMetni);
  }

  const bilinen = <String>{
    'Item',
    'Price',
    'TaxTotal',
    'Note',
    'Description',
    'ID',
    'InvoicedQuantity',
    'LineExtensionAmount',
    'OrderLineReference',
    'AllowanceCharge',
    'InvoiceLine',
  };
  for (final e in line.entries) {
    if (bilinen.contains(e.key)) continue;
    final v = e.value;
    if (v == null || v is Map || v is List) continue;
    final t = _ublXmlScalarText(v)?.trim() ?? v.toString().trim();
    if (t.isNotEmpty) {
      _kalemTabloHucreEkle(out, e.key, t);
    }
  }

  return out;
}

/// Bilinen UBL InvoiceLine yolları için tercih sırası; diğerleri alfabetik sonda.
int _kalemUblSutunSiralama(String k) {
  const sira = <String>[
    'Note',
    'OrderLineReference/ID',
    'Item/Description',
    'Item/BuyersItemIdentification/ID',
    'Item/Name',
    'InvoicedQuantity',
    'Price/PriceAmount',
    'LineExtensionAmount',
    'AllowanceCharge',
    'TaxTotal/TaxAmount',
    'TaxTotal/TaxSubtotal/Percent',
    'TaxTotal/TaxSubtotal/TaxCategory/TaxScheme/TaxTypeCode',
  ];
  final i = sira.indexOf(k);
  if (i >= 0) return i;
  return 1000 + k.hashCode.abs() % 10000;
}

List<String> _kalemUblSutunAnahtarlari(List<Map<String, dynamic>> satirlar) {
  final tum = <String>{};
  for (final r in satirlar) {
    final m = r['_ublHucreleri'];
    if (m is Map) {
      tum.addAll(m.keys.map((e) => e.toString()));
    }
  }
  final liste = tum.toList()..sort((a, b) {
    final da = _kalemUblSutunSiralama(a);
    final db = _kalemUblSutunSiralama(b);
    if (da != db) return da.compareTo(db);
    return a.compareTo(b);
  });
  return liste;
}

TextAlign _kalemUblSutunHizasi(String anahtar) {
  if (anahtar == 'InvoicedQuantity' ||
      anahtar.contains('Amount') ||
      anahtar.contains('Percent') ||
      anahtar.contains('TaxTypeCode')) {
    return TextAlign.right;
  }
  return TextAlign.left;
}

double _kalemDinamikSutunGenisligi(String anahtar) {
  if (anahtar == 'Item/Description') {
    return (120.0 + anahtar.length * 2.0).clamp(140.0, 320.0);
  }
  final base = 72.0 + anahtar.length * 4.2;
  return base.clamp(88.0, 240.0);
}

List<Map<String, dynamic>> _faturaKalemleri(Map<String, dynamic> data) {
  final bo = data['belgeOzet'];
  if (bo is Map) {
    final bom = Map<String, dynamic>.from(bo);
    final docCur = _documentCurrencyFromInvoice(data);
    final rows = <Map<String, dynamic>>[];
    final multi = bom['faturaSatirlari'];
    if (multi is List) {
      for (final raw in multi) {
        if (raw is Map) {
          final rm = Map<String, dynamic>.from(raw);
          final row = _kalemFromBelgeOzetInvoiceLine(rm);
          row['_ublHucreleri'] = _flattenBelgeOzetInvoiceLineForTablo(rm, docCur);
          rows.add(row);
        }
      }
    } else {
      final single = bom['faturaSatiri'];
      if (single is Map) {
        final rm = Map<String, dynamic>.from(single);
        final row = _kalemFromBelgeOzetInvoiceLine(rm);
        row['_ublHucreleri'] = _flattenBelgeOzetInvoiceLineForTablo(rm, docCur);
        rows.add(row);
      }
    }
    if (rows.isNotEmpty) {
      if (docCur != null && docCur.isNotEmpty) {
        for (final r in rows) {
          if (r['satirTutari'] != null &&
              (r['satirParaBirimi'] == null || (r['satirParaBirimi'] as Object).toString().trim().isEmpty)) {
            r['satirParaBirimi'] = docCur;
          }
        }
      }
      return rows;
    }
  }

  final upRaw = data['ublParsed'];
  if (upRaw is! Map) return [];
  final up = Map<String, dynamic>.from(upRaw);
  final invRaw = up['Invoice'];
  if (invRaw is! Map) return [];
  final inv = Map<String, dynamic>.from(invRaw);
  final linesRaw = inv['InvoiceLine'];
  if (linesRaw == null) return [];
  final lines = linesRaw is List
      ? linesRaw.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
      : [Map<String, dynamic>.from(linesRaw as Map)];
  final docCur = _documentCurrencyFromInvoice(data);
  final out = <Map<String, dynamic>>[];
  for (final line in lines) {
    final itemRaw = _ublFirst(line['Item']);
    var name = '';
    if (itemRaw is Map) {
      name = _ublXmlScalarText(Map<String, dynamic>.from(itemRaw)['Name'])?.trim() ?? '';
    }
    final lineId = _ublXmlScalarText(line['ID'])?.trim();
    String? sellerId;
    String? buyerId;
    if (itemRaw is Map) {
      final im = Map<String, dynamic>.from(itemRaw);
      sellerId = _ublItemIdentificationId(im['SellersItemIdentification']);
      buyerId = _ublItemIdentificationId(im['BuyersItemIdentification']);
    }
    final satirNotlari = _ublInvoiceLineNotes(line['Note']);
    final siparisSatiri = _ublOrderLineReferenceId(line['OrderLineReference']);
    final iskontoAciklama = _ublAllowanceChargeOzeti(line['AllowanceCharge']);
    final qty = line['InvoicedQuantity'];
    num? miktar;
    String? birim;
    if (qty is Map) {
      final qm = Map<String, dynamic>.from(qty);
      final t = _ublXmlScalarText(qm);
      if (t != null) miktar = num.tryParse(t) ?? double.tryParse(t);
      birim = (qm['@_unitCode'] ?? qm['@_UnitCode'])?.toString();
    } else if (qty is num) {
      miktar = qty;
    }
    String? priceCur;
    final price = line['Price'];
    num? birimFiyat;
    if (price is Map) {
      final pm = Map<String, dynamic>.from(price);
      final pa = pm['PriceAmount'];
      if (pa != null) {
        if (pa is Map) {
          final pam = Map<String, dynamic>.from(pa);
          priceCur = (pam['@_currencyID'] ?? pam['@_CurrencyID'])?.toString();
        }
        final pv = pa is Map ? _ublXmlScalarText(pa) : pa.toString();
        birimFiyat = num.tryParse(pv ?? '') ?? double.tryParse(pv ?? '');
      }
    }
    String? lineCur;
    final le = line['LineExtensionAmount'];
    num? satir;
    if (le != null) {
      if (le is Map) {
        final lem = Map<String, dynamic>.from(le);
        lineCur = (lem['@_currencyID'] ?? lem['@_CurrencyID'])?.toString();
      }
      final lv = le is Map ? _ublXmlScalarText(Map<String, dynamic>.from(le)) : le.toString();
      satir = num.tryParse(lv ?? '') ?? double.tryParse(lv ?? '');
    }
    final vergiMap = _ublInvoiceLineVergiOzet(line, docCur);
    final ublHucreleri = _flattenUblInvoiceLineForTablo(line, docCur);
    out.add(<String, dynamic>{
      if (lineId != null && lineId.isNotEmpty) 'satirNo': lineId,
      if (name.isNotEmpty) 'aciklama': name,
      if (sellerId != null && sellerId.isNotEmpty) 'saticiKalemKodu': sellerId,
      if (buyerId != null && buyerId.isNotEmpty) 'aliciKalemKodu': buyerId,
      if (satirNotlari.isNotEmpty) 'satirNotlari': satirNotlari,
      if (siparisSatiri != null && siparisSatiri.isNotEmpty) 'siparisSatiriRef': siparisSatiri,
      if (iskontoAciklama != null && iskontoAciklama.isNotEmpty) 'iskontoAciklama': iskontoAciklama,
      ...vergiMap,
      if (miktar != null) 'miktar': miktar,
      if (birim != null && birim.isNotEmpty) 'birim': birim,
      if (birimFiyat != null) 'birimFiyat': birimFiyat,
      if (birimFiyat != null) 'birimFiyatParaBirimi': priceCur ?? docCur,
      if (satir != null) 'satirTutari': satir,
      if (satir != null) 'satirParaBirimi': lineCur ?? docCur,
      '_ublHucreleri': ublHucreleri,
    });
  }
  return out;
}

Map<String, dynamic> _kalemDespatchBelgeOzet(Map<String, dynamic> line) {
  final item = line['Item'];
  String ad = '';
  if (item is Map) {
    ad = item['Name']?.toString().trim() ?? '';
  }
  return <String, dynamic>{
    if (ad.isNotEmpty) 'aciklama': ad,
    if (line['DeliveredQuantity'] != null) 'miktar': line['DeliveredQuantity'],
  };
}

List<Map<String, dynamic>> _irsaliyeKalemleri(Map<String, dynamic> data) {
  final bo = data['belgeOzet'];
  if (bo is Map) {
    final bom = Map<String, dynamic>.from(bo);
    final rows = <Map<String, dynamic>>[];
    final multi = bom['irsaliyeSatirlari'];
    if (multi is List) {
      for (final raw in multi) {
        if (raw is Map) rows.add(_kalemDespatchBelgeOzet(Map<String, dynamic>.from(raw)));
      }
    } else {
      final single = bom['irsaliyeSatiri'];
      if (single is Map) {
        rows.add(_kalemDespatchBelgeOzet(Map<String, dynamic>.from(single)));
      }
    }
    if (rows.isNotEmpty) return rows;
  }

  final upRaw = data['ublParsed'];
  if (upRaw is! Map) return [];
  final up = Map<String, dynamic>.from(upRaw);
  final daRaw = up['DespatchAdvice'];
  if (daRaw is! Map) return [];
  final da = Map<String, dynamic>.from(daRaw);
  final linesRaw = da['DespatchLine'];
  if (linesRaw == null) return [];
  final lines = linesRaw is List
      ? linesRaw.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
      : [Map<String, dynamic>.from(linesRaw as Map)];
  final out = <Map<String, dynamic>>[];
  for (final line in lines) {
    final itemRaw = _ublFirst(line['Item']);
    var name = '';
    if (itemRaw is Map) {
      name = _ublXmlScalarText(Map<String, dynamic>.from(itemRaw)['Name'])?.trim() ?? '';
    }
    final qty = line['DeliveredQuantity'];
    num? miktar;
    String? birim;
    if (qty is Map) {
      final qm = Map<String, dynamic>.from(qty);
      final t = _ublXmlScalarText(qm);
      if (t != null) miktar = num.tryParse(t) ?? double.tryParse(t);
      birim = (qm['@_unitCode'] ?? qm['@_UnitCode'])?.toString();
    } else if (qty is num) {
      miktar = qty;
    }
    out.add(<String, dynamic>{
      if (name.isNotEmpty) 'aciklama': name,
      if (miktar != null) 'miktar': miktar,
      if (birim != null && birim.isNotEmpty) 'birim': birim,
    });
  }
  return out;
}

String? _irsaliyeTarihi(Map<String, dynamic> data) {
  final bo = data['belgeOzet'];
  if (bo is Map) {
    final bb = Map<String, dynamic>.from(bo)['belgeBilgileri'];
    if (bb is Map) {
      final id = Map<String, dynamic>.from(bb)['IssueDate']?.toString().trim();
      if (id != null && id.isNotEmpty) return id;
    }
  }
  final upRaw = data['ublParsed'];
  if (upRaw is Map) {
    final up = Map<String, dynamic>.from(upRaw);
    final daRaw = _ublFirst(up['DespatchAdvice']);
    if (daRaw is Map) {
      final issue = _ublXmlScalarText(Map<String, dynamic>.from(daRaw)['IssueDate']);
      if (issue != null && issue.isNotEmpty) return issue;
    }
  }
  return null;
}

String _fmt(dynamic v) {
  if (v == null) return '—';
  if (v is num || v is bool) return v.toString();
  return v.toString().trim().isEmpty ? '—' : v.toString();
}

/// [Son10FaturaScreen] liste satırı — `belgeTarihi` kaynağı (`qnbRaw.belgeTarihi`).
dynamic _belgeTarihiListSource(Map<String, dynamic> data) {
  final q = data['qnbRaw'];
  if (q is Map) {
    final v = Map<String, dynamic>.from(q)['belgeTarihi'];
    if (v != null && v.toString().trim().isNotEmpty) return v;
  }
  return data['belgeTarihi'];
}

/// Binlik ayraç: `.`, ondalık: `,` (Türkiye).
String _formatTurkishAmount(num? value, {int fractionDigits = 2}) {
  if (value == null) return '—';
  final n = value.toDouble();
  final negative = n < 0;
  final x = negative ? -n : n;
  final parts = x.toStringAsFixed(fractionDigits).split('.');
  final intPartRaw = parts[0];
  final frac = parts.length > 1 ? parts[1].replaceAll(RegExp(r'0+$'), '') : '';
  final intDigits = intPartRaw;
  final buf = StringBuffer();
  for (int i = 0; i < intDigits.length; i++) {
    if (i > 0 && (intDigits.length - i) % 3 == 0) buf.write('.');
    buf.write(intDigits[i]);
  }
  final intStr = negative ? '-$buf' : buf.toString();
  final numStr = frac.isEmpty ? intStr : '$intStr,$frac';
  return numStr;
}

num? _parseNumLoose(dynamic raw) {
  if (raw == null) return null;
  if (raw is num) return raw;
  var s = raw.toString().trim().replaceAll(' ', '');
  if (s.isEmpty) return null;
  if (s.contains(',') && s.contains('.')) {
    s = s.replaceAll('.', '').replaceAll(',', '.');
  } else if (s.contains(',')) {
    s = s.replaceAll(',', '.');
  }
  return num.tryParse(s) ?? double.tryParse(s);
}

num? _asNum(dynamic v) {
  if (v == null) return null;
  if (v is num) return v;
  return _parseNumLoose(v);
}

String _formatMoney(num? amount, {String? currency, int fractionDigits = 2}) {
  final a = _formatTurkishAmount(amount, fractionDigits: fractionDigits);
  if (a == '—') return '—';
  final c = currency?.trim();
  if (c == null || c.isEmpty) return a;
  return '$a $c';
}

String? _documentCurrencyFromInvoice(Map<String, dynamic> data) {
  final bo = data['belgeOzet'];
  if (bo is Map) {
    final bb = Map<String, dynamic>.from(bo)['belgeBilgileri'];
    if (bb is Map) {
      final c = bb['DocumentCurrencyCode']?.toString().trim();
      if (c != null && c.isNotEmpty) return c;
    }
  }
  final upRaw = data['ublParsed'];
  if (upRaw is Map) {
    final invRaw = _ublFirst(Map<String, dynamic>.from(upRaw)['Invoice']);
    if (invRaw is Map) {
      final c = _ublXmlScalarText(Map<String, dynamic>.from(invRaw)['DocumentCurrencyCode']);
      if (c != null && c.isNotEmpty) return c;
    }
  }
  return null;
}

String _tutarListStr(Map<String, dynamic> data) {
  final q = data['qnbRaw'];
  final qm = q is Map ? Map<String, dynamic>.from(q) : <String, dynamic>{};
  final raw = qm['odenecekTutar'] ?? data['odenecekTutar'];
  final pb = qm['odenecekTutarDovizCinsi']?.toString() ?? data['odenecekTutarDovizCinsi']?.toString() ?? '';
  final n = _parseNumLoose(raw);
  if (n == null) return '—';
  return _formatMoney(n, currency: pb.isEmpty ? null : pb);
}

String? _supplierVknStr(Map<String, dynamic> d) {
  final top = d['supplierVkn']?.toString().trim();
  if (top != null && top.isNotEmpty) return top;
  final q = d['qnbRaw'];
  if (q is Map) {
    final g = Map<String, dynamic>.from(q)['gondericiVkn']?.toString().trim();
    if (g != null && g.isNotEmpty) return g;
  }
  return null;
}

/// UBL / belgeOzet fatura notları (onay açıklamalarından ayrı).
List<String> _faturaBelgeNotlari(Map<String, dynamic> data) {
  final out = <String>[];
  void collect(dynamic raw) {
    if (raw == null) return;
    if (raw is String) {
      final t = raw.trim();
      if (t.isNotEmpty) out.add(t);
      return;
    }
    if (raw is List) {
      for (final e in raw) {
        collect(e);
      }
      return;
    }
    if (raw is Map) {
      final t = _ublXmlScalarText(raw)?.trim();
      if (t != null && t.isNotEmpty) out.add(t);
    }
  }

  final bo = data['belgeOzet'];
  if (bo is Map) {
    final bb = Map<String, dynamic>.from(bo)['belgeBilgileri'];
    if (bb is Map) {
      collect(bb['Note']);
    }
  }
  final upRaw = data['ublParsed'];
  if (upRaw is Map) {
    final invRaw = _ublFirst(Map<String, dynamic>.from(upRaw)['Invoice']);
    if (invRaw is Map) {
      collect(Map<String, dynamic>.from(invRaw)['Note']);
    }
  }

  final seen = <String>{};
  return out.where((s) => seen.add(s)).toList();
}

/// Ödenecek + varsa QNB / UBL tutar satırları (ek sorgu yok).
List<String> _tutarOzetiSatirlari(Map<String, dynamic> invData) {
  final lines = <String>[];
  final od = _tutarListStr(invData);
  if (od != '—') {
    lines.add('Ödenecek tutar: $od');
  }

  final q = invData['qnbRaw'];
  if (q is Map) {
    final qm = Map<String, dynamic>.from(q);
    final pb = qm['odenecekTutarDovizCinsi']?.toString().trim() ?? '';
    final cur = pb.isEmpty ? null : pb;
    final mal = _asNum(qm['malHizmetToplamTutari']);
    final kdv = _asNum(qm['kdvToplamTutari']);
    if (mal != null) {
      lines.add('Mal/hizmet toplamı: ${_formatMoney(mal, currency: cur)}');
    }
    if (kdv != null) {
      lines.add('KDV toplamı: ${_formatMoney(kdv, currency: cur)}');
    }
  }

  final bo = invData['belgeOzet'];
  if (bo is Map) {
    final bom = Map<String, dynamic>.from(bo);
    final docCur = _documentCurrencyFromInvoice(invData);
    final top = bom['toplamlar'];
    if (top is Map) {
      final t = Map<String, dynamic>.from(top);
      final curRaw = t['currencyID']?.toString().trim() ?? '';
      final cur = curRaw.isNotEmpty ? curRaw : docCur;
      void add(String label, String key) {
        final n = _asNum(t[key]);
        if (n != null) {
          lines.add('$label: ${_formatMoney(n, currency: cur)}');
        }
      }

      add('Satır toplamı (UBL)', 'LineExtensionAmount');
      add('Vergi matrahı (UBL)', 'TaxExclusiveAmount');
      add('Vergi dahil toplam (UBL)', 'TaxInclusiveAmount');
      add('Ödenecek (UBL)', 'PayableAmount');
    }
    final vergi = bom['vergi'];
    if (vergi is Map) {
      final v = Map<String, dynamic>.from(vergi);
      final n = _asNum(v['TaxAmount']);
      if (n != null) {
        final curRaw = v['currencyID']?.toString().trim() ?? '';
        final cur = curRaw.isNotEmpty ? curRaw : docCur;
        lines.add('Vergi tutarı (UBL): ${_formatMoney(n, currency: cur)}');
      }
    }
  }

  if (lines.isEmpty) {
    lines.add('—');
  }
  return lines;
}

/// [InvoicePdfReviewScreen._kullaniciEtiketi] ile aynı.
String _kullaniciEtiketiOnay(String? raw) {
  final s = raw?.trim() ?? '';
  if (s.isEmpty) return '';
  final i = s.indexOf('@');
  if (i <= 0) return s;
  final local = s.substring(0, i).trim();
  return local.isNotEmpty ? local : s;
}

/// [InvoicePdfReviewScreen._allOnayAciklamalarDisplayText] ile aynı mantık.
String _onayAciklamalarDisplayFromMap(Map<String, dynamic> m) {
  final parts = <String>[];
  void addPart(String fallbackLabel, String textKey, String authorKey) {
    final v = m[textKey]?.toString().trim();
    if (v == null || v.isEmpty) return;
    final ad = m[authorKey]?.toString().trim();
    final label =
        (ad != null && ad.isNotEmpty) ? _kullaniciEtiketiOnay(ad) : fallbackLabel;
    parts.add('$label: $v');
  }

  addPart('Ara', 'onayAciklamaAraOnay', 'onayAciklamaAraOnayYazanAd');
  addPart('Nihai', 'onayAciklamaNihaiOnay', 'onayAciklamaNihaiOnayYazanAd');
  addPart('Muh.', 'onayAciklamaMuhasebe', 'onayAciklamaMuhasebeYazanAd');
  addPart('Genel', 'onayAciklama', 'onayAciklamaYazanAd');
  if (parts.isEmpty) return '—';
  return parts.join(' · ');
}

/// Fatura / irsaliye özeti — [InvoicePdfReviewScreen] ile uyumlu; PDF indirmeden Firestore özet verisi.
class InvoiceJsonReviewScreen extends StatefulWidget {
  const InvoiceJsonReviewScreen({
    super.key,
    required this.api,
    required this.item,
    this.userRole,
  });

  final QnbApi api;
  final Map<String, dynamic> item;

  /// [UserHomeRouter] / `user_profiles.role` — muhasebede onay çubuğu gösterilmez.
  final String? userRole;

  @override
  State<InvoiceJsonReviewScreen> createState() => _InvoiceJsonReviewScreenState();
}

class _InvoiceJsonReviewScreenState extends State<InvoiceJsonReviewScreen> {
  late final Future<Map<String, dynamic>> _summaryFuture;
  final TextEditingController _noteCtrl = TextEditingController();
  bool _saving = false;

  /// Muhasebe: yalnızca önizleme; açıklama ve Onayla/Reddet yok ([InvoicePdfReviewScreen] ile aynı).
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

  String? _aciklamaRoleForApi() {
    final r = _normalizedUserRole();
    if (r == 'ara_onay' || r == 'nihai_onay' || r == 'muhasebe' || r == 'admin') return r;
    return null;
  }

  String get _invoiceDocId {
    final belgeNo = (widget.item['belgeNo']?.toString() ?? '').trim();
    return 'invoice_${_safeDocKey(belgeNo)}';
  }

  @override
  void initState() {
    super.initState();
    _summaryFuture = _loadSummaryPayload();
  }

  @override
  void dispose() {
    _noteCtrl.dispose();
    super.dispose();
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

  Future<Map<String, dynamic>> _loadSummaryPayload() async {
    final belgeNo = (widget.item['belgeNo']?.toString() ?? '').trim();
    if (belgeNo.isEmpty) {
      return {'_error': 'BelgeNo bulunamadı.'};
    }
    final invoiceDocId = 'invoice_${_safeDocKey(belgeNo)}';

    final invSnap =
        await FirebaseFirestore.instance.collection('qnb_invoices').doc(invoiceDocId).get();
    if (!invSnap.exists) {
      return {'_error': 'Fatura bulunamadı (Firestore: $invoiceDocId).'};
    }
    final invRaw = invSnap.data();
    if (invRaw == null) {
      return {'_error': 'Fatura bulunamadı (Firestore: $invoiceDocId).'};
    }

    final invData = Map<String, dynamic>.from(invRaw);
    final mergedOnay = <String, dynamic>{...widget.item, ...invData};
    final onayAcikText = _onayAciklamalarDisplayFromMap(mergedOnay);
    final ettnStr = mergedOnay['ettn']?.toString().trim();
    final onayDurumuStr = mergedOnay['onayDurumu']?.toString().trim();

    final faturaOzeti = <String, dynamic>{
      'belgeNo': belgeNo,
      'faturaTarihi': _faturaTarihi(invData),
      'faturaGelisTarihi': _gelisTarihi(invData),
      'gonderenUnvan': _gonderenUnvani(invData),
      'supplierVkn': _supplierVknStr(invData),
      'faturaTarihiListe': formatTurkishDate(_belgeTarihiListSource(invData)),
      'tutarListe': _tutarListStr(invData),
      'tutarSatirlari': _tutarOzetiSatirlari(invData),
      'faturaNotlari': _faturaBelgeNotlari(invData),
      'kalemler': _faturaKalemleri(invData),
      'onayAciklamalarText': onayAcikText,
      if (ettnStr != null && ettnStr.isNotEmpty) 'ettn': ettnStr,
      if (onayDurumuStr != null && onayDurumuStr.isNotEmpty) 'onayDurumu': onayDurumuStr,
    };

    final irsaliyeler = <Map<String, dynamic>>[];
    final sub = await FirebaseFirestore.instance
        .collection('qnb_invoices')
        .doc(invoiceDocId)
        .collection('despatches')
        .get();

    for (final d in sub.docs) {
      final raw = d.data();
      final dd = Map<String, dynamic>.from(raw);
      final ib = (dd['belgeNo'] ?? dd['belgeNoStr'] ?? d.id).toString().trim();
      irsaliyeler.add({
        'belgeNo': ib.isNotEmpty ? ib : d.id,
        'tarih': _irsaliyeTarihi(dd),
        'kalemler': _irsaliyeKalemleri(dd),
      });
    }

    return <String, dynamic>{
      'fatura': faturaOzeti,
      'irsaliyeler': irsaliyeler,
    };
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Fatura özeti'),
        actions: _isAraOnay
            ? [
                IconButton(
                  tooltip: 'Yönlendir',
                  icon: const Icon(Icons.person_search_outlined),
                  onPressed: () async {
                    final ok =
                        await showAraOnayYonlendirDialog(context, api: widget.api, item: widget.item);
                    if (!context.mounted) return;
                    if (ok) Navigator.of(context).pop(true);
                  },
                ),
              ]
            : null,
      ),
      bottomNavigationBar: _isMuhasebe ? null : _bottomActions(context),
      body: FutureBuilder<Map<String, dynamic>>(
        future: _summaryFuture,
        builder: (context, snap) {
          if (snap.hasError) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(snap.error.toString(), textAlign: TextAlign.center),
              ),
            );
          }
          if (!snap.hasData) {
            return const Center(child: CircularProgressIndicator());
          }
          final data = snap.data;
          if (data == null) {
            return const Center(child: CircularProgressIndicator());
          }
          final err = data['_error']?.toString();
          if (err != null) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(err, textAlign: TextAlign.center),
              ),
            );
          }

          final faturaRaw = data['fatura'];
          if (faturaRaw is! Map) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(
                  'Özet verisi (fatura) bulunamadı veya hatalı.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            );
          }
          final f = Map<String, dynamic>.from(faturaRaw);
          final irs = (data['irsaliyeler'] as List<dynamic>? ?? [])
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();

          return ListView(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
            children: [
              _ozetBolumBaslik(context, 'Onay bilgileri'),
              _ozetCard(
                context,
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  child: _onayBilgiBlock(context, f),
                ),
              ),
              const SizedBox(height: 16),
              _ozetBolumBaslik(context, 'Gönderici bilgileri'),
              _ozetCard(
                context,
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  child: _gondericiOzeti(context, f),
                ),
              ),
              const SizedBox(height: 16),
              _ozetBolumBaslik(context, 'Fatura bilgileri'),
              _ozetCard(
                context,
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  child: _faturaBelgeOzeti(context, f),
                ),
              ),
              const SizedBox(height: 16),
              _ozetBolumBaslik(context, 'Kalem bilgileri'),
              _ozetCard(
                context,
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 10),
                  child: _buildKalemTablosu(context, f['kalemler'] as List<dynamic>? ?? []),
                ),
              ),
              const SizedBox(height: 16),
              _ozetBolumBaslik(context, 'Tutar bilgileri'),
              _ozetCard(
                context,
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  child: _tutarOzetiIcerik(context, f),
                ),
              ),
              const SizedBox(height: 16),
              _ozetBolumBaslik(context, 'Not bilgileri'),
              _ozetCard(
                context,
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  child: _belgeNotlariOzeti(context, f),
                ),
              ),
              const SizedBox(height: 16),
              _ozetBolumBaslik(context, 'İrsaliye bilgileri'),
              if (irs.isEmpty)
                _ozetCard(
                  context,
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                    child: Text(
                      'İrsaliye kaydı yok.',
                      style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant),
                    ),
                  ),
                )
              else
                ...irs.map((d) => _despatchCard(context, d)),
            ],
          );
        },
      ),
    );
  }

  Widget _ozetBolumBaslik(BuildContext context, String title) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8, top: 2),
      child: Text(
        title,
        style: Theme.of(context).textTheme.titleMedium?.copyWith(
              color: Theme.of(context).colorScheme.primary,
            ),
      ),
    );
  }

  Widget _ozetCard(BuildContext context, Widget child) {
    final cs = Theme.of(context).colorScheme;
    return Card(
      elevation: 0,
      color: cs.surfaceContainerHighest.withValues(alpha: 0.5),
      child: child,
    );
  }

  Widget _gondericiOzeti(BuildContext context, Map<String, dynamic> f) {
    final cs = Theme.of(context).colorScheme;
    final unvan = _fmt(f['gonderenUnvan']);
    final vkn = f['supplierVkn']?.toString().trim();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Ünvan: $unvan'),
        if (vkn != null && vkn.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              'VKN/TCKN: $vkn',
              style: TextStyle(fontSize: 13, color: cs.onSurface.withValues(alpha: 0.85)),
            ),
          ),
      ],
    );
  }

  /// Belge no, bekleme etiketi ve tarihler (gönderici / tutar ayrı bölümlerde).
  Widget _faturaBelgeOzeti(BuildContext context, Map<String, dynamic> f) {
    final belgeNoRaw = (f['belgeNo'] ?? widget.item['belgeNo'])?.toString().trim() ?? '';
    final bek = (widget.item['muhasebeBeklemeParantez']?.toString() ?? '').trim();
    final baseTitle = belgeNoRaw.isNotEmpty ? belgeNoRaw : '—';
    final titleText = bek.isNotEmpty ? '$baseTitle  $bek' : baseTitle;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          titleText,
          style: const TextStyle(fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 6),
        Text('Fatura tarihi (düzenleme): ${formatTurkishDate(f['faturaTarihi'])}'),
        Text('Portal liste tarihi: ${formatTurkishDate(f['faturaTarihiListe'])}'),
        Text('Geliş tarihi: ${formatTurkishDate(f['faturaGelisTarihi'])}'),
      ],
    );
  }

  Widget _tutarOzetiIcerik(BuildContext context, Map<String, dynamic> f) {
    final lines = (f['tutarSatirlari'] as List<dynamic>? ?? []).map((e) => e.toString()).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < lines.length; i++)
          Padding(
            padding: EdgeInsets.only(bottom: i < lines.length - 1 ? 6 : 0),
            child: Text(lines[i], style: const TextStyle(height: 1.3)),
          ),
      ],
    );
  }

  Widget _belgeNotlariOzeti(BuildContext context, Map<String, dynamic> f) {
    final cs = Theme.of(context).colorScheme;
    final notlar = (f['faturaNotlari'] as List<dynamic>? ?? [])
        .map((e) => e.toString().trim())
        .where((s) => s.isNotEmpty)
        .toList();
    if (notlar.isEmpty) {
      return Text(
        'Belge notu yok.',
        style: TextStyle(color: cs.onSurfaceVariant),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < notlar.length; i++)
          Padding(
            padding: EdgeInsets.only(bottom: i < notlar.length - 1 ? 10 : 0),
            child: Text(
              '${i + 1}. ${notlar[i]}',
              style: const TextStyle(height: 1.35),
            ),
          ),
      ],
    );
  }

  /// [InvoicePdfReviewScreen] üst çubuğu / ETTN satırı ile aynı veri kaynağı (onay açıklamaları + durum + ETTN).
  Widget _onayBilgiBlock(BuildContext context, Map<String, dynamic> f) {
    final cs = Theme.of(context).colorScheme;
    final acik = _fmt(f['onayAciklamalarText']);
    final durum = f['onayDurumu']?.toString().trim();
    final ettn = f['ettn']?.toString().trim();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Onay notları: $acik',
          style: TextStyle(
            fontSize: 13,
            height: 1.25,
            color: cs.onSurface,
          ),
        ),
        if (durum != null && durum.isNotEmpty) ...[
          const SizedBox(height: 6),
          Text(
            'Onay durumu: $durum',
            style: const TextStyle(fontSize: 13),
          ),
        ],
        if (ettn != null && ettn.isNotEmpty) ...[
          const SizedBox(height: 6),
          Text(
            'ETTN: $ettn',
            style: TextStyle(
              fontSize: 13,
              color: cs.onSurface.withValues(alpha: 0.72),
            ),
          ),
        ],
      ],
    );
  }

  /// UBL / belgeOzet alan adları sütun başlığı; satırlar faturaya göre birleşir (yatay kaydırma).
  Widget _buildKalemTablosu(BuildContext context, List<dynamic> kalemler) {
    if (kalemler.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Text(
          'Kalem bulunamadı.',
          style: TextStyle(color: Theme.of(context).colorScheme.outline),
        ),
      );
    }

    final cs = Theme.of(context).colorScheme;
    final rows = kalemler
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList();
    final keys = _kalemUblSutunAnahtarlari(rows)
        .map((k) => k.trim())
        .where((k) => k.isNotEmpty)
        .toList();
    if (keys.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Text(
          'Kalem satırlarında UBL alanı bulunamadı (belgeOzet / UBL yok veya boş).',
          style: TextStyle(color: Theme.of(context).colorScheme.outline),
        ),
      );
    }

    const siraGenislik = 44.0;
    final genislikler = <double>[siraGenislik, ...keys.map(_kalemDinamikSutunGenisligi)];
    final tabloGenislik = genislikler.fold<double>(0, (a, b) => a + b);
    final kenar = BorderSide(color: cs.outline.withValues(alpha: 0.9), width: 0.5);
    final icKenar = TableBorder(
      left: kenar,
      right: kenar,
      top: kenar,
      horizontalInside: kenar,
      verticalInside: kenar,
    );

    TableCell hucre(
      String? metin, {
      required TextAlign hiza,
      bool baslik = false,
      int maxSatir = 8,
    }) {
      final mt = (metin ?? '').trim();
      final goster = mt.isEmpty ? '—' : mt;
      final st = baslik
          ? TextStyle(
              fontWeight: FontWeight.w700,
              fontSize: 11,
              height: 1.15,
              color: cs.onSurface,
            )
          : TextStyle(fontSize: 12, height: 1.25, color: cs.onSurface);
      Alignment a;
      switch (hiza) {
        case TextAlign.right:
        case TextAlign.end:
          a = Alignment.centerRight;
          break;
        case TextAlign.left:
        case TextAlign.start:
          a = Alignment.centerLeft;
          break;
        default:
          a = Alignment.center;
      }
      return TableCell(
        verticalAlignment: TableCellVerticalAlignment.middle,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 8),
          child: Align(
            alignment: a,
            child: Text(
              goster,
              textAlign: hiza,
              maxLines: maxSatir,
              overflow: TextOverflow.ellipsis,
              style: st,
            ),
          ),
        ),
      );
    }

    final ustSatirDekor = BoxDecoration(
      color: cs.surfaceContainerHighest.withValues(alpha: 0.45),
    );

    final sutunGenislikleri = <int, TableColumnWidth>{
      for (var i = 0; i < genislikler.length; i++) i: FixedColumnWidth(genislikler[i]),
    };

    Map<String, String> ublMap(Map<String, dynamic> satir) {
      final raw = satir['_ublHucreleri'];
      if (raw is! Map) return {};
      return Map<String, dynamic>.from(raw).map(
        (k, v) => MapEntry(k.toString(), v?.toString() ?? ''),
      );
    }

    final tabloSatirlari = <TableRow>[
      TableRow(
        decoration: ustSatirDekor,
        children: [
          hucre('Sıra No', hiza: TextAlign.center, baslik: true, maxSatir: 2),
          ...keys.map(
            (k) => hucre(
              _kalemUblSutunBasligiTr(k),
              hiza: TextAlign.center,
              baslik: true,
              maxSatir: 4,
            ),
          ),
        ],
      ),
      for (var i = 0; i < rows.length; i++)
        TableRow(
          children: [
            hucre('${i + 1}', hiza: TextAlign.center),
            ...keys.map((k) {
              final m = ublMap(rows[i]);
              final v = m[k]?.trim() ?? '';
              return hucre(
                v.isEmpty ? null : v,
                hiza: _kalemUblSutunHizasi(k),
              );
            }),
          ],
        ),
    ];

    return SingleChildScrollView(
      primary: false,
      scrollDirection: Axis.horizontal,
      child: Material(
        color: cs.surface,
        clipBehavior: Clip.hardEdge,
        child: SizedBox(
          width: tabloGenislik,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Table(
                border: icKenar,
                columnWidths: sutunGenislikleri,
                children: tabloSatirlari,
              ),
              _kalemTabloAltToplamMiktarDinamik(context, genislikler, keys, rows, kenar),
            ],
          ),
        ),
      ),
    );
  }

  String _kalemToplamMiktarMetni(List<Map<String, dynamic>> rows) {
    num toplam = 0;
    var say = 0;
    for (final k in rows) {
      final n = _asNum(k['miktar']);
      if (n != null) {
        toplam += n;
        say++;
      }
    }
    if (say == 0) return '—';
    if (toplam == toplam.roundToDouble()) {
      return toplam.round().toString();
    }
    return _formatTurkishAmount(toplam, fractionDigits: 2);
  }

  /// `InvoicedQuantity` sütununun altında toplam miktar (sütun genişliği dinamik).
  Widget _kalemTabloAltToplamMiktarDinamik(
    BuildContext context,
    List<double> genislikler,
    List<String> keys,
    List<Map<String, dynamic>> rows,
    BorderSide kenar,
  ) {
    final qtyIdx = keys.indexOf('InvoicedQuantity');
    if (qtyIdx < 0) {
      return const SizedBox.shrink();
    }
    final tabloQtyIndex = 1 + qtyIdx;
    if (tabloQtyIndex < 1 || tabloQtyIndex >= genislikler.length) {
      return const SizedBox.shrink();
    }
    final cs = Theme.of(context).colorScheme;
    final gri = cs.surfaceContainerHighest.withValues(alpha: 0.65);
    final yuzey = cs.surface;
    final labelWidth = genislikler.sublist(0, tabloQtyIndex).fold<double>(0, (a, b) => a + b);
    final qtyWidth = genislikler[tabloQtyIndex];
    final toplamStr = _kalemToplamMiktarMetni(rows);

    return SizedBox(
      width: genislikler.fold<double>(0, (a, b) => a + b),
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
          Container(
            width: labelWidth,
            decoration: BoxDecoration(
              color: gri,
              border: Border(left: kenar, top: kenar, bottom: kenar, right: kenar),
            ),
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
            alignment: Alignment.centerLeft,
            child: Text(
              'Toplam Miktar',
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color: cs.onSurface,
              ),
            ),
          ),
          SizedBox(
            width: qtyWidth,
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: yuzey,
                border: Border(top: kenar, bottom: kenar, right: kenar),
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
                child: Align(
                  alignment: Alignment.centerRight,
                  child: Text(
                    toplamStr,
                    style: TextStyle(fontSize: 12, color: cs.onSurface),
                  ),
                ),
              ),
            ),
          ),
          for (var i = tabloQtyIndex + 1; i < genislikler.length; i++)
            SizedBox(
              width: genislikler[i],
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: yuzey,
                  border: Border(top: kenar, bottom: kenar, right: kenar),
                ),
              ),
            ),
        ],
        ),
      ),
    );
  }

  String _irsaliyeSatirBaslik(Map<String, dynamic> k, int i) {
    final a = k['aciklama']?.toString().trim();
    if (a != null && a.isNotEmpty) return a;
    return 'Satır ${i + 1}';
  }

  Widget _despatchCard(BuildContext context, Map<String, dynamic> d) {
    final cs = Theme.of(context).colorScheme;
    final kalemler = d['kalemler'] as List<dynamic>? ?? [];
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Card(
        elevation: 0,
        color: cs.surfaceContainerHighest.withValues(alpha: 0.35),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(Icons.local_shipping_outlined, size: 18, color: cs.primary),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _fmt(d['belgeNo']),
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                'Tarih: ${formatTurkishDate(d['tarih'])}',
                style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant),
              ),
              if (kalemler.isEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    'İrsaliye kalemi yok.',
                    style: TextStyle(fontSize: 13, color: cs.outline),
                  ),
                )
              else
                ...List<Widget>.generate(kalemler.length, (i) {
                  final k = Map<String, dynamic>.from(kalemler[i] as Map);
                  return Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('${i + 1}. ', style: TextStyle(color: cs.primary, fontWeight: FontWeight.w600)),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(_irsaliyeSatirBaslik(k, i)),
                              if (k['miktar'] != null || k['birim'] != null)
                                Text(
                                  'Miktar: ${_fmt(k['miktar'])}${k['birim'] != null ? ' ${k['birim']}' : ''}',
                                  style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
                                ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  );
                }),
            ],
          ),
        ),
      ),
    );
  }

}
