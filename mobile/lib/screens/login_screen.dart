import 'package:flutter/material.dart';

import '../services/api.dart';
import '../services/session_store.dart';
import '../theme.dart';

/// شاشة الدخول: طالب / ولي أمر / موظف
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.onLoggedIn});
  final void Function(AccountType type) onLoggedIn;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  AccountType _type = AccountType.student;
  final _phone = TextEditingController();
  final _code = TextEditingController();
  final _form = GlobalKey<FormState>();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _phone.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_type == AccountType.staff) {
      await SessionStore.saveStaff();
      widget.onLoggedIn(AccountType.staff);
      return;
    }
    if (!_form.currentState!.validate()) return;
    setState(() { _busy = true; _error = null; });
    final phone = _phone.text.replaceAll(RegExp(r'\s'), '');
    final code = _code.text.trim().toUpperCase();
    try {
      final token = _type == AccountType.parent
          ? await PortalApi.parentLogin(phone, code)
          : await PortalApi.studentLogin(phone, code);
      await SessionStore.savePortal(_type, token, code);
      widget.onLoggedIn(_type);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isStaff = _type == AccountType.staff;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Form(
                key: _form,
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(24),
                    child: Image.asset('assets/images/icon.png', width: 88, height: 88),
                  ),
                  const SizedBox(height: 16),
                  const Text.rich(
                    TextSpan(children: [
                      TextSpan(text: 'Study'),
                      TextSpan(text: 'is', style: TextStyle(color: AppColors.accent)),
                      TextSpan(text: 'funny'),
                    ]),
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 30, fontWeight: FontWeight.w800, color: AppColors.text),
                  ),
                  const Text('نظام متابعة الطلاب', textAlign: TextAlign.center, style: TextStyle(color: AppColors.muted)),
                  const SizedBox(height: 28),
                  SegmentedButton<AccountType>(
                    segments: const [
                      ButtonSegment(value: AccountType.student, label: Text('طالب'), icon: Icon(Icons.school_outlined)),
                      ButtonSegment(value: AccountType.parent, label: Text('ولي أمر'), icon: Icon(Icons.family_restroom)),
                      ButtonSegment(value: AccountType.staff, label: Text('موظف'), icon: Icon(Icons.badge_outlined)),
                    ],
                    selected: {_type},
                    showSelectedIcon: false,
                    onSelectionChanged: (s) => setState(() { _type = s.first; _error = null; }),
                  ),
                  const SizedBox(height: 24),
                  if (isStaff)
                    Card(
                      child: Padding(
                        padding: const EdgeInsets.all(18),
                        child: Column(children: const [
                          Icon(Icons.admin_panel_settings_outlined, size: 40, color: AppColors.primary),
                          SizedBox(height: 10),
                          Text(
                            'للأسيستانت والأدمن: هيفتح السيستم كامل جوه البرنامج، وتسجل دخول باليوزر والباسورد بتوعك. '
                            'مسح كود الطالب بكاميرا الموبايل شغال.',
                            textAlign: TextAlign.center,
                            style: TextStyle(height: 1.7),
                          ),
                        ]),
                      ),
                    )
                  else ...[
                    TextFormField(
                      controller: _phone,
                      keyboardType: TextInputType.phone,
                      textDirection: TextDirection.ltr,
                      decoration: InputDecoration(
                        labelText: _type == AccountType.parent ? 'رقم تليفون ولي الأمر' : 'رقم تليفون الطالب',
                        prefixIcon: const Icon(Icons.phone_outlined),
                      ),
                      validator: (v) => (v ?? '').replaceAll(RegExp(r'\s'), '').length < 10 ? 'اكتب رقم التليفون صح' : null,
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: _code,
                      textDirection: TextDirection.ltr,
                      textCapitalization: TextCapitalization.characters,
                      decoration: const InputDecoration(labelText: 'كود الطالب', hintText: 'STU-00123', prefixIcon: Icon(Icons.qr_code_2)),
                      validator: (v) => (v ?? '').trim().isEmpty ? 'اكتب كود الطالب' : null,
                      onFieldSubmitted: (_) => _submit(),
                    ),
                  ],
                  if (_error != null) ...[
                    const SizedBox(height: 16),
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(color: AppColors.dangerSoft, borderRadius: BorderRadius.circular(12)),
                      child: Text(_error!, style: const TextStyle(color: AppColors.dangerText)),
                    ),
                  ],
                  const SizedBox(height: 24),
                  FilledButton(
                    onPressed: _busy ? null : _submit,
                    child: _busy
                        ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white))
                        : Text(isStaff ? 'فتح سيستم الموظفين' : 'دخول'),
                  ),
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
