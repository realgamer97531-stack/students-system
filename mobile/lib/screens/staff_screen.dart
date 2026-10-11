import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../config.dart';
import '../services/net.dart';
import '../services/session_store.dart';
import '../services/staff_store.dart';
import '../services/updater.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'staff/create_forms.dart';
import 'staff/scan_tabs.dart';
import 'staff/students_tab.dart';
import 'staff/videos_tab.dart';
import 'web_screen.dart';

/// شاشة الموظف: مسح الحضور/الواجب/الباب (بيشتغل من غير نت) + السيستم كامل
class StaffScreen extends StatefulWidget {
  const StaffScreen({super.key, required this.user, required this.onSwitchAccount});
  final StaffUser user;
  final VoidCallback onSwitchAccount;

  @override
  State<StaffScreen> createState() => _StaffScreenState();
}

class _StaffTab {
  const _StaffTab(this.label, this.icon, this.builder);
  final String label;
  final IconData icon;
  final WidgetBuilder builder;
}

class _StaffScreenState extends State<StaffScreen> {
  final _activeSession = ValueNotifier<int?>(null);
  late final StaffScanContext _ctx = StaffScanContext(user: widget.user, activeSession: _activeSession);
  late final List<_StaffTab> _tabs = _buildTabs();
  late final List<GlobalKey<NavigatorState>> _navKeys = List.generate(_tabs.length, (_) => GlobalKey<NavigatorState>());
  final _web = GlobalKey<WebScreenState>();
  int _tab = 0;

  /// التابات بتتبني أول ما تتفتح بس (السيستم مش بيحمّل غير لما الموظف يفتحه)
  final Set<int> _opened = {0};

  @override
  void initState() {
    super.initState();
    StaffStore.start();
    SessionStore.activeSessionId().then((id) {
      if (mounted) _activeSession.value = id;
    });
    _activeSession.addListener(() => SessionStore.setActiveSessionId(_activeSession.value));
    WidgetsBinding.instance.addPostFrameCallback((_) => Updater.checkAndPrompt(context, silent: true));
  }

  @override
  void dispose() {
    StaffStore.stop();
    _activeSession.dispose();
    super.dispose();
  }

  List<_StaffTab> _buildTabs() {
    final u = widget.user;
    return [
      if (u.can('attendance_scan')) _StaffTab('الحضور', Icons.how_to_reg_outlined, (_) => _ScanPage(ctx: _ctx, child: AttendanceTab(ctx: _ctx))),
      if (u.can('homework_scan')) _StaffTab('الواجب', Icons.assignment_turned_in_outlined, (_) => _ScanPage(ctx: _ctx, child: HomeworkScanTab(ctx: _ctx))),
      if (u.can('door_scan')) _StaffTab('الباب', Icons.door_front_door_outlined, (_) => _ScanPage(ctx: _ctx, child: DoorTab(ctx: _ctx))),
      if (u.can('students_view')) _StaffTab('الطلاب', Icons.groups_outlined, (_) => Scaffold(body: StudentsTab(openWeb: _openWeb, user: u, activeSession: _activeSession))),
      if (u.can('admin_videos')) _StaffTab('الفيديوهات', Icons.video_library_outlined, (_) => Scaffold(body: VideosTab(user: u, openWeb: _openWeb))),
      _StaffTab('السيستم', Icons.dashboard_outlined, (_) => WebScreen(
            key: _web,
            title: 'السيستم',
            url: _webStartUrl ?? '${AppConfig.staffWebBase}/sessions',
            showAppBar: false,
            autoLogin: true,
          )),
    ];
  }

  /// فتح صفحة معينة من السيستم في تابه
  void _openWeb(String path) {
    final i = _tabs.indexWhere((t) => t.label == 'السيستم');
    final url = '${AppConfig.staffWebBase}$path';
    final alreadyOpen = _opened.contains(i);
    setState(() {
      _tab = i;
      _opened.add(i);
      if (!alreadyOpen) _webStartUrl = url;
    });
    if (alreadyOpen) _web.currentState?.open(url);
  }

  String? _webStartUrl;

  Future<void> _onBack() async {
    final nav = _navKeys[_tab].currentState;
    if (nav != null) {
      final handled = await nav.maybePop();
      if (handled) return;
    }
    SystemNavigator.pop();
  }

  void _openSync() {
    showModalBottomSheet<void>(context: context, useRootNavigator: true, isScrollControlled: true, showDragHandle: true, builder: (_) => const _SyncSheet());
  }

