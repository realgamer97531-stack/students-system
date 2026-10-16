import 'package:flutter/material.dart';

import '../../services/net.dart';
import '../../services/staff_api.dart';
import '../../services/staff_store.dart';
import '../../theme.dart';
import '../../widgets/common.dart';

/// البحث بالتليفون مكان الكود في تابات المسح.
/// الكود المطابق بالظبط الأول (المسح بالكاميرا مبيتغيرش)، وبعده أي طالب رقمه أو رقم ولي أمره فيه الأرقام دي.
/// الترتيب: نفس سنتر ومادة الحصة الشغالة ← نفس المادة ← الباقي.
/// بيدور في بيانات المسح المحفوظة (شغال من غير نت)، ولو ملقاش حد بيسأل السيرفر.
class StudentHit {
  StudentHit({
    required this.name,
    required this.code,
    this.phone,
    this.parentPhone,
    this.center = '',
    this.subject = '',
    this.match = 2,
    this.present = false,
    this.blocked = false,
  });
  final String name, code, center, subject;
  final String? phone, parentPhone;

  /// -1 = الكود نفسه، 0 = نفس السنتر والمادة، 1 = نفس المادة، 2 = مادة تانية
  final int match;
  final bool present, blocked;

  factory StudentHit.fromJson(Map m) => StudentHit(
        name: '${m['name'] ?? ''}',
        code: '${m['code'] ?? ''}',
        phone: m['phone'] as String?,
        parentPhone: m['parentPhone'] as String?,
        center: '${m['center'] ?? ''}',
        subject: '${m['subject'] ?? ''}',
        match: (m['match'] as num?)?.toInt() ?? 2,
        present: m['present'] == true,
        blocked: m['blocked'] == true,
      );
}

class StudentSearchResult {
  StudentSearchResult(this.hits, {this.exactCode, int? total}) : total = total ?? hits.length;
  final List<StudentHit> hits;
  final String? exactCode;
  final int total;
}

const studentSearchLimit = 30;

/// أرقام بس (عربي → إنجليزي)، و +20 قبل الرقم المصري بتتشال
String phoneDigits(String input) {
  // تليفون بس لو اللي اتكتب أرقام (مسافات/+/- مسموحة)، مش كود زي STU-00123
  if (!RegExp(r'^[+\d\s\-٠-٩۰-۹]+$').hasMatch(input.trim())) return '';
  const ar = '٠١٢٣٤٥٦٧٨٩', fa = '۰۱۲۳۴۵۶۷۸۹';
  var d = input.split('').map((c) {
    final a = ar.indexOf(c), f = fa.indexOf(c);
    return a >= 0 ? '$a' : (f >= 0 ? '$f' : c);
  }).join().replaceAll(RegExp(r'\D'), '');
  if (RegExp(r'^(?:00)?201\d{9}$').hasMatch(d)) d = d.replaceFirst(RegExp(r'^(?:00)?20'), '0');
  return d;
}

String _clean(String? phone) => (phone ?? '').replaceAll(RegExp(r'\D'), '');

/// من بيانات المسح المحفوظة
StudentSearchResult searchLocal(Snapshot snap, String query, int? sessionId) {
  final exact = snap.student(query);
  final digits = phoneDigits(query);
  final session = snap.session(sessionId);
  final sCenter = (session?['CenterId'] as num?)?.toInt();
  final sSubject = (session?['SubjectId'] as num?)?.toInt();
  int rank(SnapStudent s) {
    if (exact != null && s.id == exact.id) return -1;
    if (session == null) return 2;
    if (s.subjectId == sSubject && s.centerId == sCenter) return 0;
    if (s.subjectId == sSubject) return 1;
    return 2;
  }

  final found = <SnapStudent>[
    ?exact,
    if (digits.length >= 3)
      for (final s in snap.students)
        if (s.id != exact?.id && (_clean(s.phone).contains(digits) || _clean(s.parentPhone).contains(digits))) s,
  ]..sort((a, b) {
      final r = rank(a).compareTo(rank(b));
      return r != 0 ? r : a.name.compareTo(b.name);
    });
  return StudentSearchResult(
    [
      for (final s in found.take(studentSearchLimit))
        StudentHit(
          name: s.name,
          code: s.code,
          phone: s.phone,
          parentPhone: s.parentPhone,
          center: snap.centers[s.centerId] ?? '',
          subject: snap.subjects[s.subjectId] ?? '',
          match: rank(s),
          present: sessionId != null && (snap.attendance.contains('${s.id}:$sessionId') || snap.attendanceBy.containsKey('${s.id}:$sessionId')),
          blocked: s.blocked,
        ),
    ],
    exactCode: exact?.code,
    total: found.length,
  );
}

