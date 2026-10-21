import 'dart:math' as math;

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';

import '../formatting/display_date.dart';
import '../services/qnb_api.dart';
import '../widgets/ara_onay_yonlendir_dialog.dart';
import '../widgets/muhasebe_fisi_dialog.dart';

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
    'Item/SellersItemIdentification/ID': 'Satıcı ürün kodu',
    'Item/BuyersItemIdentification/ID': 'Alıcı ürün tanımı',
    'DeliveredQuantity': 'Teslim miktarı',
    'OutstandingQuantity': 'Kalan miktar',
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

/// Firestore `kalemKullaniciAciklamalari` anahtarı ([etaInvoiceSync.js] ile uyumlu).
String kalemSatirAnahtari(Map<String, dynamic> row, int index) {
  final satirNo = row['satirNo']?.toString().trim();
  if (satirNo != null && satirNo.isNotEmpty) return 'satir_$satirNo';
  final seller = row['saticiKalemKodu']?.toString().trim();
  if (seller != null && seller.isNotEmpty) {
    return 'sku_seller_${seller.length > 100 ? seller.substring(0, 100) : seller}';
  }
  final buyer = row['aliciKalemKodu']?.toString().trim();
  if (buyer != null && buyer.isNotEmpty) {
    return 'sku_buyer_${buyer.length > 100 ? buyer.substring(0, 100) : buyer}';
  }
  var name = row['stokCinsi']?.toString().trim();
  if (name == null || name.isEmpty) {
    name = row['aciklama']?.toString().trim();
  }
  if (name == null || name.isEmpty) {
    final hucre = row['_ublHucreleri'];
    if (hucre is Map) {
      final hm = Map<String, dynamic>.from(hucre);
      name = hm['Item/Name']?.toString().trim();
      if (name == null || name.isEmpty) {
        name = hm['Item/Description']?.toString().trim();
      }
    }
  }
  if (name != null && name.isNotEmpty) {
    final slug = name
        .replaceAll(RegExp(r'[^\p{L}\p{N}._-]+', unicode: true), '_')
        .replaceAll(RegExp(r'_+'), '_');
    final cut = slug.length > 80 ? slug.substring(0, 80) : slug;
    if (cut.isNotEmpty) return 'ad_$cut';
  }
  return 'idx_$index';
}

/// Kullanıcıya gösterilen kalem etiketi (kayıtta saklanır).
String kalemEtiket(Map<String, dynamic> row, int index) {
  final parts = <String>[];
  final sn = row['satirNo']?.toString().trim();
  if (sn != null && sn.isNotEmpty) {
    parts.add('Satır $sn');
  } else {
    parts.add('Kalem ${index + 1}');
  }
  var name = row['stokCinsi']?.toString().trim();
  if (name == null || name.isEmpty) {
    name = row['aciklama']?.toString().trim();
  }
  if (name == null || name.isEmpty) {
    final hucre = row['_ublHucreleri'];
    if (hucre is Map) {
      final hm = Map<String, dynamic>.from(hucre);
      name = hm['Item/Name']?.toString().trim();
    }
  }
  if (name != null && name.isNotEmpty) parts.add(name);
  return parts.join(' — ');
}

