import 'dart:async';

import 'package:flutter/material.dart';

import '../../services/mesh/mesh_core.dart';
import '../../services/mesh/mesh_service.dart';
import '../../services/net.dart';
import '../../services/session_store.dart';
import '../../services/staff_store.dart';
import '../../theme.dart';
import '../../widgets/common.dart';

/// تاب "الشبكة": الأجهزة اللي حواليك (متوصلة ولا لأ وقوة الإشارة) + تشغيل/إعادة الاتصال +
/// "خد كل البيانات" (للباب) + اختيار الجهاز اللي بيرفع للكل + مراجعة الحضور المكرر اللي معاه فلوس.
class NetworkTab extends StatefulWidget {
  const NetworkTab({super.key, required this.user});
  final StaffUser user;
  @override
  State<NetworkTab> createState() => _NetworkTabState();
}

class _NetworkTabState extends State<NetworkTab> {
  final mesh = MeshService.instance;
  bool _busy = false;
  Timer? _clock;

  @override
  void initState() {
    super.initState();
    // الأوقات ("من دقيقة") تتحدث لوحدها
    _clock = Timer.periodic(const Duration(seconds: 15), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _clock?.cancel();
    super.dispose();
  }

  Future<void> _run(Future<String?> Function() action, {String? success}) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final error = await action();
      if (!mounted) return;
      if (error != null) {
        toast(context, error, error: true);
      } else if (success != null) {
        toast(context, success);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _ago(int ms) {
    if (ms <= 0) return 'مفيش';
    final minutes = (DateTime.now().millisecondsSinceEpoch - ms) ~/ 60000;
    if (minutes < 1) return 'دلوقتي';
    if (minutes < 60) return 'من $minutes دقيقة';
    final hours = minutes ~/ 60;
    if (hours < 24) return 'من $hours ساعة';
    return 'من ${hours ~/ 24} يوم';
  }

  Future<void> _takeAll() async {
    await _run(() async {
      if (!mesh.running.value) {
        final error = await mesh.enable();
        if (error != null) return error;
        await Future<void>.delayed(const Duration(seconds: 4)); // وقت عشان يلاقي الأجهزة
      }
      final asked = mesh.node?.requestSnapshot() ?? false;
      if (!asked) return 'مفيش أجهزة متوصلة دلوقتي — قرّب من جهاز تاني أو اضغط "إعادة الاتصال"';
      return null;
    }, success: 'بيطلب كل البيانات من أحدث جهاز متوصل... هتوصل خلال ثواني');
  }

  Future<void> _pickUploader() async {
    final node = mesh.node;
    final peers = node?.visiblePeers() ?? [];
    final chosen = await showModalBottomSheet<String>(
      context: context,
      useRootNavigator: true,
      showDragHandle: true,
      builder: (c) => SafeArea(
        child: ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(16, 0, 16, 16), children: [
          const Text('الجهاز اللي يرفع بيانات الكل', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
          const Padding(
            padding: EdgeInsets.only(top: 4, bottom: 10),
            child: Text('أول ما النت يرجع للجهاز ده، بيرفع عمليات كل الأجهزة اللي وصلته (بعد ما يشيل المكرر). كل جهاز برضه بيرفع عملياته بنفسه لو لقى نت.',
                style: TextStyle(color: AppColors.muted, height: 1.5)),
          ),
          ListTile(leading: const Icon(Icons.phone_android), title: Text('الموبايل ده (${mesh.displayName})'), onTap: () => Navigator.pop(c, mesh.nodeId)),
          for (final p in peers)
            ListTile(leading: const Icon(Icons.devices_other), title: Text(p.name.isEmpty ? p.node : p.name), subtitle: Text(p.role), onTap: () => Navigator.pop(c, p.node)),
          ListTile(leading: const Icon(Icons.block, color: AppColors.danger), title: const Text('مفيش رافع (كل جهاز يرفع لنفسه بس)'), onTap: () => Navigator.pop(c, '')),
        ]),
      ),
    );
    if (chosen == null) return;
    mesh.setUploader(chosen.isEmpty ? null : chosen);
    if (mounted) toast(context, chosen.isEmpty ? 'اتلغى الرافع' : 'اتحدد الرافع — الإعداد بيوصل لكل الأجهزة');
  }

  /// الواي فاي اللي برنامج الكمبيوتر بيعمله: الموبايل بيدخله لوحده
  Widget _pcWifiCard() {
    final state = mesh.pcWifi.value;
    final info = mesh.pcWifiInfo!;
    final connected = state == 'connected';
    final text = switch (state) {
      'connected' => 'متوصل بواي فاي الكمبيوتر',
      'connecting' => 'بيتوصل بالكمبيوتر... لو ظهرت رسالة "توصيل بالجهاز" اختار توصيل',
      'searching' => 'بيدور على واي فاي الكمبيوتر (افتح الواي فاي في الموبايل وقرّب من الكمبيوتر)',
      'error' => 'مقدرش يدخل واي فاي الكمبيوتر — جرب الزرار أو دخّله يدوي',
      _ => 'واي فاي الكمبيوتر',
    };
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(Icons.computer, color: connected ? AppColors.accent : AppColors.muted),
            const SizedBox(width: 10),
            Expanded(child: Text(text, style: const TextStyle(fontWeight: FontWeight.w700))),
          ]),
          const SizedBox(height: 6),
          Text('اسم الشبكة: ${info.ssid}   الباسورد: ${info.password}', style: const TextStyle(color: AppColors.muted, fontSize: 12.5)),
          if (!connected) ...[
            const SizedBox(height: 8),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                onPressed: () => mesh.joinPcWifi(force: true),
                icon: const Icon(Icons.wifi),
                label: const Text('اتصل بواي فاي الكمبيوتر'),
              ),
            ),
          ],
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: Listenable.merge([mesh.revision, mesh.running, mesh.message, mesh.uploading, mesh.pcWifi, StaffStore.snapshotAt, StaffStore.queue, Connection.online]),
      builder: (context, _) {
        final node = mesh.node;
        final running = mesh.running.value;
        final peers = node?.visiblePeers() ?? const <MeshPeer>[];
        final direct = peers.where((p) => p.direct).length;
        final reachable = peers.where((p) => node!.isOnline(p)).length;
        final uploader = mesh.uploaderNode;
        final isDoor = !widget.user.can('attendance_scan') && widget.user.can('door_scan');
        final review = mesh.reviewItems;
        final waitingForOthers = mesh.statuses.entries.where((e) => e.value.state == OpState.pending).length;
        final snapAt = StaffStore.snapshotAt.value?.millisecondsSinceEpoch ?? 0;

        return ListView(padding: const EdgeInsets.fromLTRB(16, 14, 16, 40), children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Icon(Icons.hub, color: running ? AppColors.accent : AppColors.muted, size: 30),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(running ? 'الشبكة شغالة' : 'الشبكة مقفولة', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                      Text(
                        running ? 'متوصل مباشرة بـ $direct • شايف $reachable جهاز' : 'شغّلها عشان الأجهزة تتبادل البيانات من غير نت',
                        style: const TextStyle(color: AppColors.muted),
                      ),
                    ]),
                  ),
                ]),
                const SizedBox(height: 12),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  Pill('البيانات: ${_ago(snapAt)}', AppColors.neutralSoft, AppColors.text, fontSize: 12),
                  Pill('مستني الرفع هنا: ${StaffStore.queue.value.length}', AppColors.neutralSoft, AppColors.text, fontSize: 12),
                  Pill('عمليات الشبكة اللي لسه مارفعتش: $waitingForOthers', AppColors.neutralSoft, AppColors.text, fontSize: 12),
                  Pill(Connection.online.value ? 'فيه نت' : 'مفيش نت', Connection.online.value ? AppColors.successSoft : AppColors.warningSoft,
                      Connection.online.value ? AppColors.successText : AppColors.warningText, fontSize: 12),
                ]),
                if (mesh.message.value.isNotEmpty || (node?.lastProblem.isNotEmpty ?? false))
                  Padding(
                    padding: const EdgeInsets.only(top: 10),
                    child: Text(mesh.message.value.isNotEmpty ? mesh.message.value : node!.lastProblem, style: const TextStyle(color: AppColors.warningText)),
                  ),
                const SizedBox(height: 14),
                Row(children: [
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: _busy ? null : () => _run(running ? () async { await mesh.reconnect(); return null; } : mesh.enable,
                          success: running ? 'بيدور على أقرب وأقوى أجهزة...' : 'الشبكة اشتغلت'),
                      icon: Icon(running ? Icons.wifi_tethering : Icons.power_settings_new),
                      label: Text(running ? 'إعادة الاتصال' : 'تشغيل الشبكة'),
                    ),
                  ),
                  if (running) ...[
                    const SizedBox(width: 8),
                    OutlinedButton(onPressed: _busy ? null : () => _run(() async { await mesh.disable(); return null; }), child: const Text('إيقاف')),
                  ],
                ]),
                const SizedBox(height: 8),
                SizedBox(
                  width: double.infinity,
                  child: (isDoor ? FilledButton.icon : OutlinedButton.icon)(
                    onPressed: _busy || (node?.snapshotInFlight ?? false) ? null : _takeAll,
                    icon: (node?.snapshotInFlight ?? false)
                        ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Icon(Icons.download_for_offline_outlined),
                    label: const Text('خد كل البيانات من الأجهزة اللي حواليا'),
                  ),
                ),
              ]),
            ),
          ),
          if (running && mesh.pcWifiInfo != null) ...[
            const SizedBox(height: 12),
            _pcWifiCard(),
          ],
          const SizedBox(height: 12),
          Card(
            child: ListTile(
              leading: Icon(Icons.cloud_upload_outlined, color: uploader == null ? AppColors.muted : AppColors.primary),
              title: Text(uploader == null
                  ? 'مفيش جهاز رافع محدد'
                  : uploader == mesh.nodeId
                      ? 'الموبايل ده هو الرافع'
                      : 'الرافع: ${node?.peers[uploader]?.name ?? 'جهاز تاني'}'),
              subtitle: Text(mesh.isUploader
                  ? (mesh.uploading.value ? 'بيرفع دلوقتي...' : 'بيرفع عمليات كل الأجهزة أول ما يلاقي نت')
                  : 'الجهاز اللي بيرفع بيانات الكل لما النت يرجع'),
              trailing: widget.user.isAdmin ? TextButton(onPressed: _pickUploader, child: const Text('تغيير')) : null,
              onTap: mesh.isUploader && Connection.online.value
                  ? () => _run(() async {
                        final n = await mesh.uploadForOthers(force: true);
                        return n == 0 ? 'مفيش حاجة مستنية الرفع' : null;
                      }, success: 'اترفع')
                  : null,
            ),
          ),
          if (review.isNotEmpty) ...[
            const SizedBox(height: 16),
            Text('محتاج مراجعة (${review.length})', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
            const Padding(
              padding: EdgeInsets.only(top: 2, bottom: 8),
              child: Text('حضور متسجل مرتين والتاني معاه فلوس — مش هيترفع غير بقرار من الأدمن', style: TextStyle(color: AppColors.muted)),
            ),
            for (final e in review) _ReviewCard(entry: e, canDecide: widget.user.isAdmin),
          ],
          const SizedBox(height: 16),
          Text('الأجهزة (${peers.length})', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
          const SizedBox(height: 8),
          if (peers.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 24),
              child: Column(children: [
                Icon(Icons.devices_other, size: 46, color: AppColors.muted),
                SizedBox(height: 8),
                Text('لسه مفيش أجهزة ظهرت. شغّل الشبكة على الأجهزة التانية وقرّبهم من بعض.', textAlign: TextAlign.center, style: TextStyle(color: AppColors.muted)),
              ]),
            )
          else
            for (final p in peers) _PeerTile(peer: p, online: node!.isOnline(p), uploader: p.node == uploader, ago: _ago(p.lastSeen)),
        ]);
      },
    );
  }
}