  @override
  Widget build(BuildContext context) {
    final isWeb = _tabs[_tab].label == 'السيستم';
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _onBack();
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(widget.user.name.isEmpty ? 'Shady Elsharkawy' : widget.user.name),
          actions: [
            _SyncBadge(onTap: _openSync),
            if (isWeb) IconButton(onPressed: () => _web.currentState?.reload(), icon: const Icon(Icons.refresh), tooltip: 'إعادة تحميل'),
            PopupMenuButton<String>(
              onSelected: (value) {
                if (value == 'refresh') StaffStore.refreshSnapshot();
                if (value == 'update') Updater.checkAndPrompt(context);
                if (value == 'switch') widget.onSwitchAccount();
              },
              itemBuilder: (_) => const [
                PopupMenuItem(value: 'refresh', child: Text('تحديث بيانات المسح')),
                PopupMenuItem(value: 'update', child: Text('تحديثات البرنامج')),
                PopupMenuItem(value: 'switch', child: Text('تسجيل الخروج / تغيير الحساب')),
              ],
            ),
          ],
        ),
        body: Column(children: [
          ValueListenableBuilder<bool>(
            valueListenable: StaffStore.deviceRevoked,
            builder: (_, revoked, _) => revoked
                ? Container(
                    width: double.infinity,
                    color: AppColors.dangerSoft,
                    padding: const EdgeInsets.all(10),
                    child: const Text('⛔ الموبايل ده اتلغى تسجيله من السيستم — اعمل خروج وادخل تاني عشان أدمن يسجله', style: TextStyle(color: AppColors.dangerText, fontWeight: FontWeight.w700)),
                  )
                : const SizedBox.shrink(),
          ),
          Expanded(
            child: IndexedStack(index: _tab, children: [
              for (var i = 0; i < _tabs.length; i++)
                TickerMode(
                  enabled: i == _tab,
                  child: _opened.contains(i)
                      ? Navigator(key: _navKeys[i], onGenerateRoute: (_) => MaterialPageRoute(builder: _tabs[i].builder))
                      : const SizedBox.shrink(),
                ),
            ]),
          ),
        ]),
        bottomNavigationBar: _tabs.length < 2
            ? null
            : NavigationBar(
                selectedIndex: _tab,
                onDestinationSelected: (i) => setState(() {
                  _tab = i;
                  _opened.add(i);
                }),
                destinations: [for (final t in _tabs) NavigationDestination(icon: Icon(t.icon), label: t.label)],
              ),
      ),
    );
  }
}

/// صفحة مسح: الحصة المختارة فوق + الكاميرا
class _ScanPage extends StatelessWidget {
  const _ScanPage({required this.ctx, required this.child});
  final StaffScanContext ctx;
  final Widget child;
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(children: [
        _SessionPicker(ctx: ctx),
        Expanded(child: child),
      ]),
    );
  }
}

class _SessionPicker extends StatelessWidget {
  const _SessionPicker({required this.ctx});
  final StaffScanContext ctx;

  Future<void> _pick(BuildContext context) async {
    final id = await showModalBottomSheet<int>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _SessionList(selected: ctx.activeSession.value, user: ctx.user),
    );
    if (id != null) ctx.activeSession.value = id;
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: Listenable.merge([ctx.activeSession, StaffStore.snapshot, Connection.online]),
      builder: (context, _) {
        final snap = StaffStore.snapshot.value;
        final session = snap?.session(ctx.activeSession.value);
        final online = Connection.online.value;
        return Material(
          color: Colors.white,
          child: InkWell(
            onTap: () => _pick(context),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
              child: Row(children: [
                Icon(Icons.event_available, color: session == null ? AppColors.danger : AppColors.primary),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    const Text('الحصة الشغالة', style: TextStyle(color: AppColors.muted, fontSize: 12)),
                    Text(
                      session != null
                          ? snap!.sessionLabel(session)
                          : (ctx.activeSession.value != null ? 'حصة رقم ${ctx.activeSession.value}' : 'اضغط هنا واختار الحصة'),
                      style: const TextStyle(fontWeight: FontWeight.w800),
                    ),
                  ]),
                ),
                Icon(online ? Icons.cloud_done_outlined : Icons.cloud_off_outlined, color: online ? AppColors.successText : AppColors.warningText),
                const Icon(Icons.arrow_drop_down),
              ]),
            ),
          ),
        );
      },
    );
  }
}

class _SessionList extends StatefulWidget {
  const _SessionList({required this.selected, required this.user});
  final int? selected;
  final StaffUser user;
  @override
  State<_SessionList> createState() => _SessionListState();
}

class _SessionListState extends State<_SessionList> {
  String _q = '';
  bool _refreshing = false;

  Future<void> _refresh() async {
    setState(() => _refreshing = true);
    final ok = await StaffStore.refreshSnapshot();
    if (!mounted) return;
    setState(() => _refreshing = false);
    if (!ok) toast(context, 'مش قادر يحدّث — اتأكد من النت', error: true);
  }

