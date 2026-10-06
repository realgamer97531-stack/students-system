import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../services/net.dart';
import '../../services/session_store.dart';
import '../../services/staff_api.dart';
import '../../services/staff_store.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import 'scanner_box.dart';

/// اللي محتاجه كل تاب مسح: الموظف + الحصة المختارة
class StaffScanContext {
  StaffScanContext({required this.user, required this.activeSession});
  final StaffUser user;
  final ValueNotifier<int?> activeSession;
}

class ScanResult {
  ScanResult(this.text, this.kind);
  final String text;

  /// ok | warn | error | queued
  final String kind;
}

void _alarm() {
  HapticFeedback.heavyImpact();
  Future<void>.delayed(const Duration(milliseconds: 250), HapticFeedback.heavyImpact);
  SystemSound.play(SystemSoundType.alert);
}

class ResultBanner extends StatelessWidget {
  const ResultBanner({super.key, required this.result});
  final ScanResult result;
  @override
  Widget build(BuildContext context) {
    final (bg, fg, icon) = switch (result.kind) {
      'ok' => (AppColors.successSoft, AppColors.successText, Icons.check_circle),
      'queued' => (const Color(0xFFE0F2FE), const Color(0xFF0369A1), Icons.cloud_upload_outlined),
      'warn' => (AppColors.warningSoft, AppColors.warningText, Icons.warning_amber_rounded),
      _ => (AppColors.dangerSoft, AppColors.dangerText, Icons.error_outline),
    };
    return Container(
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(14)),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(icon, color: fg),
        const SizedBox(width: 10),
        Expanded(child: Text(result.text, style: TextStyle(color: fg, fontWeight: FontWeight.w700, fontSize: 15, height: 1.5))),
      ]),
    );
  }
}

/// أساس مشترك لتابات المسح
abstract class _ScanTabState<T extends StatefulWidget> extends State<T> {
  StaffScanContext get ctx;
  bool busy = false;

  /// مستني رد السيرفر (الشريط بيظهر بس وقتها، مش وقت ما الموظف بيراجع بيانات الطالب)
  bool loading = false;
  ScanResult? result;

  void idle() {
    if (mounted) setState(() => loading = false);
  }

  int? get sessionId => ctx.activeSession.value;

  void show(String text, String kind) {
    if (!mounted) return;
    setState(() => result = ScanResult(text, kind));
    if (kind == 'error' || kind == 'warn') HapticFeedback.mediumImpact();
  }

  Future<void> handle(String code);

  Future<void> onCode(String code) async {
    if (busy) return;
    if (sessionId == null) {
      show('⚠️ اختار الحصة الشغالة الأول من فوق', 'warn');
      return;
    }
    setState(() { busy = true; loading = true; result = null; });
    try {
      await handle(code);
    } on DeviceNotAuthorized catch (e) {
      StaffStore.deviceRevoked.value = true;
      show('$e', 'error');
    } on ApiException catch (e) {
      show(e.message, 'error');
    } finally {
      if (mounted) setState(() { busy = false; loading = false; });
    }
  }

  Widget scanBody(List<Widget> extra) => ListView(padding: const EdgeInsets.fromLTRB(16, 12, 16, 40), children: [
        ScannerBox(onCode: onCode, enabled: !busy),
        if (loading) const Padding(padding: EdgeInsets.only(top: 12), child: LinearProgressIndicator()),
        if (result != null) ResultBanner(result: result!),
        ...extra,
      ]);

  Map<String, dynamic> newOp(String kind, String path, Map<String, dynamic> body, String label) => {
        'id': StaffStore.newOpId(),
        'kind': kind,
        'path': path,
        'body': body,
        'userId': ctx.user.id,
        'activeSessionId': sessionId,
        'clientTime': DateTime.now().millisecondsSinceEpoch,
        'label': label,
      };
}

// ======================= الحضور =======================

class AttendanceTab extends StatefulWidget {
  const AttendanceTab({super.key, required this.ctx});
  final StaffScanContext ctx;
  @override
  State<AttendanceTab> createState() => _AttendanceTabState();
}

class _AttendanceTabState extends _ScanTabState<AttendanceTab> {
  @override
  StaffScanContext get ctx => widget.ctx;
  String? _forceCode;

