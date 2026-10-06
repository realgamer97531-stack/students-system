import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/date_symbol_data_local.dart';

import 'screens/login_screen.dart';
import 'screens/portal_home.dart';
import 'screens/staff_screen.dart';
import 'services/session_store.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await initializeDateFormatting('ar');
  final type = await SessionStore.type();
  runApp(StudyisfunnyApp(initialType: type));
}

class StudyisfunnyApp extends StatefulWidget {
  const StudyisfunnyApp({super.key, this.initialType});
  final AccountType? initialType;

  @override
  State<StudyisfunnyApp> createState() => _StudyisfunnyAppState();
}

class _StudyisfunnyAppState extends State<StudyisfunnyApp> {
  final _navigatorKey = GlobalKey<NavigatorState>();
  late AccountType? _type = widget.initialType;

  Future<void> _logout() async {
    await SessionStore.clear();
    _navigatorKey.currentState?.popUntil((r) => r.isFirst);
    setState(() => _type = null);
  }

  @override
  Widget build(BuildContext context) {
    final Widget home = switch (_type) {
      null => LoginScreen(onLoggedIn: (t) => setState(() => _type = t)),
      AccountType.staff => StaffScreen(onSwitchAccount: _logout),
      final t => PortalHome(key: ValueKey(t), type: t, onLogout: _logout),
    };
    return MaterialApp(
      navigatorKey: _navigatorKey,
      title: 'Studyisfunny',
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
