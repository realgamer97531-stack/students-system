import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:intl/intl.dart' show DateFormat;
import 'package:url_launcher/url_launcher.dart';

import '../config.dart';
import '../services/api.dart';
import '../services/session_store.dart';
import '../services/updater.dart';
import '../theme.dart';
import 'web_screen.dart';

/// الشاشة الرئيسية للطالب وولي الأمر
class PortalHome extends StatefulWidget {
  const PortalHome({super.key, required this.type, required this.onLogout});
  final AccountType type;
  final VoidCallback onLogout;

  @override
  State<PortalHome> createState() => _PortalHomeState();
}

class _PortalHomeState extends State<PortalHome> {
  int _tab = 0;
  Map<String, dynamic>? _data;
  String? _qrSvg;
  Map<String, dynamic>? _rank;
  String? _error;
  bool _loading = true;

  bool get _isStudent => widget.type == AccountType.student;

  @override
  void initState() {
    super.initState();
    _load();
    WidgetsBinding.instance.addPostFrameCallback((_) => Updater.checkAndPrompt(context, silent: true));
  }

  Future<void> _load() async {
    setState(() { _loading = _data == null; _error = null; });
    try {
      final data = await PortalApi.studentData(widget.type);
      String? qr;
      Map<String, dynamic>? rank;
      if (_isStudent) {
        qr = await PortalApi.qrSvg().catchError((_) => null);
        rank = await PortalApi.leaderboard().then<Map<String, dynamic>?>((r) => r).catchError((_) => null);
      }
      if (!mounted) return;
      setState(() { _data = data; _qrSvg = qr; _rank = rank; });
    } on ApiException catch (e) {
      if (e.unauthorized) {
        widget.onLogout();
        return;
      }
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _openWeb(String title, String page) async {
    final token = await SessionStore.token();
    final code = await SessionStore.studentCode();
    if (!mounted) return;
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => WebScreen(
        title: title,
        url: '${AppConfig.portalWebBase}/$page',
        portalLogin: {
          'portal_token': token ?? '',
          'portal_type': widget.type.name,
          'student_code': code ?? '',
          'portal_lang': 'ar',
        },
        onLoggedOut: () {
          Navigator.of(context).popUntil((r) => r.isFirst);
          widget.onLogout();
        },
      ),
    ));
  }

  Future<void> _confirmLogout() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('تسجيل الخروج'),
        content: const Text('متأكد إنك عايز تخرج؟'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('لأ')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('خروج')),
        ],
      ),
    );
    if (ok == true) widget.onLogout();
  }

  @override
  Widget build(BuildContext context) {
    final titles = ['الرئيسية', 'حصصي', 'المعاملات', 'المزيد'];
    return Scaffold(
      appBar: AppBar(title: Text(titles[_tab])),
      body: _buildBody(),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home), label: 'الرئيسية'),
          NavigationDestination(icon: Icon(Icons.event_note_outlined), selectedIcon: Icon(Icons.event_note), label: 'حصصي'),
          NavigationDestination(icon: Icon(Icons.receipt_long_outlined), selectedIcon: Icon(Icons.receipt_long), label: 'المعاملات'),
          NavigationDestination(icon: Icon(Icons.apps_outlined), selectedIcon: Icon(Icons.apps), label: 'المزيد'),
        ],
      ),
    );
  }

  Widget _buildBody() {
    if (_tab == 3) return _MoreTab(isStudent: _isStudent, openWeb: _openWeb, onLogout: _confirmLogout);
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_data == null) {
      return _ErrorView(message: _error ?? 'حصلت مشكلة', onRetry: _load);
    }
    final child = switch (_tab) {
      0 => _HomeTab(data: _data!, qrSvg: _qrSvg, rank: _rank, isStudent: _isStudent),
      1 => _SessionsTab(sessions: (_data!['sessions'] as List? ?? []).cast<Map<String, dynamic>>()),
      _ => _TransactionsTab(transactions: (_data!['transactions'] as List? ?? []).cast<Map<String, dynamic>>()),
    };
    return RefreshIndicator(onRefresh: _load, child: child);
  }
}

// ===== أدوات مشتركة =====