  @override
  Future<void> handle(String code) async {
    _forceCode = null;
    Map<String, dynamic>? online;
    try {
      final r = await StaffApi.call('/attendance/scan/lookup', {'student_code': code}, userId: ctx.user.id, activeSessionId: sessionId);
      Connection.report(true);
      if (!r.ok) {
        if (r.data['subjectMismatch'] == true) _alarm();
        show(r.message, r.data['subjectMismatch'] == true ? 'error' : 'warn');
        return;
      }
      online = r.data;
    } on ApiException catch (e) {
      if (!e.offline) rethrow;
      Connection.report(false);
    }

    final snap = StaffStore.snapshot.value;
    Map<String, dynamic> info;
    if (online != null) {
      info = online;
    } else {
      // من غير نت: الفحص من آخر بيانات اتحفظت
      if (snap == null) {
        show('📴 مفيش نت ومفيش بيانات محفوظة لسه — افتح التاب مرة وفيه نت الأول', 'error');
        return;
      }
      final s = snap.student(code);
      if (s == null) return show('كود الطالب غير صحيح (حسب آخر بيانات اتحفظت)', 'warn');
      final session = snap.session(sessionId);
      if (session == null) return show('⚠️ الحصة المختارة مش موجودة في البيانات المحفوظة', 'warn');
      if (session['status'] == 'cancelled') return show('⚠️ هذه الحصة ملغية', 'warn');
      if (s.subjectId != (session['SubjectId'] as num?)?.toInt()) {
        _alarm();
        return show('🚨 هذا الطالب تابع لمادة ${snap.subjects[s.subjectId] ?? 'مختلفة'}، والحصة الحالية لمادة مختلفة', 'error');
      }
      if (snap.attendance.contains('${s.id}:$sessionId')) return show('${s.name} مسجل حضوره من قبل', 'warn');
      info = {
        'offline': true,
        'student': {
          'id': s.id,
          'name': s.name,
          'code': s.code,
          'balance': s.balance,
          'pricePerSession': s.price,
          'adminNote': s.note,
          'centerId': s.centerId,
          'centerName': snap.centers[s.centerId] ?? 'غير محدد',
          'blocked': s.blocked,
        },
        'activeSession': {'centerId': session['CenterId'], 'centerName': snap.centers[(session['CenterId'] as num?)?.toInt()] ?? 'غير محدد'},
      };
    }
    if (!mounted) return;
    idle();
    final form = await showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _AttendanceSheet(info: info, isAdmin: ctx.user.isAdmin, ctx: ctx),
    );
    if (form == null) return;
    setState(() => loading = true);
    final st = (info['student'] as Map).cast<String, dynamic>();
    final op = newOp('attendance', '/attendance/scan', {'student_code': code, ...form}, 'حضور: ${st['name']} (${st['code']})');
    final res = await StaffStore.submit(op);
    if (res == null) {
      show('📴 مفيش نت — حضور ${st['name']} اتحفظ على الموبايل وهيتبعت لوحده أول ما النت يرجع', 'queued');
    } else if (res.ok) {
      show('✅ ${res.message}\nالطالب: ${res.data['student_name'] ?? st['name']}\nالرصيد المتبقي: ${res.data['remaining_balance'] ?? '-'} ج', 'ok');
    } else {
      if (res.data['subjectMismatch'] == true) _alarm();
      if (res.message.contains('غير كاف')) _forceCode = code;
      show(res.message, 'warn');
    }
  }

  Future<void> _force() async {
    final code = _forceCode;
    if (code == null) return;
    final password = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('تسجيل حضور بالقوة'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('الرصيد هيبقى بالسالب. محتاج باسورد الأدمن.'),
          const SizedBox(height: 10),
          TextField(controller: password, obscureText: true, decoration: const InputDecoration(labelText: 'الباسورد')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('إلغاء')),
          FilledButton(style: FilledButton.styleFrom(minimumSize: const Size(90, 42)), onPressed: () => Navigator.pop(c, true), child: const Text('تسجيل')),
        ],
      ),
    );
    if (ok != true) return;
    setState(() { busy = true; loading = true; });
    try {
      final op = newOp('force', '/attendance/scan/force', {'student_code': code, 'password': password.text}, 'حضور بالقوة: $code');
      final res = await StaffApi.call('/attendance/scan/force', op['body'] as Map<String, dynamic>, userId: ctx.user.id, activeSessionId: sessionId, opId: '${op['id']}');
      _forceCode = res.ok ? null : _forceCode;
      show(res.message, res.ok ? 'ok' : 'error');
    } on ApiException catch (e) {
      show(e.offline ? 'التسجيل بالقوة محتاج نت' : e.message, 'error');
    } finally {
      if (mounted) setState(() { busy = false; loading = false; });
    }
  }

  @override
  Widget build(BuildContext context) => scanBody([
        if (_forceCode != null && !busy)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: OutlinedButton.icon(onPressed: _force, icon: const Icon(Icons.gpp_maybe_outlined), label: const Text('تسجيل حضور بالقوة (رصيد بالسالب)')),
          ),
      ]);
}

