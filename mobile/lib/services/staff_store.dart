import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import 'cache.dart';
import 'net.dart';
import 'session_store.dart';
import 'staff_api.dart';

/// بيانات طالب في نسخة المسح أوفلاين
class SnapStudent {
  SnapStudent(this.id, this.code, this.name, this.subjectId, this.centerId, this.balance, this.price, this.blocked, this.note);
  final int id;
  final String code;
  final String name;
  final int? subjectId, centerId;
  num balance;
  final num price;
  final bool blocked;
  final String? note;
}

num _num(dynamic v) => v is num ? v : num.tryParse('$v') ?? 0;
int? _int(dynamic v) => v is int ? v : (v is num ? v.toInt() : int.tryParse('$v'));

/// نفس normalizeStudentCode على السيرفر: أرقام عربي → إنجليزي، و 123 / stu123 → STU-00123
String normalizeStudentCode(String input) {
  const ar = '٠١٢٣٤٥٦٧٨٩', fa = '۰۱۲۳۴۵۶۷۸۹';
  var text = input.split('').map((c) {
    final a = ar.indexOf(c), f = fa.indexOf(c);
    return a >= 0 ? '$a' : (f >= 0 ? '$f' : c);
  }).join().trim().toUpperCase();
  final m = RegExp(r'^(?:STU)?[\s-]*0*(\d+)$').firstMatch(text);
  if (m == null) return text;
  text = 'STU-${m.group(1)!.padLeft(5, '0')}';
  return text;
}

/// نسخة صغيرة من السيستم على الموبايل عشان المسح يشتغل من غير نت
class Snapshot {
  Snapshot(this.raw) {
    for (final c in (raw['centers'] as List? ?? [])) {
      centers[_int(c['id'])!] = '${c['name']}';
    }
    for (final s in (raw['subjects'] as List? ?? [])) {
      subjects[_int(s['id'])!] = '${s['name']}';
    }
    sessions = (raw['sessions'] as List? ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();
    for (final row in (raw['students'] as List? ?? [])) {
      final r = row as List;
      final s = SnapStudent(_int(r[0])!, '${r[1]}', '${r[2]}', _int(r[3]), _int(r[4]), _num(r[5]), _num(r[6]), r[7] == true || r[7] == 1 || r[7] == '1', r[8] == null ? null : '${r[8]}');
      byCode[s.code] = s;
      byId[s.id] = s;
    }
    for (final a in (raw['attendance'] as List? ?? [])) {
      attendance.add('${a[0]}:${a[1]}');
    }
    for (final h in (raw['homework'] as List? ?? [])) {
      homework['${h[0]}:${h[1]}'] = '${h[2]}';
    }
  }

  final Map<String, dynamic> raw;
  final Map<int, String> centers = {};
  final Map<int, String> subjects = {};
  late final List<Map<String, dynamic>> sessions;
  final Map<String, SnapStudent> byCode = {};
  final Map<int, SnapStudent> byId = {};
  final Set<String> attendance = {};
  final Map<String, String> homework = {};

  Map<String, dynamic>? session(int? id) => id == null ? null : sessions.where((s) => _int(s['id']) == id).firstOrNull;

  SnapStudent? student(String rawCode) {
    final raw = rawCode.trim();
    return byCode[raw] ?? byCode[normalizeStudentCode(raw)];
  }

  String sessionLabel(Map<String, dynamic> s) {
    final date = '${s['session_date'] ?? ''}';
    return 'حصة ${s['lesson_number']} — ${centers[_int(s['CenterId'])] ?? ''} — ${subjects[_int(s['SubjectId'])] ?? ''}'
        '${date.isNotEmpty ? ' ($date)' : ''}${s['status'] == 'cancelled' ? ' • ملغية' : ''}';
  }
}

/// العمليات اللي اتعملت والنت فاصل + نسخة المسح أوفلاين + المشاكل اللي السيرفر رفضها
class StaffStore {
  static final snapshot = ValueNotifier<Snapshot?>(null);
  static final snapshotAt = ValueNotifier<DateTime?>(null);
  static final queue = ValueNotifier<List<Map<String, dynamic>>>([]);
  static final problems = ValueNotifier<List<Map<String, dynamic>>>([]);
  static final deviceRevoked = ValueNotifier<bool>(false);
  static final syncing = ValueNotifier<bool>(false);

  static bool _started = false;
  static Timer? _timer;

