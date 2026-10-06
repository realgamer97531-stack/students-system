import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

/// نسخة محفوظة على الموبايل من آخر بيانات جت من السيرفر، عشان البرنامج يفتح ويعرضها من غير نت.
/// كل حساب ليه فولدر لوحده، وبيتمسح لما يعمل خروج.
class CachedValue {
  CachedValue(this.data, this.savedAt);
  final dynamic data;
  final DateTime savedAt;
}

class Cache {
  static String _scope = 'default';
  static Directory? _root;

  /// بيتبدل في الاختبارات بفولدر مؤقت
  static Future<Directory> Function() rootProvider = getApplicationSupportDirectory;

  /// للاختبارات: فولدر جديد فاضي
  static void resetRoot() => _root = null;

  static void setScope(String scope) => _scope = scope.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_');

  static Future<Directory> _dir([String? scope]) async {
    _root ??= await rootProvider();
    final dir = Directory('${_root!.path}/cache/${scope ?? _scope}');
    if (!dir.existsSync()) dir.createSync(recursive: true);
    return dir;
  }

  static String _safe(String key) => key.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_');

  static Future<CachedValue?> read(String key) async {
    try {
      final file = File('${(await _dir()).path}/${_safe(key)}.json');
      if (!file.existsSync()) return null;
      final map = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
      return CachedValue(map['data'], DateTime.fromMillisecondsSinceEpoch(map['savedAt'] as int));
    } catch (_) {
      return null;
    }
  }

  static Future<void> write(String key, dynamic data) async {
    try {
      final dir = await _dir();
      final file = File('${dir.path}/${_safe(key)}.json');
      final tmp = File('${file.path}.tmp');
      // ملفات صغيرة: الكتابة المباشرة أسرع وأضمن من الـ async هنا
      tmp.writeAsStringSync(jsonEncode({'savedAt': DateTime.now().millisecondsSinceEpoch, 'data': data}), flush: true);
      tmp.renameSync(file.path);
    } catch (_) {
      // الكاش مش لازم يوقف البرنامج أبدًا
    }
  }

  /// نسخة كبيرة (JSON جاهز): من غير ما نفك ونعيد تكوينها على الشاشة. بترجع (النص, وقت الحفظ)
  static Future<(String, DateTime)?> readRaw(String key) async {
    try {
      final file = File('${(await _dir()).path}/${_safe(key)}.raw');
      if (!file.existsSync()) return null;
      return (file.readAsStringSync(), file.lastModifiedSync());
    } catch (_) {
      return null;
    }
  }

  static Future<void> writeRaw(String key, String json) async {
    try {
      final file = File('${(await _dir()).path}/${_safe(key)}.raw');
      final tmp = File('${file.path}.tmp');
      tmp.writeAsStringSync(json, flush: true);
      tmp.renameSync(file.path);
    } catch (_) {}
  }

  static Future<void> remove(String key) async {
    try {
      final file = File('${(await _dir()).path}/${_safe(key)}.json');
      if (file.existsSync()) file.deleteSync();
    } catch (_) {}
  }

  /// مسح كل بيانات حساب معين (عند الخروج)
  static Future<void> clearScope([String? scope]) async {
    try {
      final dir = await _dir(scope);
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    } catch (_) {}
  }

  /// فولدر الملفات اللي مستنية تترفع (صور الواجب...)
  static Future<Directory> filesDir(String name) async {
    _root ??= await rootProvider();
    final dir = Directory('${_root!.path}/files/$name');
    if (!dir.existsSync()) dir.createSync(recursive: true);
    return dir;
  }
}
