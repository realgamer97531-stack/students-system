import 'package:flutter/material.dart';

import '../../services/api.dart';
import '../../services/session_store.dart';
import '../../theme.dart';
import '../../widgets/ads.dart';
import '../../widgets/broadcasts.dart';
import '../../widgets/cached_view.dart';
import '../../widgets/common.dart';

/// البوكليتس: السعر والمدفوع والمتبقي وحالة الاستلام (الحجز من الموقع متوقف، فهنا عرض بس زي الموقع)
class BookletsScreen extends StatefulWidget {
  const BookletsScreen({super.key, required this.onUnauthorized});
  final VoidCallback onUnauthorized;
  @override
  State<BookletsScreen> createState() => _BookletsScreenState();
}

class _BookletsScreenState extends State<BookletsScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => Ads.showFor(context, AccountType.student, 'booklets'));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('البوكليتس')),
      floatingActionButton: const BroadcastsButton(page: 'booklets'),
      body: CachedView<List<Map<String, dynamic>>>(
        cacheKey: 'booklets',
        fetch: PortalApi.booklets,
        onUnauthorized: widget.onUnauthorized,
        decode: (j) => ((j as List?) ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList(),
        builder: (context, list, refresh) {
          if (list.isEmpty) return const EmptyView('لا يوجد بوكليتس حالياً', icon: Icons.menu_book_outlined);
          return ListView.separated(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 90),
            itemCount: list.length,
            separatorBuilder: (_, _) => const SizedBox(height: 10),
            itemBuilder: (context, i) {
              final b = list[i];
              final price = (b['sellPrice'] as num?) ?? 0;
              final paid = (b['paidAmount'] as num?) ?? 0;
              final remaining = (b['remaining'] as num?) ?? 0;
              final reservation = (b['reservation'] as Map?)?.cast<String, dynamic>();
              Widget? badge;
              if (b['isDelivered'] == true) {
                badge = const Pill('تم الاستلام ✓', AppColors.successSoft, AppColors.successText);
              } else if (reservation != null) {
                badge = switch (reservation['status']) {
                  'verified' => const Pill('الحجز اتأكد', AppColors.successSoft, AppColors.successText),
                  'rejected' => const Pill('الحجز اترفض', AppColors.dangerSoft, AppColors.dangerText),
                  _ => const Pill('الحجز قيد المراجعة', AppColors.warningSoft, AppColors.warningText),
                };
              } else if (remaining <= 0) {
                badge = const Pill('مدفوع بالكامل', AppColors.successSoft, AppColors.successText);
              }
              return Card(
                clipBehavior: Clip.antiAlias,
                child: Container(
                  decoration: BoxDecoration(border: BorderDirectional(start: BorderSide(color: remaining <= 0 ? AppColors.accent : AppColors.primary, width: 4))),
                  padding: const EdgeInsets.all(14),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    Row(children: [
                      Expanded(child: Text('${b['name'] ?? ''}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15.5))),
                      ?badge,
                    ]),
                    const SizedBox(height: 10),
                    Row(children: [
                      Expanded(child: _amount('السعر', price, AppColors.text)),
                      Expanded(child: _amount('المدفوع', paid, AppColors.successText)),
                      Expanded(child: _amount('المتبقي', remaining < 0 ? 0 : remaining, remaining > 0 ? AppColors.dangerText : AppColors.successText)),
                    ]),
                    const SizedBox(height: 10),
                    ClipRRect(
                      borderRadius: BorderRadius.circular(99),
                      child: LinearProgressIndicator(
                        value: price > 0 ? (paid / price).clamp(0, 1).toDouble() : 0,
                        minHeight: 6,
                        color: AppColors.accent,
                        backgroundColor: AppColors.neutralSoft,
                      ),
                    ),
                  ]),
                ),
              );
            },
          );
        },
      ),
    );
  }

  Widget _amount(String label, num value, Color color) => Column(children: [
        Text(label, style: const TextStyle(color: AppColors.muted, fontSize: 12.5)),
        Text('${fmtNum(value)} ج', style: TextStyle(fontWeight: FontWeight.w800, color: color)),
      ]);
}