String _num(dynamic v) {
  final n = v is num ? v : num.tryParse('$v') ?? 0;
  return n == n.roundToDouble() ? n.round().toString() : n.toStringAsFixed(1);
}

String _date(dynamic v, {bool withTime = false}) {
  if (v == null) return '-';
  final d = DateTime.tryParse('$v');
  if (d == null) return '$v';
  return DateFormat(withTime ? 'd/M/yyyy – h:mm a' : 'd/M/yyyy', 'ar').format(d.toLocal());
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Icon(Icons.cloud_off_rounded, size: 56, color: AppColors.muted),
          const SizedBox(height: 14),
          Text(message, textAlign: TextAlign.center, style: const TextStyle(fontSize: 16)),
          const SizedBox(height: 18),
          FilledButton.icon(onPressed: onRetry, icon: const Icon(Icons.refresh), label: const Text('حاول تاني')),
        ]),
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge(this.text, this.bg, this.fg);
  final String text;
  final Color bg, fg;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
        child: Text(text, style: TextStyle(color: fg, fontSize: 12.5, fontWeight: FontWeight.w700)),
      );
}

// ===== الرئيسية =====

class _HomeTab extends StatelessWidget {
  const _HomeTab({required this.data, required this.qrSvg, required this.rank, required this.isStudent});
  final Map<String, dynamic> data;
  final String? qrSvg;
  final Map<String, dynamic>? rank;
  final bool isStudent;

