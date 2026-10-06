import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// نوع الحساب اللي داخل على البرنامج
enum AccountType { student, parent, staff }

/// بيانات الموظف اللي داخل (بتيجي من السيرفر وقت الدخول وبتتحفظ للشغل أوفلاين)
class StaffUser {
  StaffUser({required this.id, required this.name, required this.role, required this.permissions, required this.username});
  final int id;
  final String name;
  final String role;
  final List<String> permissions;
  final String username;

  bool get isAdmin => role == 'admin';
  bool can(String permission) => isAdmin || permissions.contains(permission);

  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'role': role, 'permissions': permissions, 'username': username};
  factory StaffUser.fromJson(Map<String, dynamic> j) => StaffUser(
        id: (j['id'] as num).toInt(),
        name: '${j['name'] ?? ''}',
        role: '${j['role'] ?? ''}',
        permissions: ((j['permissions'] as List?) ?? []).map((e) => '$e').toList(),
        username: '${j['username'] ?? ''}',
      );
}

/// حفظ بيانات الدخول على الموبايل: بتفضل محفوظة لحد ما المستخدم يعمل خروج بنفسه.
/// الطالب/ولي الأمر: بنحفظ التليفون والكود (مشفرين) عشان لو صلاحية الدخول خلصت على السيرفر (كل 30 يوم)
/// البرنامج يدخل تاني لوحده من غير ما يطلب منه حاجة.
class SessionStore {
  static const _kType = 'account_type';
  static const _kToken = 'portal_token';
  static const _kCode = 'student_code';
  static const _kStaffUser = 'staff_user';
  static const _kActiveSession = 'staff_active_session';

  static const _sPhone = 'portal_phone';
  static const _sStaffPassword = 'staff_password';
  static const _sDeviceToken = 'sync_device_token';
  static const _sOfflineHash = 'staff_offline_hash';

  static const _secure = FlutterSecureStorage();

  static Future<String?> _readSecure(String key) async {
    try {
      return await _secure.read(key: key);
    } catch (_) {
      return null;
    }
  }

  static Future<void> _writeSecure(String key, String? value) async {
    try {
      if (value == null) {
        await _secure.delete(key: key);
      } else {
        await _secure.write(key: key, value: value);
      }
    } catch (_) {}
  }

  static Future<AccountType?> type() async {
    final prefs = await SharedPreferences.getInstance();
    final value = prefs.getString(_kType);
    return AccountType.values.where((t) => t.name == value).firstOrNull;
  }

  static Future<String?> token() async => (await SharedPreferences.getInstance()).getString(_kToken);
  static Future<String?> studentCode() async => (await SharedPreferences.getInstance()).getString(_kCode);
  static Future<String?> phone() => _readSecure(_sPhone);

  static Future<void> savePortal(AccountType type, String token, String studentCode, String phone) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kType, type.name);
    await prefs.setString(_kToken, token);
    await prefs.setString(_kCode, studentCode);
    await _writeSecure(_sPhone, phone);
  }

  static Future<void> updateToken(String token) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kToken, token);
  }

  // ===== الموظفين =====

  static Future<String?> deviceToken() => _readSecure(_sDeviceToken);
  static Future<void> saveDeviceToken(String? token) => _writeSecure(_sDeviceToken, token);

  static Future<StaffUser?> staffUser() async {
    final raw = (await SharedPreferences.getInstance()).getString(_kStaffUser);
    if (raw == null) return null;
    try {
      return StaffUser.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  static Future<String?> staffPassword() => _readSecure(_sStaffPassword);

  static Future<void> saveStaff(StaffUser user, String password, String offlineHash) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kType, AccountType.staff.name);
    await prefs.setString(_kStaffUser, jsonEncode(user.toJson()));
    await prefs.remove(_kToken);
    await _writeSecure(_sStaffPassword, password);
    // للدخول أوفلاين بعد كده: بنحفظ بصمة الباسورد بس (مش الباسورد) لكل يوزر دخل قبل كده
    final hashes = await offlineHashes();
    hashes[user.username.toLowerCase()] = {'hash': offlineHash, 'user': user.toJson()};
    await _writeSecure(_sOfflineHash, jsonEncode(hashes));
  }

  static Future<Map<String, dynamic>> offlineHashes() async {
    try {
      return (jsonDecode(await _readSecure(_sOfflineHash) ?? '{}') as Map).cast<String, dynamic>();
    } catch (_) {
      return {};
    }
  }

  static Future<int?> activeSessionId() async => (await SharedPreferences.getInstance()).getInt(_kActiveSession);
  static Future<void> setActiveSessionId(int? id) async {
    final prefs = await SharedPreferences.getInstance();
    if (id == null) {
      await prefs.remove(_kActiveSession);
    } else {
      await prefs.setInt(_kActiveSession, id);
    }
  }

  /// خروج: بيمسح بيانات الحساب (تسجيل الجهاز للموظفين بيفضل زي ما هو)
  static Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_kType);
    await prefs.remove(_kToken);
    await prefs.remove(_kCode);
    await prefs.remove(_kStaffUser);
    await _writeSecure(_sPhone, null);
    await _writeSecure(_sStaffPassword, null);
  }
}
