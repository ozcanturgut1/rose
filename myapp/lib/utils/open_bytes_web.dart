import 'dart:html' as html;
import 'dart:typed_data';

Future<bool> openBytesInNewTab(
  Uint8List bytes, {
  required String mimeType,
  String? fileName,
}) async {
  try {
    final blob = html.Blob([bytes], mimeType);
    final url = html.Url.createObjectUrlFromBlob(blob);
    html.window.open(url, '_blank');
    Future<void>.delayed(const Duration(seconds: 30), () {
      html.Url.revokeObjectUrl(url);
    });
    return true;
  } catch (_) {
    return false;
  }
}