  @override
  Widget build(BuildContext context) {
    final s = (data['student'] as Map?)?.cast<String, dynamic>() ?? {};
    final sessions = (data['sessions'] as List? ?? []).cast<Map<String, dynamic>>();
    final attended = sessions.where((x) => x['attendanceStatus'] == 'attended').length;
    final absent = sessions.where((x) => x['attendanceStatus'] == 'absent').length;
    final warnings = (s['warnings'] as List? ?? []).cast<Map<String, dynamic>>();
    final assistant = (s['followUpAssistant'] as Map?)?.cast<String, dynamic>();
    final balance = (s['balance'] as num?) ?? 0;
    final photo = s['profilePhotoUrl'] as String?;

    return ListView(padding: const EdgeInsets.all(16), children: [
      Container(
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          gradient: const LinearGradient(colors: [AppColors.primaryDark, AppColors.primary]),
          borderRadius: BorderRadius.circular(20),
        ),
        child: Row(children: [
          CircleAvatar(
            radius: 32,
            backgroundColor: Colors.white24,
            backgroundImage: photo != null && photo.startsWith('http') ? NetworkImage(photo) : null,
            child: photo != null && photo.startsWith('http') ? null : const Icon(Icons.person, color: Colors.white, size: 34),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(s['name']?.toString() ?? '', style: const TextStyle(color: Colors.white, fontSize: 19, fontWeight: FontWeight.w800)),
              Text('${s['subjectName'] ?? ''} • ${s['centerName'] ?? ''}', style: const TextStyle(color: Colors.white70)),
              const SizedBox(height: 4),
              Text(s['studentCode']?.toString() ?? '', textDirection: TextDirection.ltr, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
            ]),
          ),
        ]),
      ),
      const SizedBox(height: 14),
      if (s['isBlocked'] == true)
        Padding(
          padding: const EdgeInsets.only(bottom: 14),
          child: Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(color: AppColors.dangerSoft, borderRadius: BorderRadius.circular(14)),
            child: const Text('⛔ الحساب ده محظور — تواصل مع الإدارة', style: TextStyle(color: AppColors.dangerText, fontWeight: FontWeight.w700)),
          ),
        ),
      Row(children: [
        _stat('الرصيد', '${_num(balance)} ج', Icons.account_balance_wallet_outlined, balance < 0 ? AppColors.danger : AppColors.successText),
        const SizedBox(width: 10),
        _stat('النقط', _num(s['points'] ?? 0), Icons.star_rounded, AppColors.warning),
      ]),
      const SizedBox(height: 10),
      Row(children: [
        _stat('حضور', '$attended', Icons.check_circle_outline, AppColors.accent),
        const SizedBox(width: 10),
        _stat('غياب', '$absent', Icons.cancel_outlined, AppColors.danger),
      ]),
      if (rank != null && rank!['myRank'] != null) ...[
        const SizedBox(height: 14),
        Card(
          child: ListTile(
            leading: const CircleAvatar(backgroundColor: AppColors.warningSoft, child: Icon(Icons.emoji_events, color: AppColors.warning)),
            title: Text('ترتيبك: ${rank!['myRank']} من ${rank!['total']}', style: const TextStyle(fontWeight: FontWeight.w700)),
            subtitle: Text(((rank!['top3'] as List?) ?? [])
                .map((t) => '${t['rank']}. ${t['name']} (${t['points']})')
                .join('   ')),
          ),
        ),
      ],
      if (isStudent && qrSvg != null) ...[
        const SizedBox(height: 14),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(children: [
              const Text('كود الحضور', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
              const Text('ورّي الكود ده للأسيستانت عشان يسجل حضورك', style: TextStyle(color: AppColors.muted, fontSize: 13)),
              const SizedBox(height: 12),
              SvgPicture.string(qrSvg!, width: 220, height: 220),
              const SizedBox(height: 8),
              Text(s['studentCode']?.toString() ?? '', textDirection: TextDirection.ltr, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800, letterSpacing: 1)),
            ]),
          ),
        ),
      ],
      if (assistant != null && (assistant['name'] ?? '').toString().isNotEmpty) ...[
        const SizedBox(height: 14),
        Card(
          child: ListTile(
            leading: const CircleAvatar(backgroundColor: AppColors.neutralSoft, child: Icon(Icons.support_agent, color: AppColors.primary)),
            title: Text('مسؤول المتابعة: ${assistant['name']}', style: const TextStyle(fontWeight: FontWeight.w700)),
            subtitle: assistant['phone'] != null ? Text('${assistant['phone']}', textDirection: TextDirection.ltr, textAlign: TextAlign.right) : null,
            trailing: assistant['phone'] != null
                ? IconButton(
                    icon: const Icon(Icons.call, color: AppColors.accent),
                    onPressed: () => launchUrl(Uri.parse('tel:${assistant['phone']}')),
                  )
                : null,
          ),
        ),
      ],
      if (warnings.isNotEmpty) ...[
        const SizedBox(height: 14),
        Card(
          color: AppColors.warningSoft,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('⚠️ إنذارات (${warnings.length})', style: const TextStyle(fontWeight: FontWeight.w800, color: AppColors.warningText)),
              const SizedBox(height: 6),
              ...warnings.map((w) => Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text('• ${w['reason'] ?? ''} — ${_date(w['time'])}', style: const TextStyle(color: AppColors.warningText)),
                  )),
            ]),
          ),
        ),
      ],
      const SizedBox(height: 24),
    ]);
  }

  Widget _stat(String label, String value, IconData icon, Color color) => Expanded(
        child: Card(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
            child: Row(children: [
              Icon(icon, color: color, size: 30),
              const SizedBox(width: 10),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(label, style: const TextStyle(color: AppColors.muted, fontSize: 13)),
                  Text(value, style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: color)),
                ]),
              ),
            ]),
          ),
        ),
      );
}

// ===== الحصص =====

class _SessionsTab extends StatelessWidget {
  const _SessionsTab({required this.sessions});
  final List<Map<String, dynamic>> sessions;

  static const _hw = {
    'complete': ('الواجب كامل', AppColors.successSoft, AppColors.successText),
    'incomplete': ('الواجب مش كامل', AppColors.warningSoft, AppColors.warningText),
    'no_steps': ('من غير خطوات', AppColors.neutralSoft, AppColors.muted),
    'not_done': ('الواجب مش معمول', AppColors.dangerSoft, AppColors.dangerText),
  };

