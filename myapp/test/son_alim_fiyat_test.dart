import 'package:flutter_test/flutter_test.dart';
import 'package:myapp/formatting/son_alim_fiyat.dart';

void main() {
  test('aynı para biriminde yalnız sayı', () {
    expect(
      sonAlimFiyatParantezi(
        fiyat: 1100,
        paraBirimi: 'TRY',
        yeniFiyatMetni: '1.234,5000 TRY',
      ),
      '1.100',
    );
  });

  test('TL ve TRY aynı sayılır', () {
    expect(
      sonAlimFiyatParantezi(
        fiyat: 10.5,
        paraBirimi: 'TRY',
        yeniFiyatMetni: '12,50 TL',
      ),
      '10,5',
    );
  });

  test('farklı para biriminde kod da yazılır', () {
    expect(
      sonAlimFiyatParantezi(
        fiyat: 12.5,
        paraBirimi: 'USD',
        yeniFiyatMetni: '420,0000 TRY',
      ),
      '12,5 USD',
    );
  });

  test('fiyat yoksa parantez metni boştur', () {
    expect(
      sonAlimFiyatParantezi(
        fiyat: 0,
        paraBirimi: 'TRY',
        yeniFiyatMetni: '10 TRY',
      ),
      '',
    );
  });
}
