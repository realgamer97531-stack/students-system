import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../services/net.dart';
import '../../services/session_store.dart';
import '../../services/staff_api.dart';
import '../../services/staff_store.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import 'create_forms.dart';
import 'student_qr.dart';

/// قايمة الطلاب جوه البرنامج (شغالة من غير نت من آخر بيانات اتحفظت)
class StudentsTab extends StatefulWidget {
  const StudentsTab({super.key, required this.openWeb, required this.user, required this.activeSession});

  /// فتح صفحة من السيستم (الملف الكامل للطالب) في تاب "السيستم"
  final void Function(String path) openWeb;
  final StaffUser user;
  final ValueNotifier<int?> activeSession;

  @override
  State<StudentsTab> createState() => _StudentsTabState();
}

class _StudentsTabState extends State<StudentsTab> {
  String _q = '';
  int? _center;
  int? _subject;

  List<SnapStudent> _filter(Snapshot snap) {
    final q = _q.trim().toLowerCase();
    final code = q.isEmpty ? '' : normalizeStudentCode(q).toLowerCase();
    return snap.students.where((s) {
      if (_center != null && s.centerId != _center) return false;
      if (_subject != null && s.subjectId != _subject) return false;
      if (q.isEmpty) return true;
      return s.searchText.contains(q) || s.code.toLowerCase() == code;
    }).toList();
  }

  Widget _dropdown(String hint, Map<int, String> items, int? value, ValueChanged<int?> onChanged) => Expanded(
        child: DropdownButtonFormField<int?>(
          initialValue: value,
          isExpanded: true,
          decoration: InputDecoration(isDense: true, labelText: hint),
          items: [
            DropdownMenuItem(value: null, child: Text('الكل ($hint)')),
            for (final e in items.entries) DropdownMenuItem(value: e.key, child: Text(e.value, overflow: TextOverflow.ellipsis)),
          ],
          onChanged: onChanged,
        ),
      );

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<Snapshot?>(
      valueListenable: StaffStore.snapshot,
      builder: (context, snap, _) {
        if (snap == null) {
          return ErrorView(message: 'لسه مفيش بيانات طلاب على الموبايل — افتح البرنامج وفيه نت مرة', onRetry: StaffStore.refreshSnapshot);
        }
        final list = _filter(snap);
        final body = Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
            child: Column(children: [
              TextField(
                decoration: const InputDecoration(hintText: 'دور بالاسم أو الكود أو التليفون', prefixIcon: Icon(Icons.search), isDense: true),
                onChanged: (v) => setState(() => _q = v),
              ),
              const SizedBox(height: 8),
              Row(children: [
                _dropdown('السنتر', snap.centers, _center, (v) => setState(() => _center = v)),
                const SizedBox(width: 8),
                _dropdown('المادة', snap.subjects, _subject, (v) => setState(() => _subject = v)),
              ]),
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Text('${list.length} طالب', style: const TextStyle(color: AppColors.muted, fontSize: 12.5)),
              ),
            ]),
          ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: StaffStore.refreshSnapshot,
              child: ListView.builder(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 90),
                itemCount: list.length,
                itemExtent: 74,
                itemBuilder: (context, i) {
                  final s = list[i];
                  return Card(
                    margin: const EdgeInsets.only(bottom: 6),
                    child: ListTile(
                      onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => StudentDetails(student: s, user: widget.user, openWeb: widget.openWeb))),
                      leading: CircleAvatar(
                        backgroundColor: s.blocked ? AppColors.dangerSoft : AppColors.primary.withValues(alpha: 0.1),
                        child: Text(s.name.isEmpty ? '?' : s.name.characters.first, style: TextStyle(color: s.blocked ? AppColors.dangerText : AppColors.primary, fontWeight: FontWeight.w800)),
                      ),
                      title: Text(s.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)),
                      subtitle: Text('${s.code} • ${snap.centers[s.centerId] ?? ''}', maxLines: 1, overflow: TextOverflow.ellipsis),
                      trailing: Text('${fmtNum(s.balance)} ج',
                          textDirection: TextDirection.ltr, style: TextStyle(fontWeight: FontWeight.w800, color: s.balance < 0 ? AppColors.danger : AppColors.successText)),
                    ),
                  );
                },
              ),
            ),
          ),
        ]);
        if (!widget.user.can('students_add')) return body;
        return Stack(children: [
          body,
          PositionedDirectional(
            end: 16,
            bottom: 16,
            child: FloatingActionButton.extended(
              heroTag: 'add_student',
              onPressed: () => Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => AddStudentScreen(user: widget.user, activeSession: widget.activeSession),
              )),
              icon: const Icon(Icons.person_add_alt_1),
              label: const Text('إضافة طالب'),
            ),
          ),
        ]);
      },
    );
  }
}