Map<String, dynamic> _parseKalemKullaniciAciklamalari(dynamic raw) {
  if (raw is! Map) return {};
  return Map<String, dynamic>.from(raw);
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
  String stokCinsi = '';
  String aciklama = '';
  String? sellerSku;
  String? buyerSku;
  if (item is Map) {
    final im = Map<String, dynamic>.from(item);
    stokCinsi = im['Name']?.toString().trim() ?? '';
    aciklama = im['Description']?.toString().trim() ?? '';
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
    if (stokCinsi.isNotEmpty) 'stokCinsi': stokCinsi,
    if (aciklama.isNotEmpty) 'aciklama': aciklama,
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
    final saticiKod = im['SellersItemIdentification']?.toString().trim();
    if (saticiKod != null && saticiKod.isNotEmpty) {
      _kalemTabloHucreEkle(out, 'Item/SellersItemIdentification/ID', saticiKod);
    }
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
      'Item/SellersItemIdentification/ID',
      _ublItemIdentificationId(im['SellersItemIdentification']),
    );
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
  // Basılı e-fatura mal/hizmet tablosu sırası.
  const sira = <String>[
    'Item/Name',
    'Item/Description',
    'Item/SellersItemIdentification/ID',
    'Item/BuyersItemIdentification/ID',
    'DeliveredQuantity',
    'OutstandingQuantity',
    'InvoicedQuantity',
    'Price/PriceAmount',
    'AllowanceCharge',
    'TaxTotal/TaxSubtotal/Percent',
    'TaxTotal/TaxAmount',
    'LineExtensionAmount',
    'TaxTotal/TaxSubtotal/TaxCategory/TaxScheme/TaxTypeCode',
    'Note',
    'OrderLineReference/ID',
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
      anahtar == 'DeliveredQuantity' ||
      anahtar == 'OutstandingQuantity' ||
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

void _hucreleriDoldur(Map<String, dynamic> row, Map<String, String> ekstra) {
  final mevcut = row['_ublHucreleri'];
  final base = <String, String>{};
  if (mevcut is Map) {
    mevcut.forEach((k, v) {
      final t = v?.toString().trim() ?? '';
      if (t.isNotEmpty) base[k.toString()] = t;
    });
  }
  for (final e in ekstra.entries) {
    if ((base[e.key] ?? '').isEmpty && e.value.trim().isNotEmpty) {
      base[e.key] = e.value.trim();
    }
  }
  row['_ublHucreleri'] = base;
}

List<Map<String, dynamic>> _invoiceUblLineMaps(Map<String, dynamic> data) {
  final inv = _invoiceUblNode(data);
  if (inv == null) return [];
  final linesRaw = inv['InvoiceLine'];
  if (linesRaw == null) return [];
  if (linesRaw is List) {
    return linesRaw.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
  }
  if (linesRaw is Map) return [Map<String, dynamic>.from(linesRaw)];
  return [];
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
      final ublLines = _invoiceUblLineMaps(data);
      for (var i = 0; i < rows.length && i < ublLines.length; i++) {
        _hucreleriDoldur(rows[i], _flattenUblInvoiceLineForTablo(ublLines[i], docCur));
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
    var stokCinsi = '';
    var descText = '';
    if (itemRaw is Map) {
      final im = Map<String, dynamic>.from(itemRaw);
      stokCinsi = _ublXmlScalarText(im['Name'])?.trim() ?? '';
      descText = _ublItemDescriptionText(im['Description'])?.trim() ?? '';
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
    final aciklamaParts = <String>[];
    if (descText.isNotEmpty) aciklamaParts.add(descText);
    if (satirNotlari.isNotEmpty) aciklamaParts.add(satirNotlari.join(' | '));
    final aciklama = aciklamaParts.join(' | ');
    out.add(<String, dynamic>{
      if (lineId != null && lineId.isNotEmpty) 'satirNo': lineId,
      if (stokCinsi.isNotEmpty) 'stokCinsi': stokCinsi,
      if (aciklama.isNotEmpty) 'aciklama': aciklama,
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

/// İrsaliye satırı: UBL `Note` ve `Item/Description` birleşik metin.
String? _despatchLineSatirAciklamasi(Map<String, dynamic> line) {
  final parts = <String>[];
  void add(String? s) {
    final t = s?.trim();
    if (t == null || t.isEmpty) return;
    if (!parts.contains(t)) parts.add(t);
  }

  for (final n in _ublInvoiceLineNotes(line['Note'])) {
    add(n);
  }

  final item = line['Item'];
  if (item is Map) {
    final im = Map<String, dynamic>.from(item);
    add(im['Description']?.toString());
    add(_ublItemDescriptionText(im['Description']));
  }

  if (parts.isEmpty) return null;
  return parts.join(' | ');
}

List<Map<String, dynamic>> _irsaliyeUblDespatchLines(Map<String, dynamic> data) {
  final upRaw = data['ublParsed'];
  if (upRaw is! Map) return [];
  final up = Map<String, dynamic>.from(upRaw);
  final daRaw = up['DespatchAdvice'];
  if (daRaw is! Map) return [];
  final da = Map<String, dynamic>.from(daRaw);
  final linesRaw = da['DespatchLine'];
  if (linesRaw == null) return [];
  return linesRaw is List
      ? linesRaw.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
      : [Map<String, dynamic>.from(linesRaw as Map)];
}

void _irsaliyeKalemlerineSatirAciklamasiEkle(
  List<Map<String, dynamic>> rows,
  List<Map<String, dynamic>> ublLines,
) {
  if (rows.isEmpty || ublLines.isEmpty) return;
  for (var i = 0; i < rows.length; i++) {
    final existing = rows[i]['satirAciklama']?.toString().trim();
    if (existing != null && existing.isNotEmpty) continue;
    if (i >= ublLines.length) break;
    final acik = _despatchLineSatirAciklamasi(ublLines[i]);
    if (acik != null && acik.isNotEmpty) rows[i]['satirAciklama'] = acik;
  }
}

Map<String, dynamic> _kalemDespatchBelgeOzet(Map<String, dynamic> line) {
  final item = line['Item'];
  String ad = '';
  if (item is Map) {
    ad = item['Name']?.toString().trim() ?? '';
  }
  final satirAcik = _despatchLineSatirAciklamasi(line);
  final qty = line['DeliveredQuantity'];
  num? miktar;
  String? birim;
  if (qty is num) {
    miktar = qty;
  } else if (qty is Map) {
    final qm = Map<String, dynamic>.from(qty);
    final t = _ublXmlScalarText(qm);
    if (t != null) miktar = num.tryParse(t) ?? double.tryParse(t);
    birim = (qm['@_unitCode'] ?? qm['@_UnitCode'])?.toString();
  }
  birim ??= line['unitCode']?.toString();
  return <String, dynamic>{
    if (ad.isNotEmpty) 'aciklama': ad,
    if (satirAcik != null && satirAcik.isNotEmpty) 'satirAciklama': satirAcik,
    if (miktar != null) 'miktar': miktar,
    if (birim != null && birim.isNotEmpty) 'birim': birim,
    '_ublHucreleri': _despatchSatirHucreleri(line),
  };
}

Map<String, String> _despatchSatirHucreleri(Map<String, dynamic> line) {
  final out = <String, String>{};
  final item = line['Item'];
  if (item is Map) {
    final im = Map<String, dynamic>.from(item);
    _kalemTabloHucreEkle(
      out,
      'Item/Name',
      im['Name']?.toString().trim().isNotEmpty == true
          ? im['Name']?.toString()
          : _ublXmlScalarText(im['Name']),
    );
    _kalemTabloHucreEkle(
      out,
      'Item/Description',
      _ublItemDescriptionText(im['Description']) ?? im['Description']?.toString(),
    );
    _kalemTabloHucreEkle(
      out,
      'Item/SellersItemIdentification/ID',
      _ublItemIdentificationId(im['SellersItemIdentification']) ??
          im['SellersItemIdentification']?.toString(),
    );
  }
  final notes = _ublInvoiceLineNotes(line['Note']);
  if (notes.isNotEmpty) {
    _kalemTabloHucreEkle(out, 'Note', notes.join(' | '));
  }
  void miktarAlani(String anahtar, dynamic qty, String? yedekBirim) {
    if (qty == null && (yedekBirim == null || yedekBirim.isEmpty)) return;
    String metin = '';
    String? birim = yedekBirim;
    if (qty is Map) {
      final qm = Map<String, dynamic>.from(qty);
      metin = _ublXmlScalarText(qm)?.trim() ?? '';
      birim = (qm['@_unitCode'] ?? qm['@_UnitCode'])?.toString() ?? birim;
    } else if (qty != null) {
      metin = qty.toString().trim();
    }
    if (metin.isEmpty) return;
    if (birim != null && birim.trim().isNotEmpty) metin = '$metin ${birim.trim()}';
    _kalemTabloHucreEkle(out, anahtar, metin);
  }

  miktarAlani('DeliveredQuantity', line['DeliveredQuantity'], line['unitCode']?.toString());
  miktarAlani('OutstandingQuantity', line['OutstandingQuantity'], null);
  return out;
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
    if (rows.isNotEmpty) {
      final ublLines = _irsaliyeUblDespatchLines(data);
      _irsaliyeKalemlerineSatirAciklamasiEkle(rows, ublLines);
      for (var i = 0; i < rows.length && i < ublLines.length; i++) {
        _hucreleriDoldur(rows[i], _despatchSatirHucreleri(ublLines[i]));
      }
      return rows;
    }
  }

  final lines = _irsaliyeUblDespatchLines(data);
  if (lines.isEmpty) return [];
  final out = <Map<String, dynamic>>[];
  for (final line in lines) {
    final itemRaw = _ublFirst(line['Item']);
    var name = '';
    if (itemRaw is Map) {
      name = _ublXmlScalarText(Map<String, dynamic>.from(itemRaw)['Name'])?.trim() ?? '';
    }
    final satirAcik = _despatchLineSatirAciklamasi(line);
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
      if (satirAcik != null && satirAcik.isNotEmpty) 'satirAciklama': satirAcik,
      if (miktar != null) 'miktar': miktar,
      if (birim != null && birim.isNotEmpty) 'birim': birim,
      '_ublHucreleri': _despatchSatirHucreleri(line),
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
  final q = data['qnbRaw'];
  if (q is Map) {
    final c = Map<String, dynamic>.from(q)['odenecekTutarDovizCinsi']?.toString().trim();
    if (c != null && c.isNotEmpty) return c;
  }
  return data['odenecekTutarDovizCinsi']?.toString().trim();
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

String _joinNonEmpty(Iterable<String?> parts, [String sep = ', ']) {
  return parts.map((e) => e?.trim() ?? '').where((e) => e.isNotEmpty).join(sep);
}

Map<String, dynamic>? _belgeOzetMap(Map<String, dynamic> data) {
  final bo = data['belgeOzet'];
  if (bo is Map) return Map<String, dynamic>.from(bo);
  return null;
}

Map<String, dynamic>? _invoiceUblNode(Map<String, dynamic> data) {
  final up = data['ublParsed'];
  if (up is! Map) return null;
  final inv = _ublFirst(Map<String, dynamic>.from(up)['Invoice']);
  if (inv is Map) return Map<String, dynamic>.from(inv);
  return null;
}

Map<String, dynamic>? _despatchUblNode(Map<String, dynamic> data) {
  final up = data['ublParsed'];
  if (up is! Map) return null;
  final da = _ublFirst(Map<String, dynamic>.from(up)['DespatchAdvice']);
  if (da is Map) return Map<String, dynamic>.from(da);
  return null;
}

String _faturaSenaryoEtiket(String raw) {
  switch (raw.trim().toUpperCase()) {
    case 'TEMELFATURA':
      return 'Temel Fatura';
    case 'TICARIFATURA':
      return 'Ticari Fatura';
    case 'EARSIVFATURA':
      return 'e-Arşiv Fatura';
    case 'IHRACAT':
      return 'İhracat';
    case 'YOLCUBERABERFATURA':
      return 'Yolcu Beraber';
    case 'KAMU':
      return 'Kamu';
    case 'HKS':
      return 'HKS';
    case 'ENERJI':
      return 'Enerji';
    default:
      return raw.trim();
  }
}

String _faturaTipEtiket(String raw) {
  switch (raw.trim().toUpperCase()) {
    case 'SATIS':
      return 'Satış';
    case 'IADE':
      return 'İade';
    case 'TEVKIFAT':
      return 'Tevkifat';
    case 'ISTISNA':
      return 'İstisna';
    case 'OZELMATRAH':
      return 'Özel Matrah';
    case 'IHRACKAYITLI':
      return 'İhraç Kayıtlı';
    case 'SGK':
      return 'SGK';
    default:
      return raw.trim();
  }
}

String _irsaliyeSenaryoEtiket(String raw) {
  switch (raw.trim().toUpperCase()) {
    case 'TEMELIRSALIYE':
      return 'Temel İrsaliye';
    case 'HKSIRSALIYE':
      return 'HKS İrsaliye';
    default:
      return raw.trim();
  }
}

String _saatMetni(String raw) {
  final t = raw.trim();
  if (t.isEmpty) return '';
  final m = RegExp(r'^(\d{2}):(\d{2})').firstMatch(t);
  if (m != null) return '${m.group(1)}:${m.group(2)}';
  return t;
}

String _adresMetni(dynamic adres) {
  if (adres == null) return '';
  if (adres is String) return adres.trim();
  if (adres is! Map) return '';
  final a = Map<String, dynamic>.from(adres);
  String? country;
  final c = a['Country'];
  if (c is Map) {
    country = _ublXmlScalarText(Map<String, dynamic>.from(c)['Name']) ?? c['Name']?.toString();
  } else {
    country = c?.toString();
  }
  String? alan(String k) {
    final v = a[k];
    if (v is Map) return _ublXmlScalarText(v);
    return v?.toString();
  }

  return _joinNonEmpty([
    alan('StreetName'),
    alan('BuildingName'),
    alan('BuildingNumber'),
    alan('Room'),
    alan('CitySubdivisionName'),
    alan('CityName'),
    alan('PostalZone'),
    alan('Region'),
    country,
  ]);
}

bool _tarafDolu(Map<String, String> t) => t.values.any((v) => v.trim().isNotEmpty);

Map<String, String>? _tarafFromBelgeOzetNode(dynamic raw) {
  if (raw is! Map) return null;
  final m = Map<String, dynamic>.from(raw);
  final vkn = m['VKN']?.toString().trim() ?? '';
  final tckn = m['TCKN']?.toString().trim() ?? '';
  var kimlik = '';
  if (vkn.isNotEmpty) {
    kimlik = 'VKN $vkn';
  } else if (tckn.isNotEmpty) {
    kimlik = 'TCKN $tckn';
  }
  final t = <String, String>{
    'unvan': m['Unvan']?.toString().trim() ?? '',
    'kimlik': kimlik,
    'vergiDairesi': m['VergiDairesi']?.toString().trim() ?? '',
    'adres': _adresMetni(m['Adres']),
    'telefon': m['Telefon']?.toString().trim() ?? '',
    'eposta': m['ElectronicMail']?.toString().trim() ?? '',
  };
  return _tarafDolu(t) ? t : null;
}

Map<String, String>? _tarafFromUblParty(dynamic partyNode) {
  final first = _ublFirst(partyNode);
  if (first is! Map) return null;
  var p = Map<String, dynamic>.from(first);
  if (p['Party'] != null) {
    final inner = _ublFirst(p['Party']);
    if (inner is Map) p = Map<String, dynamic>.from(inner);
  }
  var unvan = '';
  final pn = _ublFirst(p['PartyName']);
  if (pn is Map) unvan = _ublXmlScalarText(Map<String, dynamic>.from(pn)['Name']) ?? '';
  if (unvan.isEmpty) {
    final person = _ublFirst(p['Person']);
    if (person is Map) {
      final pm = Map<String, dynamic>.from(person);
      unvan = _joinNonEmpty([
        _ublXmlScalarText(pm['FirstName']),
        _ublXmlScalarText(pm['FamilyName']),
      ], ' ');
    }
  }
  var kimlik = '';
  final idsRaw = p['PartyIdentification'];
  final ids = idsRaw is List ? idsRaw : (idsRaw != null ? [idsRaw] : <dynamic>[]);
  for (final idn in ids) {
    if (idn is! Map) continue;
    final idNode = _ublFirst(Map<String, dynamic>.from(idn)['ID']);
    String? scheme;
    String? value;
    if (idNode is Map) {
      final idm = Map<String, dynamic>.from(idNode);
      scheme = (idm['@_schemeID'] ?? idm['@_SchemeID'])?.toString();
      value = _ublXmlScalarText(idm);
    } else {
      value = idNode?.toString();
    }
    final v = value?.trim() ?? '';
    if (v.isEmpty) continue;
    final sch = (scheme ?? '').trim().toUpperCase();
    kimlik = sch.isNotEmpty ? '$sch $v' : v;
    if (sch == 'VKN' || sch == 'TCKN') break;
  }
  var vergiDairesi = '';
  final pts = _ublFirst(p['PartyTaxScheme']);
  if (pts is Map) {
    final ts = _ublFirst(Map<String, dynamic>.from(pts)['TaxScheme']);
    if (ts is Map) {
      vergiDairesi = _ublXmlScalarText(Map<String, dynamic>.from(ts)['Name']) ?? '';
    }
  }
  final adres = _adresMetni(_ublFirst(p['PostalAddress']));
  var telefon = '';
  var eposta = '';
  final contact = _ublFirst(p['Contact']);
  if (contact is Map) {
    final cm = Map<String, dynamic>.from(contact);
    telefon = _ublXmlScalarText(cm['Telephone']) ?? '';
    eposta = _ublXmlScalarText(cm['ElectronicMail']) ?? '';
  }
  final t = <String, String>{
    'unvan': unvan,
    'kimlik': kimlik,
    'vergiDairesi': vergiDairesi,
    'adres': adres,
    'telefon': telefon,
    'eposta': eposta,
  };
  return _tarafDolu(t) ? t : null;
}

String _ozetAlan(Map<String, dynamic>? bb, Map<String, dynamic>? ubl, String key) {
  final a = bb?[key]?.toString().trim() ?? '';
  if (a.isNotEmpty) return a;
  if (ubl == null) return '';
  return _ublXmlScalarText(ubl[key])?.trim() ?? '';
}

Map<String, String> _faturaBaslikAlanlari(Map<String, dynamic> invData) {
  final bo = _belgeOzetMap(invData);
  final bb = bo?['belgeBilgileri'] is Map
      ? Map<String, dynamic>.from(bo!['belgeBilgileri'] as Map)
      : null;
  final inv = _invoiceUblNode(invData);
  final ettnDoc = invData['ettn']?.toString().trim() ?? '';
  final ettn = _ozetAlan(bb, inv, 'UUID');
  return <String, String>{
    'senaryo': _faturaSenaryoEtiket(_ozetAlan(bb, inv, 'ProfileID')),
    'faturaTipi': _faturaTipEtiket(_ozetAlan(bb, inv, 'InvoiceTypeCode')),
    'saat': _saatMetni(_ozetAlan(bb, inv, 'IssueTime')),
    'paraBirimi': _ozetAlan(bb, inv, 'DocumentCurrencyCode'),
    'ettn': ettn.isNotEmpty ? ettn : ettnDoc,
  };
}

Map<String, String> _faturaSatici(Map<String, dynamic> invData) {
  final fromBo = _tarafFromBelgeOzetNode(_belgeOzetMap(invData)?['tedarikci']);
  if (fromBo != null) return fromBo;
  final fromUbl = _tarafFromUblParty(_invoiceUblNode(invData)?['AccountingSupplierParty']);
  if (fromUbl != null) return fromUbl;
  final vkn = _supplierVknStr(invData);
  return <String, String>{
    'unvan': _gonderenUnvani(invData),
    'kimlik': (vkn == null || vkn.isEmpty) ? '' : 'VKN $vkn',
    'vergiDairesi': '',
    'adres': '',
    'telefon': '',
    'eposta': '',
  };
}

Map<String, String> _faturaAlici(Map<String, dynamic> invData) {
  return _tarafFromBelgeOzetNode(_belgeOzetMap(invData)?['musteri']) ??
      _tarafFromUblParty(_invoiceUblNode(invData)?['AccountingCustomerParty']) ??
      <String, String>{
        'unvan': '',
        'kimlik': '',
        'vergiDairesi': '',
        'adres': '',
        'telefon': '',
        'eposta': '',
      };
}

List<Map<String, String>> _faturaReferanslari(Map<String, dynamic> invData) {
  final out = <Map<String, String>>[];
  void add(String etiket, String deger) {
    final d = deger.trim();
    if (d.isEmpty || d == '—') return;
    out.add({'etiket': etiket, 'deger': d});
  }

  final bo = _belgeOzetMap(invData);
  if (bo != null) {
    final sip = bo['siparisReferansi'];
    if (sip is Map) {
      final or = Map<String, dynamic>.from(sip)['OrderReference'];
      if (or is Map) {
        final om = Map<String, dynamic>.from(or);
        add('Sipariş no', om['ID']?.toString() ?? '');
        final dt = om['IssueDate']?.toString() ?? '';
        if (dt.trim().isNotEmpty) add('Sipariş tarihi', formatTurkishDate(dt, empty: ''));
      }
    }
    final ir = bo['irsaliyeReferansi'];
    if (ir is Map) {
      final irm = Map<String, dynamic>.from(ir);
      final refs = <Map<String, dynamic>>[];
      final list = irm['DespatchDocumentReferenceList'];
      if (list is List) {
        for (final e in list) {
          if (e is Map) refs.add(Map<String, dynamic>.from(e));
        }
      }
      if (refs.isEmpty && irm['DespatchDocumentReference'] is Map) {
        refs.add(Map<String, dynamic>.from(irm['DespatchDocumentReference'] as Map));
      }
      for (final r in refs) {
        final id = r['ID']?.toString().trim() ?? '';
        final dt = r['IssueDate']?.toString().trim() ?? '';
        final tarih = dt.isEmpty ? '' : formatTurkishDate(dt, empty: '');
        add('İrsaliye no', tarih.isEmpty ? id : '$id ($tarih)');
      }
    }
    final donem = bo['donem'];
    if (donem is Map) {
      final ip = Map<String, dynamic>.from(donem)['InvoicePeriod'];
      if (ip is Map) {
        final ipm = Map<String, dynamic>.from(ip);
        final a = ipm['StartDate']?.toString().trim() ?? '';
        final b = ipm['EndDate']?.toString().trim() ?? '';
        if (a.isNotEmpty || b.isNotEmpty) {
          add(
            'Fatura dönemi',
            '${a.isEmpty ? '—' : formatTurkishDate(a)} – ${b.isEmpty ? '—' : formatTurkishDate(b)}',
          );
        }
      }
    }
  }
  return out;
}

Map<String, String> _irsaliyeBaslikAlanlari(Map<String, dynamic> dd) {
  final bo = _belgeOzetMap(dd);
  final bb = bo?['belgeBilgileri'] is Map
      ? Map<String, dynamic>.from(bo!['belgeBilgileri'] as Map)
      : null;
  final da = _despatchUblNode(dd);
  final ettnDoc = dd['ettn']?.toString().trim() ?? '';
  final ettn = _ozetAlan(bb, da, 'UUID');
  return <String, String>{
    'senaryo': _irsaliyeSenaryoEtiket(_ozetAlan(bb, da, 'ProfileID')),
    'saat': _saatMetni(_ozetAlan(bb, da, 'IssueTime')),
    'ettn': ettn.isNotEmpty ? ettn : ettnDoc,
  };
}

Map<String, String> _irsaliyeSevk(Map<String, dynamic> dd) {
  final out = <String, String>{'tarih': '', 'adres': ''};
  final teslim = _belgeOzetMap(dd)?['teslimat'];
  if (teslim is Map) {
    final t = Map<String, dynamic>.from(teslim);
    final tarih = t['ActualDeliveryDate']?.toString().trim() ?? '';
    final saat = _saatMetni(t['ActualDeliveryTime']?.toString() ?? '');
    if (tarih.isNotEmpty) {
      out['tarih'] = saat.isEmpty
          ? formatTurkishDate(tarih)
          : '${formatTurkishDate(tarih)} $saat';
    }
    out['adres'] = _adresMetni(t['DeliveryAddress']);
  }
  if (out['tarih']!.isEmpty || out['adres']!.isEmpty) {
    final da = _despatchUblNode(dd);
    final del = da == null ? null : _ublFirst(da['Delivery']);
    if (del is Map) {
      final dm = Map<String, dynamic>.from(del);
      if (out['tarih']!.isEmpty) {
        final tarih = _ublXmlScalarText(dm['ActualDeliveryDate']) ?? '';
        final saat = _saatMetni(_ublXmlScalarText(dm['ActualDeliveryTime']) ?? '');
        if (tarih.trim().isNotEmpty) {
          out['tarih'] = saat.isEmpty
              ? formatTurkishDate(tarih)
              : '${formatTurkishDate(tarih)} $saat';
        }
      }
      if (out['adres']!.isEmpty) {
        out['adres'] = _adresMetni(_ublFirst(dm['DeliveryAddress']));
      }
    }
  }
  return out;
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

bool _tryParaBirimi(String? code) {
  final u = (code ?? '').trim().toUpperCase();
  return u == 'TRY' || u == 'TL' || u == 'TRL';
}

/// 1 birim belge dövizi = kaç TL. Kaynak: faturada duran kur (ek sorgu yok).
({num rate, String source})? _tlKuru(Map<String, dynamic> invData, String? docCur) {
  final doc = (docCur ?? '').trim().toUpperCase();
  if (_tryParaBirimi(doc)) return null;

  ({num rate, String source})? fromNode(dynamic node) {
    final first = _ublFirst(node);
    if (first is! Map) return null;
    final m = Map<String, dynamic>.from(first);
    final rate = _asNum(_ublXmlScalarText(m['CalculationRate']) ?? m['CalculationRate'] ?? m['Rate']);
    if (rate == null || rate <= 0) return null;
    final src = (_ublXmlScalarText(m['SourceCurrencyCode']) ?? '').trim().toUpperCase();
    final tgt = (_ublXmlScalarText(m['TargetCurrencyCode']) ?? '').trim().toUpperCase();
    if (doc.isNotEmpty && src.isNotEmpty && src != doc && !_tryParaBirimi(src)) return null;
    if (tgt.isNotEmpty && !_tryParaBirimi(tgt)) {
      if (_tryParaBirimi(src) && tgt == doc) {
        return (rate: 1 / rate, source: 'ubl');
      }
      return null;
    }
    return (rate: rate, source: 'ubl');
  }

  final inv = _invoiceUblNode(invData);
  if (inv != null) {
    for (final key in ['PricingExchangeRate', 'PaymentExchangeRate', 'TaxExchangeRate']) {
      final found = fromNode(inv[key]);
      if (found != null) return found;
    }
  }
  final q = invData['qnbRaw'];
  if (q is Map) {
    final n = _asNum(Map<String, dynamic>.from(q)['dovizKuru']);
    if (n != null && n > 0) return (rate: n, source: 'qnb');
  }
  return null;
}

/// PDF/XSLT ile aynı kaynak: AdditionalDocumentReference içindeki TL toplamlar.
({num? mal, num? iskonto, num? vergiHaric, num? kdv, num? vergiDahil, num? odenecek})? _belgedekiTlToplamlari(
  Map<String, dynamic> invData,
) {
  final refs = <dynamic>[];
  void ekleRef(dynamic raw) {
    if (raw == null) return;
    if (raw is List) {
      refs.addAll(raw);
    } else {
      refs.add(raw);
    }
  }

  final inv = _invoiceUblNode(invData);
  if (inv != null) ekleRef(inv['AdditionalDocumentReference']);
  ekleRef(_belgeOzetMap(invData)?['AdditionalDocumentReference']);
  num? mal;
  num? iskonto;
  num? vergiHaric;
  num? kdv;
  num? vergiDahil;
  num? odenecek;
  var any = false;
  for (final raw in refs) {
    if (raw is! Map) continue;
    final m = Map<String, dynamic>.from(raw);
    final typ = (_ublXmlScalarText(m['DocumentType']) ?? m['DocumentType']?.toString() ?? '')
        .trim()
        .toUpperCase();
    final kod = (_ublXmlScalarText(m['DocumentTypeCode']) ?? m['DocumentTypeCode']?.toString() ?? '')
        .trim()
        .toUpperCase();
    final desc =
        (_ublXmlScalarText(m['DocumentDescription']) ?? m['DocumentDescription']?.toString() ?? '')
            .trim()
            .toUpperCase();
    final id = _asNum(_ublXmlScalarText(m['ID']) ?? m['ID']);
    final aciklamaTutar = _asNum(_ublXmlScalarText(m['DocumentDescription']) ?? m['DocumentDescription']);
    num? tutar = id;
    if (aciklamaTutar != null && aciklamaTutar > 0 && (tutar == null || tutar <= 0 || (tutar < 100 && aciklamaTutar > tutar))) {
      tutar = aciklamaTutar;
    }
    if (tutar == null || tutar <= 0) continue;
    final anahtar = typ.isNotEmpty ? typ : kod;
    if (anahtar == 'LINEEXTENSIONAMOUNT') {
      mal = tutar;
    } else if (anahtar == 'ALLOWANCETOTALAMOUNT') {
      iskonto = tutar;
    } else if (anahtar == 'TAXEXCLUSIVEAMOUNT') {
      vergiHaric = tutar;
    } else if (anahtar == 'TAXINCLUSIVEAMOUNT') {
      vergiDahil = tutar;
    } else if (anahtar == 'PAYABLEAMOUNT') {
      odenecek = tutar;
    } else if (desc == 'KDV' || anahtar == 'TAXAMOUNT' || anahtar == 'KDV') {
      kdv = tutar;
    } else {
      continue;
    }
    any = true;
  }
  if (!any) return null;
  return (
    mal: mal,
    iskonto: iskonto,
    vergiHaric: vergiHaric,
    kdv: kdv,
    vergiDahil: vergiDahil,
    odenecek: odenecek,
  );
}

String _tutarSatiri(
  String label,
  num amount,
  String? cur,
  ({num rate, String source})? kur, {
  String ek = '',
  num? tl,
}) {
  final c = cur?.trim() ?? '';
  final ana = _formatMoney(amount, currency: c.isEmpty ? null : c);
  var line = '$label: $ana';
  if (ek.trim().isNotEmpty) line = '$line ${ek.trim()}';
  if (_tryParaBirimi(c)) return line;
  final tlTutar = tl ?? (kur == null ? null : amount * kur.rate);
  if (tlTutar != null) {
    line = '$line    ·    ${_formatMoney(tlTutar, currency: 'TL')}';
  }
  return line;
}

/// Basılı e-fatura dip toplam sırası.
/// TL önce belgedeki AdditionalDocumentReference tutarından, yoksa kurdan.
List<String> _tutarOzetiSatirlari(Map<String, dynamic> invData) {
  final lines = <String>[];
  final bo = _belgeOzetMap(invData);
  final docCur = _documentCurrencyFromInvoice(invData);
  final kur = _tlKuru(invData, docCur);
  final tlBelge = _belgedekiTlToplamlari(invData);
  if (kur != null) {
    final kaynak = (docCur ?? '').trim().isEmpty ? 'döviz' : docCur!.trim().toUpperCase();
    lines.add(
      'Döviz kuru: 1 $kaynak = ${_formatTurkishAmount(kur.rate, fractionDigits: 4)} TL',
    );
  }
  num? tlAlan(String key) {
    if (tlBelge == null) return null;
    switch (key) {
      case 'LineExtensionAmount':
        return tlBelge.mal;
      case 'AllowanceTotalAmount':
        return tlBelge.iskonto;
      case 'TaxExclusiveAmount':
        return tlBelge.vergiHaric;
      case 'TaxInclusiveAmount':
        return tlBelge.vergiDahil;
      case 'PayableAmount':
        return tlBelge.odenecek;
      default:
        return null;
    }
  }

  var structured = false;
  if (bo != null && bo['toplamlar'] is Map) {
    final t = Map<String, dynamic>.from(bo['toplamlar'] as Map);
    final curRaw = t['currencyID']?.toString().trim() ?? '';
    final cur = curRaw.isNotEmpty ? curRaw : docCur;
    void add(String label, String key) {
      final n = _asNum(t[key]);
      if (n == null) return;
      if (key == 'AllowanceTotalAmount' && n == 0) return;
      lines.add(_tutarSatiri(label, n, cur, kur, tl: tlAlan(key)));
      structured = true;
    }

    add('Mal hizmet toplam tutarı', 'LineExtensionAmount');
    add('Toplam iskonto', 'AllowanceTotalAmount');
    add('Vergi hariç toplam', 'TaxExclusiveAmount');

    final vergi = bo['vergi'];
    if (vergi is Map) {
      final v = Map<String, dynamic>.from(vergi);
      final vCurRaw = v['currencyID']?.toString().trim() ?? '';
      final vCur = vCurRaw.isNotEmpty ? vCurRaw : cur;
      final subsRaw = v['TaxSubtotal'];
      final subs = subsRaw is List ? subsRaw : (subsRaw != null ? [subsRaw] : <dynamic>[]);
      final taxRows = <Map<String, dynamic>>[];
      for (final s in subs) {
        if (s is! Map) continue;
        final sm = Map<String, dynamic>.from(s);
        if (_asNum(sm['TaxAmount']) == null) continue;
        taxRows.add(sm);
      }
      final tekVergi = taxRows.length == 1;
      var wroteSub = false;
      for (final sm in taxRows) {
        final taxAmt = _asNum(sm['TaxAmount']);
        if (taxAmt == null) continue;
        final percent = _asNum(sm['Percent']);
        final matrah = _asNum(sm['TaxableAmount']);
        var name = 'Hesaplanan KDV';
        final scheme = sm['TaxScheme'];
        if (scheme is Map) {
          final n = Map<String, dynamic>.from(scheme)['Name']?.toString().trim();
          if (n != null && n.isNotEmpty) name = n;
        }
        final oran = percent == null ? '' : ' %${_formatTurkishAmount(percent, fractionDigits: 0)}';
        var mat = '';
        if (matrah != null) {
          mat = '(matrah ${_formatMoney(matrah, currency: vCur)}';
          if (!_tryParaBirimi(vCur)) {
            final matrahTl = tlBelge?.vergiHaric ?? (kur == null ? null : matrah * kur.rate);
            if (matrahTl != null) {
              mat = '$mat / ${_formatMoney(matrahTl, currency: 'TL')}';
            }
          }
          mat = '$mat)';
        }
        lines.add(
          _tutarSatiri(
            '$name$oran',
            taxAmt,
            vCur,
            kur,
            ek: mat,
            tl: tekVergi ? tlBelge?.kdv : null,
          ),
        );
        wroteSub = true;
        structured = true;
      }
      if (!wroteSub) {
        final n = _asNum(v['TaxAmount']);
        if (n != null) {
          lines.add(_tutarSatiri('Hesaplanan vergi', n, vCur, kur, tl: tlBelge?.kdv));
          structured = true;
        }
      }
    }

    add('Vergiler dahil toplam', 'TaxInclusiveAmount');
    add('Ödenecek tutar', 'PayableAmount');
  }

  if (!structured) {
    final q = invData['qnbRaw'];
    if (q is Map) {
      final qm = Map<String, dynamic>.from(q);
      final pb = qm['odenecekTutarDovizCinsi']?.toString().trim() ?? '';
      final cur = pb.isEmpty ? docCur : pb;
      final mal = _asNum(qm['malHizmetToplamTutari']);
      final kdv = _asNum(qm['kdvToplamTutari']);
      if (mal != null) {
        lines.add(_tutarSatiri('Mal hizmet toplam tutarı', mal, cur, kur, tl: tlBelge?.mal));
      }
      if (kdv != null) {
        lines.add(_tutarSatiri('Hesaplanan KDV', kdv, cur, kur, tl: tlBelge?.kdv));
      }
    }
    final od = _tutarListStr(invData);
    if (od != '—') {
      final q = invData['qnbRaw'];
      final qm = q is Map ? Map<String, dynamic>.from(q) : <String, dynamic>{};
      final n = _parseNumLoose(qm['odenecekTutar'] ?? invData['odenecekTutar']);
      final pb = qm['odenecekTutarDovizCinsi']?.toString() ?? invData['odenecekTutarDovizCinsi']?.toString() ?? docCur;
      if (n != null) {
        lines.add(_tutarSatiri('Ödenecek tutar', n, pb, kur, tl: tlBelge?.odenecek));
      } else {
        lines.add('Ödenecek tutar: $od');
      }
    }
  }

  final qPortal = invData['qnbRaw'];
  if (qPortal is Map) {
    final qm = Map<String, dynamic>.from(qPortal);
    final pb = qm['odenecekTutarDovizCinsi']?.toString().trim() ?? docCur;
    void portalSatir(String label, dynamic raw, {num? tl}) {
      final n = _asNum(raw);
      if (n == null) return;
      final goster = _formatMoney(n, currency: pb);
      if (lines.any((l) => l.contains(goster))) return;
      lines.add(_tutarSatiri(label, n, pb, kur, tl: tl));
    }

    portalSatir('Mal hizmet toplamı', qm['malHizmetToplamTutari'], tl: tlBelge?.mal);
    portalSatir('KDV toplamı', qm['kdvToplamTutari'], tl: tlBelge?.kdv);
    portalSatir('Ödenecek tutar', qm['odenecekTutar'] ?? invData['odenecekTutar'], tl: tlBelge?.odenecek);
  }

  if (lines.isEmpty) lines.add('—');
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
  final GlobalKey<_KalemKullaniciAciklamaPanelState> _kalemAciklamaPanelKey =
      GlobalKey<_KalemKullaniciAciklamaPanelState>();
  bool _saving = false;
  bool _mahsupAcik = false;

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
      final kalemState = _kalemAciklamaPanelKey.currentState;
      if (kalemState != null) {
        final kalemOk = await kalemState.saveAllPending();
        if (!kalemOk) {
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(
                content: Text(
                  'Kalem açıklamaları kaydedilemedi. Onay işlemi iptal edildi.',
                ),
              ),
            );
          }
          return;
        }
      }

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

    final baslik = _faturaBaslikAlanlari(invData);
    final faturaOzeti = <String, dynamic>{
      'belgeNo': belgeNo,
      'faturaTarihi': _faturaTarihi(invData),
      'faturaGelisTarihi': _gelisTarihi(invData),
      'gonderenUnvan': _gonderenUnvani(invData),
      'supplierVkn': _supplierVknStr(invData),
      'faturaTarihiListe': formatTurkishDate(_belgeTarihiListSource(invData)),
      'senaryo': baslik['senaryo'],
      'faturaTipi': baslik['faturaTipi'],
      'duzenlemeSaati': baslik['saat'],
      'paraBirimi': baslik['paraBirimi'],
      'satici': _faturaSatici(invData),
      'alici': _faturaAlici(invData),
      'referanslar': _faturaReferanslari(invData),
      'tutarListe': _tutarListStr(invData),
      'tutarSatirlari': _tutarOzetiSatirlari(invData),
      'faturaNotlari': _faturaBelgeNotlari(invData),
      'kalemler': _faturaKalemleri(invData),
      'kalemKullaniciAciklamalari': _parseKalemKullaniciAciklamalari(
        invData['kalemKullaniciAciklamalari'],
      ),
      'onayAciklamalarText': onayAcikText,
      if ((baslik['ettn'] ?? '').isNotEmpty)
        'ettn': baslik['ettn']
      else if (ettnStr != null && ettnStr.isNotEmpty)
        'ettn': ettnStr,
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
      final canonical = dd['belgeNoCanonical']?.toString().trim() ?? '';
      final baslikIrs = _irsaliyeBaslikAlanlari(dd);
      final sevk = _irsaliyeSevk(dd);
      irsaliyeler.add({
        'belgeNo': canonical.isNotEmpty ? canonical : (ib.isNotEmpty ? ib : d.id),
        if (canonical.isNotEmpty && ib.isNotEmpty && canonical != ib) 'belgeNoKisa': ib,
        'tarih': _irsaliyeTarihi(dd),
        'senaryo': baslikIrs['senaryo'],
        'saat': baslikIrs['saat'],
        'ettn': baslikIrs['ettn'],
        'gonderici': _tarafFromBelgeOzetNode(_belgeOzetMap(dd)?['gonderici']) ??
            _tarafFromUblParty(_despatchUblNode(dd)?['DespatchSupplierParty']) ??
            <String, String>{},
        'alici': _tarafFromBelgeOzetNode(_belgeOzetMap(dd)?['alici']) ??
            _tarafFromUblParty(
              _despatchUblNode(dd)?['DeliveryCustomerParty'] ??
                  _despatchUblNode(dd)?['DespatchCustomerParty'],
            ) ??
            <String, String>{},
        'sevkTarihi': sevk['tarih'],
        'teslimatAdresi': sevk['adres'],
        'kalemler': _irsaliyeKalemleri(dd),
      });
    }

    return <String, dynamic>{
      'fatura': faturaOzeti,
      'irsaliyeler': irsaliyeler,
      'muhasebeFisi': invData['muhasebeFisi'],
    };
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Fatura özeti'),
        actions: [
          if (_isMuhasebe)
            Builder(
              builder: (ctx) {
                final renk = DefaultTextStyle.of(ctx).style.color;
                return TextButton.icon(
                  style: TextButton.styleFrom(foregroundColor: renk),
                  onPressed: () => setState(() => _mahsupAcik = !_mahsupAcik),
                  icon: Icon(_mahsupAcik ? Icons.close : Icons.receipt_long_outlined),
                  label: Text(_mahsupAcik ? 'Fişi Kapat' : 'Mahsup Fişi'),
                );
              },
            ),
          if (_isAraOnay)
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
        ],
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

          final fisHam = data['muhasebeFisi'];
          final mahsupFisi = fisHam is Map ? Map<String, dynamic>.from(fisHam) : null;
          final mahsupBelgeNo = (f['belgeNo'] ?? widget.item['belgeNo'])?.toString().trim() ?? '';

          return _OzetMahsupKatmani(
            acik: _isMuhasebe && _mahsupAcik,
            fis: mahsupFisi,
            belgeNo: mahsupBelgeNo,
            onKapat: () => setState(() => _mahsupAcik = false),
            child: ListView(
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
              _ozetBolumBaslik(context, 'Fatura'),
              _ozetCard(
                context,
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  child: _faturaBelgeOzeti(context, f),
                ),
              ),
              const SizedBox(height: 12),
              _ikiTaraf(
                context,
                'Satıcı',
                _tarafMap(f['satici']),
                'Alıcı',
                _tarafMap(f['alici']),
              ),
              if ((f['referanslar'] as List?)?.isNotEmpty == true) ...[
                const SizedBox(height: 12),
                _ozetCard(
                  context,
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                    child: _referansSatirlari(context, f['referanslar'] as List),
                  ),
                ),
              ],
              const SizedBox(height: 16),
              _ozetBolumBaslik(context, 'Mal / hizmet'),
              _ozetCard(
                context,
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 10),
                  child: _buildKalemTablosu(context, f['kalemler'] as List<dynamic>? ?? []),
                ),
              ),
              const SizedBox(height: 8),
              _ozetCard(
                context,
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  child: _KalemKullaniciAciklamaPanel(
                    key: _kalemAciklamaPanelKey,
                    invoiceDocId: _invoiceDocId,
                    kalemler: (f['kalemler'] as List<dynamic>? ?? [])
                        .whereType<Map>()
                        .map((e) => Map<String, dynamic>.from(e))
                        .toList(),
                    kayitlar: _parseKalemKullaniciAciklamalari(
                      f['kalemKullaniciAciklamalari'],
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              _ozetBolumBaslik(context, 'Toplamlar'),
              _ozetCard(
                context,
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  child: _tutarOzetiIcerik(context, f),
                ),
              ),
              const SizedBox(height: 16),
              _ozetBolumBaslik(context, 'Notlar'),
              _ozetCard(
                context,
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  child: _belgeNotlariOzeti(context, f),
                ),
              ),
              const SizedBox(height: 16),
              _ozetBolumBaslik(context, 'İrsaliye'),
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
          ),
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

  Map<String, String> _tarafMap(dynamic raw) {
    if (raw is! Map) return {};
    return Map<String, dynamic>.from(raw).map(
      (k, v) => MapEntry(k.toString(), v?.toString() ?? ''),
    );
  }

  Widget _etiketliSatir(BuildContext context, String etiket, String? deger, {bool vurgulu = false}) {
    final d = deger?.trim() ?? '';
    if (d.isEmpty || d == '—') return const SizedBox.shrink();
    final cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Text.rich(
        TextSpan(
          children: [
            TextSpan(
              text: '$etiket: ',
              style: TextStyle(
                fontSize: 13,
                color: cs.onSurfaceVariant,
                fontWeight: FontWeight.w600,
              ),
            ),
            TextSpan(
              text: d,
              style: TextStyle(
                fontSize: 13,
                height: 1.3,
                fontWeight: vurgulu ? FontWeight.w600 : FontWeight.w400,
                color: cs.onSurface,
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Basılı e-fatura üst bilgisi: senaryo, tip, no, tarih, saat, ETTN.
  Widget _faturaBelgeOzeti(BuildContext context, Map<String, dynamic> f) {
    final belgeNoRaw = (f['belgeNo'] ?? widget.item['belgeNo'])?.toString().trim() ?? '';
    final bek = (widget.item['muhasebeBeklemeParantez']?.toString() ?? '').trim();
    final no = belgeNoRaw.isEmpty ? '—' : (bek.isEmpty ? belgeNoRaw : '$belgeNoRaw  $bek');
    final senaryo = f['senaryo']?.toString().trim() ?? '';
    final tip = f['faturaTipi']?.toString().trim() ?? '';
    final ust = _joinNonEmpty([
      if (senaryo.isNotEmpty) senaryo,
      if (tip.isNotEmpty) tip,
    ], ' · ');

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (ust.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Text(ust, style: const TextStyle(fontWeight: FontWeight.w600)),
          ),
        _etiketliSatir(context, 'Fatura no', no, vurgulu: true),
        Text('Düzenleme tarihi: ${formatTurkishDate(f['faturaTarihi'])}'),
        _etiketliSatir(context, 'Düzenleme saati', f['duzenlemeSaati']?.toString()),
        _etiketliSatir(context, 'ETTN', f['ettn']?.toString()),
        _etiketliSatir(context, 'Para birimi', f['paraBirimi']?.toString()),
        Text('Portal liste tarihi: ${formatTurkishDate(f['faturaTarihiListe'])}'),
        Text('Geliş tarihi: ${formatTurkishDate(f['faturaGelisTarihi'])}'),
      ],
    );
  }

  Widget _tarafBlogu(BuildContext context, String baslik, Map<String, String> taraf) {
    final cs = Theme.of(context).colorScheme;
    final dolu = _tarafDolu(taraf);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          baslik,
          style: TextStyle(fontWeight: FontWeight.w700, color: cs.primary, fontSize: 13),
        ),
        const SizedBox(height: 6),
        if (!dolu)
          Text('—', style: TextStyle(color: cs.onSurfaceVariant))
        else ...[
          if ((taraf['unvan'] ?? '').isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(taraf['unvan']!, style: const TextStyle(fontWeight: FontWeight.w600)),
            ),
          _etiketliSatir(context, 'VKN / TCKN', taraf['kimlik']),
          _etiketliSatir(context, 'Vergi dairesi', taraf['vergiDairesi']),
          _etiketliSatir(context, 'Adres', taraf['adres']),
          _etiketliSatir(context, 'Telefon', taraf['telefon']),
          _etiketliSatir(context, 'E-posta', taraf['eposta']),
        ],
      ],
    );
  }

  Widget _ikiTaraf(
    BuildContext context,
    String solBaslik,
    Map<String, String> sol,
    String sagBaslik,
    Map<String, String> sag,
  ) {
    Widget kart(Widget child) => _ozetCard(
          context,
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: child,
          ),
        );
    return LayoutBuilder(
      builder: (context, c) {
        final left = kart(_tarafBlogu(context, solBaslik, sol));
        final right = kart(_tarafBlogu(context, sagBaslik, sag));
        if (c.maxWidth >= 720) {
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: left),
              const SizedBox(width: 12),
              Expanded(child: right),
            ],
          );
        }
        return Column(
          children: [
            left,
            const SizedBox(height: 12),
            right,
          ],
        );
      },
    );
  }

  Widget _referansSatirlari(BuildContext context, List<dynamic> refs) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final raw in refs)
          if (raw is Map)
            _etiketliSatir(
              context,
              raw['etiket']?.toString() ?? '',
              raw['deger']?.toString(),
            ),
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

  Widget _despatchCard(BuildContext context, Map<String, dynamic> d) {
    final cs = Theme.of(context).colorScheme;
    final kalemler = d['kalemler'] as List<dynamic>? ?? [];
    final senaryo = d['senaryo']?.toString().trim() ?? '';
    final kisa = d['belgeNoKisa']?.toString().trim() ?? '';
    final gonderici = _tarafMap(d['gonderici']);
    final alici = _tarafMap(d['alici']);
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
              if (senaryo.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Text(senaryo, style: TextStyle(fontWeight: FontWeight.w600, color: cs.primary)),
                ),
              _etiketliSatir(context, 'İrsaliye no', d['belgeNo']?.toString(), vurgulu: true),
              if (kisa.isNotEmpty) _etiketliSatir(context, 'Faturadaki yazım', kisa),
              _etiketliSatir(context, 'Düzenleme tarihi', formatTurkishDate(d['tarih'], empty: '')),
              _etiketliSatir(context, 'Düzenleme saati', d['saat']?.toString()),
              _etiketliSatir(context, 'ETTN', d['ettn']?.toString()),
              _etiketliSatir(context, 'Fiili sevk tarihi', d['sevkTarihi']?.toString()),
              _etiketliSatir(context, 'Teslimat adresi', d['teslimatAdresi']?.toString()),
              const SizedBox(height: 8),
              _ikiTaraf(context, 'Gönderici', gonderici, 'Teslim alan', alici),
              const SizedBox(height: 10),
              Text('Mal / hizmet', style: TextStyle(fontWeight: FontWeight.w700, color: cs.primary, fontSize: 13)),
              const SizedBox(height: 6),
              if (kalemler.isEmpty)
                Text('İrsaliye kalemi yok.', style: TextStyle(fontSize: 13, color: cs.outline))
              else
                _buildKalemTablosu(context, kalemler),
            ],
          ),
        ),
      ),
    );
  }

}

