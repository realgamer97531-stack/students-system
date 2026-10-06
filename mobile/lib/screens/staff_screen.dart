import 'package:flutter/material.dart';

import '../config.dart';
import '../services/updater.dart';
import 'web_screen.dart';

/// سيستم الموظفين كامل جوه البرنامج (نفس الموقع بالظبط) — الدخول باليوزر والباسورد بيتحفظ،
/// ومسح كود الطالب بالكاميرا شغال من صفحات تسجيل الحضور/الواجب/الباب.
class StaffScreen extends StatefulWidget {
  const StaffScreen({super.key, required this.onSwitchAccount});
  final VoidCallback onSwitchAccount;

  @override
  State<StaffScreen> createState() => _StaffScreenState();
}

class _StaffScreenState extends State<StaffScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => Updater.checkAndPrompt(context, silent: true));
  }

  @override
  Widget build(BuildContext context) {
    return WebScreen(
      title: 'Studyisfunny',
      url: '${AppConfig.staffWebBase}/sessions',
      extraActions: [
        PopupMenuButton<String>(
          onSelected: (value) {
            if (value == 'update') Updater.checkAndPrompt(context);
            if (value == 'switch') widget.onSwitchAccount();
          },
          itemBuilder: (_) => const [
            PopupMenuItem(value: 'update', child: Text('تحديثات البرنامج')),
            PopupMenuItem(value: 'switch', child: Text('تغيير نوع الحساب (طالب/ولي أمر)')),
          ],
        ),
      ],
    );
  }
}