class _AttendanceSheet extends StatefulWidget {
  const _AttendanceSheet({required this.info, required this.isAdmin, required this.ctx});
  final Map<String, dynamic> info;
  final bool isAdmin;
  final StaffScanContext ctx;
  @override
  State<_AttendanceSheet> createState() => _AttendanceSheetState();
}

class _AttendanceSheetState extends State<_AttendanceSheet> {
  final _comment = TextEditingController();
  final _payment = TextEditingController();
  final Map<String, TextEditingController> _booklets = {};
  final Set<String> _delivered = {};
  bool _bookletDelivered = false;

  Map<String, dynamic> get s => (widget.info['student'] as Map).cast<String, dynamic>();
  bool get _offline => widget.info['offline'] == true;

  @override
  void dispose() {
    _comment.dispose();
    _payment.dispose();
    for (final c in _booklets.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _deliver(Map<String, dynamic> b) async {
    final id = '${b['studentBookletId']}';
    try {
      final res = await StaffApi.call('/attendance/scan/booklet-deliver', {'studentId': s['id'], 'studentBookletId': b['studentBookletId']},
          userId: widget.ctx.user.id, activeSessionId: widget.ctx.activeSession.value, opId: StaffStore.newOpId());
      if (!mounted) return;
      if (res.ok) {
        setState(() => _delivered.add(id));
      } else {
        toast(context, res.message, error: true);
      }
    } on ApiException catch (e) {
      if (mounted) toast(context, e.message, error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final active = (widget.info['activeSession'] as Map?)?.cast<String, dynamic>() ?? {};
    final centerMismatch = '${s['centerId']}' != '${active['centerId']}';
    final balance = (s['balance'] as num?) ?? num.tryParse('${s['balance']}') ?? 0;
    final price = (s['pricePerSession'] as num?) ?? num.tryParse('${s['pricePerSession']}') ?? 0;
    final summary = ((widget.info['summary'] as List?) ?? []).cast<Map>();
    final exams = ((widget.info['independentExamResults'] as List?) ?? []).cast<Map>();
    final booklets = ((widget.info['bookletStatuses'] as List?) ?? widget.info['pendingBooklets'] as List? ?? []).cast<Map>();
    final assistant = (widget.info['followUpAssistant'] as Map?)?.cast<String, dynamic>();

    Widget note(String text, Color bg, Color fg) => Container(
          margin: const EdgeInsets.only(top: 8),
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(10)),
          child: Text(text, style: TextStyle(color: fg, fontWeight: FontWeight.w600)),
        );

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.88),
          child: ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(16, 0, 16, 16), children: [
            Text('${s['name']}', style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w800)),
            Text('${s['code']} • الرصيد: ${fmtNum(balance)} ج${price > 0 ? ' • الحصة: ${fmtNum(price)} ج' : ''}',
                style: const TextStyle(color: AppColors.muted)),
            if (_offline) note('📴 مفيش نت — البيانات دي من آخر تحديث، والحضور هيتسجل لما النت يرجع', const Color(0xFFE0F2FE), const Color(0xFF0369A1)),
            if (s['blocked'] == true) note('⛔ الطالب ده محظور — السيرفر هيرفض الحضور', AppColors.dangerSoft, AppColors.dangerText),
            if (_offline && balance < price) note('⚠️ الرصيد حسب آخر تحديث مش كفاية للحصة — ممكن السيرفر يرفض لو مدفعش', AppColors.warningSoft, AppColors.warningText),
            if ('${s['adminNote'] ?? ''}'.isNotEmpty) note('📌 ملاحظة: ${s['adminNote']}', AppColors.warningSoft, AppColors.warningText),
            if (assistant != null) note('🎯 أسيستانت المتابعة: ${assistant['name']}', AppColors.primary.withValues(alpha: 0.08), AppColors.primary),
            note(
              centerMismatch
                  ? '🚨 السنتر المرتبط بالطالب: ${s['centerName']} — لا يطابق الحصة الحالية ${active['centerName'] ?? ''}'
                  : '✅ السنتر المرتبط بالطالب: ${s['centerName']} — مطابق للحصة الحالية',
              centerMismatch ? AppColors.dangerSoft : AppColors.successSoft,
              centerMismatch ? AppColors.dangerText : AppColors.successText,
            ),
            if (summary.isNotEmpty) ...[
              const SizedBox(height: 12),
              const Text('الحصص', style: TextStyle(fontWeight: FontWeight.w800)),
              const SizedBox(height: 4),
              Wrap(spacing: 6, runSpacing: 6, children: [
                for (final row in summary)
                  Tooltip(
                    message: ((row['parts'] as List?) ?? [])
                        .map((p) => '${p['category']}: ${((p['watchedSeconds'] ?? 0) as num) ~/ 60}/${((p['durationSeconds'] ?? 0) as num) ~/ 60} د')
                        .join('\n'),
                    child: Pill(
                      '${row['lessonNumber']}: ${row['attended'] == true ? 'حضر (${row['attendedWhere']})' : 'غاب'}',
                      row['attended'] == true ? AppColors.successSoft : AppColors.dangerSoft,
                      row['attended'] == true ? AppColors.successText : AppColors.dangerText,
                      fontSize: 11.5,
                    ),
                  ),
              ]),
            ],
            if (exams.isNotEmpty) ...[
              const SizedBox(height: 12),
              const Text('📊 درجات الامتحانات غير المرتبطة بحصة', style: TextStyle(fontWeight: FontWeight.w800)),
              for (final e in exams)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Row(children: [Expanded(child: Text('${e['name']}')), Text('${e['score']} / ${e['maxScore']}', style: const TextStyle(fontWeight: FontWeight.w700))]),
                ),
            ],
            if (booklets.isNotEmpty) ...[
              const SizedBox(height: 12),
              const Text('📚 البوكليتس', style: TextStyle(fontWeight: FontWeight.w800)),
              for (final b in booklets) _booklet(b.cast<String, dynamic>()),
            ],
            if (_offline == false && widget.isAdmin && s['bookletStatus'] != true)
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                value: _bookletDelivered,
                onChanged: (v) => setState(() => _bookletDelivered = v ?? false),
                title: const Text('استلم البوكليت', style: TextStyle(fontWeight: FontWeight.w700)),
                subtitle: const Text('هيتحفظ مع تأكيد الحضور'),
              ),
            const SizedBox(height: 12),
            TextField(controller: _payment, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'المبلغ المدفوع الآن (اختياري)', isDense: true)),
            const SizedBox(height: 10),
            TextField(controller: _comment, decoration: const InputDecoration(labelText: 'تعليق (اختياري)', isDense: true)),
            const SizedBox(height: 14),
            Row(children: [
              Expanded(child: OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('إلغاء'))),
              const SizedBox(width: 10),
              Expanded(
                flex: 2,
                child: FilledButton(
                  onPressed: () {
                    final payments = <Map<String, dynamic>>[];
                    _booklets.forEach((id, c) {
                      final amount = num.tryParse(c.text.trim()) ?? 0;
                      if (amount > 0) payments.add({'booklet_id': id, 'amount': amount});
                    });
                    Navigator.pop(context, {
                      'comment': _comment.text.trim(),
                      'payment_collected': _payment.text.trim(),
                      'booklet_payments': payments,
                      'booklet_delivered': _bookletDelivered,
                    });
                  },
                  child: const Text('✅ تأكيد الحضور'),
                ),
              ),
            ]),
          ]),
        ),
      ),
    );
  }

  Widget _booklet(Map<String, dynamic> b) {
    final remaining = (b['remaining'] as num?) ?? 0;
    final delivered = b['isDelivered'] == true || _delivered.contains('${b['studentBookletId']}');
    final complete = delivered || remaining <= 0;
    final controller = _booklets.putIfAbsent('${b['id']}', TextEditingController.new);
    return Container(
      margin: const EdgeInsets.only(top: 6),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(border: Border.all(color: const Color(0xFFE2E4F3)), borderRadius: BorderRadius.circular(10)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Expanded(child: Text('${b['name']}', style: const TextStyle(fontWeight: FontWeight.w700))),
          if (b['reservationStatus'] != null) Padding(padding: const EdgeInsetsDirectional.only(end: 4), child: Pill('حجز: ${b['reservationStatus']}', AppColors.neutralSoft, AppColors.muted, fontSize: 11)),
          Pill(
            delivered ? '✓ استلم' : (remaining <= 0 ? '✓ مدفوع بالكامل' : 'متبقي: ${fmtNum(remaining)} ج'),
            complete ? AppColors.successSoft : AppColors.warningSoft,
            complete ? AppColors.successText : AppColors.warningText,
            fontSize: 11,
          ),
        ]),
        if (b['studentBookletId'] != null && !delivered && widget.isAdmin)
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: TextButton.icon(onPressed: () => _deliver(b), icon: const Icon(Icons.check, size: 18), label: const Text('تسليم البوكليت')),
          ),
        if (!complete)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: TextField(
              controller: controller,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(hintText: 'المبلغ المدفوع الآن', isDense: true),
            ),
          ),
      ]),
    );
  }
}

