import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../config.dart';
import '../../services/outbox.dart';
import '../../services/session_store.dart';
import '../../services/updater.dart';
import '../../theme.dart';
import '../../widgets/ads.dart';
import '../../widgets/broadcasts.dart';
import '../../widgets/common.dart';
import 'booklets_screen.dart';
import 'home_tab.dart';
import 'homework_screen.dart';
import 'lessons_screen.dart';
import 'portal_data.dart';
import 'sessions_tab.dart';

class _Tab {
  const _Tab(this.label, this.icon, this.selectedIcon, this.builder);
  final String label;
  final IconData icon, selectedIcon;
  final WidgetBuilder builder;
}

/// الشاشة الرئيسية للطالب وولي الأمر.
/// كل تاب ليه "مسار" لوحده، فالشريط اللي تحت بيفضل ظاهر في كل الصفحات (حتى جوه الفيديو)،
/// وتقدر تتنقل لأي صفحة تانية في أي وقت.
class PortalShell extends StatefulWidget {
  const PortalShell({super.key, required this.type, required this.onLogout});
  final AccountType type;
  final VoidCallback onLogout;

  @override
  State<PortalShell> createState() => _PortalShellState();
}

class _PortalShellState extends State<PortalShell> {
  late final PortalData _portal = PortalData(widget.type, onUnauthorized: widget.onLogout);
  late final List<_Tab> _tabs = _buildTabs();
  late final List<GlobalKey<NavigatorState>> _navKeys = List.generate(_tabs.length, (_) => GlobalKey<NavigatorState>());
  int _tab = 0;

  bool get _isStudent => widget.type == AccountType.student;

  @override
  void initState() {
    super.initState();
    _portal.start();
    if (_isStudent) Outbox.start();
    WidgetsBinding.instance.addPostFrameCallback((_) => Updater.checkAndPrompt(context, silent: true));
  }

  @override
  void dispose() {
    if (_isStudent) Outbox.stop();
    _portal.dispose();
    super.dispose();
  }

  List<_Tab> _buildTabs() {
    final home = _Tab('الرئيسية', Icons.home_outlined, Icons.home, (_) => _HomePage(portal: _portal));
    final sessions = _Tab(_isStudent ? 'حصصي' : 'الحصص', Icons.event_note_outlined, Icons.event_note, (_) => _SessionsPage(portal: _portal));
    final more = _Tab('المزيد', Icons.apps_outlined, Icons.apps, (_) => _MorePage(portal: _portal, onLogout: _confirmLogout));
    if (!_isStudent) {
      return [home, sessions, _Tab('المعاملات', Icons.receipt_long_outlined, Icons.receipt_long, (_) => _TransactionsPage(portal: _portal)), more];
    }
    return [
      home,
      sessions,
      _Tab('الفيديوهات', Icons.play_circle_outline, Icons.play_circle, (_) => LessonsScreen(onUnauthorized: widget.onLogout)),
      _Tab('الواجب', Icons.assignment_outlined, Icons.assignment, (_) => HomeworkScreen(onUnauthorized: widget.onLogout)),
      more,
    ];
  }

  Future<void> _confirmLogout() async {
    final ok = await confirmDialog(context, title: 'تسجيل الخروج', message: 'متأكد إنك عايز تخرج؟ البيانات المحفوظة على الموبايل هتتمسح.', ok: 'خروج');
    if (ok) widget.onLogout();
  }

  void _select(int i) {
    if (i == _tab) {
      _navKeys[i].currentState?.popUntil((r) => r.isFirst);
      return;
    }
    setState(() => _tab = i);
  }

  Future<void> _onBack() async {
    final nav = _navKeys[_tab].currentState;
    if (nav != null && nav.canPop()) {
      await nav.maybePop();
      return;
    }
    if (_tab != 0) {
      setState(() => _tab = 0);
      return;
    }
    SystemNavigator.pop();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _onBack();
      },
      child: Scaffold(
        body: IndexedStack(
          index: _tab,
          children: [
            for (var i = 0; i < _tabs.length; i++)
              TickerMode(
                enabled: i == _tab,
                child: Navigator(
                  key: _navKeys[i],
                  onGenerateRoute: (_) => MaterialPageRoute(builder: _tabs[i].builder),
                ),
              ),
          ],
        ),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _tab,
          onDestinationSelected: _select,
          destinations: [
            for (final t in _tabs) NavigationDestination(icon: Icon(t.icon), selectedIcon: Icon(t.selectedIcon), label: t.label),
          ],
        ),
      ),
    );
  }
}

