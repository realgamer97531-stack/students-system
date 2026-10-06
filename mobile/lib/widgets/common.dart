import 'package:flutter/material.dart';
import 'package:intl/intl.dart' show DateFormat;

import '../theme.dart';

String fmtNum(dynamic v) {
  final n = v is num ? v : num.tryParse('$v') ?? 0;
  return n == n.roundToDouble() ? n.round().toString() : n.toStringAsFixed(1);
}

String fmtDate(dynamic v, {bool withTime = false}) {
  if (v == null || '$v'.isEmpty) return '-';
  final d = DateTime.tryParse('$v');
  if (d == null) return '$v';
  return DateFormat(withTime ? 'd/M/yyyy – h:mm a' : 'd/M/yyyy', 'ar').format(d.toLocal());
}

String fmtAgo(DateTime t) {
  final diff = DateTime.now().difference(t);
  if (diff.inMinutes < 1) return 'دلوقتي';
  if (diff.inMinutes < 60) return 'من ${diff.inMinutes} دقيقة';
  if (diff.inHours < 24) return 'من ${diff.inHours} ساعة';
  return 'من ${diff.inDays} يوم';
}

int? asInt(dynamic v) => v is int ? v : (v is num ? v.toInt() : int.tryParse('$v'));

class ErrorView extends StatelessWidget {
  const ErrorView({super.key, required this.message, required this.onRetry, this.icon = Icons.cloud_off_rounded});
  final String message;
  final VoidCallback onRetry;
  final IconData icon;
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 56, color: AppColors.muted),
          const SizedBox(height: 14),
          Text(message, textAlign: TextAlign.center, style: const TextStyle(fontSize: 16)),
          const SizedBox(height: 18),
          FilledButton.icon(
            style: FilledButton.styleFrom(minimumSize: const Size(160, 46)),
            onPressed: onRetry,
            icon: const Icon(Icons.refresh),
            label: const Text('حاول تاني'),
          ),
        ]),
      ),
    );
  }
}

class Pill extends StatelessWidget {
  const Pill(this.text, this.bg, this.fg, {super.key, this.fontSize = 12.5});
  final String text;
  final Color bg, fg;
  final double fontSize;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
        child: Text(text, style: TextStyle(color: fg, fontSize: fontSize, fontWeight: FontWeight.w700)),
      );
}

/// شريط صغير بيقول إن البيانات المعروضة محفوظة من آخر مرة (مفيش نت)
class OfflineBanner extends StatelessWidget {
  const OfflineBanner({super.key, required this.savedAt, this.message});
  final DateTime? savedAt;
  final String? message;
  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      color: AppColors.warningSoft,
      child: Row(children: [
        const Icon(Icons.wifi_off_rounded, size: 18, color: AppColors.warningText),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            message ?? 'مفيش نت — بتشوف آخر بيانات اتحفظت${savedAt != null ? ' (${fmtAgo(savedAt!)})' : ''}',
            style: const TextStyle(color: AppColors.warningText, fontSize: 12.5, fontWeight: FontWeight.w600),
          ),
        ),
      ]),
    );
  }
}

class EmptyView extends StatelessWidget {
  const EmptyView(this.text, {super.key, this.icon = Icons.inbox_outlined});
  final String text;
  final IconData icon;
  @override
  Widget build(BuildContext context) => ListView(children: [
        const SizedBox(height: 110),
        Icon(icon, size: 52, color: AppColors.muted.withValues(alpha: 0.6)),
        const SizedBox(height: 12),
        Text(text, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.muted, fontSize: 15)),
      ]);
}

Future<bool> confirmDialog(BuildContext context, {required String title, required String message, String ok = 'موافق', String cancel = 'لأ'}) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: Text(cancel)),
        FilledButton(
          style: FilledButton.styleFrom(minimumSize: const Size(90, 42)),
          onPressed: () => Navigator.pop(context, true),
          child: Text(ok),
        ),
      ],
    ),
  );
  return result == true;
}

void toast(BuildContext context, String message, {bool error = false}) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(
      content: Text(message),
      backgroundColor: error ? AppColors.dangerText : null,
      behavior: SnackBarBehavior.floating,
    ));
}