// ======================= الواجب =======================

class HomeworkScanTab extends StatefulWidget {
  const HomeworkScanTab({super.key, required this.ctx});
  final StaffScanContext ctx;
  @override
  State<HomeworkScanTab> createState() => _HomeworkScanTabState();
}

class _HomeworkScanTabState extends _ScanTabState<HomeworkScanTab> {
  @override
  StaffScanContext get ctx => widget.ctx;

  static const _statuses = [
    ('complete', 'كامل', AppColors.successText),
    ('incomplete', 'مش كامل', AppColors.warning),
    ('no_steps', 'من غير خطوات', AppColors.muted),
    ('not_done', 'مش معمول', AppColors.danger),
  ];

  @override
  Future<void> handle(String code) async {
    String? name;
    String? note;
    List<Map> summary = [];
    var offline = false;
    try {
      final r = await StaffApi.call('/homework/scan/summary', {'student_code': code}, userId: ctx.user.id, activeSessionId: sessionId);
      Connection.report(true);
      if (!r.ok) return show(r.message, 'warn');
      name = '${r.data['studentName']}';
      note = r.data['adminNote'] as String?;
      summary = ((r.data['summary'] as List?) ?? []).cast<Map>();
    } on ApiException catch (e) {
      if (!e.offline) rethrow;
      Connection.report(false);
      offline = true;
      final s = StaffStore.snapshot.value?.student(code);
      if (s == null) return show('كود الطالب غير صحيح (حسب آخر بيانات اتحفظت)', 'warn');
      name = s.name;
      note = s.note;
    }
    final snap = StaffStore.snapshot.value;
    final s = snap?.student(code);
    final current = s == null ? null : snap!.homework['${s.id}:$sessionId'];
    if (!mounted) return;
    idle();
    final status = await showModalBottomSheet<String>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (c) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(c).size.height * 0.85),
          child: ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(16, 0, 16, 16), children: [
            Text(name!, style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w800)),
            Text(code, textDirection: TextDirection.ltr, textAlign: TextAlign.right, style: const TextStyle(color: AppColors.muted)),
            if (offline)
              const Padding(padding: EdgeInsets.only(top: 6), child: Text('📴 مفيش نت — هيتسجل لما النت يرجع', style: TextStyle(color: Color(0xFF0369A1), fontWeight: FontWeight.w600))),
            if ((note ?? '').isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text('📌 ملاحظة: $note', style: const TextStyle(color: AppColors.warningText))),
            if (current != null)
              Padding(padding: const EdgeInsets.only(top: 6), child: Text('الحالة المسجلة في الحصة دي: ${_statuses.firstWhere((x) => x.$1 == current, orElse: () => (current, current, AppColors.muted)).$2}')),
            if (summary.isNotEmpty) ...[
              const SizedBox(height: 10),
              Wrap(spacing: 6, runSpacing: 6, children: [
                for (final r in summary) Pill('${r['lessonNumber']} (${r['centerName']}): ${r['homeworkStatus']}', AppColors.neutralSoft, AppColors.text, fontSize: 11.5),
              ]),
            ],
            const SizedBox(height: 14),
            GridView.count(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              crossAxisCount: 2,
              childAspectRatio: 2.6,
              mainAxisSpacing: 10,
              crossAxisSpacing: 10,
              children: [
                for (final st in _statuses)
                  FilledButton(
                    style: FilledButton.styleFrom(backgroundColor: st.$3, minimumSize: Size.zero),
                    onPressed: () => Navigator.pop(c, st.$1),
                    child: Text(st.$2),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            OutlinedButton(onPressed: () => Navigator.pop(c), child: const Text('إلغاء')),
          ]),
        ),
      ),
    );
    if (status == null) return;
    setState(() => loading = true);
    final label = _statuses.firstWhere((x) => x.$1 == status).$2;
    final op = newOp('homework', '/homework/scan/save', {'student_code': code, 'status': status}, 'واجب: $name ($code) — $label');
    final res = await StaffStore.submit(op);
    if (res == null) {
      show('📴 مفيش نت — واجب $name ($label) اتحفظ وهيتبعت لوحده أول ما النت يرجع', 'queued');
    } else {
      show(res.ok ? '✅ ${res.message} - ${res.data['student_name'] ?? name} ($label)' : '⚠️ ${res.message}', res.ok ? 'ok' : 'warn');
    }
  }

  @override
  Widget build(BuildContext context) => scanBody(const []);
}