/// غلاف للصفحات اللي معتمدة على بيانات الطالب الأساسية
class _PortalBody extends StatelessWidget {
  const _PortalBody({required this.portal, required this.builder});
  final PortalData portal;
  final Widget Function() builder;
  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: portal,
      builder: (context, _) {
        if (portal.data == null) {
          if (portal.loading) return const Center(child: CircularProgressIndicator());
          return ErrorView(message: portal.error ?? 'حصلت مشكلة', onRetry: portal.refresh);
        }
        return Column(children: [
          if (portal.stale && portal.error != null) OfflineBanner(savedAt: portal.savedAt),
          Expanded(child: RefreshIndicator(onRefresh: portal.refresh, child: builder())),
        ]);
      },
    );
  }
}

class _HomePage extends StatefulWidget {
  const _HomePage({required this.portal});
  final PortalData portal;
  @override
  State<_HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<_HomePage> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => Ads.showFor(context, widget.portal.type, widget.portal.isStudent ? 'student' : 'parent'),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.portal.isStudent ? 'بياناتي' : 'متابعة ولي الأمر')),
      floatingActionButton: widget.portal.isStudent ? const BroadcastsButton(page: 'student') : null,
      body: _PortalBody(portal: widget.portal, builder: () => HomeTab(portal: widget.portal)),
    );
  }
}

class _SessionsPage extends StatefulWidget {
  const _SessionsPage({required this.portal});
  final PortalData portal;
  @override
  State<_SessionsPage> createState() => _SessionsPageState();
}

class _SessionsPageState extends State<_SessionsPage> {
  @override
  void initState() {
    super.initState();
    if (widget.portal.isStudent) {
      WidgetsBinding.instance.addPostFrameCallback((_) => Ads.showFor(context, AccountType.student, 'sessions'));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.portal.isStudent ? 'حصصي' : 'الحصص')),
      floatingActionButton: widget.portal.isStudent ? const BroadcastsButton(page: 'sessions') : null,
      body: _PortalBody(portal: widget.portal, builder: () => SessionsList(sessions: widget.portal.sessions)),
    );
  }
}

class _TransactionsPage extends StatelessWidget {
  const _TransactionsPage({required this.portal});
  final PortalData portal;
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('المعاملات')),
      body: _PortalBody(portal: portal, builder: () => TransactionsList(transactions: portal.transactions)),
    );
  }
}

class _MorePage extends StatelessWidget {
  const _MorePage({required this.portal, required this.onLogout});
  final PortalData portal;
  final VoidCallback onLogout;

  @override
  Widget build(BuildContext context) {
    Widget item(IconData icon, String title, String subtitle, VoidCallback onTap, {Color color = AppColors.primary}) => Card(
          child: ListTile(
            leading: CircleAvatar(backgroundColor: color.withValues(alpha: 0.12), child: Icon(icon, color: color)),
            title: Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
            subtitle: Text(subtitle),
            trailing: const Icon(Icons.chevron_left),
            onTap: onTap,
          ),
        );
    void push(Widget page) => Navigator.of(context).push(MaterialPageRoute(builder: (_) => page));
    return Scaffold(
      appBar: AppBar(title: const Text('المزيد')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        if (portal.isStudent) ...[
          item(Icons.menu_book_outlined, 'البوكليتس', 'المدفوع والمتبقي وحالة الاستلام', () => push(BookletsScreen(onUnauthorized: portal.onUnauthorized))),
          const SizedBox(height: 8),
          item(Icons.receipt_long_outlined, 'كشف الحساب', 'الشحن والمدفوعات', () => push(_TransactionsPage(portal: portal))),
          const SizedBox(height: 8),
        ],
        item(Icons.chat_outlined, 'تواصل معانا', 'واتساب الدعم',
            () => launchUrl(Uri.parse('https://wa.me/${AppConfig.supportWhatsapp}'), mode: LaunchMode.externalApplication),
            color: AppColors.accent),
        const SizedBox(height: 8),
        item(Icons.system_update, 'تحديثات البرنامج', 'دور على إصدار جديد', () => Updater.checkAndPrompt(context), color: AppColors.warning),
        const SizedBox(height: 8),
        item(Icons.logout, 'تسجيل الخروج', 'الخروج من الحساب ده', onLogout, color: AppColors.danger),
        const SizedBox(height: 18),
        FutureBuilder<String>(
          future: Updater.currentVersion(),
          builder: (_, snap) => Text('إصدار ${snap.data ?? ''}', textAlign: TextAlign.center, style: const TextStyle(color: AppColors.muted)),
        ),
      ]),
    );
  }
}