/// Fatura kalemleri için isteğe bağlı kullanıcı açıklaması (Firestore `kalemKullaniciAciklamalari`).
class _KalemKullaniciAciklamaPanel extends StatefulWidget {
  const _KalemKullaniciAciklamaPanel({
    super.key,
    required this.invoiceDocId,
    required this.kalemler,
    required this.kayitlar,
  });

  final String invoiceDocId;
  final List<Map<String, dynamic>> kalemler;
  final Map<String, dynamic> kayitlar;

  @override
  State<_KalemKullaniciAciklamaPanel> createState() => _KalemKullaniciAciklamaPanelState();
}

class _KalemKullaniciAciklamaPanelState extends State<_KalemKullaniciAciklamaPanel> {
  late final List<String> _keys;
  late final List<String> _etiketler;
  late final Map<String, TextEditingController> _controllers;
  final Set<String> _savingKeys = {};
  bool _savingAll = false;

  @override
  void initState() {
    super.initState();
    _keys = [];
    _etiketler = [];
    _controllers = {};
    for (var i = 0; i < widget.kalemler.length; i++) {
      final row = widget.kalemler[i];
      final key = kalemSatirAnahtari(row, i);
      final etiket = kalemEtiket(row, i);
      _keys.add(key);
      _etiketler.add(etiket);
      final prev = widget.kayitlar[key];
      var metin = '';
      if (prev is Map) {
        metin = prev['aciklama']?.toString() ?? '';
      }
      _controllers[key] = TextEditingController(text: metin);
    }
  }

