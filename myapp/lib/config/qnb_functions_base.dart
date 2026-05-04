import 'package:flutter/foundation.dart' show kIsWeb;

const String _qnbFunctionsHost =
    'https://europe-west1-curious-nucleus-392008.cloudfunctions.net';

/// Firebase Hosting (`*.web.app` / `*.firebaseapp.com`) üzerindeyken aynı kökten `/api/<fn>`.
/// Yerel `flutter run -d chrome` veya mobilde doğrudan Cloud Functions URL’si.
String qnbFunctionUrl(String functionName) {
  if (kIsWeb) {
    final host = Uri.base.host;
    if (host.endsWith('.web.app') || host.endsWith('.firebaseapp.com')) {
      return '${Uri.base.origin}/api/$functionName';
    }
  }
  return '$_qnbFunctionsHost/$functionName';
}
