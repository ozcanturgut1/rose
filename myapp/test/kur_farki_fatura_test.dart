import 'package:flutter_test/flutter_test.dart';
import 'package:myapp/services/kur_farki_fatura.dart';

void main() {
  test('satır adındaki kur farkı yakalanır', () {
    expect(
      kurFarkiFaturasi({
        'ublParsed': {
          'Invoice': {
            'InvoiceLine': {'Name': 'NA6 ÇEKİM kur farkı'},
          },
        },
      }),
      isTrue,
    );
  });

  test('belge notundaki kur farkı yakalanır', () {
    expect(
      kurFarkiFaturasi({
        'contentUbl': '<cbc:Note>Kur Farkı faturası</cbc:Note>',
      }),
      isTrue,
    );
  });

  test('vade farkı ve fiyat farkı kur farkı değildir', () {
    expect(
      kurFarkiFaturasi({
        'ublParsed': {
          'Invoice': {'Note': 'vade farkı ve fiyat farkı'},
        },
      }),
      isFalse,
    );
  });
}