class _PeerTile extends StatelessWidget {
  const _PeerTile({required this.peer, required this.online, required this.uploader, required this.ago});
  final MeshPeer peer;
  final bool online;
  final bool uploader;
  final String ago;

  @override
  Widget build(BuildContext context) {
    final (color, label) = !online
        ? (AppColors.muted, 'مش متصل • آخر ظهور $ago')
        : peer.direct
            ? switch (peer.quality) {
                3 => (AppColors.accent, 'متصل مباشرة • إشارة قوية'),
                2 => (AppColors.accent, 'متصل مباشرة • إشارة متوسطة'),
                1 => (AppColors.warning, 'متصل مباشرة • إشارة ضعيفة'),
                _ => (AppColors.accent, 'متصل مباشرة'),
              }
            : (const Color(0xFF0EA5E9), 'متصل عن طريق ${peer.hops - 1 <= 1 ? 'جهاز تاني' : '${peer.hops - 1} أجهزة'}');
    final bars = !online ? 0 : (peer.direct ? (peer.quality == 0 ? 2 : peer.quality) : 1);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Card(
        child: ListTile(
          leading: Stack(clipBehavior: Clip.none, children: [
            CircleAvatar(backgroundColor: color.withValues(alpha: .15), child: Icon(peer.role == 'الباب' ? Icons.door_front_door_outlined : Icons.phone_android, color: color)),
            Positioned(right: -2, bottom: -2, child: Container(width: 12, height: 12, decoration: BoxDecoration(color: online ? AppColors.accent : AppColors.muted, shape: BoxShape.circle, border: Border.all(color: Colors.white, width: 2)))),
          ]),
          title: Text(peer.name.isEmpty ? peer.node : peer.name, style: const TextStyle(fontWeight: FontWeight.w700)),
          subtitle: Text([label, if (peer.role.isNotEmpty) peer.role, if (uploader) 'الرافع', if (peer.pending > 0) 'مستني رفع ${peer.pending}', if (peer.rttMs != null && peer.direct) '${peer.rttMs}ms'].join(' • ')),
          trailing: Row(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.end, textDirection: TextDirection.ltr, children: [
            for (var i = 1; i <= 3; i++)
              Container(
                width: 5,
                height: 6.0 + i * 5,
                margin: const EdgeInsets.only(left: 2),
                decoration: BoxDecoration(color: i <= bars ? color : const Color(0xFFE5E7EB), borderRadius: BorderRadius.circular(2)),
              ),
          ]),
        ),
      ),
    );
  }
}