class StudentDetails extends StatefulWidget {
  const StudentDetails({super.key, required this.student, required this.user, required this.openWeb});
  final SnapStudent student;
  final StaffUser user;
  final void Function(String path) openWeb;

  @override
  State<StudentDetails> createState() => _StudentDetailsState();
}

class _StudentDetailsState extends State<StudentDetails> {
  static const _hw = {'complete': 'كامل', 'incomplete': 'مش كامل', 'no_steps': 'من غير خطوات', 'not_done': 'مش معمول'};

  /// بيانات الطالب من السيرفر دلوقتي (الرصيد + البوكليتات + آخر حركات الرصيد)
  Map<String, dynamic>? _live;
  String? _liveError;
  bool _loading = false;
  final _walletOp = OnlineOp();
  final _bookletOps = <int, OnlineOp>{};

  @override
  void initState() {
    super.initState();
    _loadLive();
  }

  Future<void> _loadLive() async {
    setState(() {
      _loading = true;
      _liveError = null;
    });
    try {
      final data = await StaffApi.studentDetails(widget.student.id);
      Connection.report(true);
      final balance = (data['student'] as Map?)?['balance'];
      if (balance is num) widget.student.balance = balance; // قايمة الطلاب تبان بالرصيد الجديد على طول
      if (mounted) setState(() => _live = data);
    } on DeviceNotAuthorized catch (e) {
      StaffStore.deviceRevoked.value = true;
      if (mounted) setState(() => _liveError = '$e');
    } on ApiException catch (e) {
      if (e.offline) Connection.report(false);
      if (mounted) setState(() => _liveError = e.offline ? 'البوكليتات والمحفظة محتاجين نت' : e.message);
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _addWallet() async {
    final input = await _askAmount(context, title: 'إضافة رصيد للمحفظة', subtitle: 'الرصيد الحالي: ${fmtNum(widget.student.balance)} ج', noteLabel: 'السبب (اختياري)');
    if (input == null || !mounted) return;
    final res = await _walletOp.send(
      context,
      '/students/${widget.student.id}/balance',
      {'amount': input.$1, 'type': 'add', 'reason': input.$2},
      user: widget.user,
    );
    if (res == null || !mounted) return;
    if (!res.ok) return toast(context, res.message, error: true);
    toast(context, '✅ اتضاف ${fmtNum(input.$1)} ج للمحفظة');
    _loadLive();
  }

  Future<void> _payBooklet(Map<String, dynamic> b) async {
    final remaining = (b['remaining'] as num?) ?? 0;
    final input = await _askAmount(
      context,
      title: 'دفع بوكليت: ${b['name']}',
      subtitle: 'السعر ${fmtNum(b['price'])} ج • مدفوع ${fmtNum(b['paid'])} ج • متبقي ${fmtNum(remaining)} ج',
      max: remaining,
      noteLabel: 'ملاحظة (اختياري)',
    );
    if (input == null || !mounted) return;
    final id = (b['id'] as num).toInt();
    // رقم عملية لكل بوكليت لوحده: دفع بوكليت تاني بعد ما النت قطع ميتلخبطش مع الأولاني
    final res = await _bookletOps.putIfAbsent(id, OnlineOp.new).send(
      context,
      '/students/${widget.student.id}/booklet-payment',
      {'booklet_id': id, 'paid_amount': input.$1, 'notes': input.$2},
      user: widget.user,
    );
    if (res == null || !mounted) return;
    if (!res.ok) return toast(context, res.message, error: true);
    toast(context, '✅ اتدفع ${fmtNum(input.$1)} ج في ${b['name']}');
    _loadLive();
  }

  Widget _phone(String label, String? phone) {
    if (phone == null || phone.trim().isEmpty) return const SizedBox.shrink();
    final p = phone.trim();
    return Card(
      child: ListTile(
        title: Text(label, style: const TextStyle(color: AppColors.muted, fontSize: 13)),
        subtitle: Text(p, textDirection: TextDirection.ltr, textAlign: TextAlign.right, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16, color: AppColors.text)),
        trailing: Row(mainAxisSize: MainAxisSize.min, children: [
          IconButton(icon: const Icon(Icons.call, color: AppColors.accent), onPressed: () => launchUrl(Uri.parse('tel:$p'))),
          IconButton(
            icon: const Icon(Icons.chat, color: Color(0xFF25D366)),
            onPressed: () => launchUrl(Uri.parse('https://wa.me/20${p.replaceFirst(RegExp('^0'), '')}'), mode: LaunchMode.externalApplication),
          ),
        ]),
      ),
    );
  }

  Widget _liveStatus() {
    if (_live != null) return const SizedBox.shrink();
    if (_loading) return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()));
    return Card(
      color: AppColors.warningSoft,
      child: ListTile(
        leading: const Icon(Icons.cloud_off_outlined, color: AppColors.warningText),
        title: Text(_liveError ?? 'محتاج نت', style: const TextStyle(color: AppColors.warningText, fontWeight: FontWeight.w700)),
        trailing: TextButton(onPressed: _loadLive, child: const Text('حاول تاني')),
      ),
    );
  }

  Widget _wallet() {
    final balance = widget.student.balance;
    final txs = ((_live?['transactions'] as List?) ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            const Icon(Icons.account_balance_wallet_outlined, color: AppColors.primary),
            const SizedBox(width: 8),
            const Expanded(child: Text('المحفظة', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16))),
            Text('${fmtNum(balance)} ج',
                textDirection: TextDirection.ltr, style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: balance < 0 ? AppColors.danger : AppColors.successText)),
          ]),
          const SizedBox(height: 10),
          FilledButton.icon(onPressed: _addWallet, icon: const Icon(Icons.add_card), label: const Text('إضافة رصيد')),
          if (txs.isNotEmpty)
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              title: const Text('آخر حركات الرصيد', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
              children: [
                for (final t in txs)
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: Text('${t['reason'] ?? '-'}', maxLines: 2, overflow: TextOverflow.ellipsis),
                    subtitle: Text(fmtDate(t['createdAt'], withTime: true)),
                    trailing: Text('${((t['amount'] as num?) ?? 0) > 0 ? '+' : ''}${fmtNum(t['amount'])} ج',
                        textDirection: TextDirection.ltr,
                        style: TextStyle(fontWeight: FontWeight.w800, color: ((t['amount'] as num?) ?? 0) < 0 ? AppColors.danger : AppColors.successText)),
                  ),
              ],
            ),
        ]),
      ),
    );
  }

  Widget _booklets() {
    final list = ((_live?['booklets'] as List?) ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Row(children: [
            Icon(Icons.menu_book_outlined, color: AppColors.primary),
            SizedBox(width: 8),
            Text('البوكليتات', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
          ]),
          const SizedBox(height: 8),
          if (list.isEmpty) const Text('مفيش بوكليتات للمادة دي', style: TextStyle(color: AppColors.muted)),
          for (final b in list) ...[
            const Divider(height: 18),
            Row(children: [
              Expanded(child: Text('${b['name']}', style: const TextStyle(fontWeight: FontWeight.w700))),
              if (b['delivered'] == true)
                const Pill('✓ اتسلم', AppColors.successSoft, AppColors.successText, fontSize: 11.5)
              else if (b['owned'] == true)
                const Pill('⚠️ مش مستلم', AppColors.warningSoft, AppColors.warningText, fontSize: 11.5),
            ]),
            const SizedBox(height: 6),
            Wrap(spacing: 6, runSpacing: 6, children: [
              Pill('السعر: ${fmtNum(b['price'])} ج${b['customPrice'] == true ? ' (مخصص)' : ''}', AppColors.neutralSoft, AppColors.text, fontSize: 11.5),
              Pill('مدفوع: ${fmtNum(b['paid'])} ج', AppColors.successSoft, AppColors.successText, fontSize: 11.5),
              Pill('متبقي: ${fmtNum(b['remaining'])} ج', ((b['remaining'] as num?) ?? 0) > 0 ? AppColors.dangerSoft : AppColors.successSoft,
                  ((b['remaining'] as num?) ?? 0) > 0 ? AppColors.dangerText : AppColors.successText,
                  fontSize: 11.5),
            ]),
            if ('${b['notes'] ?? ''}'.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text('📝 ${b['notes']}', style: const TextStyle(color: AppColors.muted, fontSize: 12.5)),
            ],
            if (((b['remaining'] as num?) ?? 0) > 0)
              Align(
                alignment: AlignmentDirectional.centerEnd,
                child: TextButton.icon(onPressed: () => _payBooklet(b), icon: const Icon(Icons.payments_outlined), label: const Text('دفع للبوكليت')),
              ),
          ],
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final snap = StaffStore.snapshot.value!;
    final s = widget.student;
    final sessions = snap.sessions.where((x) => (x['SubjectId'] as num?)?.toInt() == s.subjectId).toList()
      ..sort((a, b) => ((b['lesson_number'] as num?) ?? 0).compareTo((a['lesson_number'] as num?) ?? 0));
    // لكل رقم حصة: حضر فين + الواجب
    final byLesson = <int, (String?, String?)>{};
    for (final x in sessions) {
      final lesson = (x['lesson_number'] as num?)?.toInt() ?? 0;
      final key = '${s.id}:${x['id']}';
      final prev = byLesson[lesson] ?? (null, null);
      final attendedHere = snap.attendance.contains(key) ? snap.centers[(x['CenterId'] as num?)?.toInt()] ?? 'حضر' : null;
      byLesson[lesson] = (prev.$1 ?? attendedHere, prev.$2 ?? snap.homework[key]);
    }
    final lessons = byLesson.keys.toList()..sort((a, b) => b.compareTo(a));
    return Scaffold(
      appBar: AppBar(title: Text(s.name)),
      body: RefreshIndicator(
        onRefresh: _loadLive,
        child: ListView(padding: const EdgeInsets.all(16), children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(s.name, style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w800)),
                Text('${s.code} • ${snap.subjects[s.subjectId] ?? ''} • ${snap.centers[s.centerId] ?? ''}', style: const TextStyle(color: AppColors.muted)),
                const SizedBox(height: 10),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  Pill('الرصيد: ${fmtNum(s.balance)} ج', s.balance < 0 ? AppColors.dangerSoft : AppColors.successSoft, s.balance < 0 ? AppColors.dangerText : AppColors.successText),
                  Pill('سعر الحصة: ${fmtNum(s.price)} ج', AppColors.neutralSoft, AppColors.text),
                  if (s.points != null) Pill('النقط: ${fmtNum(s.points)}', AppColors.warningSoft, AppColors.warningText),
                  if (s.blocked) const Pill('⛔ محظور', AppColors.dangerSoft, AppColors.dangerText),
                ]),
                if ((s.note ?? '').isNotEmpty) ...[
                  const SizedBox(height: 10),
                  Text('📌 ${s.note}', style: const TextStyle(color: AppColors.warningText)),
                ],
              ]),
            ),
          ),
          Card(
            child: ExpansionTile(
              leading: const Icon(Icons.qr_code_2, color: AppColors.primary),
              title: const Text('QR الكود', style: TextStyle(fontWeight: FontWeight.w700)),
              subtitle: Text(s.code),
              children: [Padding(padding: const EdgeInsets.only(bottom: 16), child: StudentQr(studentId: s.id, user: widget.user, size: 220))],
            ),
          ),
          _phone('تليفون الطالب', s.phone),
          _phone('تليفون ولي الأمر', s.parentPhone),
          const SizedBox(height: 4),
          _liveStatus(),
          if (_live != null) ...[_wallet(), _booklets()],
          const SizedBox(height: 8),
          const Text('آخر الحصص (من البيانات المحفوظة)', style: TextStyle(fontWeight: FontWeight.w800)),
          const SizedBox(height: 6),
          for (final n in lessons)
            Card(
              margin: const EdgeInsets.only(bottom: 6),
              child: ListTile(
                dense: true,
                title: Text('حصة $n', style: const TextStyle(fontWeight: FontWeight.w700)),
                subtitle: Text(byLesson[n]!.$2 == null ? 'الواجب: لم يصحح' : 'الواجب: ${_hw[byLesson[n]!.$2] ?? byLesson[n]!.$2}'),
                trailing: byLesson[n]!.$1 != null
                    ? Pill('حضر (${byLesson[n]!.$1})', AppColors.successSoft, AppColors.successText, fontSize: 11.5)
                    : const Pill('غاب', AppColors.dangerSoft, AppColors.dangerText, fontSize: 11.5),
              ),
            ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: () {
              Navigator.of(context).pop();
              widget.openWeb('/students/${s.id}');
            },
            icon: const Icon(Icons.open_in_new),
            label: const Text('الملف الكامل على السيستم (محتاج نت)'),
          ),
        ]),
      ),
    );
  }
}

