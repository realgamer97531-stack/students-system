import 'package:flutter/material.dart';

import '../screens/portal/video_screen.dart';
import '../services/api.dart';
import '../services/cache.dart';
import '../theme.dart';
import 'common.dart';

/// زرار "🎬 فيديوهات" اللي بيظهر في الصفحة لو الأدمن ناشر فيديوهات ليها (نفس video-broadcasts.js)
class BroadcastsButton extends StatefulWidget {
  const BroadcastsButton({super.key, required this.page});
  final String page;
  @override
  State<BroadcastsButton> createState() => _BroadcastsButtonState();
}

class _BroadcastsButtonState extends State<BroadcastsButton> {
  List<Map<String, dynamic>> _videos = [];

  String get _key => 'broadcasts_${widget.page}';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final cached = await Cache.read(_key);
    if (cached != null && mounted) setState(() => _videos = ((cached.data as List?) ?? []).cast<Map<String, dynamic>>());
    try {
      final fresh = await PortalApi.broadcasts(widget.page);
      await Cache.write(_key, fresh);
      if (mounted) setState(() => _videos = fresh);
    } catch (_) {}
  }

  Future<void> _open(Map<String, dynamic> video) async {
    String? url = video['locked'] != true ? video['video_url'] as String? : null;
    try {
      if (url == null) {
        var res = await PortalApi.purchaseBroadcast(video['id'] as int, confirmPayment: false);
        if (res['success'] != true && res['requiresPayment'] == true) {
          if (!mounted) return;
          final ok = await confirmDialog(context,
              title: 'تأكيد الدفع', message: '${res['message'] ?? 'هل توافق على دفع ${res['price']} ج لمشاهدة هذا الفيديو؟'}', ok: 'موافق، ادفع وشاهد', cancel: 'رفض');
          if (!ok) return;
          res = await PortalApi.purchaseBroadcast(video['id'] as int, confirmPayment: true);
        }
        if (res['success'] != true) throw ApiException('${res['message'] ?? 'تعذّر فتح الفيديو'}');
        url = res['video_url'] as String?;
        _load();
      }
      if (url == null || !mounted) return;
      await openVideoOrLink(context, url, '${video['title'] ?? 'فيديو'}');
    } on ApiException catch (e) {
      if (mounted) toast(context, e.message, error: true);
    }
  }

  void _showList() {
    showModalBottomSheet<void>(
      context: context,
      useRootNavigator: true,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(sheetContext).size.height * 0.75),
          child: ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(16, 0, 16, 16), children: [
            const Text('🎬 فيديوهات متاحة في الصفحة دي', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
            const SizedBox(height: 12),
            for (final v in _videos)
              Card(
                color: AppColors.bg,
                child: ListTile(
                  onTap: () {
                    Navigator.of(sheetContext).pop();
                    _open(v);
                  },
                  title: Text('${v['title'] ?? ''}', style: const TextStyle(fontWeight: FontWeight.w700)),
                  subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    if ('${v['description'] ?? ''}'.isNotEmpty) Text('${v['description']}'),
                    if ('${v['session_label'] ?? ''}'.isNotEmpty) Text('🔗 ${v['session_label']}', style: const TextStyle(color: AppColors.primary, fontSize: 12)),
                  ]),
                  trailing: v['locked'] == true
                      ? Pill('💰 ${v['price']} ج', AppColors.warningSoft, AppColors.warningText)
                      : const Pill('مجاني', AppColors.successSoft, AppColors.successText),
                ),
              ),
          ]),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_videos.isEmpty) return const SizedBox.shrink();
    return FloatingActionButton.extended(
      heroTag: 'broadcasts_${widget.page}',
      backgroundColor: AppColors.primary,
      foregroundColor: Colors.white,
      onPressed: _showList,
      icon: const Icon(Icons.movie_outlined),
      label: Text('فيديوهات (${_videos.length})'),
    );
  }
}
