import 'package:flutter/material.dart';

import '../../theme.dart';
import '../../widgets/common.dart';

/// الحصص: حضور/غياب + الواجب + الامتحان + تعليقات المتابعة
class SessionsList extends StatelessWidget {
  const SessionsList({super.key, required this.sessions});
  final List<Map<String, dynamic>> sessions;

  static const _hw = {
    'complete': ('الواجب كامل', AppColors.successSoft, AppColors.successText),
    'incomplete': ('الواجب مش كامل', AppColors.warningSoft, AppColors.warningText),
    'no_steps': ('من غير خطوات', AppColors.neutralSoft, AppColors.muted),
    'not_done': ('الواجب مش معمول', AppColors.dangerSoft, AppColors.dangerText),
  };

  @override
  Widget build(BuildContext context) {
    if (sessions.isEmpty) return const EmptyView('لسه مفيش حصص', icon: Icons.event_note_outlined);
    final list = sessions.reversed.toList();
    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 90),
      itemCount: list.length,
      separatorBuilder: (_, _) => const SizedBox(height: 10),
      itemBuilder: (context, i) {
        final s = list[i];
        final status = s['attendanceStatus'];
        final (label, bg, fg) = switch (status) {
          'attended' => ('حضر', AppColors.successSoft, AppColors.successText),
          'cancelled' => ('الحصة اتلغت', AppColors.neutralSoft, AppColors.muted),
          _ => ('غياب', AppColors.dangerSoft, AppColors.dangerText),
        };
        final hw = _hw[s['homeworkStatus']];
        final examScore = s['examScore'];
        final stats = (s['examStats'] as Map?)?.cast<String, dynamic>();
        final notes = [s['comment'], s['followUpComment']].where((c) => c != null && '$c'.trim().isNotEmpty).toList();
        return Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Text('حصة ${s['lessonNumber']}', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
                const SizedBox(width: 8),
                Text(fmtDate(s['date']), style: const TextStyle(color: AppColors.muted, fontSize: 13)),
                const Spacer(),
                Pill(label, bg, fg),
              ]),
              if (status == 'attended') ...[
                const SizedBox(height: 6),
                Text(
                  [
                    if (s['attendedCenterName'] != null) 'في ${s['attendedCenterName']}',
                    if (s['attendanceTime'] != null) fmtDate(s['attendanceTime'], withTime: true),
                    if ((s['payment'] ?? 0) is num && (s['payment'] ?? 0) > 0) 'دفع ${fmtNum(s['payment'])} ج',
                  ].join(' • '),
                  style: const TextStyle(color: AppColors.muted, fontSize: 13),
                ),
              ],
              if (hw != null || examScore != null) ...[
                const SizedBox(height: 10),
                Wrap(spacing: 8, runSpacing: 6, children: [
                  if (hw != null) Pill(hw.$1, hw.$2, hw.$3),
                  if (examScore != null)
                    Pill('الامتحان: ${fmtNum(examScore)} / ${fmtNum(s['examMax'] ?? 0)}', const Color(0xFFE0F2FE), const Color(0xFF0369A1)),
                ]),
              ],
              if (stats != null) ...[
                const SizedBox(height: 6),
                Text('أعلى درجة ${fmtNum(stats['max'])} • متوسط ${stats['avg']} • أقل ${fmtNum(stats['min'])}',
                    style: const TextStyle(color: AppColors.muted, fontSize: 12.5)),
              ],
              for (final note in notes) ...[
                const SizedBox(height: 8),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(color: const Color(0xFFF8F9FC), borderRadius: BorderRadius.circular(10)),
                  child: Text('💬 $note', style: const TextStyle(fontSize: 13.5)),
                ),
              ],
            ]),
          ),
        );
      },
    );
  }
}

/// كشف الحساب (من غير حركات النقط)
class TransactionsList extends StatelessWidget {
  const TransactionsList({super.key, required this.transactions});
  final List<Map<String, dynamic>> transactions;

  @override
  Widget build(BuildContext context) {
    final money = transactions.where((t) => !'${t['reason'] ?? ''}'.startsWith('نقاط:')).toList();
    if (money.isEmpty) return const EmptyView('مفيش معاملات', icon: Icons.receipt_long_outlined);
    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 90),
      itemCount: money.length,
      separatorBuilder: (_, _) => const SizedBox(height: 8),
      itemBuilder: (context, i) {
        final t = money[i];
        final amount = (t['amount'] as num?) ?? 0;
        final positive = amount >= 0;
        return Card(
          child: ListTile(
            leading: CircleAvatar(
              backgroundColor: positive ? AppColors.successSoft : AppColors.dangerSoft,
              child: Icon(positive ? Icons.arrow_downward : Icons.arrow_upward, color: positive ? AppColors.successText : AppColors.dangerText),
            ),
            title: Text(t['reason']?.toString() ?? '-', style: const TextStyle(fontWeight: FontWeight.w600)),
            subtitle: Text(fmtDate(t['time'], withTime: true)),
            trailing: Text(
              '${positive ? '+' : ''}${fmtNum(amount)} ج',
              textDirection: TextDirection.ltr,
              style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16, color: positive ? AppColors.successText : AppColors.dangerText),
            ),
          ),
        );
      },
    );
  }
}