  @override
  void dispose() {
    for (final c in _controllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  String _kayitliAciklama(String key) {
    final prev = widget.kayitlar[key];
    if (prev is Map) return prev['aciklama']?.toString().trim() ?? '';
    return '';
  }

  /// Firestore güncellemesi için değişen kalemler (tek update).
  Map<String, dynamic> _buildPendingKalemPatch() {
    final patch = <String, dynamic>{};
    for (var i = 0; i < _keys.length; i++) {
      final key = _keys[i];
      final aciklama = _controllers[key]!.text.trim();
      if (aciklama == _kayitliAciklama(key)) continue;
      final field = 'kalemKullaniciAciklamalari.$key';
      if (aciklama.isEmpty) {
        patch[field] = FieldValue.delete();
      } else {
        patch[field] = {
          'etiket': _etiketler[i],
          'aciklama': aciklama,
          'guncelleme': FieldValue.serverTimestamp(),
        };
      }
    }
    return patch;
  }

  /// Onaya Sun / Onayla / Reddet öncesi: kaydedilmemiş tüm kalem notlarını yazar.
  Future<bool> saveAllPending() async {
    if (_savingAll) return false;
    final patch = _buildPendingKalemPatch();
    if (patch.isEmpty) return true;

    setState(() => _savingAll = true);
    try {
      final ref =
          FirebaseFirestore.instance.collection('qnb_invoices').doc(widget.invoiceDocId);
      await ref.update(patch);
      return true;
    } catch (_) {
      return false;
    } finally {
      if (mounted) setState(() => _savingAll = false);
    }
  }

  Future<void> _kaydet(String key, String etiket) async {
    if (_savingKeys.contains(key) || _savingAll) return;
    setState(() => _savingKeys.add(key));
    try {
      final aciklama = _controllers[key]!.text.trim();
      final ref = FirebaseFirestore.instance.collection('qnb_invoices').doc(widget.invoiceDocId);
      if (aciklama.isEmpty) {
        await ref.update({
          'kalemKullaniciAciklamalari.$key': FieldValue.delete(),
        });
      } else {
        await ref.set(
          {
            'kalemKullaniciAciklamalari': {
              key: {
                'etiket': etiket,
                'aciklama': aciklama,
                'guncelleme': FieldValue.serverTimestamp(),
              },
            },
          },
          SetOptions(merge: true),
        );
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(aciklama.isEmpty ? 'Kalem açıklaması silindi.' : 'Kalem açıklaması kaydedildi.'),
          duration: const Duration(seconds: 2),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Kayıt hatası: $e'), backgroundColor: Theme.of(context).colorScheme.error),
      );
    } finally {
      if (mounted) setState(() => _savingKeys.remove(key));
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.kalemler.isEmpty) return const SizedBox.shrink();

    final cs = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Kalem açıklamaları (isteğe bağlı)',
          style: Theme.of(context).textTheme.titleSmall?.copyWith(
                fontWeight: FontWeight.w600,
                color: cs.primary,
              ),
        ),
        const SizedBox(height: 4),
        Text(
          'Açıklamalar bu faturanın kalemiyle birlikte kaydedilir. Onaya Sun, Onayla veya Reddet\'e basıldığında kaydedilmemiş notlar otomatik yazılır. ETA stok kodu seçiminde birincil kriter olarak kullanılır.',
          style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant, height: 1.3),
        ),
        const SizedBox(height: 12),
        for (var i = 0; i < widget.kalemler.length; i++) ...[
          if (i > 0) const SizedBox(height: 10),
          _kalemAciklamaSatiri(
            context,
            etiket: _etiketler[i],
            controller: _controllers[_keys[i]]!,
            saving: _savingKeys.contains(_keys[i]) || _savingAll,
            onKaydet: () => _kaydet(_keys[i], _etiketler[i]),
          ),
        ],
      ],
    );
  }

  Widget _kalemAciklamaSatiri(
    BuildContext context, {
    required String etiket,
    required TextEditingController controller,
    required bool saving,
    required VoidCallback onKaydet,
  }) {
    final cs = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border.all(color: cs.outline.withValues(alpha: 0.35)),
        borderRadius: BorderRadius.circular(8),
        color: cs.surface.withValues(alpha: 0.6),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              etiket,
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color: cs.onSurface,
              ),
            ),
            const SizedBox(height: 6),
            TextField(
              controller: controller,
              minLines: 1,
              maxLines: 4,
              decoration: const InputDecoration(
                isDense: true,
                hintText: 'Bu kalem için not / açıklama (isteğe bağlı)',
                border: OutlineInputBorder(),
                contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              ),
              onSubmitted: (_) => onKaydet(),
            ),
            const SizedBox(height: 6),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton.icon(
                onPressed: saving ? null : onKaydet,
                icon: saving
                    ? SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2, color: cs.primary),
                      )
                    : const Icon(Icons.save_outlined, size: 18),
                label: const Text('Kaydet'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Özet listesinin üzerinde duran mahsup penceresi. Sürükleme yalnızca bu
/// katmanı yeniler; alttaki fatura özetinin kaydırma konumu korunur.
class _OzetMahsupKatmani extends StatefulWidget {
  const _OzetMahsupKatmani({
    required this.acik,
    required this.fis,
    required this.belgeNo,
    required this.onKapat,
    required this.child,
  });

  final bool acik;
  final Map<String, dynamic>? fis;
  final String belgeNo;
  final VoidCallback onKapat;
  final Widget child;

  @override
  State<_OzetMahsupKatmani> createState() => _OzetMahsupKatmaniState();
}

class _OzetMahsupKatmaniState extends State<_OzetMahsupKatmani> {
  Offset? _konum;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final alan = constraints.biggest;
        final panelW = math.min(680.0, math.max(280.0, alan.width - 24));
        final panelH = math.min(560.0, math.max(240.0, alan.height * 0.62));
        final varsayilan = Offset(math.max(12, alan.width - panelW - 12), 12);
        final konum = _konum ?? varsayilan;
        final sol = konum.dx.clamp(0.0, math.max(0.0, alan.width - 48)).toDouble();
        final ust = konum.dy.clamp(0.0, math.max(0.0, alan.height - 40)).toDouble();
        return Stack(
          children: [
            Positioned.fill(child: widget.child),
            if (widget.acik)
              Positioned(
                left: sol,
                top: ust,
                width: panelW,
                height: panelH,
                child: MahsupFisiYuzerPencere(
                  fis: widget.fis,
                  belgeNo: widget.belgeNo,
                  onKapat: widget.onKapat,
                  onSurukle: (delta) {
                    setState(() {
                      final bas = _konum ?? varsayilan;
                      _konum = Offset(
                        (bas.dx + delta.dx).clamp(0.0, math.max(0.0, alan.width - 48)).toDouble(),
                        (bas.dy + delta.dy).clamp(0.0, math.max(0.0, alan.height - 40)).toDouble(),
                      );
                    });
                  },
                ),
              ),
          ],
        );
      },
    );
  }
}










