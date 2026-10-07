import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../services/net.dart';
import '../../services/session_store.dart';
import '../../services/staff_api.dart';
import '../../services/staff_store.dart';
import '../../theme.dart';
import '../../widgets/common.dart';

/// إضافة طالب / بدء حصة من الموبايل: محتاجين نت (مش بيتحطوا في الطابور).
/// كل محاولة ليها رقم عملية ثابت لحد ما السيرفر يرد، فلو النت قطع في النص وجربت تاني
/// مستحيل الطالب أو الحصة يتعملوا مرتين.
class _OnlineOp {
  String? _opId;

  Future<OpResult?> send(BuildContext context, String path, Map<String, dynamic> body, {required StaffUser user, int? activeSessionId}) async {
    _opId ??= StaffStore.newOpId();
    try {
      final res = await StaffApi.call(path, {...body, 'response_format': 'json'}, userId: user.id, activeSessionId: activeSessionId, opId: _opId);
      Connection.report(true);
      _opId = null; // السيرفر رد (قبول أو رفض): المحاولة الجاية عملية جديدة
      return res;
    } on DeviceNotAuthorized catch (e) {
      StaffStore.deviceRevoked.value = true;
      if (context.mounted) toast(context, '$e', error: true);
    } on ApiException catch (e) {
      if (e.offline) Connection.report(false);
      if (context.mounted) toast(context, e.offline ? 'محتاج نت — اتأكد من النت وجرب تاني' : e.message, error: true);
    }
    return null;
  }
}

Future<String?> _askPassword(BuildContext context, String title, String message) {
  final controller = TextEditingController();
  return showDialog<String>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(message),
        const SizedBox(height: 12),
        TextField(controller: controller, obscureText: true, autofocus: true, decoration: const InputDecoration(labelText: 'الباسورد')),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('رجوع')),
        FilledButton(onPressed: () => Navigator.pop(context, controller.text.trim()), child: const Text('موافق')),
      ],
    ),
  ).whenComplete(controller.dispose);
}

Widget _intDropdown(String label, Map<int, String> items, int? value, ValueChanged<int?> onChanged) => DropdownButtonFormField<int>(
      initialValue: value,
      isExpanded: true,
      decoration: InputDecoration(labelText: label),
      items: [for (final e in items.entries) DropdownMenuItem(value: e.key, child: Text(e.value, overflow: TextOverflow.ellipsis))],
      onChanged: onChanged,
      validator: (v) => v == null ? 'اختار $label' : null,
    );

// ===== إضافة طالب =====

class AddStudentScreen extends StatefulWidget {
  const AddStudentScreen({super.key, required this.user, required this.activeSession});
  final StaffUser user;
  final ValueNotifier<int?> activeSession;

  @override
  State<AddStudentScreen> createState() => _AddStudentScreenState();
}

