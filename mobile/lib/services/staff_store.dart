import 'dart:async';
import 'dart:convert';
import 'dart:isolate';
import 'dart:math';

import 'package:flutter/foundation.dart';

import 'cache.dart';
import 'mesh/mesh_core.dart' show OpState;
import 'mesh/mesh_service.dart';
import 'net.dart';
import 'session_store.dart';
import 'staff_api.dart';

/// بيانات طالب في نسخة المسح أوفلاين
class SnapStudent {
  SnapStudent(this.id, this.code, this.name, this.subjectId, this.centerId, this.balance, this.price, this.blocked, this.note,
      {this.phone, this.parentPhone, this.points});
  final int id;
  final String code;
  final String name;
  final int? subjectId, centerId;
  num balance;
  final num price;
  final bool blocked;
  final String? note;
  final String? phone, parentPhone;
  final num? points;

  /// للبحث: الاسم + الكود + التليفونات
  late final String searchText = '${name.toLowerCase()} ${code.toLowerCase()} ${phone ?? ''} ${parentPhone ?? ''}';
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

/// نفس باليتة الموقع (utils/entityColors.js): لو السنتر/المادة ملهاش لون محفوظ
const _entityPalette = [
  0xFF6366F1, 0xFF14B8A6, 0xFFF59E0B, 0xFFEC4899, 0xFF0EA5E9, 0xFF22C55E,
  0xFF8B5CF6, 0xFFF97316, 0xFFEF4444, 0xFF06B6D4, 0xFF84CC16, 0xFFD946EF,
];

int autoEntityColor(String kind, int? id) {
  if (id == null || id <= 0) return 0xFF94A3B8;
  final offset = kind == 'subject' ? 4 : 0;
  return _entityPalette[(id - 1 + offset) % _entityPalette.length];
}

int? parseHexColor(dynamic value) {
  final m = RegExp(r'^#?([0-9a-fA-F]{6})$').firstMatch('${value ?? ''}'.trim());
  return m == null ? null : 0xFF000000 | int.parse(m.group(1)!, radix: 16);
}

/// نسخة صغيرة من السيستم على الموبايل عشان المسح يشتغل من غير نت
class Snapshot {
  Snapshot(this.raw) {
    for (final c in (raw['centers'] as List? ?? [])) {
      final id = _int(c['id'])!;
      centers[id] = '${c['name']}';
      centerColors[id] = parseHexColor(c['color']) ?? autoEntityColor('center', id);
    }
    for (final s in (raw['subjects'] as List? ?? [])) {
      final id = _int(s['id'])!;
      subjects[id] = '${s['name']}';
      subjectColors[id] = parseHexColor(s['color']) ?? autoEntityColor('subject', id);
    }
    sessions = (raw['sessions'] as List? ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();
    for (final row in (raw['students'] as List? ?? [])) {
      final r = row as List;
      String? at(int i) => r.length > i && r[i] != null ? '${r[i]}' : null;
      final s = SnapStudent(_int(r[0])!, '${r[1]}', '${r[2]}', _int(r[3]), _int(r[4]), _num(r[5]), _num(r[6]), r[7] == true || r[7] == 1 || r[7] == '1', at(8),
          phone: at(9), parentPhone: at(10), points: r.length > 11 ? _num(r[11]) : null);
      students.add(s);
      byCode[s.code] = s;
      byId[s.id] = s;
    }
    for (final a in (raw['attendance'] as List? ?? [])) {
      attendance.add('${a[0]}:${a[1]}');
    }
    for (final h in (raw['homework'] as List? ?? [])) {
      homework['${h[0]}:${h[1]}'] = '${h[2]}';
    }
    final details = raw['details'];
    if (details is Map) {
      hasDetails = true;
      for (final r in (details['history'] as List? ?? [])) {
        // حضور المنصة = -1 (بيظهر "المنصة") — والحضور الفعلي في سنتر أولى منه لو الاتنين موجودين
        final lessons = _history[_int(r[0])!] ??= {};
        final lesson = _int(r[1])!;
        final platform = r.length > 3 && _int(r[3]) == 1;
        if (platform && lessons.containsKey(lesson)) continue;
        lessons[lesson] = platform ? -1 : _int(r[2]);
      }
      for (final r in (details['groups'] as List? ?? [])) {
        (_groupLessons['${r[0]}:${r[1]}'] ??= {}).add(_int(r[2])!);
      }
      for (final r in (details['exams'] as List? ?? [])) {
        (_exams[_int(r[0])!] ??= []).add({'name': r[1], 'score': r[2], 'maxScore': r[3], 'examDate': r[4]});
      }
      for (final r in (details['booklets'] as List? ?? [])) {
        (_booklets[_int(r[1])] ??= []).add(r as List);
      }
      for (final r in (details['studentBooklets'] as List? ?? [])) {
        _studentBooklets['${r[0]}:${r[1]}'] = r as List;
      }
      for (final r in (details['reservations'] as List? ?? [])) {
        _reservations['${r[0]}:${r[1]}'] = '${r[2]}';
      }
      for (final r in (details['followUp'] as List? ?? [])) {
        _followUp[_int(r[0])!] = '${r[1]}';
      }
    }
  }

  /// النسخة فيها تفاصيل الطالب (السيرفر الجديد بيبعتها)
  bool hasDetails = false;
  final Map<int, Map<int, int?>> _history = {};
  final Map<String, Set<int>> _groupLessons = {};
  final Map<int, List<Map<String, dynamic>>> _exams = {};
  final Map<int?, List<List>> _booklets = {};
  final Map<String, List> _studentBooklets = {};
  final Map<String, String> _reservations = {};
  final Map<int, String> _followUp = {};

  /// نفس اللي /attendance/scan/lookup بيرجعه (تاريخ الحضور + الامتحانات + البوكليتات + المتابعة) من النسخة المحفوظة
  Map<String, dynamic> lookupDetails(SnapStudent s) {
    if (!hasDetails) return {};
    final attended = _history[s.id] ?? const {};
    final lessons = {...?_groupLessons['${s.centerId}:${s.subjectId}'], ...attended.keys}.toList()..sort();
    final booklets = [
      for (final b in _booklets[s.subjectId] ?? const <List>[])
        () {
          final sb = _studentBooklets['${s.id}:${b[0]}'];
          final price = sb != null ? _num(sb[2]) : _num(b[3]);
          final paid = sb != null ? _num(sb[3]) : 0;
          final remaining = max(0, price - paid);
          return <String, dynamic>{
            'id': b[0],
            'name': b[2],
            'sellPrice': price,
            'paidAmount': paid,
            'remaining': remaining,
            'studentBookletId': null, // التسليم محتاج نت
            'isDelivered': sb != null && (sb[4] == 1 || sb[4] == true),
            'reservationStatus': _reservations['${s.id}:${b[0]}'],
            'isFullyPaid': remaining <= 0,
          };
        }(),
    ];
    return {
      'summary': [
        for (final n in lessons)
          {
            'lessonNumber': n,
            'attended': attended.containsKey(n),
            'attendedWhere': attended.containsKey(n) ? (attended[n] == -1 ? 'المنصة (أونلاين)' : (centers[attended[n]] ?? '')) : null,
            'parts': const [],
          },
      ],
      'independentExamResults': _exams[s.id] ?? const [],
      'bookletStatuses': booklets,
      if (_followUp[s.id] != null) 'followUpAssistant': {'name': _followUp[s.id]},
    };
  }

  final Map<String, dynamic> raw;
  final Map<int, String> centers = {};
  final Map<int, String> subjects = {};
  /// لون كل سنتر/مادة (ARGB) — نفس ألوان الموقع
  final Map<int, int> centerColors = {};
  final Map<int, int> subjectColors = {};
  late final List<Map<String, dynamic>> sessions;
  final Map<String, SnapStudent> byCode = {};
  final List<SnapStudent> students = [];
  final Map<int, SnapStudent> byId = {};
  final Set<String> attendance = {};
  final Map<String, String> homework = {};
  /// مين سجل الحضور/الواجب (للعمليات اللي لسه مارفعتش، من الموبايل ده أو من أجهزة الشبكة)
  final Map<String, String> attendanceBy = {};
  final Map<String, String> homeworkBy = {};

  Map<String, dynamic>? session(int? id) => id == null ? null : sessions.where((s) => _int(s['id']) == id).firstOrNull;

  SnapStudent? student(String rawCode) {
    final raw = rawCode.trim();
    return byCode[raw] ?? byCode[normalizeStudentCode(raw)];
  }

  int centerColor(Map<String, dynamic> s) => centerColors[_int(s['CenterId'])] ?? autoEntityColor('center', _int(s['CenterId']));
  int subjectColor(Map<String, dynamic> s) => subjectColors[_int(s['SubjectId'])] ?? autoEntityColor('subject', _int(s['SubjectId']));

  String sessionLabel(Map<String, dynamic> s) {
    final date = '${s['session_date'] ?? ''}';
    return 'حصة ${s['lesson_number']} — ${centers[_int(s['CenterId'])] ?? ''} — ${subjects[_int(s['SubjectId'])] ?? ''}'
        '${date.isNotEmpty ? ' ($date)' : ''}${s['status'] == 'cancelled' ? ' • ملغية' : ''}';
  }
}

/// العمليات اللي اتعملت والنت فاصل + نسخة المسح أوفلاين + المشاكل اللي السيرفر رفضها
/// تحويل النسخة لـ Snapshot بعيد عن الشاشة (عشان البرنامج ميتقلش مع آلاف الطلاب)
Future<Snapshot> parseSnapshot(String json) async {
  if (!StaffStore.useIsolate) return Snapshot((jsonDecode(json) as Map).cast<String, dynamic>());
  return Isolate.run(() => Snapshot((jsonDecode(json) as Map).cast<String, dynamic>()));
}

class StaffStore {
  /// في الاختبارات بنشتغل من غير isolate
  static bool useIsolate = true;

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
    final snap = await Cache.readRaw('snapshot');
    if (snap != null) {
      try {
        snapshot.value = await parseSnapshot(snap.$1);
        snapshotAt.value = await _savedSnapshotAt() ?? snap.$2;
      } catch (_) {}
    }
    queue.value = (((await Cache.read('queue'))?.data as List?) ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();
    problems.value = (((await Cache.read('problems'))?.data as List?) ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();
    await MeshService.instance.load(await SessionStore.staffUser());
    // قبل أي حفظ للسجل (الحفظ بيمسح القديم): ناخد نسخة كاملة من العمليات المرفوضة
    await _rescueProblemOps();
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
    unawaited(MeshService.instance.detach());
  }

  static void _onConnection() {
    if (Connection.online.value) {
      unawaited(flush());
      unawaited(refreshSnapshot());
    }
  }

  static Future<bool> refreshSnapshot() async {
    try {
      final raw = await StaffApi.snapshotJson();
      final parsed = await parseSnapshot(raw);
      await Cache.writeRaw('snapshot', raw);
      final now = DateTime.now();
      await Cache.write('snapshot_meta', {'at': now.millisecondsSinceEpoch, 'from': 'server'});
      snapshot.value = parsed;
      snapshotAt.value = now;
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

  /// وقت نسخة البيانات الحقيقي (من السيرفر — أو من السيرفر عن طريق جهاز تاني في الشبكة)
  static Future<DateTime?> _savedSnapshotAt() async {
    final at = ((await Cache.read('snapshot_meta'))?.data as Map?)?['at'];
    return at is int ? DateTime.fromMillisecondsSinceEpoch(at) : null;
  }

  /// العمليات المستنية لازم تبان في الفحص أوفلاين (مثلاً متسجلش حضور نفس الطالب مرتين)
  /// — بتاعة الموبايل ده + اللي وصلت من أجهزة الشبكة
  static void _applyQueueToSnapshot() {
    final snap = snapshot.value;
    if (snap == null) return;
    for (final op in queue.value) {
      _applyOp(snap, op, by: 'الموبايل ده');
    }
    applyMeshEntries(MeshService.instance.log.ofKind('op').where((e) => e['o'] != MeshService.instance.nodeIdOrNull).toList());
  }

  static void _applyOp(Snapshot snap, Map<String, dynamic> op, {String? by}) {
    final student = snap.student('${op['body']?['student_code'] ?? ''}');
    if (student == null) return;
    final key = '${student.id}:${op['activeSessionId']}';
    if (op['kind'] == 'attendance' || op['kind'] == 'force') {
      snap.attendance.add(key);
      if (by != null) snap.attendanceBy.putIfAbsent(key, () => by);
    } else if (op['kind'] == 'homework') {
      snap.homework[key] = '${op['body']['status']}';
      if (by != null) snap.homeworkBy[key] = by;
    }
  }

  /// الفلوس اللي بتدخل الرصيد: المبلغ الأساسي بس — "مبلغ تاني بسبب تاني" بيتسجل من غير ما يدخل الرصيد (زي السيرفر)
  static num _paid(dynamic body) {
    if (body is! Map) return 0;
    return _num(body['payment_collected']);
  }

  static String _hhmm(dynamic ms) {
    if (ms is! num) return '';
    final t = DateTime.fromMillisecondsSinceEpoch(ms.toInt());
    return '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
  }

  /// عمليات وصلت من أجهزة تانية في الشبكة: بتتحسب في الفحص أوفلاين (حضور/واجب/الباب)
  static void applyMeshEntries(List<Map<String, dynamic>> entries) {
    final snap = snapshot.value;
    if (snap == null) return;
    var changed = false;
    for (final e in entries) {
      if (e['k'] != 'op') continue;
      final d = (e['d'] as Map).cast<String, dynamic>();
      final state = MeshService.instance.statusOf('${d['id']}')?.state;
      if (state == OpState.rejected || state == OpState.dismissed) continue;
      final op = {'kind': d['kind'], 'body': d['body'], 'activeSessionId': d['sid']};
      final student = snap.student('${(d['body'] as Map?)?['student_code'] ?? ''}');
      final key = student == null ? null : '${student.id}:${d['sid']}';
      final already = key != null && snap.attendance.contains(key);
      _applyOp(snap, op, by: '${d['user'] ?? 'جهاز تاني'} ${_hhmm(d['ct'])}'.trim());
      // الرصيد التقريبي: مرة واحدة بس، وللعمليات اللي لسه مارفعتش (اللي اترفعت السيرفر حسبها في النسخة الجاية)
      if ((d['kind'] == 'attendance') && !already && student != null && state == OpState.pending) {
        student.balance = student.balance + _paid(d['body']) - student.price;
      }
      changed = true;
    }
    if (changed) MeshService.instance.revision.value++;
  }

  /// نسخة بيانات أحدث جت من جهاز تاني في الشبكة (من غير نت)
  static Future<bool> adoptPeerSnapshot(String raw, DateTime at, String fromName) async {
    final current = snapshotAt.value;
    if (current != null && !at.isAfter(current)) return false;
    try {
      final parsed = await parseSnapshot(raw);
      if ('${parsed.raw['meshKey'] ?? ''}'.isEmpty) return false;
      await Cache.writeRaw('snapshot', raw);
      await Cache.write('snapshot_meta', {'at': at.millisecondsSinceEpoch, 'from': fromName});
      snapshot.value = parsed;
      snapshotAt.value = at;
      _applyQueueToSnapshot();
      return true;
    } catch (_) {
      return false;
    }
  }

  /// بعد ما الرافع رفع عمليات من الموبايل ده (أو اتعرف إنها مكررة) بتتشال من الطابور
  static Future<void> flushMeshUploaded() async {
    var removed = false;
    for (final op in [...queue.value]) {
      final s = MeshService.instance.statusOf('${op['id']}');
      if (s == null) continue;
      if (s.state == OpState.uploaded || s.state == OpState.rejected) {
        if (s.state == OpState.rejected) await addProblem(op, s.message);
        await _remove('${op['id']}');
        removed = true;
      } else if (s.state == OpState.duplicate || s.state == OpState.dismissed) {
        await addProblem(op, 'ماترفعتش: ${s.message}');
        await _remove('${op['id']}');
        removed = true;
      }
    }
    if (removed) MeshService.instance.revision.value++;
  }

  static Future<void> enqueue(Map<String, dynamic> op) async {
    queue.value = [...queue.value, op];
    await Cache.write('queue', queue.value);
    final snap = snapshot.value;
    if (snap != null) _applyOp(snap, op);
    if (op['kind'] == 'attendance' && snap != null) {
      // الرصيد التقريبي بعد الحضور (عشان الفحص أوفلاين بعد كده)
      final s = snap.student('${op['body']['student_code']}');
      if (s != null) s.balance = s.balance + _paid(op['body']) - s.price;
    }
    if (op['kind'] == 'payment' && snap != null) {
      // "ضيف فلوس بس": الرصيد التقريبي بيزيد بالمبلغ
      final s = snap.student('${op['body']['student_code']}');
      if (s != null) s.balance = s.balance + _paid(op['body']);
    }
  }

  static Future<void> _remove(String id) async {
    queue.value = queue.value.where((o) => o['id'] != id).toList();
    await Cache.write('queue', queue.value);
  }

  /// العملية المرفوضة بتتحفظ كاملة (مش الاسم بس) عشان تترفع تاني على حصة تانية
  static Future<void> addProblem(Map<String, dynamic> op, String message) async {
    problems.value = [
      {'id': op['id'], 'label': op['label'], 'message': message, 'at': DateTime.now().toIso8601String(), 'clientTime': op['clientTime'], 'op': op},
      ...problems.value,
    ];
    await Cache.write('problems', problems.value);
  }

  static Future<void> dismissProblem(String id) async {
    problems.value = problems.value.where((p) => p['id'] != id).toList();
    await Cache.write('problems', problems.value);
  }

  /// المشكلة لسه مفتوحة (السجل مش بيمسح عمليتها)
  static bool hasProblem(String id) => problems.value.any((p) => '${p['id']}' == id);

  /// المشاكل القديمة كان متحفظ فيها الاسم بس: بنرجّع العملية كاملة من سجل الشبكة
  static Future<void> _rescueProblemOps() async {
    final ops = {for (final e in MeshService.instance.log.ofKind('op')) '${e['d']?['id']}': (e['d'] as Map).cast<String, dynamic>()};
    var changed = false;
    final list = [
      for (final p in problems.value)
        if (p['op'] == null && ops['${p['id']}'] != null)
          () {
            changed = true;
            final d = ops['${p['id']}']!;
            return <String, dynamic>{
              ...p,
              'op': {
                'id': d['id'], 'kind': d['kind'], 'path': d['path'], 'body': d['body'], 'userId': d['userId'],
                'activeSessionId': d['sid'], 'clientTime': d['ct'], 'label': d['label'],
              },
            };
          }()
        else
          p,
    ];
    if (!changed) return;
    problems.value = list;
    await Cache.write('problems', list);
  }

  /// المشكلة دي ينفع تترفع تاني على حصة (عندنا العملية كاملة)
  static bool canResend(Map<String, dynamic> problem) {
    final op = problem['op'];
    return op is Map && op['path'] != null && op['body'] is Map && op['userId'] is num && op['activeSessionId'] != null;
  }

  /// عملية اترفضت (مثلاً حصتها اتمسحت): بنرفعها تاني على الحصة اللي الموظف اختارها، بنفس وقت المسح الأصلي.
  /// بيرجع null لو اترفعت، أو رسالة الرفض (والمشكلة بتفضل محفوظة).
  static Future<String?> resendProblem(Map<String, dynamic> problem, int sessionId) async {
    final old = (problem['op'] as Map).cast<String, dynamic>();
    final op = <String, dynamic>{
      ...old,
      'id': newOpId(), // رقم جديد: الرقم القديم السيرفر فاكره إنه اترفض
      'body': Map<String, dynamic>.from(old['body'] as Map),
      'userId': (old['userId'] as num).toInt(),
      'activeSessionId': sessionId,
      'clientTime': (old['clientTime'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch,
    };
    final oldId = '${problem['id']}';
    String? failure;
    try {
      final result = await _send(op);
      Connection.report(true);
      await MeshService.instance.recordOwn(op);
      MeshService.instance.receipt('${op['id']}', ok: result.ok, message: result.message, duplicate: result.duplicate);
      if (result.ok) {
        final snap = snapshot.value;
        if (snap != null) _applyOp(snap, op, by: 'الموبايل ده');
        await dismissProblem(oldId);
        return null;
      }
      failure = result.message;
    } on DeviceNotAuthorized {
      deviceRevoked.value = true;
      return 'الموبايل ده اتلغى تسجيله من السيستم';
    } on ApiException catch (e) {
      if (e.offline) {
        Connection.report(false);
        return 'مفيش نت — جرب تاني لما النت يرجع (العملية لسه محفوظة)';
      }
      failure = e.message;
    }
    // اترفضت تاني: نحفظها بالحصة الجديدة مكان القديمة (البيانات متضيعش)
    problems.value = [
      for (final p in problems.value)
        if ('${p['id']}' == oldId)
          {...p, 'id': op['id'], 'op': op, 'message': failure, 'at': DateTime.now().toIso8601String()}
        else
          p,
    ];
    await Cache.write('problems', problems.value);
    return failure;
  }

  /// بيبعت عملية على طول (لو فيه نت)، ولو النت فاصل بيحطها في الطابور.
  /// بيرجع النتيجة لو اتبعتت، أو null لو اتحفظت للإرسال بعدين.
  static Future<OpResult?> submit(Map<String, dynamic> op) async {
    // كل عملية بتتسجل في سجل الشبكة (متوقعة بمفتاح الجهاز) عشان الأجهزة التانية تعرف بيها حتى من غير نت
    await MeshService.instance.recordOwn(op);
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
      if (result.ok && snap != null) _applyOp(snap, op, by: 'الموبايل ده');
      MeshService.instance.receipt('${op['id']}', ok: result.ok, message: result.message, duplicate: result.duplicate);
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
        // تصفية المكرر قبل الرفع (هنا على الموبايل، مش على السيرفر)
        final mesh = MeshService.instance.statusOf('${op['id']}');
        if (mesh != null && mesh.state != OpState.pending) {
          if (mesh.state == OpState.review) continue; // مستنية قرار الأدمن
          if (mesh.state == OpState.uploaded) {
            await _remove('${op['id']}');
          } else {
            await addProblem(op, mesh.state == OpState.rejected ? mesh.message : 'ماترفعتش: ${mesh.message}');
            await _remove('${op['id']}');
          }
          continue;
        }
        try {
          final result = await _send(op);
          Connection.report(true);
          MeshService.instance.receipt('${op['id']}', ok: result.ok, message: result.message, duplicate: result.duplicate);
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
