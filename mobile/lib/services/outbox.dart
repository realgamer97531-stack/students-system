import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'cache.dart';
import 'net.dart';

/// عمليات الطالب اللي اتعملت من غير نت وبتستنى تتبعت:
///  - تسليم واجب (الصور بتتنسخ جوه البرنامج لحد ما تترفع)
///  - وقت مشاهدة الفيديو
/// بتتبعت لوحدها أول ما النت يرجع، أو لما البرنامج يتفتح.
class Outbox {
  static const _key = 'outbox';
  static final items = ValueNotifier<List<Map<String, dynamic>>>([]);
  static bool _loaded = false;
  static bool _flushing = false;
  static Timer? _timer;

  static Future<void> start() async {
    await _load();
    Connection.online.addListener(_onConnection);
    _timer ??= Timer.periodic(const Duration(minutes: 1), (_) => flush());
    unawaited(flush());
  }

  static void stop() {
    Connection.online.removeListener(_onConnection);
    _timer?.cancel();
    _timer = null;
    _loaded = false;
    items.value = [];
  }

  static void _onConnection() {
    if (Connection.online.value) unawaited(flush());
  }

  static Future<void> _load() async {
    if (_loaded) return;
    final cached = await Cache.read(_key);
    items.value = ((cached?.data as List?) ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();
    _loaded = true;
  }

  static Future<void> _save() => Cache.write(_key, items.value);

  static String _newId() => '${DateTime.now().microsecondsSinceEpoch}-${Random().nextInt(1 << 30)}';

  /// الواجبات اللي مستنية تتبعت (عشان نعرضها على كارت الواجب)
  static List<Map<String, dynamic>> homeworkFor(int assignmentId) =>
      items.value.where((i) => i['type'] == 'homework' && i['assignmentId'] == assignmentId).toList();

  static Future<void> addHomework(int assignmentId, String title, List<File> files, String comment) async {
    await _load();
    final id = _newId();
    final dir = await Cache.filesDir('homework/$id');
    final copies = <String>[];
    for (var i = 0; i < files.length; i++) {
      final name = files[i].uri.pathSegments.last;
      final copy = files[i].copySync('${dir.path}/${i}_$name');
      copies.add(copy.path);
    }
    items.value = [
      ...items.value,
      {'id': id, 'type': 'homework', 'assignmentId': assignmentId, 'title': title, 'files': copies, 'comment': comment, 'createdAt': DateTime.now().toIso8601String()},
    ];
    await _save();
  }

  /// وقت المشاهدة: بنحتفظ بأكبر وقت لكل جزء بس
  static Future<void> addWatch(int partId, int seconds) async {
    await _load();
    final list = [...items.value];
    final i = list.indexWhere((e) => e['type'] == 'watch' && e['partId'] == partId);
    if (i >= 0) {
      if ((list[i]['seconds'] as int) >= seconds) return;
      list[i] = {...list[i], 'seconds': seconds};
    } else {
      list.add({'id': _newId(), 'type': 'watch', 'partId': partId, 'seconds': seconds});
    }
    items.value = list;
    await _save();
  }

  static Future<void> dismiss(String id) async {
    final item = items.value.where((e) => e['id'] == id).firstOrNull;
    items.value = items.value.where((e) => e['id'] != id).toList();
    await _save();
    if (item != null) await _deleteFiles(item);
  }

  static Future<void> _deleteFiles(Map<String, dynamic> item) async {
    if (item['type'] != 'homework') return;
    try {
      final dir = Directory((await Cache.filesDir('homework/${item['id']}')).path);
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    } catch (_) {}
  }

  /// إرسال كل اللي مستني بالترتيب. لو النت فصل بنقف ونكمل بعدين.
  static Future<void> flush() async {
    if (_flushing) return;
    await _load();
    _flushing = true;
    try {
      for (final item in [...items.value]) {
        if (item['failed'] == true) continue;
        try {
          if (item['type'] == 'watch') {
            await PortalApi.watchProgress(item['partId'] as int, item['seconds'] as int);
          } else if (item['type'] == 'homework') {
            final files = ((item['files'] as List?) ?? []).map((p) => File('$p')).where((f) => f.existsSync()).toList();
            if (files.isEmpty) throw ApiException('ملفات الواجب اتمسحت من الموبايل');
            await PortalApi.submitHomework(item['assignmentId'] as int, files, '${item['comment'] ?? ''}');
          }
          items.value = items.value.where((e) => e['id'] != item['id']).toList();
          await _save();
          await _deleteFiles(item);
        } on ApiException catch (e) {
          if (e.offline || e.unauthorized) break;
          if (item['type'] == 'watch') {
            items.value = items.value.where((x) => x['id'] != item['id']).toList();
            await _save();
            continue;
          }
          // السيرفر رفض (مثلاً وقت التسليم خلص): بنسيبها ظاهرة للطالب برسالة السبب
          items.value = items.value.map((x) => x['id'] == item['id'] ? {...x, 'failed': true, 'error': e.message} : x).toList();
          await _save();
        } catch (_) {
          break;
        }
      }
    } finally {
      _flushing = false;
    }
  }
}
