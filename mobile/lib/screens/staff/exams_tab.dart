import 'package:flutter/material.dart';

import '../../services/cache.dart';
import '../../services/net.dart';
import '../../services/session_store.dart';
import '../../services/staff_api.dart';
import '../../services/staff_store.dart';
import '../../theme.dart';
import '../../widgets/common.dart';

/// رصد درجات الامتحانات من الموبايل — بيشتغل من غير نت.
/// القايمة من /api/staff/exams ومتحفظة على الموبايل، والأسماء والسناتر من نسخة المسح.
/// الحفظ بيبعت الدرجات اللي اتغيرت بس لنفس صفحة الموقع (/exams/:id/scores)؛ لو مفيش نت بتستنى في الطابور وتتبعت لوحدها.
/// إرسال المعروضين للاتصال محتاج نت.
const _cacheKey = 'staff_exams';

/// الدرجات اللي لسه مستنية في الطابور لامتحان معين (studentId → درجة)
Map<int, num> pendingExamScores(int examId) {
  final out = <int, num>{};
  for (final op in StaffStore.queue.value) {
    if (op['kind'] != 'exam_scores' || asInt(op['examId']) != examId) continue;
    (op['body'] as Map).forEach((key, value) {
      final id = int.tryParse('$key'.replaceFirst('score_', ''));
      final score = value is num ? value : num.tryParse('$value');
      if (id != null && score != null) out[id] = score;
    });
  }
  return out;
}

/// أرقام عربي → إنجليزي، والفاصلة العربي → نقطة
num? parseScore(String input) {
  const ar = '٠١٢٣٤٥٦٧٨٩', fa = '۰۱۲۳۴۵۶۷۸۹';
  final text = input.trim().split('').map((c) {
    final a = ar.indexOf(c), f = fa.indexOf(c);
    return a >= 0 ? '$a' : (f >= 0 ? '$f' : (c == '٫' || c == ',' ? '.' : c));
  }).join();
  if (text.isEmpty) return null;
  return num.tryParse(text);
}

/// طلاب الامتحان: مرتبط بحصة → اللي حضروها، مستقل → كل طلاب المادة (من نسخة المسح)
List<int> examStudentIds(Map<String, dynamic> exam, Snapshot? snap) {
  final ids = exam['studentIds'];
  if (ids is List) return ids.map(asInt).whereType<int>().toList();
  if (snap == null) return [];
  final subjectId = asInt(exam['subjectId']);
  return snap.students.where((s) => s.subjectId == subjectId).map((s) => s.id).toList();
}

Map<int, num> savedExamScores(Map<String, dynamic> exam) => {
      for (final row in (exam['scores'] as List? ?? []))
        if (asInt((row as List)[0]) != null && row[1] != null) asInt(row[0])!: (row[1] is num ? row[1] as num : num.tryParse('${row[1]}') ?? 0),
    };

/// نسخة الامتحانات المشتركة بين القايمة وصفحة الرصد: من السيرفر، ولو مفيش نت من آخر نسخة متحفظة
class ExamsData {
  static final data = ValueNotifier<Map<String, dynamic>?>(null);
  static DateTime? savedAt;
  static bool fromCache = false;
  static int _pendingOps = 0;
  static StaffUser? _user;

