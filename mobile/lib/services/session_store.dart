import 'package:shared_preferences/shared_preferences.dart';

/// نوع الحساب اللي داخل على البرنامج
enum AccountType { student, parent, staff }

/// حفظ بيانات الدخول على الموبايل (بتفضل لحد ما يعمل خروج)
class SessionStore {
  static const _kType = 'account_type';
  static const _kToken = 'portal_token';
  static const _kCode = 'student_code';

  static Future<AccountType?> type() async {
    final prefs = await SharedPreferences.getInstance();
    final value = prefs.getString(_kType);
    return AccountType.values.where((t) => t.name == value).firstOrNull;
  }

  static Future<String?> token() async => (await SharedPreferences.getInstance()).getString(_kToken);
  static Future<String?> studentCode() async => (await SharedPreferences.getInstance()).getString(_kCode);

  static Future<void> savePortal(AccountType type, String token, String studentCode) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kType, type.name);
    await prefs.setString(_kToken, token);
    await prefs.setString(_kCode, studentCode);
  }

  static Future<void> saveStaff() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kType, AccountType.staff.name);
    await prefs.remove(_kToken);
  }

  static Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_kType);
    await prefs.remove(_kToken);
    await prefs.remove(_kCode);
  }
}