/// المحفوظ الأول، ولو مفيش نتيجة (طالب جديد لسه منزلش) بيسأل السيرفر
Future<StudentSearchResult> searchStudents(String query, {required int userId, int? sessionId, bool askServer = true}) async {
  final snap = StaffStore.snapshot.value;
  final local = snap == null ? null : searchLocal(snap, query, sessionId);
  if (local != null && local.hits.isNotEmpty) return local;
  if (!askServer) return local ?? StudentSearchResult(const []);
  try {
    final data = await StaffApi.getJson(
      '/attendance/scan/search?q=${Uri.encodeQueryComponent(query)}${sessionId != null ? '&session_id=$sessionId' : ''}',
      userId: userId,
    );
    Connection.report(true);
    return StudentSearchResult(
      ((data['students'] as List?) ?? []).map((e) => StudentHit.fromJson(e as Map)).toList(),
      exactCode: data['exactCode'] as String?,
      total: (data['total'] as num?)?.toInt(),
    );
  } on DeviceNotAuthorized {
    rethrow;
  } on ApiException catch (e) {
    if (e.offline) Connection.report(false);
    return local ?? StudentSearchResult(const []);
  }
}

/// اللي اتكتب → كود الطالب: كود مطابق أو طالب واحد على طول، أكتر من واحد بيطلع قايمة تختار منها.
/// null = الموظف قفل القايمة من غير ما يختار.
Future<String?> resolveStudentInput(BuildContext context, String text, {required int userId, int? sessionId}) async {
  final result = await searchStudents(text, userId: userId, sessionId: sessionId);
  if (result.exactCode != null) return text; // كود مطابق: يكمل بالظبط زي الأول
  if (result.hits.isEmpty) return text; // نفس الأول: السيرفر هيقول "كود الطالب غير صحيح"
  if (result.hits.length == 1) return result.hits.first.code;
  if (!context.mounted) return null;
  return showModalBottomSheet<String>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (c) => SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(c).size.height * 0.8),
        child: ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(16, 0, 16, 16), children: [
          Text('لقينا ${result.total} طالب بالرقم ده', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
          Text(
            result.total > result.hits.length ? 'ظاهر أول ${result.hits.length} — اكتب أرقام أكتر عشان تقلل القايمة' : 'اضغط على الطالب اللي انت عايزه',
            style: const TextStyle(color: AppColors.muted),
          ),
          const SizedBox(height: 8),
          for (final h in result.hits) StudentHitTile(hit: h, query: text, onTap: () => Navigator.pop(c, h.code)),
        ]),
      ),
    ),
  );
}

class StudentHitTile extends StatelessWidget {
  const StudentHitTile({super.key, required this.hit, required this.query, required this.onTap});
  final StudentHit hit;
  final String query;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final (label, bg, fg) = switch (hit.match) {
      -1 => ('الكود', AppColors.neutralSoft, AppColors.text),
      0 => ('نفس السنتر والمادة', AppColors.successSoft, AppColors.successText),
      1 => ('نفس المادة', const Color(0xFFE0F2FE), const Color(0xFF0369A1)),
      _ => ('مادة تانية', AppColors.neutralSoft, AppColors.muted),
    };
    final digits = phoneDigits(query);
    return Opacity(
      opacity: hit.match == 2 ? 0.75 : 1,
      child: Card(
        margin: const EdgeInsets.only(top: 6),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(10),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text(hit.name, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15))),
                Pill(label, bg, fg, fontSize: 11),
              ]),
              const SizedBox(height: 3),
              Text('${hit.code} • ${hit.subject} • ${hit.center}', style: const TextStyle(color: AppColors.muted, fontSize: 12.5)),
              if ((hit.phone ?? '').isNotEmpty || (hit.parentPhone ?? '').isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 3),
                  child: Wrap(spacing: 12, children: [
                    if ((hit.phone ?? '').isNotEmpty) _phone(Icons.smartphone, hit.phone!, digits),
                    if ((hit.parentPhone ?? '').isNotEmpty) _phone(Icons.family_restroom, hit.parentPhone!, digits),
                  ]),
                ),
              if (hit.present || hit.blocked)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Wrap(spacing: 6, children: [
                    if (hit.present) const Pill('حاضر في الحصة', AppColors.successSoft, AppColors.successText, fontSize: 11),
                    if (hit.blocked) const Pill('محظور', AppColors.dangerSoft, AppColors.dangerText, fontSize: 11),
                  ]),
                ),
            ]),
          ),
        ),
      ),
    );
  }

  /// الأرقام اللي اتكتبت بتظهر بلون مختلف جوه الرقم
  Widget _phone(IconData icon, String phone, String digits) {
    final clean = phone.replaceAll(RegExp(r'\s'), '');
    final i = digits.length >= 3 ? clean.indexOf(digits) : -1;
    const base = TextStyle(color: AppColors.text, fontSize: 13);
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Icon(icon, size: 15, color: AppColors.muted),
      const SizedBox(width: 3),
      Text.rich(
        TextSpan(style: base, children: i < 0
            ? [TextSpan(text: clean)]
            : [
                TextSpan(text: clean.substring(0, i)),
                TextSpan(text: clean.substring(i, i + digits.length), style: const TextStyle(backgroundColor: Color(0xFFFFF3B0), fontWeight: FontWeight.w800)),
                TextSpan(text: clean.substring(i + digits.length)),
              ]),
        textDirection: TextDirection.ltr,
      ),
    ]);
  }
}