  static List<Map<String, dynamic>> get exams => ((data.value?['exams'] as List?) ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();
  static Map<String, dynamic>? exam(int id) => exams.where((e) => asInt(e['id']) == id).firstOrNull;
  static bool get callCenter => data.value?['callCenter'] == true;

  /// بيرجع رسالة خطأ لو فيه مشكلة (null = تمام أو مفيش نت وبنعرض النسخة المتحفظة)
  static Future<String?> load(StaffUser user) async {
    if (_user == null) {
      _pendingOps = _countPending();
      StaffStore.queue.addListener(_onQueue);
    } else if (_user!.id != user.id) {
      data.value = null; // موظف تاني دخل على نفس الموبايل
    }
    _user = user;
    String? error;
    try {
      final fresh = await StaffApi.getJson('/api/staff/exams', userId: user.id);
      Connection.report(true);
      await Cache.write(_cacheKey, fresh);
      savedAt = DateTime.now();
      fromCache = false;
      data.value = fresh;
      return null;
    } on DeviceNotAuthorized catch (e) {
      StaffStore.deviceRevoked.value = true;
      error = '$e';
    } on ApiException catch (e) {
      if (e.offline) Connection.report(false);
      error = e.offline ? null : e.message;
    }
    if (data.value == null) {
      final cached = await Cache.read(_cacheKey);
      if (cached != null) {
        savedAt = cached.savedAt;
        fromCache = true;
        data.value = (cached.data as Map).cast<String, dynamic>();
      } else {
        error ??= 'مفيش نت ومفيش امتحانات متحفظة على الموبايل لسه — افتح التاب ده مرة والنت شغال';
      }
    } else {
      fromCache = true;
      data.value = Map<String, dynamic>.from(data.value!);
    }
    return error;
  }

  /// لما درجات كانت مستنية في الطابور تتبعت، نجيب النسخة الجديدة من السيرفر
  static void _onQueue() {
    final now = _countPending();
    final dropped = now < _pendingOps;
    _pendingOps = now;
    if (dropped && _user != null) load(_user!);
  }

  static int _countPending() => StaffStore.queue.value.where((op) => op['kind'] == 'exam_scores').length;

  /// بعد حفظ ناجح أونلاين: نحدّث النسخة اللي على الموبايل على طول
  static Future<void> mergeSaved(int examId, Map<int, num> saved) async {
    final current = data.value;
    if (current == null) return;
    for (final e in (current['exams'] as List)) {
      final exam = e as Map;
      if (asInt(exam['id']) != examId) continue;
      final scores = <int, dynamic>{for (final row in (exam['scores'] as List? ?? [])) asInt((row as List)[0])!: row[1]};
      scores.addAll(saved);
      exam['scores'] = [for (final entry in scores.entries) [entry.key, entry.value]];
    }
    await Cache.write(_cacheKey, current);
    data.value = Map<String, dynamic>.from(current);
  }
}

class ExamsTab extends StatefulWidget {
  const ExamsTab({super.key, required this.user});
  final StaffUser user;

  @override
  State<ExamsTab> createState() => _ExamsTabState();
}

class _ExamsTabState extends State<ExamsTab> {
  String? _error;
  String _q = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    final error = await ExamsData.load(widget.user);
    if (mounted) setState(() => _error = error);
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: Listenable.merge([ExamsData.data, StaffStore.snapshot, StaffStore.queue]),
      builder: (context, _) {
        if (ExamsData.data.value == null) {
          return _error != null ? ErrorView(message: _error!, onRetry: _load) : const Center(child: CircularProgressIndicator());
        }
        final q = _q.trim().toLowerCase();
        final exams = ExamsData.exams.where((e) => q.isEmpty || '${e['name']} ${e['subject']} ${e['session']?['label'] ?? ''}'.toLowerCase().contains(q)).toList();
        return Column(children: [
          if (ExamsData.fromCache) OfflineBanner(savedAt: ExamsData.savedAt),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
            child: TextField(
              decoration: const InputDecoration(hintText: 'دور باسم الامتحان أو المادة أو السنتر', prefixIcon: Icon(Icons.search), isDense: true),
              onChanged: (v) => setState(() => _q = v),
            ),
          ),
          if (_error != null)
            Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Text(_error!, style: const TextStyle(color: AppColors.dangerText, fontSize: 12.5))),
          Expanded(
            child: RefreshIndicator(
              onRefresh: _load,
              child: exams.isEmpty
                  ? const EmptyView('مفيش امتحانات', icon: Icons.assignment_outlined)
                  : ListView.builder(
                      padding: const EdgeInsets.fromLTRB(16, 6, 16, 24),
                      itemCount: exams.length,
                      itemBuilder: (context, i) => _ExamCard(
                        exam: exams[i],
                        onTap: () => Navigator.of(context).push(MaterialPageRoute(
                          builder: (_) => ExamScoresScreen(examId: asInt(exams[i]['id'])!, user: widget.user),
                        )),
                      ),
                    ),
            ),
          ),
        ]);
      },
    );
  }
}