/// مبلغ + ملاحظة. max: أقصى مبلغ مسموح (المتبقي في البوكليت)
Future<(num, String)?> _askAmount(BuildContext context, {required String title, required String subtitle, num? max, required String noteLabel}) =>
    showDialog<(num, String)>(
      context: context,
      builder: (_) => _AmountDialog(title: title, subtitle: subtitle, max: max, noteLabel: noteLabel),
    );

class _AmountDialog extends StatefulWidget {
  const _AmountDialog({required this.title, required this.subtitle, required this.max, required this.noteLabel});
  final String title, subtitle, noteLabel;
  final num? max;

  @override
  State<_AmountDialog> createState() => _AmountDialogState();
}

class _AmountDialogState extends State<_AmountDialog> {
  final _amount = TextEditingController();
  final _note = TextEditingController();
  final _form = GlobalKey<FormState>();

  @override
  void dispose() {
    _amount.dispose();
    _note.dispose();
    super.dispose();
  }

  void _submit() {
    if (!_form.currentState!.validate()) return;
    Navigator.pop(context, (num.parse(_amount.text.trim()), _note.text.trim()));
  }

  @override
  Widget build(BuildContext context) {
    final max = widget.max;
    return AlertDialog(
      title: Text(widget.title),
      content: Form(
        key: _form,
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(widget.subtitle, style: const TextStyle(color: AppColors.muted)),
            const SizedBox(height: 12),
            TextFormField(
              controller: _amount,
              autofocus: true,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(labelText: 'المبلغ'),
              validator: (v) {
                final n = num.tryParse((v ?? '').trim());
                if (n == null || n <= 0) return 'اكتب مبلغ أكبر من صفر';
                if (max != null && n > max) return 'أقصى مبلغ ${fmtNum(max)} ج';
                return null;
              },
            ),
            const SizedBox(height: 10),
            TextField(controller: _note, decoration: InputDecoration(labelText: widget.noteLabel)),
          ]),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('رجوع')),
        FilledButton(onPressed: _submit, child: const Text('تأكيد')),
      ],
    );
  }
}