// ======================= الباب =======================

class DoorTab extends StatefulWidget {
  const DoorTab({super.key, required this.ctx});
  final StaffScanContext ctx;
  @override
  State<DoorTab> createState() => _DoorTabState();
}

class _DoorTabState extends _ScanTabState<DoorTab> {
  @override
  StaffScanContext get ctx => widget.ctx;

  @override
  Future<void> handle(String code) async {
    try {
      final r = await StaffApi.call('/door/scan', {'student_code': code}, userId: ctx.user.id, activeSessionId: sessionId);
      Connection.report(true);
      if (!r.ok) _alarm();
      show(r.message, r.ok ? 'ok' : 'error');
    } on ApiException catch (e) {
      if (!e.offline) rethrow;
      Connection.report(false);
      _offlineCheck(code);
    }
  }

  /// نفس منطق /door/scan بالظبط بس من البيانات المحفوظة + العمليات اللي مستنية
  void _offlineCheck(String code) {
    final snap = StaffStore.snapshot.value;
    if (snap == null) return show('📴 مفيش نت ومفيش بيانات محفوظة', 'error');
    final s = snap.student(code);
    if (s == null) return show('كود الطالب غير صحيح (حسب آخر بيانات اتحفظت)', 'error');
    final current = snap.session(sessionId);
    var attended = snap.attendance.contains('${s.id}:$sessionId');
    if (!attended && current != null) {
      attended = snap.sessions.any((x) =>
          x['lesson_number'] == current['lesson_number'] &&
          x['SubjectId'] == current['SubjectId'] &&
          x['CenterId'] != current['CenterId'] &&
          snap.attendance.contains('${s.id}:${x['id']}'));
    }
    final lesson = (current?['lesson_number'] as num?)?.toInt() ?? 0;
    Map<String, dynamic>? previous;
    if (current != null && lesson > 1) {
      final candidates = snap.sessions
          .where((x) => (x['lesson_number'] as num?)?.toInt() == lesson - 1 && x['CenterId'] == current['CenterId'] && x['SubjectId'] == current['SubjectId'])
          .toList()
        ..sort((a, b) => ((b['id'] as num).toInt()).compareTo((a['id'] as num).toInt()));
      previous = candidates.firstOrNull;
    }
    final homework = previous != null && snap.homework.containsKey('${s.id}:${previous['id']}');
    if (attended && homework) return show('✅ ${s.name} - تمام، الحضور والواجب مسجلين\n(أوفلاين — من آخر بيانات اتحفظت)', 'ok');
    final missing = [if (!attended) 'الحضور', if (!homework) 'الواجب'];
    _alarm();
    show('⚠️ ${s.name} - ناقص: ${missing.join(' و ')}\n(أوفلاين — من آخر بيانات اتحفظت)', 'error');
  }

  @override
  Widget build(BuildContext context) => scanBody(const []);
}
