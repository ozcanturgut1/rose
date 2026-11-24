import 'package:flutter_test/flutter_test.dart';
import 'package:myapp/services/teslim_belgesi.dart';

void main() {
  test('ayırıcıyı siler ve seri numarasını 9 haneye tamamlar', () {
    expect(teslimBelgeNoTamamla('SCA2026-1084'), 'SCA2026000001084');
    expect(teslimBelgeNoTamamla('SCA2026/1084'), 'SCA2026000001084');
    expect(teslimBelgeNoTamamla('SCA2026 1084'), 'SCA2026000001084');
    expect(teslimBelgeNoTamamla('SCA2026.1084'), 'SCA2026000001084');
    expect(teslimBelgeNoTamamla('SCA2026_1084'), 'SCA2026000001084');
  });

  test('zaten tam olan numarayı değiştirmez', () {
    expect(teslimBelgeNoTamamla('SCA2026000001084'), 'SCA2026000001084');
    expect(teslimBelgeNoTamamla('  ava2026000462736 '), 'AVA2026000462736');
  });
}
