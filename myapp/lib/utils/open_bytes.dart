import 'dart:typed_data';

import 'open_bytes_stub.dart'
    if (dart.library.html) 'open_bytes_web.dart' as impl;

Future<bool> openBytesInNewTab(
  Uint8List bytes, {
  required String mimeType,
  String? fileName,
}) {
  return impl.openBytesInNewTab(bytes, mimeType: mimeType, fileName: fileName);
}