class _ExamCard extends StatelessWidget {
  const _ExamCard({required this.exam, required this.onTap});
  final Map<String, dynamic> exam;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final snap = StaffStore.snapshot.value;
    final session = (exam['session'] as Map?)?.cast<String, dynamic>();
    final subjectId = asInt(exam['subjectId']);
    final subjectColor = snap?.subjectColors[subjectId] ?? autoEntityColor('subject', subjectId);
    final centerId = asInt(session?['centerId']);
    final centerColor = snap?.centerColors[centerId] ?? autoEntityColor('center', centerId);
    final ids = examStudentIds(exam, snap);
    final pendingScores = pendingExamScores(asInt(exam['id'])!);
    final scores = {...savedExamScores(exam), ...pendingScores};
    final scored = ids.where(scores.containsKey).length;

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text('${exam['name']}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16))),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(color: AppColors.primary.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(10)),
                child: Text('من ${fmtNum(exam['max'])}', style: const TextStyle(color: AppColors.primary, fontWeight: FontWeight.w800)),
              ),
            ]),
            const SizedBox(height: 8),
            Wrap(spacing: 6, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
              ColorChip('${exam['subject']}', subjectColor),
              if (session != null) ...[
                ColorChip('${session['center']}', centerColor),
                Pill('حصة ${session['lesson']}', AppColors.neutralSoft, AppColors.text, fontSize: 11.5),
                Pill('سيريال ${session['serial']}', AppColors.neutralSoft, AppColors.text, fontSize: 11.5),
              ] else
                const Pill('مستقل (كل طلاب المادة)', AppColors.neutralSoft, AppColors.text, fontSize: 11.5),
              Pill(fmtDate(exam['date']), AppColors.neutralSoft, AppColors.muted, fontSize: 11.5),
            ]),
            const SizedBox(height: 10),
            ClipRRect(
              borderRadius: BorderRadius.circular(99),
              child: LinearProgressIndicator(value: ids.isEmpty ? 0 : scored / ids.length, minHeight: 6, backgroundColor: AppColors.neutralSoft),
            ),
            const SizedBox(height: 6),
            Row(children: [
              Text('اترصد $scored من ${ids.length}', style: const TextStyle(color: AppColors.muted, fontSize: 12.5)),
              const Spacer(),
              if (ids.length - scored > 0) Pill('${ids.length - scored} لسه ملهمش درجة', AppColors.warningSoft, AppColors.warningText, fontSize: 11),
              if (pendingScores.isNotEmpty) ...[
                const SizedBox(width: 6),
                Pill('📴 ${pendingScores.length} مستنية تتبعت', AppColors.dangerSoft, AppColors.dangerText, fontSize: 11),
              ],
            ]),
          ]),
        ),
      ),
    );
  }
}

enum _ScoreFilter { all, missing, scored }

/// صفحة رصد درجات امتحان واحد
class ExamScoresScreen extends StatefulWidget {
  const ExamScoresScreen({super.key, required this.examId, required this.user});
  final int examId;
  final StaffUser user;

  @override
  State<ExamScoresScreen> createState() => _ExamScoresScreenState();
}

class _ExamScoresScreenState extends State<ExamScoresScreen> {
  final Map<int, TextEditingController> _controllers = {};
  final Map<int, num> _edits = {};
  final Set<int> _invalid = {};
  _ScoreFilter _filter = _ScoreFilter.all;
  int? _center;
  String _q = '';
  bool _saving = false;
  bool _sending = false;