  @override
  Widget build(BuildContext context) {
    if (sessions.isEmpty) {
      return ListView(children: const [SizedBox(height: 120), Center(child: Text('لسه مفيش حصص', style: TextStyle(color: AppColors.muted)))]);
    }
    final list = sessions.reversed.toList();
    return ListView.separated(
      padding: const EdgeInsets.all(16),
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
                Text(_date(s['date']), style: const TextStyle(color: AppColors.muted, fontSize: 13)),
                const Spacer(),
                _Badge(label, bg, fg),
              ]),
              if (status == 'attended') ...[
                const SizedBox(height: 6),
                Text(
                  [
                    if (s['attendedCenterName'] != null) 'في ${s['attendedCenterName']}',
                    if (s['attendanceTime'] != null) _date(s['attendanceTime'], withTime: true),
                    if ((s['payment'] ?? 0) is num && (s['payment'] ?? 0) > 0) 'دفع ${_num(s['payment'])} ج',
                  ].join(' • '),
                  style: const TextStyle(color: AppColors.muted, fontSize: 13),
                ),
              ],
              if (hw != null || examScore != null) ...[
                const SizedBox(height: 10),
                Wrap(spacing: 8, runSpacing: 6, children: [
                  if (hw != null) _Badge(hw.$1, hw.$2, hw.$3),
                  if (examScore != null)
                    _Badge('الامتحان: ${_num(examScore)} / ${_num(s['examMax'] ?? 0)}', const Color(0xFFE0F2FE), const Color(0xFF0369A1)),
                ]),
              ],
              if (stats != null) ...[
                const SizedBox(height: 6),
                Text('أعلى درجة ${_num(stats['max'])} • متوسط ${stats['avg']} • أقل ${_num(stats['min'])}',
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

// ===== المعاملات =====

class _TransactionsTab extends StatelessWidget {
  const _TransactionsTab({required this.transactions});
  final List<Map<String, dynamic>> transactions;

  @override
  Widget build(BuildContext context) {
    final money = transactions.where((t) => !('${t['reason'] ?? ''}').startsWith('نقاط:')).toList();
    if (money.isEmpty) {
      return ListView(children: const [SizedBox(height: 120), Center(child: Text('مفيش معاملات', style: TextStyle(color: AppColors.muted)))]);
    }
    return ListView.separated(
      padding: const EdgeInsets.all(16),
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
            subtitle: Text(_date(t['time'], withTime: true)),
            trailing: Text(
              '${positive ? '+' : ''}${_num(amount)} ج',
              textDirection: TextDirection.ltr,
              style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16, color: positive ? AppColors.successText : AppColors.dangerText),
            ),
          ),
        );
      },
    );
  }
}

// ===== المزيد =====

class _MoreTab extends StatelessWidget {
  const _MoreTab({required this.isStudent, required this.openWeb, required this.onLogout});
  final bool isStudent;
  final Future<void> Function(String title, String page) openWeb;
  final VoidCallback onLogout;

  @override
  Widget build(BuildContext context) {
    Widget item(IconData icon, String title, String subtitle, VoidCallback onTap, {Color color = AppColors.primary}) => Card(
          child: ListTile(
            leading: CircleAvatar(backgroundColor: color.withValues(alpha: 0.12), child: Icon(icon, color: color)),
            title: Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
            subtitle: Text(subtitle),
            trailing: const Icon(Icons.chevron_right),
            onTap: onTap,
          ),
        );
    return ListView(padding: const EdgeInsets.all(16), children: [
      if (isStudent) ...[
        item(Icons.play_circle_outline, 'الفيديوهات', 'شرح الحصص والأسئلة', () => openWeb('الفيديوهات', 'lessons.html')),
        const SizedBox(height: 8),
        item(Icons.assignment_outlined, 'الواجب', 'تسليم الواجب أونلاين', () => openWeb('الواجب', 'homework.html')),
        const SizedBox(height: 8),
        item(Icons.menu_book_outlined, 'البوكليتس', 'حجز ودفع البوكليتس', () => openWeb('البوكليتس', 'booklets.html')),
        const SizedBox(height: 8),
        item(Icons.language, 'صفحتي على الموقع', 'كل حاجة زي الموقع بالظبط (الشحن، الصورة...)', () => openWeb('صفحتي', 'student.html')),
      ] else
        item(Icons.language, 'صفحة ولي الأمر على الموقع', 'كل التفاصيل زي الموقع بالظبط', () => openWeb('ولي الأمر', 'parent.html')),
      const SizedBox(height: 8),
      item(Icons.chat_outlined, 'تواصل معانا', 'واتساب الدعم', () => launchUrl(Uri.parse('https://wa.me/${AppConfig.supportWhatsapp}'), mode: LaunchMode.externalApplication),
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
    ]);
  }
}
