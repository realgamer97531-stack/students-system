import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../services/staff_store.dart';
import '../../theme.dart';
import '../../widgets/common.dart';

/// قايمة الطلاب جوه البرنامج (شغالة من غير نت من آخر بيانات اتحفظت)
class StudentsTab extends StatefulWidget {
  const StudentsTab({super.key, required this.openWeb});

  /// فتح صفحة من السيستم (الملف الكامل للطالب) في تاب "السيستم"
  final void Function(String path) openWeb;

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
        return Column(children: [
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
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 30),
                itemCount: list.length,
                itemExtent: 74,
                itemBuilder: (context, i) {
                  final s = list[i];
                  return Card(
                    margin: const EdgeInsets.only(bottom: 6),
                    child: ListTile(
                      onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => StudentDetails(student: s, openWeb: widget.openWeb))),
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
      },
    );
  }
}

class StudentDetails extends StatelessWidget {
  const StudentDetails({super.key, required this.student, required this.openWeb});
  final SnapStudent student;
  final void Function(String path) openWeb;

  static const _hw = {'complete': 'كامل', 'incomplete': 'مش كامل', 'no_steps': 'من غير خطوات', 'not_done': 'مش معمول'};

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

  @override
  Widget build(BuildContext context) {
    final snap = StaffStore.snapshot.value!;
    final s = student;
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
      body: ListView(padding: const EdgeInsets.all(16), children: [
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
        const SizedBox(height: 8),
        _phone('تليفون الطالب', s.phone),
        _phone('تليفون ولي الأمر', s.parentPhone),
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
            openWeb('/students/${s.id}');
          },
          icon: const Icon(Icons.open_in_new),
          label: const Text('الملف الكامل على السيستم (محتاج نت)'),
        ),
      ]),
    );
  }
}