class _AddStudentScreenState extends State<AddStudentScreen> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _parentPhone = TextEditingController();
  final _price = TextEditingController();
  final _balance = TextEditingController(text: '0');
  final _bookletPaid = TextEditingController(text: '0');
  final _comment = TextEditingController();
  final _op = _OnlineOp();
  int? _center;
  int? _subject;
  bool _hasBooklet = false;
  bool _attended = true;
  bool _saving = false;

  @override
  void dispose() {
    for (final c in [_name, _phone, _parentPhone, _price, _balance, _bookletPaid, _comment]) {
      c.dispose();
    }
    super.dispose();
  }

  /// نفس سعر الحصة الافتراضي في صفحة السيستم: Math Senior 1 = 80 وأي مادة تانية 90
  void _onSubject(int? id, Snapshot snap) {
    setState(() => _subject = id);
    if (id == null) return;
    final name = (snap.subjects[id] ?? '').trim().toLowerCase();
    if (_price.text.trim().isEmpty || _price.text.trim() == '0' || _price.text == '80' || _price.text == '90') {
      _price.text = name == 'math senior 1' ? '80' : '90';
    }
  }

  static bool _phoneOk(String v) => v.replaceAll(RegExp(r'[^0-9]'), '').length == 11;

  Future<void> _save({String? adminPassword}) async {
    if (!_form.currentState!.validate()) return;
    if (adminPassword == null && (!_phoneOk(_phone.text) || !_phoneOk(_parentPhone.text))) {
      final pwd = await _askPassword(context, 'أرقام التليفون مش 11 رقم', 'لو متأكد من الأرقام، اكتب باسورد حسابك عشان توافق.');
      if (pwd == null || pwd.isEmpty || !mounted) return;
      return _save(adminPassword: pwd);
    }
    final session = widget.activeSession.value;
    setState(() => _saving = true);
    final res = await _op.send(
      context,
      '/students',
      {
        'name': _name.text.trim(),
        'phone': _phone.text.trim(),
        'parent_phone': _parentPhone.text.trim(),
        'price_per_session': _price.text.trim(),
        'balance': _balance.text.trim().isEmpty ? '0' : _balance.text.trim(),
        'booklet_paid_amount': _bookletPaid.text.trim().isEmpty ? '0' : _bookletPaid.text.trim(),
        'comment': _comment.text.trim(),
        'center_id': _center,
        'subject_id': _subject,
        if (_hasBooklet) 'booklet_status': 'on',
        if (_attended && session != null) 'register_attendance': 'on',
        'admin_password': ?adminPassword,
      },
      user: widget.user,
      activeSessionId: session,
    );
    if (!mounted) return;
    setState(() => _saving = false);
    if (res == null) return;

    if (!res.ok) {
      if (res.data['code'] == 'DUPLICATE') {
        final pwd = await _askPassword(context, 'الطالب موجود قبل كده', '${res.message}\n\nلو عايز تضيفه برضه، اكتب باسورد التكرار.');
        if (pwd != null && pwd.isNotEmpty && mounted) return _save(adminPassword: pwd);
        return;
      }
      if (res.data['code'] == 'PHONE_INVALID' && adminPassword != null) {
        final pwd = await _askPassword(context, 'الباسورد غلط', 'اكتب باسورد حسابك تاني.');
        if (pwd != null && pwd.isNotEmpty && mounted) return _save(adminPassword: pwd);
        return;
      }
      toast(context, res.message, error: true);
      return;
    }

    final student = (res.data['student'] as Map?)?.cast<String, dynamic>() ?? {};
    final note = res.data['attendanceNote'];
    await StaffStore.refreshSnapshot();
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('✅ تم إضافة الطالب'),
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${student['name'] ?? ''}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
          const SizedBox(height: 8),
          SelectableText('الكود: ${student['student_code'] ?? '-'}', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16, color: AppColors.primary)),
          if (note != null) ...[const SizedBox(height: 10), Text('$note')],
        ]),
        actions: [
          TextButton(
            onPressed: () => Clipboard.setData(ClipboardData(text: '${student['student_code'] ?? ''}')),
            child: const Text('نسخ الكود'),
          ),
          FilledButton(onPressed: () => Navigator.pop(context), child: const Text('تمام')),
        ],
      ),
    );
    if (mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final snap = StaffStore.snapshot.value;
    return Scaffold(
      appBar: AppBar(title: const Text('إضافة طالب')),
      body: snap == null
          ? ErrorView(message: 'لسه مفيش بيانات السناتر والمواد — اضغط تحديث وفيه نت', onRetry: StaffStore.refreshSnapshot)
          : Form(
              key: _form,
              child: ListView(padding: const EdgeInsets.all(16), children: [
                TextFormField(
                  controller: _name,
                  decoration: const InputDecoration(labelText: 'اسم الطالب'),
                  validator: (v) => (v ?? '').trim().isEmpty ? 'اكتب الاسم' : null,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _phone,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(labelText: 'تليفون الطالب'),
                  validator: (v) => (v ?? '').trim().isEmpty ? 'اكتب التليفون' : null,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _parentPhone,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(labelText: 'تليفون ولي الأمر'),
                  validator: (v) => (v ?? '').trim().isEmpty ? 'اكتب تليفون ولي الأمر' : null,
                ),
                const SizedBox(height: 12),
                _intDropdown('المادة', snap.subjects, _subject, (v) => _onSubject(v, snap)),
                const SizedBox(height: 12),
                _intDropdown('السنتر', snap.centers, _center, (v) => setState(() => _center = v)),
                const SizedBox(height: 12),
                Row(children: [
                  Expanded(
                    child: TextFormField(
                      controller: _price,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      decoration: const InputDecoration(labelText: 'سعر الحصة'),
                      validator: (v) => num.tryParse((v ?? '').trim()) == null ? 'اكتب السعر' : null,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: TextFormField(
                      controller: _balance,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      decoration: const InputDecoration(labelText: 'الرصيد المبدئي'),
                    ),
                  ),
                ]),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _bookletPaid,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(labelText: 'مبلغ بوكليت مدفوع'),
                ),
                const SizedBox(height: 12),
                TextFormField(controller: _comment, decoration: const InputDecoration(labelText: 'كومنت الحضور (اختياري)')),
                const SizedBox(height: 8),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('يوجد بوكليت'),
                  value: _hasBooklet,
                  onChanged: (v) => setState(() => _hasBooklet = v),
                ),
                ValueListenableBuilder<int?>(
                  valueListenable: widget.activeSession,
                  builder: (context, session, _) {
                    final s = snap.session(session);
                    return SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('سجل حضوره في الحصة الشغالة'),
                      subtitle: Text(session == null ? 'مفيش حصة شغالة مختارة' : (s != null ? snap.sessionLabel(s) : 'حصة رقم $session')),
                      value: _attended && session != null,
                      onChanged: session == null ? null : (v) => setState(() => _attended = v),
                    );
                  },
                ),
                const SizedBox(height: 16),
                FilledButton.icon(
                  onPressed: _saving ? null : () => _save(),
                  icon: _saving ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : const Icon(Icons.save),
                  label: const Text('حفظ الطالب'),
                ),
                const SizedBox(height: 8),
                const Text('إضافة طالب محتاجة نت.', textAlign: TextAlign.center, style: TextStyle(color: AppColors.muted, fontSize: 12.5)),
              ]),
            ),
    );
  }
}