  int get _examId => widget.examId;
  Map<String, dynamic> get _exam => ExamsData.exam(widget.examId) ?? {'id': widget.examId, 'name': '', 'max': 100, 'scores': []};
  num get _max => _exam['max'] is num ? _exam['max'] as num : num.tryParse('${_exam['max']}') ?? 100;

  /// الدرجة المعروفة (محفوظة على السيرفر أو مستنية في الطابور)
  Map<int, num> get _known => {...savedExamScores(_exam), ...pendingExamScores(_examId)};

  @override
  void dispose() {
    for (final c in _controllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  TextEditingController _controllerFor(int id, Map<int, num> known) => _controllers.putIfAbsent(id, () {
        final value = known[id];
        return TextEditingController(text: value == null ? '' : fmtNum(value));
      });

  void _onChanged(int id, String text) {
    final known = _known[id];
    final value = parseScore(text);
    setState(() {
      _invalid.remove(id);
      if (text.trim().isEmpty) {
        _edits.remove(id); // فاضي = متغيرش (الموقع كمان مبيمسحش درجة)
        return;
      }
      if (value == null || value < 0 || value > _max) {
        _invalid.add(id);
        _edits.remove(id);
        return;
      }
      if (known != null && known == value) {
        _edits.remove(id);
      } else {
        _edits[id] = value;
      }
    });
  }

  Future<void> _save() async {
    if (_edits.isEmpty || _saving) return;
    if (_invalid.isNotEmpty) {
      toast(context, 'فيه ${_invalid.length} درجة غلط (لازم من 0 لـ ${fmtNum(_max)}) — صلحها الأول', error: true);
      return;
    }
    final edits = Map<int, num>.from(_edits);
    final op = <String, dynamic>{
      'id': StaffStore.newOpId(),
      'kind': 'exam_scores',
      'examId': _examId,
      'path': '/exams/$_examId/scores',
      'body': {for (final e in edits.entries) 'score_${e.key}': e.value},
      'userId': widget.user.id,
      'activeSessionId': null,
      'clientTime': DateTime.now().millisecondsSinceEpoch,
      'label': 'درجات ${_exam['name']}: ${edits.length} طالب',
    };
    setState(() => _saving = true);
    try {
      final res = await StaffStore.submit(op);
      if (!mounted) return;
      if (res == null) {
        setState(() => _edits.clear());
        toast(context, '📴 مفيش نت — ${edits.length} درجة اتحفظت على الموبايل وهتتبعت لوحدها أول ما النت يرجع');
      } else if (res.ok) {
        await ExamsData.mergeSaved(_examId, edits);
        if (!mounted) return;
        setState(() => _edits.clear());
        toast(context, '✅ اتحفظت ${edits.length} درجة');
      } else {
        toast(context, res.message.isEmpty ? 'السيرفر رفض الحفظ' : res.message, error: true);
      }
    } on DeviceNotAuthorized catch (e) {
      StaffStore.deviceRevoked.value = true;
      if (mounted) toast(context, '$e', error: true);
    } on ApiException catch (e) {
      if (mounted) toast(context, e.message, error: true);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _sendToCallCenter(List<SnapStudent> shown, int total) async {
    if (shown.isEmpty || _sending) return;
    final unsent = _edits.length + pendingExamScores(_examId).length;
    final ok = await confirmDialog(
      context,
      title: 'إرسال للاتصال',
      message: 'هيتبعت ${shown.length} طالب (المعروضين) من $total للاتصال.'
          '${unsent > 0 ? '\n\n⚠️ فيه $unsent درجة لسه متبعتتش للسيرفر — الاتصال هيشوف الدرجات المحفوظة على السيرفر بس.' : ''}',
      ok: 'ابعت',
    );
    if (!ok || !mounted) return;
    final label = [
      if (_filter == _ScoreFilter.missing) 'لسه ملهمش درجة',
      if (_filter == _ScoreFilter.scored) 'ليهم درجة',
      if (_center != null) StaffStore.snapshot.value?.centers[_center] ?? '',
      if (_q.trim().isNotEmpty) 'بحث: ${_q.trim()}',
    ].where((s) => s.isNotEmpty).join(' + ');
    setState(() => _sending = true);
    try {
      final res = await StaffApi.call('/exams/$_examId/send-to-callcenter', {'student_ids': shown.map((s) => s.id).toList(), 'filter_label': label},
          userId: widget.user.id);
      Connection.report(true);
      if (!mounted) return;
      if (res.ok) {
        toast(context, '✅ اتعملت جلسة اتصال رقم ${res.data['sessionId']} (${res.data['imported']} طالب)');
      } else {
        toast(context, '${res.data['error'] ?? (res.message.isEmpty ? 'تعذر الإرسال' : res.message)}', error: true);
      }
    } on DeviceNotAuthorized catch (e) {
      StaffStore.deviceRevoked.value = true;
      if (mounted) toast(context, '$e', error: true);
    } on ApiException catch (e) {
      if (e.offline) Connection.report(false);
      if (mounted) toast(context, e.offline ? 'الإرسال للاتصال محتاج نت' : e.message, error: true);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: _edits.isEmpty,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        final leave = await confirmDialog(context,
            title: 'درجات متحفظتش', message: 'فيه ${_edits.length} درجة اتكتبت ومتحفظتش. تخرج من غير حفظ؟', ok: 'اخرج', cancel: 'خليني');
        if (leave && context.mounted) {
          setState(() => _edits.clear());
          Navigator.of(context).pop();
        }
      },
      child: Scaffold(
        appBar: AppBar(title: Text('${_exam['name']}'), actions: [
          Padding(
            padding: const EdgeInsets.only(left: 12),
            child: Center(child: Pill('من ${fmtNum(_max)}', Colors.white.withValues(alpha: 0.18), Colors.white)),
          ),
        ]),
        body: ListenableBuilder(
          listenable: Listenable.merge([ExamsData.data, StaffStore.snapshot, StaffStore.queue]),
          builder: (context, _) => _body(),
        ),
      ),
    );
  }

  Widget _body() {
    final snap = StaffStore.snapshot.value;
    if (snap == null) {
      return const Center(
        child: Padding(padding: EdgeInsets.all(24), child: Text('بيانات الطلاب لسه متنزلتش على الموبايل — افتح البرنامج والنت شغال مرة', textAlign: TextAlign.center)),
      );
    }
    final known = _known;
    final pending = pendingExamScores(_examId);
    final all = examStudentIds(_exam, snap).map((id) => snap.byId[id]).whereType<SnapStudent>().toList()..sort((a, b) => a.name.compareTo(b.name));
    final centerCounts = <int, int>{};
    for (final s in all) {
      if (s.centerId != null) centerCounts[s.centerId!] = (centerCounts[s.centerId!] ?? 0) + 1;
    }
    final scoredCount = all.where((s) => known.containsKey(s.id)).length;
    final q = _q.trim().toLowerCase();
    final shown = all.where((s) {
      final has = known.containsKey(s.id);
      if (_filter == _ScoreFilter.missing && has) return false;
      if (_filter == _ScoreFilter.scored && !has) return false;
      if (_center != null && s.centerId != _center) return false;
      return q.isEmpty || s.searchText.contains(q);
    }).toList();

    return Column(children: [
      if (ExamsData.fromCache) OfflineBanner(savedAt: ExamsData.savedAt),
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
        child: TextField(
          decoration: const InputDecoration(hintText: 'دور بالاسم أو الكود أو التليفون', prefixIcon: Icon(Icons.search), isDense: true),
          onChanged: (v) => setState(() => _q = v),
        ),
      ),
      SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
        child: Row(children: [
          for (final f in _ScoreFilter.values) ...[
            ChoiceChip(
              label: Text(switch (f) {
                _ScoreFilter.all => 'الكل (${all.length})',
                _ScoreFilter.missing => 'لسه ملهمش درجة (${all.length - scoredCount})',
                _ScoreFilter.scored => 'ليهم درجة ($scoredCount)',
              }),
              selected: _filter == f,
              onSelected: (_) => setState(() => _filter = f),
            ),
            const SizedBox(width: 6),
          ],
          if (centerCounts.length > 1)
            DropdownButton<int?>(
              value: _center,
              hint: const Text('كل السناتر'),
              underline: const SizedBox.shrink(),
              items: [
                const DropdownMenuItem<int?>(value: null, child: Text('كل السناتر')),
                for (final e in centerCounts.entries) DropdownMenuItem<int?>(value: e.key, child: Text('${snap.centers[e.key] ?? '#${e.key}'} (${e.value})')),
              ],
              onChanged: (v) => setState(() => _center = v),
            ),
        ]),
      ),
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 6, 16, 2),
        child: Row(children: [
          Text('المعروض ${shown.length} من ${all.length}', style: const TextStyle(color: AppColors.muted, fontSize: 12.5)),
          if (pending.isNotEmpty) ...[
            const SizedBox(width: 8),
            Pill('📴 ${pending.length} مستنية تتبعت', AppColors.dangerSoft, AppColors.dangerText, fontSize: 11),
          ],
          const Spacer(),
          if (ExamsData.callCenter)
            TextButton.icon(
              onPressed: shown.isEmpty || _sending ? null : () => _sendToCallCenter(shown, all.length),
              icon: _sending
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.phone_forwarded_outlined, size: 18),
              label: Text('للاتصال (${shown.length})'),
            ),
        ]),
      ),
      Expanded(
        child: shown.isEmpty
            ? const EmptyView('مفيش طلاب بالفلتر ده', icon: Icons.person_search_outlined)
            : ListView.builder(
                padding: const EdgeInsets.fromLTRB(12, 4, 12, 16),
                itemCount: shown.length,
                itemBuilder: (context, i) {
                  final s = shown[i];
                  final edited = _edits.containsKey(s.id);
                  final invalid = _invalid.contains(s.id);
                  final isPending = pending.containsKey(s.id);
                  return Card(
                    key: ValueKey('exam-student-${s.id}'),
                    margin: const EdgeInsets.only(bottom: 6),
                    color: invalid ? AppColors.dangerSoft : (edited ? AppColors.warningSoft : null),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      child: Row(children: [
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text(s.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                            const SizedBox(height: 3),
                            Wrap(spacing: 6, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
                              Text(s.code, style: const TextStyle(color: AppColors.muted, fontSize: 12)),
                              if (s.centerId != null)
                                ColorChip(snap.centers[s.centerId] ?? '', snap.centerColors[s.centerId] ?? autoEntityColor('center', s.centerId), fontSize: 11),
                              if (isPending && !edited) const Pill('📴 مستنية', AppColors.dangerSoft, AppColors.dangerText, fontSize: 10.5),
                            ]),
                          ]),
                        ),
                        SizedBox(
                          width: 86,
                          child: TextField(
                            controller: _controllerFor(s.id, known),
                            keyboardType: const TextInputType.numberWithOptions(decimal: true),
                            textAlign: TextAlign.center,
                            textInputAction: TextInputAction.next,
                            decoration: InputDecoration(
                              isDense: true,
                              hintText: '—',
                              errorText: invalid ? '0–${fmtNum(_max)}' : null,
                              errorStyle: const TextStyle(fontSize: 10),
                            ),
                            onChanged: (v) => _onChanged(s.id, v),
                          ),
                        ),
                      ]),
                    ),
                  );
                },
              ),
      ),
      SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 6, 12, 10),
          child: FilledButton.icon(
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50), backgroundColor: AppColors.successText),
            onPressed: _edits.isEmpty || _saving ? null : _save,
            icon: _saving
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Icon(Icons.save_outlined),
            label: Text(_edits.isEmpty ? 'مفيش تغييرات' : 'حفظ ${_edits.length} درجة'),
          ),
        ),
      ),
    ]);
  }
}