class _ReviewCard extends StatelessWidget {
  const _ReviewCard({required this.entry, required this.canDecide});
  final MeshEntry entry;
  final bool canDecide;

  @override
  Widget build(BuildContext context) {
    final d = entry['d'] as Map;
    final status = MeshService.instance.statusOf('${d['id']}');
    final first = status?.firstBy?['d'] as Map?;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Card(
        color: AppColors.warningSoft,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${d['label'] ?? d['id']}', style: const TextStyle(fontWeight: FontWeight.w800)),
            const SizedBox(height: 4),
            Text('التانية: ${d['user'] ?? ''} • دفع ${opMoney(entry)} ج'),
            if (first != null) Text('الأولى: ${first['user'] ?? ''} • دفع ${opMoney(status!.firstBy!)} ج'),
            if (canDecide) ...[
              const SizedBox(height: 8),
              Row(children: [
                FilledButton(onPressed: () => MeshService.instance.decide('${d['id']}', 'upload'), child: const Text('ارفعها برضه')),
                const SizedBox(width: 8),
                OutlinedButton(onPressed: () => MeshService.instance.decide('${d['id']}', 'dismiss'), child: const Text('تجاهلها')),
              ]),
            ] else
              const Padding(padding: EdgeInsets.only(top: 6), child: Text('الأدمن بس يقدر يقرر', style: TextStyle(color: AppColors.muted))),
          ]),
        ),
      ),
    );
  }
}