// ===== بدء حصة جديدة =====

/// بيرجع رقم الحصة الجديدة لو اتعملت
class NewSessionSheet extends StatefulWidget {
  const NewSessionSheet({super.key, required this.user});
  final StaffUser user;

  @override
  State<NewSessionSheet> createState() => _NewSessionSheetState();
}

class _NewSessionSheetState extends State<NewSessionSheet> {
  final _form = GlobalKey<FormState>();
  final _lesson = TextEditingController();
  final _op = _OnlineOp();
  int? _center;
  int? _subject;
  int? _week;
  bool _repeat = false;
  bool _saving = false;

  @override
  void dispose() {
    _lesson.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    setState(() => _saving = true);
    final res = await _op.send(
      context,
      '/sessions',
      {
        'center_id': _center,
        'subject_id': _subject,
        'mode': _repeat ? 'repeat' : 'new',
        if (_repeat) 'lesson_number': _lesson.text.trim(),
        'week_number': _week ?? '',
      },
      user: widget.user,
    );
    if (!mounted) return;
    setState(() => _saving = false);
    if (res == null) return;
    if (!res.ok) {
      toast(context, res.message, error: true);
      return;
    }
    final id = ((res.data['session'] as Map?)?['id'] as num?)?.toInt();
    await StaffStore.refreshSnapshot();
    if (!mounted) return;
    toast(context, res.message.isEmpty ? '✅ اتعملت الحصة' : res.message);
    Navigator.pop(context, id);
  }

  @override
  Widget build(BuildContext context) {
    final snap = StaffStore.snapshot.value;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(16, 0, 16, 16 + MediaQuery.of(context).viewInsets.bottom),
        child: snap == null
            ? const Padding(padding: EdgeInsets.all(24), child: Text('لسه مفيش بيانات السناتر والمواد — اضغط تحديث وفيه نت'))
            : Form(
                key: _form,
                child: SingleChildScrollView(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
                    const Text('بدء حصة جديدة', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
                    const SizedBox(height: 12),
                    _intDropdown('المادة', snap.subjects, _subject, (v) => setState(() => _subject = v)),
                    const SizedBox(height: 12),
                    _intDropdown('السنتر', snap.centers, _center, (v) => setState(() => _center = v)),
                    const SizedBox(height: 8),
                    RadioGroup<bool>(
                      groupValue: _repeat,
                      onChanged: (v) => setState(() => _repeat = v ?? false),
                      child: const Column(children: [
                        RadioListTile<bool>(contentPadding: EdgeInsets.zero, value: false, title: Text('حصة جديدة (السيستم يحسب رقمها)')),
                        RadioListTile<bool>(contentPadding: EdgeInsets.zero, value: true, title: Text('تكرار حصة سابقة في سنتر تاني (أنا أحدد رقمها)')),
                      ]),
                    ),
                    if (_repeat) ...[
                      TextFormField(
                        controller: _lesson,
                        keyboardType: TextInputType.number,
                        decoration: const InputDecoration(labelText: 'رقم الحصة النسبي (مثلاً 3)'),
                        validator: (v) => (int.tryParse((v ?? '').trim()) ?? 0) < 1 ? 'اكتب رقم صحيح' : null,
                      ),
                      const SizedBox(height: 12),
                    ],
                    DropdownButtonFormField<int?>(
                      initialValue: _week,
                      decoration: const InputDecoration(labelText: 'رقم الأسبوع (اختياري)'),
                      items: [
                        const DropdownMenuItem(value: null, child: Text('من غير أسبوع')),
                        for (var w = 1; w <= 10; w++) DropdownMenuItem(value: w, child: Text('الأسبوع $w')),
                      ],
                      onChanged: (v) => setState(() => _week = v),
                    ),
                    const SizedBox(height: 16),
                    FilledButton.icon(
                      onPressed: _saving ? null : _save,
                      icon: _saving
                          ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                          : const Icon(Icons.play_arrow),
                      label: const Text('بدء الحصة'),
                    ),
                    const SizedBox(height: 6),
                    const Text('بدء حصة محتاج نت.', textAlign: TextAlign.center, style: TextStyle(color: AppColors.muted, fontSize: 12.5)),
                  ]),
                ),
              ),
      ),
    );
  }
}