  static Future<void> start() async {
    if (_started) return;
    _started = true;
    Cache.setScope('staff_device');
    final snap = await Cache.read('snapshot');
    if (snap != null) {
      try {
        snapshot.value = Snapshot((snap.data as Map).cast<String, dynamic>());
        snapshotAt.value = snap.savedAt;
      } catch (_) {}
    }
    queue.value = (((await Cache.read('queue'))?.data as List?) ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();
    problems.value = (((await Cache.read('problems'))?.data as List?) ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();
    _applyQueueToSnapshot();
    Connection.online.addListener(_onConnection);
    _timer = Timer.periodic(const Duration(seconds: 45), (_) => flush());
    unawaited(refreshSnapshot());
    unawaited(flush());
  }

  static void stop() {
    Connection.online.removeListener(_onConnection);
    _timer?.cancel();
    _timer = null;
    _started = false;
  }

  static void _onConnection() {
    if (Connection.online.value) {
      unawaited(flush());
      unawaited(refreshSnapshot());
    }
  }

  static Future<bool> refreshSnapshot() async {
    try {
      final raw = await StaffApi.snapshot();
      await Cache.write('snapshot', raw);
      snapshot.value = Snapshot(raw);
      snapshotAt.value = DateTime.now();
      _applyQueueToSnapshot();
      deviceRevoked.value = false;
      Connection.report(true);
      return true;
    } on DeviceNotAuthorized {
      deviceRevoked.value = true;
      return false;
    } on ApiException catch (e) {
      if (e.offline) Connection.report(false);
      return false;
    } catch (_) {
      return false;
    }
  }

  static String newOpId() {
    final r = Random.secure();
    return 'm-${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}-${List.generate(10, (_) => r.nextInt(36).toRadixString(36)).join()}';
  }

  /// العمليات المستنية لازم تبان في الفحص أوفلاين (مثلاً متسجلش حضور نفس الطالب مرتين)
  static void _applyQueueToSnapshot() {
    final snap = snapshot.value;
    if (snap == null) return;
    for (final op in queue.value) {
      _applyOp(snap, op);
    }
  }

  static void _applyOp(Snapshot snap, Map<String, dynamic> op) {
    final student = snap.student('${op['body']?['student_code'] ?? ''}');
    if (student == null) return;
    final key = '${student.id}:${op['activeSessionId']}';
    if (op['kind'] == 'attendance') {
      snap.attendance.add(key);
    } else if (op['kind'] == 'homework') {
      snap.homework[key] = '${op['body']['status']}';
    }
  }

  static Future<void> enqueue(Map<String, dynamic> op) async {
    queue.value = [...queue.value, op];
    await Cache.write('queue', queue.value);
    final snap = snapshot.value;
    if (snap != null) _applyOp(snap, op);
    if (op['kind'] == 'attendance' && snap != null) {
      // الرصيد التقريبي بعد الحضور (عشان الفحص أوفلاين بعد كده)
      final s = snap.student('${op['body']['student_code']}');
      if (s != null) s.balance = s.balance + _num(op['body']['payment_collected']) - s.price;
    }
  }

  static Future<void> _remove(String id) async {
    queue.value = queue.value.where((o) => o['id'] != id).toList();
    await Cache.write('queue', queue.value);
  }

  static Future<void> addProblem(Map<String, dynamic> op, String message) async {
    problems.value = [
      {'id': op['id'], 'label': op['label'], 'message': message, 'at': DateTime.now().toIso8601String(), 'clientTime': op['clientTime']},
      ...problems.value,
    ];
    await Cache.write('problems', problems.value);
  }

  static Future<void> dismissProblem(String id) async {
    problems.value = problems.value.where((p) => p['id'] != id).toList();
    await Cache.write('problems', problems.value);
  }

  /// بيبعت عملية على طول (لو فيه نت)، ولو النت فاصل بيحطها في الطابور.
  /// بيرجع النتيجة لو اتبعتت، أو null لو اتحفظت للإرسال بعدين.
  static Future<OpResult?> submit(Map<String, dynamic> op) async {
    if (queue.value.isNotEmpty) {
      // فيه عمليات أقدم مستنية: لازم تتبعت بالترتيب
      await enqueue(op);
      unawaited(flush());
      return null;
    }
    try {
      final result = await _send(op);
      Connection.report(true);
      final snap = snapshot.value;
      if (result.ok && snap != null) _applyOp(snap, op);
      return result;
    } on ApiException catch (e) {
      if (!e.offline) rethrow;
      Connection.report(false);
      await enqueue(op);
      return null;
    }
  }

  static Future<OpResult> _send(Map<String, dynamic> op) => StaffApi.call(
        '${op['path']}',
        (op['body'] as Map).cast<String, dynamic>(),
        userId: op['userId'] as int,
        activeSessionId: op['activeSessionId'] as int?,
        opId: '${op['id']}',
        clientTime: DateTime.fromMillisecondsSinceEpoch(op['clientTime'] as int),
      );

  static bool _flushing = false;

  static Future<void> flush() async {
    if (_flushing || queue.value.isEmpty) return;
    _flushing = true;
    syncing.value = true;
    try {
      for (final op in [...queue.value]) {
        try {
          final result = await _send(op);
          Connection.report(true);
          if (!result.ok) await addProblem(op, result.message);
          await _remove('${op['id']}');
        } on DeviceNotAuthorized {
          deviceRevoked.value = true;
          break;
        } on ApiException catch (e) {
          if (e.offline) {
            Connection.report(false);
            break;
          }
          await addProblem(op, e.message);
          await _remove('${op['id']}');
        }
      }
    } finally {
      _flushing = false;
      syncing.value = false;
    }
  }

  static Future<StaffUser?> currentUser() => SessionStore.staffUser();
}
