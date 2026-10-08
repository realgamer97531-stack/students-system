import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';

import '../services/api.dart';
import '../services/session_store.dart';
import '../services/staff_api.dart';
import '../theme.dart';

/// بصمة الباسورد للدخول أوفلاين (الباسورد نفسه مش بيتحفظ هنا)
String staffOfflineHash(String username, String password) =>
    sha256.convert(utf8.encode('studyisfunny|${username.trim().toLowerCase()}|$password')).toString();

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
  final _username = TextEditingController();
  final _password = TextEditingController();
  bool _showPassword = false;
  final _form = GlobalKey<FormState>();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _phone.dispose();
    _code.dispose();
    _username.dispose();
    _password.dispose();
    super.dispose();
  }

  /// أول مرة على الموبايل: لازم أدمن يسجله (زي اللابتوب بالظبط)
  Future<bool> _ensureDevice(String username, String password) async {
    if (await SessionStore.deviceToken() != null) return true;
    final name = 'موبايل: $username';
    try {
      // لو اللي داخل أدمن، بيسجل الجهاز بنفس بياناته
      await SessionStore.saveDeviceToken(await StaffApi.registerDevice(username, password, name));
      return true;
    } on ApiException catch (e) {
      if (e.offline) rethrow;
    }
    if (!mounted) return false;
    final admin = await showDialog<(String, String)>(context: context, builder: (_) => const _AdminRegisterDialog());
    if (admin == null) return false;
    await SessionStore.saveDeviceToken(await StaffApi.registerDevice(admin.$1, admin.$2, name));
    return true;
  }

  Future<void> _staffLogin() async {
    if (!_form.currentState!.validate()) return;
    final username = _username.text.trim();
    final password = _password.text;
    setState(() { _busy = true; _error = null; });
    try {
      if (!await _ensureDevice(username, password)) return;
      StaffUser user;
      try {
        user = await StaffApi.login(username, password);
      } on DeviceNotAuthorized {
        // التسجيل اتلغى من السيستم: نسجل تاني
        await SessionStore.saveDeviceToken(null);
        if (!await _ensureDevice(username, password)) return;
        user = await StaffApi.login(username, password);
      }
      await SessionStore.saveStaff(user, password, staffOfflineHash(username, password));
      widget.onLoggedIn(AccountType.staff);
    } on ApiException catch (e) {
      if (e.offline) {
        // مفيش نت: ينفع يدخل لو دخل بنفس اليوزر والباسورد على الموبايل ده قبل كده
        final saved = (await SessionStore.offlineHashes())[username.toLowerCase()];
        if (saved is Map && saved['hash'] == staffOfflineHash(username, password) && await SessionStore.deviceToken() != null) {
          await SessionStore.saveStaff(StaffUser.fromJson((saved['user'] as Map).cast<String, dynamic>()), password, saved['hash'] as String);
          widget.onLoggedIn(AccountType.staff);
          return;
        }
        setState(() => _error = 'مفيش نت — أول دخول لازم يكون فيه نت');
        return;
      }
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _submit() async {
    if (_type == AccountType.staff) return _staffLogin();
    if (!_form.currentState!.validate()) return;
    setState(() { _busy = true; _error = null; });
    final phone = _phone.text.replaceAll(RegExp(r'\s'), '');
    final code = _code.text.trim().toUpperCase();
    try {
      final token = _type == AccountType.parent
          ? await PortalApi.parentLogin(phone, code)
          : await PortalApi.studentLogin(phone, code);
      await SessionStore.savePortal(_type, token, code, phone);
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
                      TextSpan(text: 'Shady '),
                      TextSpan(text: 'Elsharkawy', style: TextStyle(color: AppColors.accent)),
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
                  if (isStaff) ...[
                    TextFormField(
                      controller: _username,
                      textDirection: TextDirection.ltr,
                      autocorrect: false,
                      decoration: const InputDecoration(labelText: 'اليوزرنيم', prefixIcon: Icon(Icons.person_outline)),
                      validator: (v) => (v ?? '').trim().isEmpty ? 'اكتب اليوزرنيم' : null,
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: _password,
                      obscureText: !_showPassword,
                      textDirection: TextDirection.ltr,
                      decoration: InputDecoration(
                        labelText: 'الباسورد',
                        prefixIcon: const Icon(Icons.lock_outline),
                        suffixIcon: IconButton(
                          icon: Icon(_showPassword ? Icons.visibility_off : Icons.visibility),
                          onPressed: () => setState(() => _showPassword = !_showPassword),
                        ),
                      ),
                      validator: (v) => (v ?? '').isEmpty ? 'اكتب الباسورد' : null,
                      onFieldSubmitted: (_) => _submit(),
                    ),
                    const SizedBox(height: 10),
                    const Text(
                      'مسح الحضور والواجب والباب شغال حتى من غير نت، وكل حاجة بتتبعت لوحدها لما النت يرجع.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: AppColors.muted, fontSize: 13),
                    ),
                  ]
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
                        : const Text('دخول'),
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

class _AdminRegisterDialog extends StatefulWidget {
  const _AdminRegisterDialog();
  @override
  State<_AdminRegisterDialog> createState() => _AdminRegisterDialogState();
}

class _AdminRegisterDialogState extends State<_AdminRegisterDialog> {
  final _u = TextEditingController();
  final _p = TextEditingController();

  @override
  void dispose() {
    _u.dispose();
    _p.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('تسجيل الموبايل في السيستم'),
      content: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('أول مرة بس على الموبايل ده: محتاج يوزر وباسورد أدمن عشان يتسجل (زي اللابتوب). بعد كده كل موظف يدخل ببياناته.'),
          const SizedBox(height: 12),
          TextField(controller: _u, textDirection: TextDirection.ltr, decoration: const InputDecoration(labelText: 'يوزرنيم الأدمن')),
          const SizedBox(height: 10),
          TextField(controller: _p, obscureText: true, textDirection: TextDirection.ltr, decoration: const InputDecoration(labelText: 'باسورد الأدمن')),
        ]),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('إلغاء')),
        FilledButton(
          style: FilledButton.styleFrom(minimumSize: const Size(90, 42)),
          onPressed: () => Navigator.pop(context, (_u.text.trim(), _p.text)),
          child: const Text('تسجيل'),
        ),
      ],
    );
  }
}
