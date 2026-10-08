import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/date_symbol_data_local.dart';

import 'screens/login_screen.dart';
import 'screens/portal/portal_shell.dart';
import 'screens/staff_screen.dart';
import 'services/cache.dart';
import 'services/net.dart';
import 'services/outbox.dart';
import 'services/session_store.dart';
import 'services/staff_store.dart';
import 'theme.dart';
import 'widgets/ads.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await initializeDateFormatting('ar');
  await Connection.start();
  final session = await AppSession.restore();
  runApp(StudyisfunnyApp(initial: session));
}

/// الحساب اللي داخل دلوقتي (بيفضل محفوظ لحد ما المستخدم يعمل خروج بنفسه)
class AppSession {
  AppSession(this.type, {this.staff});
  final AccountType type;
  final StaffUser? staff;

  static Future<AppSession?> restore() async {
    final type = await SessionStore.type();
    if (type == null) return null;
    if (type == AccountType.staff) {
      final user = await SessionStore.staffUser();
      return user == null ? null : AppSession(type, staff: user);
    }
    final code = await SessionStore.studentCode();
    if (code == null || await SessionStore.token() == null) return null;
    Cache.setScope('${type.name}_$code');
    return AppSession(type);
  }
}

class StudyisfunnyApp extends StatefulWidget {
  const StudyisfunnyApp({super.key, this.initial});
  final AppSession? initial;

  @override
  State<StudyisfunnyApp> createState() => _StudyisfunnyAppState();
}

class _StudyisfunnyAppState extends State<StudyisfunnyApp> with WidgetsBindingObserver {
  final _navigatorKey = GlobalKey<NavigatorState>();
  late AppSession? _session = widget.initial;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // البرنامج رجع قدام: نبعت أي حاجة كانت مستنية
    if (state == AppLifecycleState.resumed) {
      if (_session?.type == AccountType.staff) {
        StaffStore.flush();
      } else if (_session?.type == AccountType.student) {
        Outbox.flush();
      }
    }
  }

  Future<void> _logout() async {
    final type = _session?.type;
    if (type != null && type != AccountType.staff) await Cache.clearScope();
    await SessionStore.clear();
    Ads.reset();
    _navigatorKey.currentState?.popUntil((r) => r.isFirst);
    if (mounted) setState(() => _session = null);
  }

  Future<void> _loggedIn(AccountType type) async {
    final session = await AppSession.restore();
    if (mounted) setState(() => _session = session ?? AppSession(type));
  }

  @override
  Widget build(BuildContext context) {
    final s = _session;
    final Widget home = switch (s?.type) {
      null => LoginScreen(onLoggedIn: _loggedIn),
      AccountType.staff => StaffScreen(key: ValueKey('staff_${s!.staff?.id}'), user: s.staff!, onSwitchAccount: _logout),
      final t => PortalShell(key: ValueKey(t), type: t, onLogout: _logout),
    };
    return MaterialApp(
      navigatorKey: _navigatorKey,
      title: 'Shady Elsharkawy',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      locale: const Locale('ar'),
      supportedLocales: const [Locale('ar'), Locale('en')],
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      home: home,
    );
  }
}