  Future<void> _newSession() async {
    final id = await showModalBottomSheet<int>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => NewSessionSheet(user: widget.user),
    );
    if (id != null && mounted) Navigator.pop(context, id);
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.8,
        child: ValueListenableBuilder<Snapshot?>(
          valueListenable: StaffStore.snapshot,
          builder: (context, snap, _) {
            final sessions = (snap?.sessions ?? []).where((s) => _q.isEmpty || snap!.sessionLabel(s).contains(_q)).toList();
            return Column(children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: Row(children: [
                  Expanded(
                    child: TextField(
                      decoration: const InputDecoration(hintText: 'دور (رقم الحصة، السنتر، المادة)', isDense: true, prefixIcon: Icon(Icons.search)),
                      onChanged: (v) => setState(() => _q = v.trim()),
                    ),
                  ),
                  IconButton(
                    onPressed: _refreshing ? null : _refresh,
                    icon: _refreshing ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.refresh),
                    tooltip: 'تحديث',
                  ),
                ]),
              ),
              if (widget.user.can('sessions_create'))
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: OutlinedButton.icon(
                    onPressed: _newSession,
                    icon: const Icon(Icons.add),
                    label: const Text('بدء حصة جديدة (محتاج نت)'),
                  ),
                ),
              Expanded(
                child: snap == null
                    ? const Center(child: Text('مفيش بيانات لسه — اضغط تحديث وفيه نت'))
                    : ListView.builder(
                        itemCount: sessions.length,
                        itemBuilder: (_, i) {
                          final s = sessions[i];
                          final id = (s['id'] as num).toInt();
                          return ListTile(
                            selected: id == widget.selected,
                            leading: CircleAvatar(child: Text('${s['lesson_number'] ?? ''}')),
                            title: Text(snap.sessionLabel(s)),
                            subtitle: Text('سيريال ${s['serial_number'] ?? '-'}'),
                            onTap: () => Navigator.pop(context, id),
                          );
                        },
                      ),
              ),
            ]);
          },
        ),
      ),
    );
  }
}

class _SyncBadge extends StatelessWidget {
  const _SyncBadge({required this.onTap});
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: Listenable.merge([StaffStore.queue, StaffStore.problems, StaffStore.syncing]),
      builder: (context, _) {
        final pending = StaffStore.queue.value.length;
        final problems = StaffStore.problems.value.length;
        return IconButton(
          tooltip: 'العمليات المستنية',
          onPressed: onTap,
          icon: Badge(
            isLabelVisible: pending + problems > 0,
            backgroundColor: problems > 0 ? AppColors.danger : AppColors.warning,
            label: Text('${problems > 0 ? problems : pending}'),
            child: Icon(StaffStore.syncing.value ? Icons.sync : (pending > 0 ? Icons.cloud_upload_outlined : Icons.cloud_done_outlined)),
          ),
        );
      },
    );
  }
}

class _SyncSheet extends StatelessWidget {
  const _SyncSheet();
  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.75,
        child: ListenableBuilder(
          listenable: Listenable.merge([StaffStore.queue, StaffStore.problems, StaffStore.snapshotAt, StaffStore.syncing]),
          builder: (context, _) {
            final queue = StaffStore.queue.value;
            final problems = StaffStore.problems.value;
            final at = StaffStore.snapshotAt.value;
            return ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 16), children: [
              Text(at == null ? 'بيانات المسح: لسه متنزلتش' : 'آخر تحديث لبيانات المسح: ${fmtAgo(at)}', style: const TextStyle(color: AppColors.muted)),
              const SizedBox(height: 10),
              Row(children: [
                Expanded(child: Text('مستني يتبعت (${queue.length})', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16))),
                if (queue.isNotEmpty)
                  FilledButton.icon(
                    style: FilledButton.styleFrom(minimumSize: const Size(0, 40)),
                    onPressed: StaffStore.syncing.value ? null : StaffStore.flush,
                    icon: const Icon(Icons.send),
                    label: const Text('ابعت دلوقتي'),
                  ),
              ]),
              if (queue.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('✅ كل حاجة اتبعتت', style: TextStyle(color: AppColors.successText))),
              for (final op in queue)
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.schedule, color: AppColors.warning),
                  title: Text('${op['label']}'),
                  subtitle: Text(fmtDate(DateTime.fromMillisecondsSinceEpoch(op['clientTime'] as int).toIso8601String(), withTime: true)),
                ),
              const Divider(height: 28),
              Text('اترفضت من السيرفر (${problems.length})', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
              const Text('عمليات اتعملت من غير نت والسيرفر رفضها (مثلاً رصيد مش كفاية) — لازم تتراجع يدوي.', style: TextStyle(color: AppColors.muted, fontSize: 12.5)),
              for (final p in problems)
                Card(
                  color: AppColors.dangerSoft,
                  child: ListTile(
                    title: Text('${p['label']}', style: const TextStyle(fontWeight: FontWeight.w700)),
                    subtitle: Text('${p['message']}\n${p['clientTime'] is int ? fmtDate(DateTime.fromMillisecondsSinceEpoch(p['clientTime'] as int).toIso8601String(), withTime: true) : ''}'),
                    trailing: IconButton(icon: const Icon(Icons.close), tooltip: 'تمام، اتراجعت', onPressed: () => StaffStore.dismissProblem('${p['id']}')),
                  ),
                ),
            ]);
          },
        ),
      ),
    );
  }
}
